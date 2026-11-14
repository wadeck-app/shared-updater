import { spawn } from 'node:child_process';
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { HealthCheck, HealthCheckInput, HealthCheckResult, UpdateState, WithoutDaemonConfig } from '../types.js';
import { globalRoot } from './installed.js';
import { installGlobal } from './installGlobal.js';
import { appendLog } from './log.js';
import { killProcessTree, trackChild, untrackChild } from './process.js';
import { redactSecrets } from './redact.js';
import { journalApplying, stateFilePath } from './state.js';
import { errorCode, errorMessage, packageBaseName, sleep } from './util.js';

/**
 * Staged install: the new version is installed into a private prefix while the global install
 * keeps working, health-tested there, then switched in by two directory renames (the global
 * package dir aside, the staged one into its place). The CLI is missing only between those two
 * renames, instead of for the whole download + extraction of `npm install -g`.
 *
 * Journal (update-state.json, status 'applying', field `phase`): staging -> staged -> swapping ->
 * swapped. Every phase is written BEFORE its step; a journal write that fails stops the update.
 * The previous dir is kept until the caller's post-checks pass (`SwapHandle.commit`), or put back
 * by `SwapHandle.rollback`; `repairStagedPhase` decides the same way after a crash.
 */

/** Everything the staged install touches outside its own logic, replaceable by tests. */
export interface StagedDeps {
	/** `npm root -g`, or `npm root -g --prefix <prefix>` when a prefix is given. */
	globalRoot: (prefix?: string) => string;
	renameSync: (from: string, to: string) => void;
	/** Recursive delete; throws when it fails (the caller decides how loud that is). */
	removeDir: (path: string) => void;
	sleep: (ms: number) => Promise<void>;
	now: () => number;
	/** True when a rename between the two paths stays on one volume (a cross-volume rename is a copy). */
	sameVolume: (a: string, b: string) => boolean;
	/** Throws when the user cannot create / delete entries in `dir` (checked before any download). */
	probeWritable: (dir: string) => void;
	/** Called after the first rename and before the second: the only moment the global package is absent. */
	betweenRenames: () => void;
	/** How long a locked rename (EPERM / EBUSY) is retried before the update is aborted. */
	renameBudgetMs: number;
}

const realDeps: StagedDeps = {
	globalRoot,
	renameSync,
	removeDir: (p) => rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }),
	sleep,
	now: () => Date.now(),
	sameVolume: (a, b) => statSync(a).dev === statSync(b).dev,
	probeWritable: (dir) => {
		const probe = join(dir, `.updater-write-probe-${process.pid}`);
		writeFileSync(probe, '');
		rmSync(probe, { force: true });
	},
	betweenRenames: () => {},
	renameBudgetMs: 10_000,
};

export function resolveDeps(cfg: WithoutDaemonConfig): StagedDeps {
	return { ...realDeps, ...cfg.stagedDeps };
}

/** Returned by a successful swap: the previous version stays on disk until one of these is called. */
export interface SwapHandle {
	/** The post-checks passed: delete the previous package dir (a failure to delete is a warning). */
	commit: () => void;
	/** The post-checks failed: put the previous version back by rename (no network, no npm). */
	rollback: () => Promise<{ ok: true } | { ok: false; error: string }>;
}

export type StagedResult =
	/** The new version is in place; the previous one is kept aside until `handle.commit()`. */
	| { kind: 'swapped'; handle: SwapHandle }
	/** The staged path does not apply (or was refused before any change): use the direct `npm install -g`. */
	| { kind: 'fallback'; reason: string }
	/** The update was abandoned and the global install was NOT changed (stage removed). */
	| { kind: 'failed'; why: string }
	/** The swap broke and the previous version could not be put back: the journal is left for the next run's repair. */
	| { kind: 'half-state'; why: string };

/** Windows locks: a process with an open file in, or its cwd inside, the directory. Transient. */
const RETRYABLE = new Set(['EPERM', 'EBUSY']);
const PERMISSION_CODES = new Set(['EACCES', 'EPERM', 'EROFS']);

