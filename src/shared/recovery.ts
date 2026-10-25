import type { WithoutDaemonConfig } from '../types.js';
import { appendLog } from './log.js';
import { execNpm } from './npm.js';
import { findLeftoverTempDirs, verifyInstalled } from './installed.js';
import { isPidAlive } from './lock.js';
import { readState, writeState, stateFilePath } from './state.js';

export const INSTALL_TIMEOUT_MS = 5 * 60_000;
/** An 'applying' record older than this is dead whatever its pid says (pid reuse). */
const APPLYING_STALE_MS = 15 * 60_000;

export function installFlags(cfg: WithoutDaemonConfig): string[] {
	return cfg.npmInstallFlags ?? [];
}

/**
 * Makes `version` the installed one, trusting the filesystem rather than npm's exit code.
 * No-op when it is already there.
 */
export function ensureVersion(cfg: WithoutDaemonConfig, version: string): { ok: boolean; error?: string } {
	const { pkgName, configDir } = cfg;
	const before = verifyInstalled(pkgName, version);
	if (before.ok) {
		appendLog(configDir, 'info', `${pkgName}@${version} is already installed, nothing to restore`);
		return { ok: true };
	}
	appendLog(configDir, 'warn', `${pkgName}@${version} not in place (${before.reason}), running npm install -g ${pkgName}@${version}`);
	try {
		execNpm(['install', '-g', `${pkgName}@${version}`, ...installFlags(cfg)], { timeout: INSTALL_TIMEOUT_MS });
	} catch (err) {
		return { ok: false, error: `npm install -g ${pkgName}@${version} failed: ${describeNpmError(err)}` };
	}
	const after = verifyInstalled(pkgName, version);
	if (after.unverifiable) {
		appendLog(configDir, 'warn', `${pkgName}@${version} installed but cannot be verified: ${after.reason}`);
		return { ok: true };
	}
	return after.ok ? { ok: true } : { ok: false, error: `npm reported success but ${after.reason}` };
}

/** A timeout kills npm but may leave its children running and the package half-replaced. */
export function describeNpmError(err: unknown): string {
	const e = err as NodeJS.ErrnoException & { signal?: string };
	if (e?.code === 'ETIMEDOUT') {
		return `timed out after ${INSTALL_TIMEOUT_MS / 60_000} min (npm was killed; its child processes may still be running and the package may be half-replaced): ${e.message}`;
	}
	return String(err);
}

export function warnLeftoverTempDirs(cfg: WithoutDaemonConfig): void {
	const leftovers = findLeftoverTempDirs(cfg.pkgName);
	if (leftovers.length > 0) {
		appendLog(cfg.configDir, 'warn', `${cfg.pkgName} leftover npm temp dir(s) from an interrupted install, not deleted (may hold the previous version): ${leftovers.join(', ')}`);
	}
}

/**
 * Run at the start of every without-daemon run, with the lock held (so no other updater is live).
 * If the persisted state is 'applying', a previous run died inside the install: verify what is
 * installed and restore it. Returns true when an interrupted install was found (and handled).
 */
export async function repairInterruptedInstall(
	cfg: WithoutDaemonConfig,
	selfCheck: () => Promise<boolean>,
): Promise<boolean> {
	const { pkgName, configDir } = cfg;
	const file = stateFilePath(configDir);
	const state = readState(file);
	if (!state || state.status !== 'applying') return false;

	const age = Date.now() - (state.timestamp ?? 0);
	if (state.pid !== undefined && state.pid !== process.pid && isPidAlive(state.pid) && age < APPLYING_STALE_MS) {
		appendLog(configDir, 'warn', `${pkgName} state is 'applying' by pid ${state.pid} which is still alive (${Math.round(age / 1000)}s old), not repairing`);
		return true;
	}

	const previous = state.previousVersion ?? state.currentVersion;
	const target = state.targetVersion;
	appendLog(configDir, 'error', `${pkgName} previous install ${previous} -> ${target} was interrupted (updater pid ${state.pid ?? '?'} is gone), verifying the installation`);
	warnLeftoverTempDirs(cfg);

	const done = (status: 'success' | 'rolled-back' | 'failed', error?: string): void => {
		writeState(file, {
			status,
			currentVersion: cfg.currentVersion,
			...(target ? { targetVersion: target } : {}),
			...(previous ? { previousVersion: previous } : {}),
			...(error ? { error } : {}),
			timestamp: Date.now(),
		});
	};

	// The install may have completed right before the process died: keep it if it is healthy.
	if (target) {
		const t = verifyInstalled(pkgName, target);
		if (t.ok) {
			if (await selfCheck()) {
				appendLog(configDir, 'warn', `${pkgName}@${target} was fully installed and passes self-check, keeping it`);
				done('success');
				return true;
			}
			appendLog(configDir, 'warn', `${pkgName}@${target} installed but fails self-check, restoring ${previous}`);
		}
	}

	const restoreTo = previous ?? target;
	if (!restoreTo) {
		const msg = 'interrupted install with no recorded version: cannot choose a version to restore, reinstall manually';
		appendLog(configDir, 'error', `${pkgName} ${msg}`);
		done('failed', msg);
		return true;
	}
	const res = ensureVersion(cfg, restoreTo);
	if (res.ok) {
		appendLog(configDir, 'warn', `${pkgName} repaired: ${restoreTo} is installed again after an interrupted update to ${target ?? '?'}`);
		done('rolled-back', `interrupted install repaired: ${restoreTo} restored`);
	} else {
		appendLog(configDir, 'error', `${pkgName} REPAIR FAILED, the CLI may be missing: ${res.error}. Fix manually: npm install -g ${pkgName}@${restoreTo}`);
		done('failed', `interrupted install and repair failed: ${res.error}. Fix manually: npm install -g ${pkgName}@${restoreTo}`);
	}
	return true;
}
