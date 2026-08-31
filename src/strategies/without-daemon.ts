import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { WithoutDaemonConfig } from '../types.js';
import { tryAcquireLock, releaseLock } from '../shared/lock.js';
import { readCache, writeCache, writeState, stateFilePath, cacheFilePath, lockFilePath } from '../shared/state.js';
import { readUpdateConfig } from '../shared/config.js';
import { fetchLatestVersion } from '../shared/fetch.js';
import { execNpm } from '../shared/npm.js';
import { appendLog } from '../shared/log.js';
import { semverLte } from '../shared/semver.js';

export async function runWithoutDaemon(cfg: WithoutDaemonConfig): Promise<void> {
	const force = process.env['UPDATER_FORCE'] === '1';
	const { pkgName, configDir, currentVersion } = cfg;
	const lockFile = lockFilePath(configDir);

	if (!tryAcquireLock(lockFile)) {
		appendLog(configDir, 'info', `${pkgName} updater already running, skipping`);
		return;
	}

	try {
		const updateCfg = readUpdateConfig(configDir);
		if (updateCfg.disabled) return;

		const cache = readCache(cacheFilePath(configDir));
		const now = Date.now();
		if (!force && cache && now - cache.lastCheckedAt < updateCfg.checkIntervalMs) return;

		appendLog(configDir, 'info', `${pkgName} checking for updates (current: ${currentVersion})`);

		let latestVersion: string;
		try {
			latestVersion = fetchLatestVersion(pkgName, updateCfg.channel);
		} catch (err) {
			appendLog(configDir, 'warn', `${pkgName} version fetch failed: ${err}`);
			return;
		}

		writeCache(cacheFilePath(configDir), { lastCheckedAt: now, latestVersion });

		if (semverLte(latestVersion, currentVersion)) {
			appendLog(configDir, 'info', `${pkgName} is up to date (${currentVersion})`);
			return;
		}

		appendLog(configDir, 'info', `${pkgName} update available: ${currentVersion} → ${latestVersion}`);

		if (cfg.onUpdateAvailable) {
			const decision = await cfg.onUpdateAvailable(latestVersion);
			if (typeof decision === 'object' && decision.defer) {
				const retryIn = decision.retryIn ?? updateCfg.checkIntervalMs;
				writeState(stateFilePath(configDir), {
					status: 'deferred',
					currentVersion,
					targetVersion: latestVersion,
					retryAt: Date.now() + retryIn,
					timestamp: Date.now(),
				});
				appendLog(configDir, 'info', `${pkgName} update deferred to ${latestVersion} (retry in ${retryIn}ms)`);
				return;
			}
			// decision === 'apply-now': fall through to install
		}

		try {
			execNpm(['install', '-g', `${pkgName}@${latestVersion}`], { timeout: 5 * 60_000 });
		} catch (err) {
			appendLog(configDir, 'error', `${pkgName} install failed: ${err}`);
			writeState(stateFilePath(configDir), {
				status: 'failed',
				currentVersion,
				targetVersion: latestVersion,
				error: String(err),
				timestamp: Date.now(),
			});
			return;
		}

		const selfCheckPassed = await selfCheck();
		if (!selfCheckPassed) {
			appendLog(configDir, 'warn', `${pkgName} self-check failed after update, rolling back to ${currentVersion}`);
			try {
				execNpm(['install', '-g', `${pkgName}@${currentVersion}`], { timeout: 5 * 60_000 });
				writeState(stateFilePath(configDir), {
					status: 'rolled-back',
					currentVersion,
					targetVersion: latestVersion,
					previousVersion: currentVersion,
					timestamp: Date.now(),
				});
			} catch (rollbackErr) {
				appendLog(configDir, 'error', `${pkgName} rollback failed: ${rollbackErr}`);
			}
			return;
		}

		writeState(stateFilePath(configDir), {
			status: 'success',
			currentVersion,
			targetVersion: latestVersion,
			previousVersion: currentVersion,
			timestamp: Date.now(),
		});
		appendLog(configDir, 'info', `${pkgName} updated to ${latestVersion}`);

		if (cfg.restartDaemon) {
			await restartDaemon(cfg, latestVersion);
		}
	} finally {
		releaseLock(lockFile);
	}
}

// Writes config.restart sentinel so the Go launcher restarts the daemon,
// then sends POST /quit to trigger graceful shutdown of the running daemon.
async function restartDaemon(cfg: WithoutDaemonConfig, latestVersion: string): Promise<void> {
	const { configDir, pkgName, restartDaemon: rd } = cfg;
	if (!rd) return;

	// Write restart sentinel — Go launcher detects this on daemon exit and restarts it.
	try {
		writeFileSync(join(configDir, 'config.restart'), '1', 'utf-8');
		appendLog(configDir, 'info', `${pkgName} restart sentinel written`);
	} catch (err) {
		appendLog(configDir, 'warn', `${pkgName} failed to write restart sentinel: ${err}`);
		return;
	}

	// Send POST /quit to daemon — it exits cleanly, Go launcher detects exit + sentinel, restarts.
	if (!existsSync(rd.portFile)) {
		appendLog(configDir, 'info', `${pkgName} daemon not running (no port file), restart will happen on next start`);
		return;
	}

	let port: number;
	let token: string;
	try {
		const data = JSON.parse(readFileSync(rd.portFile, 'utf8'));
		port = data.port;
		token = readFileSync(rd.healthTokenFile, 'utf8').trim();
	} catch (err) {
		appendLog(configDir, 'warn', `${pkgName} cannot read port/token for restart: ${err}`);
		return;
	}

	try {
		await fetch(`http://127.0.0.1:${port}/quit`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(5000),
		});
		appendLog(configDir, 'info', `${pkgName} POST /quit sent on port ${port} — daemon will restart with ${latestVersion}`);
	} catch (err) {
		appendLog(configDir, 'warn', `${pkgName} POST /quit failed: ${err}`);
	}
}

async function selfCheck(): Promise<boolean> {
	// The self-check command is injected via UPDATER_SELF_CHECK_CMD env var.
	// Format: "node /path/to/cli.js cli self-check"
	// If not set, skip self-check and assume success.
	const cmd = process.env['UPDATER_SELF_CHECK_CMD'];
	if (!cmd) return true;
	try {
		const { execSync } = await import('node:child_process');
		execSync(cmd, { timeout: 30_000, windowsHide: true });
		return true;
	} catch {
		return false;
	}
}