/** bin entries as { command: normalized relative path }; a string `bin` is named after the unscoped package. */
export function normalizeBin(manifest: { bin?: unknown }, pkgName: string): Record<string, string> {
	const norm = (p: string): string => p.replace(/\\/g, '/').replace(/^\.\//, '');
	const bin = manifest.bin;
	if (typeof bin === 'string') {
		return { [packageBaseName(pkgName)]: norm(bin) };
	}
	if (bin && typeof bin === 'object') {
		const out: Record<string, string> = {};
		for (const [k, v] of Object.entries(bin as Record<string, unknown>)) {
			if (typeof v === 'string') {
				out[k] = norm(v);
			}
		}
		return out;
	}
	return {};
}

function sameBin(a: Record<string, string>, b: Record<string, string>): boolean {
	const ka = Object.keys(a).sort();
	const kb = Object.keys(b).sort();
	return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]);
}

function readManifest(dir: string): { name?: string; version?: string; bin?: unknown } | null {
	try {
		return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
	} catch {
		return null;
	}
}

/** The staged package's bin file to run: the command named like the package, else the first one. */
export function pickBinEntry(bin: Record<string, string>, pkgName: string): string | null {
	const names = Object.keys(bin);
	if (names.length === 0) {
		return null;
	}
	return bin[packageBaseName(pkgName)] ?? bin[names[0]!]!;
}

export type BinPlan = { runnable: true; entry: string } | { runnable: false; reason: string };

/**
 * Can `node <bin> cli version` be run on this package? A `.js` / `.cjs` / `.mjs` file, or a file
 * whose shebang names node, yes; a shell script, a native binary, a missing file or no `bin`, no.
 */
export function planBin(packageDir: string, bin: Record<string, string>, pkgName: string): BinPlan {
	const rel = pickBinEntry(bin, pkgName);
	if (rel === null) {
		return { runnable: false, reason: 'the package declares no "bin"' };
	}
	const entry = join(packageDir, ...rel.split('/'));
	if (!existsSync(entry)) {
		return { runnable: false, reason: `the bin entry ${entry} does not exist` };
	}
	if (/\.[cm]?js$/i.test(entry)) {
		return { runnable: true, entry };
	}
	const head = Buffer.alloc(256);
	let n = 0;
	try {
		const fd = openSync(entry, 'r');
		try {
			n = readSync(fd, head, 0, head.length, 0);
		} finally {
			closeSync(fd);
		}
	} catch (err) {
		return { runnable: false, reason: `the bin entry ${entry} cannot be read (${errorMessage(err)})` };
	}
	const bytes = head.subarray(0, n);
	if (bytes.includes(0)) {
		return { runnable: false, reason: `the bin entry ${entry} is a native binary, not a script node can run` };
	}
	const shebang = /^#!([^\n\r]*)/.exec(bytes.toString('latin1'));
	if (shebang && /\bnode(js)?\b/.test(shebang[1]!)) {
		return { runnable: true, entry };
	}
	return { runnable: false, reason: `the bin entry ${entry} is not a JavaScript file for node (${shebang ? `shebang "#!${shebang[1]}"` : 'no .js extension and no node shebang'})` };
}

/**
 * True when `output` contains `version` as a whole token: not glued to another version character
 * ("1.0.1" is not in "1.0.10", "11.0.1" or "1.0.1.2"; "v1.0.1", "1.0.1)" and "1.0.1." are fine).
 */
export function containsVersionToken(output: string, version: string): boolean {
	const esc = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return new RegExp(`(?<![0-9A-Za-z.+-])v?${esc}(?![0-9A-Za-z+-])(?!\\.[0-9A-Za-z])`).test(output);
}

/**
 * Renames, retrying a Windows lock (EPERM / EBUSY: an open file, or a process whose cwd is inside)
 * with a doubling pause until the budget is spent. EACCES and everything else fail at once: they are
 * not transient. The first attempt is synchronous: when nothing blocks, nothing yields between renames.
 */
