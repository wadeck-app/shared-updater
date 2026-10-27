import type { WithoutDaemonConfig } from '../types.js';
import { appendLog } from './log.js';
import { runNpmAsync } from './npm.js';
import { findLeftoverTempDirs, verifyInstalled } from './installed.js';
import { isPidAlive } from './lock.js';
import { getProcessStartMs, isProcessRunning, killProcessTree } from './process.js';
import { journalNpmChild, readState, writeState, stateFilePath } from './state.js';

export const INSTALL_TIMEOUT_MS = 5 * 60_000;
/** An 'applying' record older than this is dead whatever its pid says (pid reuse). */
const APPLYING_STALE_MS = 15 * 60_000;
export const DEFAULT_ORPHAN_NPM_WAIT_MS = 30_000;
/** An npm is stopped after INSTALL_TIMEOUT_MS: a recorded npm pid older than this + margin is not our npm. */
const ORPHAN_MAX_AGE_MS = INSTALL_TIMEOUT_MS + 60_000;
/** Allowed gap between the journaled spawn time and the live process' start time (ps has 1 s resolution). */
const START_TIME_TOLERANCE_MS = 15_000;
const ORPHAN_STOP_GRACE_MS = 10_000;

export function installFlags(cfg: WithoutDaemonConfig): string[] {
	return cfg.npmInstallFlags ?? [];
}

/**
 * `npm install -g <spec>` with its pid journaled in the 'applying' state as soon as it is
 * spawned (and cleared when it ends), so that a hard-killed updater leaves a trail to the
 * orphaned npm. Throws like execNpm did (message `Command failed: ...`, `code: 'ETIMEDOUT'`).
 */
