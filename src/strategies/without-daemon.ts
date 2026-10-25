import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { WithoutDaemonConfig } from '../types.js';
import { tryAcquireLock, releaseLock } from '../shared/lock.js';
import { readCache, writeCache, writeState, stateFilePath, cacheFilePath, lockFilePath } from '../shared/state.js';
import { readUpdateConfig } from '../shared/config.js';
import { fetchLatestVersion } from '../shared/fetch.js';
import { verifyInstalled } from '../shared/installed.js';
import { installInterruptGuard } from '../shared/guard.js';
import { describeNpmError, ensureVersion, installGlobal, repairInterruptedInstall } from '../shared/recovery.js';
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

	const disposeGuard = installInterruptGuard({ configDir, pkgName, lockFile });
	try {
		// An 'applying' state left by a killed install is repaired first, regardless of
		// autoUpdate / throttle: restoring a CLI that vanished is not "an update".
		if (await repairInterruptedInstall(cfg, selfCheck)) return;

		const updateCfg = readUpdateConfig(configDir);
		// autoUpdate: false disables updating on our own initiative, not an update the user just
		// asked for: UPDATER_FORCE=1 is only ever set by an explicit `<cli> cli update`. Either way
		// the decision is logged -- returning in silence made an explicit update look like a no-op.
		if (updateCfg.disabled) {
			if (!force) {
				appendLog(configDir, 'info', `${pkgName} not updating: autoUpdate: false in ${configDir}/config.yml`);
				return;
			}
			appendLog(
				configDir,
				'warn',
				`${pkgName} update requested explicitly, overriding autoUpdate: false in ${configDir}/config.yml`,
			);
		}

		const cache = readCache(cacheFilePath(configDir));
		const now = Date.now();

		// If a deferred update has reached its retryAt, bypass the cache and re-check.
		const stateFile = stateFilePath(configDir);
		let deferredRetryDue = false;
		if (existsSync(stateFile)) {
			try {
				const state = JSON.parse(readFileSync(stateFile, 'utf8')) as { status?: string; retryAt?: number };
				if (state.status === 'deferred' && typeof state.retryAt === 'number' && state.retryAt <= now) {
					deferredRetryDue = true;
					appendLog(configDir, 'info', `${pkgName} deferred update retry due`);
				}
			} catch { /* ignore corrupt state file */ }
		}

		if (!force && !cfg.skipThrottle && !deferredRetryDue && cache && now - cache.lastCheckedAt < updateCfg.checkIntervalMs) {
			// This used to return in silence: a caller invoking us every 30m (to not miss a 4h-ish
			// checkIntervalMs by much) looked identical in the logs to the check never running at all.
			const sinceMin = Math.round((now - cache.lastCheckedAt) / 60_000);
			const dueInMin = Math.round((updateCfg.checkIntervalMs - (now - cache.lastCheckedAt)) / 60_000);
			appendLog(configDir, 'info', `${pkgName} check skipped: last checked ${sinceMin}m ago, next check in ~${dueInMin}m`);
			return;
		}

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

		const installStateFile = stateFilePath(configDir);
		const base = { currentVersion, targetVersion: latestVersion, previousVersion: currentVersion };
		// Persisted BEFORE npm runs: if this process is killed inside the install (npm removes the
		// old package before the new one is in place), the next run finds 'applying' and repairs.
		writeState(installStateFile, { status: 'applying', ...base, pid: process.pid, timestamp: Date.now() });
		appendLog(configDir, 'info', `${pkgName} installing ${latestVersion} (previous: ${currentVersion})`);

		// Every failure below ends in a restore of the previous version + a state, never a bare return.
		const failAndRestore = async (status: 'failed' | 'rolled-back', why: string): Promise<void> => {
			appendLog(configDir, 'error', `${pkgName} ${why}, restoring ${currentVersion}`);
			const res = await ensureVersion(cfg, currentVersion);
			if (res.ok) {
				appendLog(configDir, 'warn', `${pkgName} ${currentVersion} is installed again`);
				writeState(installStateFile, { status, ...base, error: why, timestamp: Date.now() });
			} else {
				appendLog(configDir, 'error', `${pkgName} RESTORE FAILED, the CLI may be missing: ${res.error}. Fix manually: npm install -g ${pkgName}@${currentVersion}`);
				writeState(installStateFile, {
					status: 'failed', ...base,
					error: `${why}; restore of ${currentVersion} failed: ${res.error}. Fix manually: npm install -g ${pkgName}@${currentVersion}`,
					timestamp: Date.now(),
				});
			}
		};

		try {
			await installGlobal(cfg, `${pkgName}@${latestVersion}`);
		} catch (err) {
			await failAndRestore('failed', `install of ${latestVersion} failed: ${describeNpmError(err)}`);
			return;
		}

		// npm's exit code is not proof: read the installed package.json.
		const installed = verifyInstalled(pkgName, latestVersion);
		if (installed.unverifiable) {
			appendLog(configDir, 'warn', `${pkgName} install of ${latestVersion} cannot be verified: ${installed.reason}`);
		} else if (!installed.ok) {
			await failAndRestore('rolled-back', `npm install reported success but ${installed.reason}`);
			return;
		}

		const selfCheckPassed = await selfCheck();
		if (!selfCheckPassed) {
			await failAndRestore('rolled-back', `self-check failed after update to ${latestVersion}`);
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
		disposeGuard();
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