async function renameWithRetry(
	d: StagedDeps, from: string, to: string,
): Promise<{ ok: true } | { ok: false; error: unknown; attempts: number }> {
	const deadline = d.now() + d.renameBudgetMs;
	let delay = 50;
	for (let attempts = 1; ; attempts++) {
		try {
			d.renameSync(from, to);
			return { ok: true };
		} catch (error) {
			if (!RETRYABLE.has(errorCode(error)) || d.now() + delay > deadline) {
				return { ok: false, error, attempts };
			}
		}
		await d.sleep(delay);
		delay = Math.min(delay * 2, 1000);
	}
}

function permissionMessage(dir: string, what: string, err: unknown): string {
	return `permission denied: ${what} in ${dir} (${errorCode(err)}: ${errorMessage(err)}). The user running the updater cannot modify the global npm directory. Use a user-owned npm prefix (npm config set prefix <a folder you own>) or fix the ownership of ${dir}. Closing running processes will not help`;
}

/** Why a rename failed, as an actionable sentence. */
function renameFailure(pkgName: string, from: string, to: string, f: { error: unknown; attempts: number }, budgetMs: number): string {
	const base = packageBaseName(pkgName);
	if (errorCode(f.error) === 'EACCES') {
		return permissionMessage(dirname(to), `cannot rename ${from} to ${to}`, f.error);
	}
	return `${from} could not be renamed to ${to} after ${f.attempts} attempt(s) over up to ${Math.round(budgetMs / 1000)}s (${errorCode(f.error)}: ${errorMessage(f.error)}). A running ${base} process (or a shell whose current directory is inside the package) probably holds it: close every running ${base} process, then run the update again`;
}

/** Removes `path`; a failure (Windows: a process still runs from it) is a warning, never an error. */
function removeQuietly(cfg: WithoutDaemonConfig, d: StagedDeps, path: string, what: string): boolean {
	if (!existsSync(path)) {
		return true;
	}
	try {
		d.removeDir(path);
		return true;
	} catch (err) {
		appendLog(cfg.configDir, 'warn', `${cfg.pkgName} could not delete ${what} ${path} (${errorCode(err)}: ${errorMessage(err)}); a process may still run from it. It is left in place and the next update run removes it`);
		return false;
	}
}

/** Directories of an earlier staged install that nobody needs any more. Runs with the lock held. */
function sweepLeftovers(cfg: WithoutDaemonConfig, d: StagedDeps, pkgParent: string, root: string): void {
	const base = packageBaseName(cfg.pkgName);
	const candidates: string[] = [];
	const list = (dir: string, match: (n: string) => boolean): void => {
		try {
			for (const n of readdirSync(dir)) {
				if (match(n)) {
					candidates.push(join(dir, n));
				}
			}
		} catch { /* directory absent: nothing to sweep */ }
	};
	list(pkgParent, (n) => n.startsWith(`.${base}-old-`));
	list(root, (n) => n.startsWith(`.staging-${base}-`));
	list(join(cfg.configDir, 'staging'), () => true);
	for (const p of candidates) {
		if (removeQuietly(cfg, d, p, 'leftover of an earlier staged update')) {
			appendLog(cfg.configDir, 'info', `${cfg.pkgName} removed leftover ${p}`);
		}
	}
}

/** Output of the health child kept in memory: a runaway child must not grow the updater. */
export const HEALTH_OUTPUT_CAP = 64 * 1024;

/**
 * Default health test: `<node> <staged bin> cli version` in an isolated environment (temp HOME and
 * config dirs, UPDATER_DISABLE=1 so it cannot start another update, no forced / self-check variables).
 * Passes on exit 0 with the staged version as a whole token in stdout + stderr. The child is tracked
 * (the interrupt guard stops its tree) and killed with its tree on timeout.
 */