export async function installGlobal(cfg: WithoutDaemonConfig, spec: string): Promise<void> {
	const file = stateFilePath(cfg.configDir);
	try {
		await runNpmAsync(['install', '-g', spec, ...installFlags(cfg)], {
			timeout: INSTALL_TIMEOUT_MS,
			onSpawn: (pid) => journalNpmChild(file, { pid, startedAt: Date.now() }),
		});
	} finally {
		try { journalNpmChild(file, null); } catch (err) {
			appendLog(cfg.configDir, 'warn', `${cfg.pkgName} could not clear the npm pid from ${file}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
}

export interface OrphanDeps {
	isRunning: (pid: number) => boolean;
	stopTree: (pid: number) => void;
	startMs: (pid: number) => number | null;
	sleep: (ms: number) => Promise<void>;
	now: () => number;
}
const realOrphanDeps: OrphanDeps = {
	isRunning: isProcessRunning,
	stopTree: killProcessTree,
	startMs: (pid) => getProcessStartMs(pid),
	sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
	now: () => Date.now(),
};

/**
 * Before the global dir is touched: if the journal names an npm that is still running (orphaned
 * by a hard-killed updater), give it `orphanNpmWaitMs` to finish, then stop its whole tree.
 * Returns false only when the orphan could not be stopped (repair must not race it).
 *
 * Pid reuse: the pid is only trusted when the journaled spawn time is younger than any npm can
 * be (INSTALL_TIMEOUT_MS) and, where the OS tells us (ps / PowerShell), the live process started
 * within 15 s of it. When the start time cannot be read, only the age bound protects an unrelated
 * process that recycled the pid within those ~6 minutes.
 */
export async function reapOrphanNpm(
	cfg: WithoutDaemonConfig,
	state: { npmPid?: number; npmStartedAt?: number },
	overrides: Partial<OrphanDeps> = {},
): Promise<boolean> {
	const { pkgName, configDir } = cfg;
	const pid = state.npmPid;
	if (pid === undefined) return true;
	const d = { ...realOrphanDeps, ...overrides };
	if (!d.isRunning(pid)) {
		appendLog(configDir, 'info', `${pkgName} the npm (pid ${pid}) recorded by the interrupted updater is no longer running`);
		return true;
	}
	const startedAt = state.npmStartedAt;
	if (startedAt === undefined || d.now() - startedAt > ORPHAN_MAX_AGE_MS) {
		appendLog(configDir, 'warn', `${pkgName} pid ${pid} is alive but was recorded ${startedAt === undefined ? 'without a spawn time' : `${Math.round((d.now() - startedAt) / 1000)}s ago`}, longer than any npm install can run: assuming the pid was reused, NOT touching it`);
		return true;
	}
	const actual = d.startMs(pid);
	if (actual === null) {
		appendLog(configDir, 'warn', `${pkgName} cannot read the start time of pid ${pid}: its identity is unverified, relying on the recorded spawn time only`);
	} else if (Math.abs(actual - startedAt) > START_TIME_TOLERANCE_MS) {
		appendLog(configDir, 'warn', `${pkgName} pid ${pid} started ${Math.round((actual - startedAt) / 1000)}s away from the recorded npm spawn: the pid was reused, NOT touching it`);
		return true;
	}

	const waitMs = cfg.orphanNpmWaitMs ?? DEFAULT_ORPHAN_NPM_WAIT_MS;
	appendLog(configDir, 'warn', `${pkgName} npm (pid ${pid}) orphaned by the interrupted updater is still running, waiting up to ${waitMs}ms for it to finish before repairing`);
	const waitUntil = d.now() + waitMs;
	while (d.isRunning(pid) && d.now() < waitUntil) await d.sleep(Math.min(250, Math.max(0, waitUntil - d.now())));
	if (!d.isRunning(pid)) {
		appendLog(configDir, 'info', `${pkgName} orphaned npm (pid ${pid}) finished on its own`);
		return true;
	}

	appendLog(configDir, 'error', `${pkgName} orphaned npm (pid ${pid}) did not finish within ${waitMs}ms: STOPPING its process tree before repairing`);
	d.stopTree(pid);
	const stopUntil = d.now() + ORPHAN_STOP_GRACE_MS;
	while (d.isRunning(pid) && d.now() < stopUntil) await d.sleep(100);
	if (d.isRunning(pid)) {
		appendLog(configDir, 'error', `${pkgName} orphaned npm (pid ${pid}) is STILL running after being stopped: not repairing (it would race the repair). Stop it manually (taskkill /PID ${pid} /T /F on Windows, kill -9 -${pid} elsewhere); the next run retries`);
		return false;
	}
	appendLog(configDir, 'warn', `${pkgName} orphaned npm (pid ${pid}) stopped`);
	return true;
}

/**
 * Makes `version` the installed one, trusting the filesystem rather than npm's exit code.
 * No-op when it is already there.
 */
export async function ensureVersion(cfg: WithoutDaemonConfig, version: string): Promise<{ ok: boolean; error?: string }> {
	const { pkgName, configDir } = cfg;
	const before = verifyInstalled(pkgName, version);
	if (before.ok) {
		appendLog(configDir, 'info', `${pkgName}@${version} is already installed, nothing to restore`);
		return { ok: true };
	}
	appendLog(configDir, 'warn', `${pkgName}@${version} not in place (${before.reason}), running npm install -g ${pkgName}@${version}`);
	try {
		await installGlobal(cfg, `${pkgName}@${version}`);
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

/** A timeout stops npm's whole process tree but leaves the package possibly half-replaced. */
export function describeNpmError(err: unknown): string {
	const e = err as NodeJS.ErrnoException & { signal?: string };
	if (e?.code === 'ETIMEDOUT') {
		return `timed out after ${INSTALL_TIMEOUT_MS / 60_000} min (npm and its child processes were stopped; the package may be half-replaced): ${e.message}`;
	}
	return String(err);
}

/**
 * Leftover `.<name>-XXXX` dirs are never deleted. `restoring`: the previous version is about to be
 * reinstalled, a dir may still hold a copy of it (warn). Otherwise the complete new install is kept,
 * the dirs are not needed (info, no alarm, with the way to remove them).
 */
export function reportLeftoverTempDirs(cfg: WithoutDaemonConfig, restoring: boolean): void {
	const leftovers = findLeftoverTempDirs(cfg.pkgName);
	if (leftovers.length === 0) return;
	if (restoring) {
		appendLog(cfg.configDir, 'warn', `${cfg.pkgName} leftover npm temp dir(s) from an interrupted install, not deleted (may hold the previous version): ${leftovers.join(', ')}`);
	} else {
		appendLog(cfg.configDir, 'info', `${cfg.pkgName} leftover npm temp dir(s) from the interrupted install are not needed (the new version is complete); not deleted, remove them manually if wanted: ${leftovers.join(', ')}`);
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

	// An npm orphaned by the dead updater may still be writing the global dir: it goes first.
	if (!(await reapOrphanNpm(cfg, state))) return true;

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
				reportLeftoverTempDirs(cfg, false);
				done('success');
				return true;
			}
			appendLog(configDir, 'warn', `${pkgName}@${target} installed but fails self-check, restoring ${previous}`);
		}
	}

	reportLeftoverTempDirs(cfg, true);
	const restoreTo = previous ?? target;
	if (!restoreTo) {
		const msg = 'interrupted install with no recorded version: cannot choose a version to restore, reinstall manually';
		appendLog(configDir, 'error', `${pkgName} ${msg}`);
		done('failed', msg);
		return true;
	}
	const res = await ensureVersion(cfg, restoreTo);
	if (res.ok) {
		appendLog(configDir, 'warn', `${pkgName} repaired: ${restoreTo} is installed again after an interrupted update to ${target ?? '?'}`);
		done('rolled-back', `interrupted install repaired: ${restoreTo} restored`);
	} else {
		appendLog(configDir, 'error', `${pkgName} REPAIR FAILED, the CLI may be missing: ${res.error}. Fix manually: npm install -g ${pkgName}@${restoreTo}`);
		done('failed', `interrupted install and repair failed: ${res.error}. Fix manually: npm install -g ${pkgName}@${restoreTo}`);
	}
	return true;
}
