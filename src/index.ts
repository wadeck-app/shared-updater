export type { UpdaterConfig, WithDaemonConfig, WithoutDaemonConfig, UpdateConfig, UpdateState, UpdateCache, Strategy } from './types.js';
export { semverLte } from './shared/semver.js';
export { execNpm } from './shared/npm.js';
export { tryAcquireLock, releaseLock } from './shared/lock.js';
export { readState, writeState, readCache, writeCache, stateFilePath, cacheFilePath, lockFilePath } from './shared/state.js';
export { readUpdateConfig } from './shared/config.js';
export { appendLog } from './shared/log.js';
export { fetchLatestVersion } from './shared/fetch.js';
export { runWithoutDaemon } from './strategies/without-daemon.js';
export { runWithDaemon } from './strategies/with-daemon.js';

export async function runUpdater(cfg: import('./types.js').UpdaterConfig): Promise<void> {
	if (cfg.strategy === 'without-daemon') {
		const { runWithoutDaemon: run } = await import('./strategies/without-daemon.js');
		return run(cfg);
	}
	const { runWithDaemon: run } = await import('./strategies/with-daemon.js');
	return run(cfg);
}