export const defaultHealthCheck: HealthCheck = async (input: HealthCheckInput): Promise<HealthCheckResult> => {
	const home = mkdtempSync(join(tmpdir(), 'updater-health-'));
	const env: NodeJS.ProcessEnv = {
		...process.env,
		UPDATER_DISABLE: '1',
		HOME: home,
		USERPROFILE: home,
		XDG_CONFIG_HOME: join(home, '.config'),
		XDG_DATA_HOME: join(home, '.local', 'share'),
		XDG_CACHE_HOME: join(home, '.cache'),
		APPDATA: join(home, 'AppData', 'Roaming'),
		LOCALAPPDATA: join(home, 'AppData', 'Local'),
	};
	for (const k of ['UPDATER_FORCE', 'UPDATER_MANUAL', 'UPDATER_SELF_CHECK_CMD']) {
		delete env[k];
	}
	try {
		return await new Promise<HealthCheckResult>((resolve) => {
			// POSIX: own process group (like npm), so killProcessTree / stopTrackedChildren reach its children.
			const child = spawn(process.execPath, [input.entry, 'cli', 'version'], {
				cwd: home, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
			});
			const pid = child.pid;
			if (pid !== undefined) {
				trackChild(pid);
			}
			let out = '';
			let truncated = false;
			let done = false;
			const finish = (r: HealthCheckResult): void => {
				if (done) {
					return;
				}
				done = true;
				clearTimeout(timer);
				if (pid !== undefined) {
					untrackChild(pid);
				}
				resolve(r);
			};
			const collect = (c: string): void => {
				const room = HEALTH_OUTPUT_CAP - out.length;
				if (c.length > room) {
					truncated = true;
				}
				if (room > 0) {
					out += c.slice(0, room);
				}
			};
			const shown = (): string => (truncated ? `${out}\n[output truncated at ${HEALTH_OUTPUT_CAP} bytes]` : out);
			const timer = setTimeout(() => {
				if (pid !== undefined) {
					killProcessTree(pid);
				}
				child.stdout?.destroy();
				child.stderr?.destroy();
				finish({ ok: false, output: `timed out after ${input.timeoutMs}ms (process tree stopped). Output so far: ${shown()}` });
			}, input.timeoutMs);
			child.stdout?.setEncoding('utf8');
			child.stderr?.setEncoding('utf8');
			child.stdout?.on('data', collect);
			child.stderr?.on('data', collect);
			child.on('error', (err) => finish({ ok: false, output: `could not start ${input.entry}: ${err.message}` }));
			child.on('close', (code, signal) => {
				if (code !== 0) {
					return finish({ ok: false, output: `exit ${code ?? `signal ${signal}`}: ${shown()}` });
				}
				if (!containsVersionToken(out, input.version)) {
					return finish({ ok: false, output: `exit 0 but the output does not contain the staged version ${input.version} as a whole token: ${shown()}` });
				}
				finish({ ok: true, output: shown() });
			});
		});
	} finally {
		try { rmSync(home, { recursive: true, force: true }); } catch { /* temp dir, best effort */ }
	}
};

function describeChange(before: { version?: string; bin: Record<string, string> }, now: { version?: string; bin: Record<string, string> } | null): string | null {
	if (!now) {
		return 'its package.json is gone or unreadable';
	}
	if (now.version !== before.version) {
		return `its version changed from ${before.version} to ${now.version}`;
	}
	if (!sameBin(before.bin, now.bin)) {
		return `its bin entries changed (${JSON.stringify(before.bin)} -> ${JSON.stringify(now.bin)})`;
	}
	return null;
}

/** A symlink / junction is an `npm link` dev install: renaming it would move the link, not the code. */
function symlinkProblem(pkgDir: string): string | null {
	try {
		if (lstatSync(pkgDir).isSymbolicLink()) {
			return `the global package ${pkgDir} is a symlink (npm link): update it manually`;
		}
	} catch { /* absent: the caller's manifest read reports it */ }
	return null;
}

/**
 * Installs `version` next to the live global install and switches to it. The journal must already
 * be in status 'applying'. See StagedResult for what each outcome means for the global install.
 */
