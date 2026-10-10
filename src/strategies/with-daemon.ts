import { readFileSync, existsSync } from 'node:fs';
import type { WithDaemonConfig } from '../types.js';
import { tryAcquireLock, releaseLock } from '../shared/lock.js';
import { readCache, writeCache, writeState, stateFilePath, cacheFilePath, lockFilePath } from '../shared/state.js';
import { readUpdateConfig } from '../shared/config.js';
import { fetchLatestVersion } from '../shared/fetch.js';
import { appendLog } from '../shared/log.js';
import { semverLte } from '../shared/semver.js';

export async function runWithDaemon(cfg: WithDaemonConfig): Promise<void> {
	// UPDATER_FORCE=1 → bypass cache interval + trigger immediate apply via POST /quit
	const force = process.env['UPDATER_FORCE'] === '1';
	const { pkgName, configDir, currentVersion } = cfg;
	const lockFile = lockFilePath(configDir);

	if (!tryAcquireLock(lockFile)) {
		appendLog(configDir, 'info', `${pkgName} updater already running, skipping`);
		return;
	}

	try {
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
		if (!force && !cfg.skipThrottle && cache && now - cache.lastCheckedAt < updateCfg.checkIntervalMs) {
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

		// Signal the daemon — it decides when to apply (idle-aware).
		// Go launcher applies via updateCmd in launcher.config.json on next restart.
		writeState(stateFilePath(configDir), {
			status: 'update-available',
			currentVersion,
			targetVersion: latestVersion,
			timestamp: Date.now(),
		});

		if (force) {
			await triggerImmediateRestart(cfg, latestVersion);
		}
	} finally {
		releaseLock(lockFile);
	}
}

// Sends POST /quit to the daemon's health server (singleton-daemon-kit built-in endpoint).
// Port is read from configDir/config.port (PortFileData), token from configDir/health_token.
// Only called when UPDATER_FORCE=1. The daemon restarts and Go launcher applies the update.
async function triggerImmediateRestart(cfg: WithDaemonConfig, targetVersion: string): Promise<void> {
	const { configDir, pkgName } = cfg;
	const portFilePath = `${configDir}/config.port`;
	const tokenFilePath = `${configDir}/health_token`;

	if (!existsSync(portFilePath)) {
		appendLog(configDir, 'warn', `${pkgName} --force: daemon not running (no config.port), skipping POST /quit`);
		return;
	}

	let port: number;
	let token: string;
	try {
		const data = JSON.parse(readFileSync(portFilePath, 'utf8'));
		port = data.port;
		token = readFileSync(tokenFilePath, 'utf8').trim();
	} catch (err) {
		appendLog(configDir, 'warn', `${pkgName} --force: cannot read port/token: ${err}`);
		return;
	}

	try {
		await fetch(`http://127.0.0.1:${port}/quit`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(5000),
		});
		appendLog(configDir, 'info', `${pkgName} --force: POST /quit sent, daemon restarting to apply ${targetVersion}`);
	} catch (err) {
		appendLog(configDir, 'warn', `${pkgName} --force: POST /quit failed: ${err}`);
	}
}
