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
	} finally {
		releaseLock(lockFile);
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