export async function stagedInstall(cfg: WithoutDaemonConfig, version: string): Promise<StagedResult> {
	const { pkgName, configDir } = cfg;
	const d = resolveDeps(cfg);
	const file = stateFilePath(configDir);
	const spec = `${pkgName}@${version}`;
	const base = packageBaseName(pkgName);

	let root: string;
	try {
		root = d.globalRoot();
	} catch (err) {
		return { kind: 'fallback', reason: `cannot resolve the npm global root: ${errorMessage(err)}` };
	}
	const pkgDir = join(root, ...pkgName.split('/'));
	const pkgParent = dirname(pkgDir);
	const link = symlinkProblem(pkgDir);
	if (link) {
		return { kind: 'failed', why: `${link}. Nothing was changed` };
	}
	const oldManifest = readManifest(pkgDir);
	if (!oldManifest) {
		return { kind: 'fallback', reason: `${pkgName} is not installed globally in ${root}: nothing to swap` };
	}
	const oldBin = normalizeBin(oldManifest, pkgName);
	const oldPlan = planBin(pkgDir, oldBin, pkgName);
	if (!oldPlan.runnable) {
		return { kind: 'fallback', reason: `${oldPlan.reason}: there is no CLI that can be health-tested before the switch` };
	}
	const before = { version: oldManifest.version, bin: oldBin };

	// Fail early, before any download, when the user cannot rename inside the global directory.
	try {
		d.probeWritable(pkgParent);
	} catch (err) {
		const why = PERMISSION_CODES.has(errorCode(err))
			? permissionMessage(pkgParent, 'cannot create or delete entries', err)
			: `${pkgParent} is not writable (${errorCode(err)}: ${errorMessage(err)}); the update needs to rename the package directory there`;
		return { kind: 'failed', why: `${why}. Nothing was downloaded or changed` };
	}

	sweepLeftovers(cfg, d, pkgParent, root);

	// Stage on the volume of the global root, else a rename would be a copy (not atomic, slow).
	const stamp = new Date(d.now()).toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
	const id = `${stamp}-${process.pid}`;
	const inConfig = join(configDir, 'staging', id);
	const inRoot = join(root, `.staging-${base}-${id}`);
	let stage: string;
	try {
		mkdirSync(dirname(inConfig), { recursive: true });
		if (d.sameVolume(dirname(inConfig), pkgParent)) {
			stage = inConfig;
		} else {
			appendLog(configDir, 'info', `${pkgName} ${inConfig} is on another volume than ${pkgParent}, staging next to the global packages instead`);
			mkdirSync(root, { recursive: true });
			if (!d.sameVolume(root, pkgParent)) {
				throw new Error('same volume check failed for the global root too');
			}
			stage = inRoot;
		}
	} catch (err) {
		return { kind: 'failed', why: `cannot stage the update on the volume of ${pkgParent}: neither ${inConfig} nor ${inRoot} can be used (${errorMessage(err)}). A directory rename across volumes is not atomic, so the update is not applied. Nothing was changed; make ${configDir} or ${root} writable on that volume and run the update again` };
	}

	const cleanStage = (): void => {
		removeQuietly(cfg, d, stage, 'stage');
	};
	// 'none': nothing of the global dir touched; 'aside': between the two renames; 'swapped': both done.
	let swap: 'none' | 'aside' | 'swapped' = 'none';
	const oldDir = join(pkgParent, `.${base}-old-${stamp}-${process.pid}`);

	try {
		journalApplying(file, { phase: 'staging', stagePath: stage, packageDirPath: pkgDir });
		mkdirSync(stage, { recursive: true });
		appendLog(configDir, 'info', `${pkgName} installing ${version} into the staging prefix ${stage} (the installed version keeps working meanwhile)`);
		try {
			await installGlobal(cfg, spec, { prefix: stage });
		} catch (err) {
			cleanStage();
			return { kind: 'failed', why: `install of ${version} into the staging prefix failed (the installed version was not touched): ${errorMessage(err)}` };
		}

		let stagedPkg: string;
		try {
			stagedPkg = join(d.globalRoot(stage), ...pkgName.split('/'));
		} catch (err) {
			cleanStage();
			return { kind: 'failed', why: `cannot locate the staged package: ${errorMessage(err)}` };
		}
		const stagedManifest = readManifest(stagedPkg);
		if (!stagedManifest || stagedManifest.version !== version) {
			cleanStage();
			return { kind: 'failed', why: `the staged install is not ${spec} (${stagedManifest ? `package.json says ${String(stagedManifest.version)}` : `${join(stagedPkg, 'package.json')} is missing or unreadable`}); the installed version was not touched` };
		}
		const newBin = normalizeBin(stagedManifest, pkgName);
		if (!sameBin(oldBin, newBin)) {
			cleanStage();
			return { kind: 'fallback', reason: `the "bin" entries changed (installed: ${JSON.stringify(oldBin)}, ${version}: ${JSON.stringify(newBin)}); the global shims point into the package dir by path, so only npm can regenerate them` };
		}
		const newPlan = planBin(stagedPkg, newBin, pkgName);
		if (!newPlan.runnable) {
			cleanStage();
			return { kind: 'fallback', reason: `${newPlan.reason}: ${version} cannot be health-tested before the switch` };
		}

		journalApplying(file, { phase: 'staged' });
		const healthInput: HealthCheckInput = {
			pkgName, version, packageDir: stagedPkg, entry: newPlan.entry, configDir,
			timeoutMs: cfg.healthCheckTimeoutMs ?? 15_000,
		};
		let health: HealthCheckResult;
		try {
			health = await (cfg.healthCheck ?? defaultHealthCheck)(healthInput);
		} catch (err) {
			health = { ok: false, output: `the health check threw: ${errorMessage(err)}` };
		}
		if (!health.ok) {
			cleanStage();
			return { kind: 'failed', why: `staged ${version} failed its health test (\`${base} cli version\`), nothing was switched: ${redactSecrets(health.output)}` };
		}
		appendLog(configDir, 'info', `${pkgName} staged ${version} passed its health test`);

		// --- the swap: journal, re-check what is about to be moved, then two back-to-back renames ---
		journalApplying(file, { phase: 'swapping', oldDirPath: oldDir });
		const linkNow = symlinkProblem(pkgDir);
		if (linkNow) {
			cleanStage();
			return { kind: 'failed', why: `${linkNow}. It was replaced while the update was staged; nothing was switched` };
		}
		const changed = describeChange(before, (() => {
			const m = readManifest(pkgDir);
			return m ? { version: m.version, bin: normalizeBin(m, pkgName) } : null;
		})());
		if (changed) {
			cleanStage();
			return { kind: 'failed', why: `the installed ${pkgName} changed while ${version} was staged (${changed}); someone probably ran npm install -g meanwhile. Nothing was switched; the next check retries` };
		}
		const first = await renameWithRetry(d, pkgDir, oldDir);
		if (!first.ok) {
			cleanStage();
			return { kind: 'failed', why: `${renameFailure(pkgName, pkgDir, oldDir, first, d.renameBudgetMs)}. Nothing was changed` };
		}
		swap = 'aside';
		d.betweenRenames();
		const second = await renameWithRetry(d, stagedPkg, pkgDir);
		if (!second.ok) {
			const back = await renameWithRetry(d, oldDir, pkgDir);
			if (!back.ok) {
				return { kind: 'half-state', why: `moving the staged ${version} into ${pkgDir} failed (${errorCode(second.error)}: ${errorMessage(second.error)}) AND putting the previous version back from ${oldDir} failed (${errorCode(back.error)}: ${errorMessage(back.error)}). The CLI is MISSING. Fix by hand: rename ${oldDir} to ${pkgDir}; the next updater run also tries it` };
			}
			swap = 'none';
			cleanStage();
			return { kind: 'failed', why: `${renameFailure(pkgName, stagedPkg, pkgDir, second, d.renameBudgetMs)}. The previous version was put back, nothing changed` };
		}
		swap = 'swapped';
		cleanStage();
		const handle = makeHandle(cfg, d, { pkgDir, oldDir, stamp });
		try {
			journalApplying(file, { phase: 'swapped' });
		} catch (err) {
			const undone = await handle.rollback();
			return undone.ok
				? { kind: 'failed', why: `the swap could not be journaled (${errorMessage(err)}); the previous version was put back` }
				: { kind: 'half-state', why: `the swap could not be journaled (${errorMessage(err)}) and could not be undone: ${undone.error}` };
		}
		appendLog(configDir, 'info', `${pkgName} ${version} is in place at ${pkgDir}; the previous version is kept at ${oldDir} until the post-checks pass`);
		return { kind: 'swapped', handle };
	} catch (err) {
		// A journal write that failed (nothing was touched yet) or an unexpected error: say where things stand.
		if (swap === 'none') {
			cleanStage();
			return { kind: 'failed', why: `${errorMessage(err)}; nothing was switched` };
		}
		if (swap === 'aside') {
			try {
				d.renameSync(oldDir, pkgDir);
				cleanStage();
				return { kind: 'failed', why: `${errorMessage(err)}; the previous version was put back` };
			} catch (e2) {
				return { kind: 'half-state', why: `${errorMessage(err)}; and putting the previous version back from ${oldDir} failed (${errorMessage(e2)}). The CLI is MISSING. Fix by hand: rename ${oldDir} to ${pkgDir}` };
			}
		}
		throw err;
	}
}

