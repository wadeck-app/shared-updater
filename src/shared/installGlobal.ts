import type { WithoutDaemonConfig } from '../types.js';
import { INSTALL_TIMEOUT_MS } from './constants.js';
import { appendLog } from './log.js';
import { runNpmAsync } from './npm.js';
import { journalNpmChild, stateFilePath } from './state.js';
import { errorMessage } from './util.js';

export function installFlags(cfg: WithoutDaemonConfig): string[] {
	return cfg.npmInstallFlags ?? [];
}

/**
 * `npm install -g <spec>` (into `--prefix <prefix>` when given) with its pid journaled in the
 * 'applying' state as soon as it is spawned (and cleared when it ends), so that a hard-killed updater
 * leaves a trail to the orphaned npm. Throws like execNpm did (message `Command failed: ...`,
 * `code: 'ETIMEDOUT'`).
 */
export async function installGlobal(cfg: WithoutDaemonConfig, spec: string, opts: { prefix?: string } = {}): Promise<void> {
	const file = stateFilePath(cfg.configDir);
	const prefix = opts.prefix === undefined ? [] : ['--prefix', opts.prefix];
	try {
		await runNpmAsync(['install', '-g', ...prefix, spec, ...installFlags(cfg)], {
			timeout: INSTALL_TIMEOUT_MS,
			onSpawn: (pid) => journalNpmChild(file, { pid, startedAt: Date.now() }),
		});
	} finally {
		try { journalNpmChild(file, null); } catch (err) {
			appendLog(cfg.configDir, 'warn', `${cfg.pkgName} could not clear the npm pid from ${file}: ${errorMessage(err)}`);
		}
	}
}