function makeHandle(cfg: WithoutDaemonConfig, d: StagedDeps, p: { pkgDir: string; oldDir: string; stamp: string }): SwapHandle {
	let finished = false;
	return {
		commit: () => {
			if (finished) {
				return;
			}
			finished = true;
			removeQuietly(cfg, d, p.oldDir, 'previous package dir');
		},
		rollback: async () => {
			if (finished) {
				return { ok: false, error: 'the swap was already committed or rolled back' };
			}
			finished = true;
			return restoreOld(cfg, d, p.pkgDir, p.oldDir, `rb-${p.stamp}`);
		},
	};
}

/**
 * Puts `oldDir` back at `pkgDir`: the dir now there is moved aside first, then the old one renamed in
 * (two back-to-back renames, no network, no npm). The dir moved aside is deleted.
 */
async function restoreOld(cfg: WithoutDaemonConfig, d: StagedDeps, pkgDir: string, oldDir: string, tag: string): Promise<{ ok: true } | { ok: false; error: string }> {
	const failedDir = join(dirname(pkgDir), `.${packageBaseName(cfg.pkgName)}-old-${tag}-${process.pid}`);
	if (existsSync(pkgDir)) {
		const away = await renameWithRetry(d, pkgDir, failedDir);
		if (!away.ok) {
			return { ok: false, error: renameFailure(cfg.pkgName, pkgDir, failedDir, away, d.renameBudgetMs) };
		}
	}
	const back = await renameWithRetry(d, oldDir, pkgDir);
	if (!back.ok) {
		if (existsSync(failedDir)) {
			await renameWithRetry(d, failedDir, pkgDir);
		}
		return { ok: false, error: renameFailure(cfg.pkgName, oldDir, pkgDir, back, d.renameBudgetMs) };
	}
	removeQuietly(cfg, d, failedDir, 'the rejected new version');
	return { ok: true };
}

/** Repair rule for a package dir that holds the target version next to the previous one aside. */
async function newDirProblem(cfg: WithoutDaemonConfig, pkgDir: string, target: string | undefined, selfCheck: () => Promise<boolean>): Promise<string | null> {
	const manifest = readManifest(pkgDir);
	if (!manifest) {
		return `${join(pkgDir, 'package.json')} is missing or unreadable`;
	}
	if (target === undefined || manifest.version !== target) {
		return `its version is ${String(manifest.version)}, the update targeted ${target ?? '?'}`;
	}
	const plan = planBin(pkgDir, normalizeBin(manifest, cfg.pkgName), cfg.pkgName);
	if (plan.runnable) {
		let health: HealthCheckResult;
		try {
			health = await (cfg.healthCheck ?? defaultHealthCheck)({
				pkgName: cfg.pkgName, version: target, packageDir: pkgDir, entry: plan.entry, configDir: cfg.configDir,
				timeoutMs: cfg.healthCheckTimeoutMs ?? 15_000,
			});
		} catch (err) {
			health = { ok: false, output: `the health check threw: ${errorMessage(err)}` };
		}
		if (!health.ok) {
			return `its health test failed: ${redactSecrets(health.output)}`;
		}
	} else {
		appendLog(cfg.configDir, 'warn', `${cfg.pkgName} the new dir cannot be health-tested (${plan.reason}); judging it by its package.json and the self-check`);
	}
	if (!(await selfCheck())) {
		return 'it fails the self-check';
	}
	return null;
}

/**
 * Repair of an 'applying' journal that carries a staged `phase` (the updater died or crashed):
 * brings the global dir back to ONE consistent version and removes what the staged install made.
 * The rule when both the new dir (in place) and the previous one (aside) exist (crash in
 * 'swapping' after both renames, or in 'swapped' before the commit): the new dir is kept, and the
 * previous one deleted, only if it is the target version, its bin passes the health test (when it
 * can be run) and the self-check passes; otherwise the previous one is renamed back. The caller then
 * verifies whatever is installed, as for any interrupted install.
 */
export async function repairStagedPhase(cfg: WithoutDaemonConfig, state: UpdateState, selfCheck: () => Promise<boolean>): Promise<void> {
	const { pkgName, configDir } = cfg;
	const d = resolveDeps(cfg);
	const { phase, stagePath, packageDirPath: pkgDir, oldDirPath: oldDir } = state;
	appendLog(configDir, 'error', `${pkgName} staged install was interrupted in phase '${phase}' (stage ${stagePath ?? '?'}, package dir ${pkgDir ?? '?'}, previous dir ${oldDir ?? '?'})`);

	if (pkgDir && oldDir && (phase === 'swapping' || phase === 'swapped')) {
		if (!existsSync(oldDir)) {
			appendLog(configDir, 'info', `${pkgName} no previous dir ${oldDir} aside: the global package dir was never moved, or the update was committed`);
		} else if (!existsSync(pkgDir)) {
			const back = await renameWithRetry(d, oldDir, pkgDir);
			if (back.ok) {
				appendLog(configDir, 'warn', `${pkgName} restored the previous version: ${oldDir} renamed back to ${pkgDir}`);
			} else {
				appendLog(configDir, 'error', `${pkgName} could not rename ${oldDir} back to ${pkgDir} (${errorCode(back.error)}: ${errorMessage(back.error)}); the generic repair reinstalls the previous version`);
			}
		} else {
			const problem = await newDirProblem(cfg, pkgDir, state.targetVersion, selfCheck);
			if (problem === null) {
				if (removeQuietly(cfg, d, oldDir, 'previous package dir')) {
					appendLog(configDir, 'info', `${pkgName} the swap to ${state.targetVersion} had completed and the new version is healthy: removed ${oldDir}`);
				}
			} else {
				appendLog(configDir, 'warn', `${pkgName} the new ${pkgDir} is not trusted (${problem}): putting the previous version back from ${oldDir}`);
				const r = await restoreOld(cfg, d, pkgDir, oldDir, `repair-${new Date(d.now()).toISOString().replace(/\D/g, '').slice(0, 14)}`);
				appendLog(configDir, r.ok ? 'warn' : 'error', r.ok ? `${pkgName} restored the previous version at ${pkgDir}` : `${pkgName} could not restore the previous version: ${r.error}; the generic repair reinstalls it`);
			}
		}
	}
	if (stagePath && existsSync(stagePath) && removeQuietly(cfg, d, stagePath, 'stage')) {
		appendLog(configDir, 'info', `${pkgName} removed the stage ${stagePath}`);
	}
}
