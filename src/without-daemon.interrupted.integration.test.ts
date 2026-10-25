/**
 * Reproduces the incident: the updater process is killed while `npm install -g` is in flight.
 *
 * A real updater runs as a child process (built dist/), against MockRegistry and a temp npm
 * prefix. The registry stalls the 2.0.0 tarball so the kill lands mid-install; no handler can run
 * (hard kill), so only the persisted 'applying' state lets the next run repair.
 *
 * The second test covers the orphaned npm: the next run reads its pid from the journal, stops its
 * process tree and only then repairs.
 *
 * Requires `npm run build` first: the child loads dist/index.js and this test throws if it is missing.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MockRegistry } from './MockRegistry.js';
import { runUpdater, verifyInstalled, execNpm, isProcessRunning, killProcessTree } from './index.js';

const DIST_INDEX = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const PKG = '@test/my-cli';

let registry: MockRegistry;
let configDir: string;
let npmPrefix: string;
let scriptDir: string;

function setEnv(r: MockRegistry): void {
	process.env['npm_config_registry'] = r.url;
	process.env['npm_config_prefix'] = npmPrefix;
	process.env['npm_config_cache'] = join(npmPrefix, '.npm-cache');
	process.env['npm_config_fetch_retries'] = '0';
	process.env['npm_config_fetch_retry_mintimeout'] = '0';
}

/** Rejects with an explicit message instead of letting vitest report a silent timeout. */
function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: NodeJS.Timeout;
	const t = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms: ${what}`)), ms); });
	return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

let childPid: number | undefined;
/** pid of the npm (sh on POSIX) the updater child journaled; reaped in afterEach whatever happened. */
let npmPid: number | undefined;

/**
 * POSIX: the updater child runs in its own process group; kills that group. The npm it spawned
 * leads a group of its own (reaped through npmPid), so this alone never reaches it.
 */
function killGroup(): void {
	if (process.platform === 'win32' || childPid === undefined) return;
	try { process.kill(-childPid, 'SIGKILL'); } catch { /* ESRCH: group already gone */ }
}

function waitFor(cond: () => boolean, what: string, ms = 40_000): Promise<void> {
	return new Promise((resolve, reject) => {
		const t0 = Date.now();
		const tick = (): void => {
			if (cond()) return resolve();
			if (Date.now() - t0 > ms) return reject(new Error(`timed out waiting for ${what}`));
			setTimeout(tick, 100);
		};
		tick();
	});
}

/** POSIX: true while any process of the group led by `pid` exists (a stray grandchild shows up here). */
function groupAlive(pid: number): boolean {
	if (process.platform === 'win32') return isProcessRunning(pid);
	try { process.kill(-pid, 0); return true; } catch { return false; }
}

function updaterLog(): string {
	try { return readFileSync(join(configDir, 'logs', `${new Date().toISOString().slice(0, 10)}.ndjson`), 'utf8'); } catch { return '(no log)'; }
}

function applyingState(): Record<string, unknown> | null {
	try {
		const s = JSON.parse(readFileSync(join(configDir, 'update-state.json'), 'utf8'));
		return s.status === 'applying' ? s : null;
	} catch { return null; }
}

beforeAll(() => {
	if (!existsSync(DIST_INDEX)) throw new Error(`${DIST_INDEX} is missing: run "npm run build" before the integration tests`);
});

beforeEach(async () => {
	registry = new MockRegistry();
	await registry.start();
	configDir = mkdtempSync(join(tmpdir(), 'updater-int-cfg-'));
	npmPrefix = mkdtempSync(join(tmpdir(), 'updater-int-prefix-'));
	scriptDir = mkdtempSync(join(tmpdir(), 'updater-int-script-'));
	setEnv(registry);
	delete process.env['UPDATER_SELF_CHECK_CMD'];
	delete process.env['UPDATER_FORCE'];
});

afterEach(async () => {
	// npm is spawned detached (its own group), so killing the updater's group never reaches it.
	if (npmPid !== undefined && isProcessRunning(npmPid)) killProcessTree(npmPid);
	npmPid = undefined;
	killGroup();
	childPid = undefined;
	await within(registry.stop(), 15_000, 'MockRegistry.stop()');
	for (const k of ['npm_config_registry', 'npm_config_prefix', 'npm_config_cache', 'npm_config_fetch_retries', 'npm_config_fetch_retry_mintimeout']) delete process.env[k];
	for (const d of [configDir, npmPrefix, scriptDir]) rmSync(d, { recursive: true, force: true });
});


describe('updater killed mid-install', () => {
	it('the next run stops the orphaned npm, repairs, and leaves the previous version intact with no stray process', { timeout: 150_000 }, async () => {
		// 1. Machine state: 1.0.0 installed globally in the temp prefix.
		registry.setLatestVersion(PKG, '1.0.0', 'old');
		registry.setLatestVersion(PKG, '2.0.0');
		execNpm(['install', '-g', `${PKG}@1.0.0`], { timeout: 90_000 });
		expect(verifyInstalled(PKG, '1.0.0').ok).toBe(true);

		// 2. A real updater starts the 2.0.0 install; the registry never answers the tarball request.
		registry.setHangTarball(PKG, '2.0.0');
		const childScript = join(scriptDir, 'run-updater.mjs');
		writeFileSync(childScript, `
import { runUpdater } from ${JSON.stringify(pathToFileURL(DIST_INDEX).href)};
await runUpdater({ pkgName: ${JSON.stringify(PKG)}, configDir: ${JSON.stringify(configDir)}, currentVersion: '1.0.0', strategy: 'without-daemon' });
`);
		const child = spawn(process.execPath, [childScript], {
			stdio: 'ignore', env: process.env, detached: process.platform !== 'win32',
		});
		childPid = child.pid;
		const exited = new Promise<void>((r) => child.on('exit', () => r()));
		await waitFor(() => typeof applyingState()?.['npmPid'] === 'number', "the updater child to journal its npm pid in the 'applying' state");
		const journal = applyingState()!;
		npmPid = journal['npmPid'] as number;
		expect(npmPid).not.toBe(child.pid);
		expect(journal['npmStartedAt']).toBeGreaterThan(Date.now() - 120_000);
		expect(isProcessRunning(npmPid)).toBe(true);
		// give npm time to open the stalled tarball request
		await new Promise((r) => setTimeout(r, 3_000));

		// 3. Hard kill of the updater only: no handler runs, npm is orphaned and keeps the request open.
		child.kill('SIGKILL');
		await within(exited, 10_000, 'the killed updater to exit');
		// Windows: libuv puts non-detached children in a kill-on-close job object, so npm dies WITH
		// the updater (observed) and there is no orphan to reproduce; the repair then finds it gone.
		// POSIX: npm has its own process group and must survive the SIGKILL.
		const orphaned = isProcessRunning(npmPid);
		if (!orphaned && process.platform !== 'win32') {
			throw new Error(`precondition failed: npm pid ${npmPid} died together with the updater, so the orphan scenario was not reproduced. Updater log:
${updaterLog()}`);
		}

		// 4. What npm had already done when it died: the old package removed.
		rmSync(join(process.platform === 'win32' ? npmPrefix : join(npmPrefix, 'lib'), 'node_modules', '@test', 'my-cli'), { recursive: true, force: true });
		expect(verifyInstalled(PKG).ok).toBe(false);
		expect(applyingState()).not.toBeNull();

		// 5. The next run (registry still up, 2.0.0 tarball still stalled) must stop the orphan, then repair.
		await within(
			runUpdater({ pkgName: PKG, configDir, currentVersion: '1.0.0', strategy: 'without-daemon', orphanNpmWaitMs: 1_500 }),
			90_000, 'the repair run',
		);

		await waitFor(() => !groupAlive(npmPid!), `the orphaned npm (pid ${npmPid}) and its process group to be gone`, 10_000);
		expect(isProcessRunning(npmPid)).toBe(false);
		expect(verifyInstalled(PKG).installedVersion).toBe('1.0.0');
		const state = JSON.parse(readFileSync(join(configDir, 'update-state.json'), 'utf8'));
		expect(state.status).toBe('rolled-back');
		expect(state.npmPid).toBeUndefined();
		expect(existsSync(join(configDir, 'update.lock'))).toBe(false);
		const log = readFileSync(join(configDir, 'logs', `${new Date().toISOString().slice(0, 10)}.ndjson`), 'utf8');
		if (orphaned) {
			expect(log).toContain('orphaned by the interrupted updater is still running');
			expect(log).toContain('STOPPING its process tree');
		} else {
			expect(log).toContain('no longer running');
		}
		expect(log).toContain('repaired');
	});

	it('is repaired by the next run: previous version reinstalled, state finalised, lock taken over', { timeout: 100_000 }, async () => {
		// 1. Machine state: 1.0.0 installed globally in the temp prefix.
		registry.setLatestVersion(PKG, '1.0.0', 'old');
		registry.setLatestVersion(PKG, '2.0.0');
		execNpm(['install', '-g', `${PKG}@1.0.0`], { timeout: 90_000 });
		expect(verifyInstalled(PKG, '1.0.0').ok).toBe(true);

		// 2. A real updater process starts the 2.0.0 install; the tarball download stalls.
		registry.setHangTarball(PKG, '2.0.0');
		const childScript = join(scriptDir, 'run-updater.mjs');
		writeFileSync(childScript, `
import { runUpdater } from ${JSON.stringify(pathToFileURL(DIST_INDEX).href)};
await runUpdater({ pkgName: ${JSON.stringify(PKG)}, configDir: ${JSON.stringify(configDir)}, currentVersion: '1.0.0', strategy: 'without-daemon' });
`);
		const child = spawn(process.execPath, [childScript], {
			stdio: 'ignore', env: process.env, detached: process.platform !== 'win32',
		});
		childPid = child.pid;
		const exited = new Promise<void>((r) => child.on('exit', () => r()));
		await waitFor(() => applyingState() !== null, "the child to persist an 'applying' state");
		const applying = applyingState()!;
		expect(applying).toMatchObject({ previousVersion: '1.0.0', targetVersion: '2.0.0', pid: child.pid });
		// give npm time to open the stalled tarball request
		await new Promise((r) => setTimeout(r, 3_000));
		npmPid = applyingState()?.['npmPid'] as number | undefined;

		// 3. Hard kill of the updater process only (no handler can run). Its npm child survives as
		// an orphan, exactly as in production, and keeps the stalled request open.
		child.kill('SIGKILL');
		await within(exited, 10_000, 'the killed updater to exit');
		// The registry must shut down even with that request still open, then the orphan is reaped
		// (POSIX: whole group; Windows: it fails once the server is gone) so it cannot finish the
		// install behind the repair's back.
		await within(registry.stop(), 15_000, 'MockRegistry.stop() with a stalled request open');
		killGroup();
		await new Promise((r) => setTimeout(r, 2_000));

		// 4. Simulate what npm had already done when it died: the old package removed.
		rmSync(join(process.platform === 'win32' ? npmPrefix : join(npmPrefix, 'lib'), 'node_modules', '@test', 'my-cli'), { recursive: true, force: true });
		expect(verifyInstalled(PKG).ok).toBe(false);
		expect(existsSync(join(configDir, 'update.lock'))).toBe(true);
		expect(applyingState()).not.toBeNull();

		// 5. A healthy registry is back; the next run must repair, not just retry the update.
		registry = new MockRegistry();
		await registry.start();
		registry.setLatestVersion(PKG, '1.0.0', 'old');
		registry.setLatestVersion(PKG, '2.0.0');
		setEnv(registry);

		await runUpdater({ pkgName: PKG, configDir, currentVersion: '1.0.0', strategy: 'without-daemon' });

		const check = verifyInstalled(PKG);
		expect(check.installedVersion).toBe('1.0.0');
		const state = JSON.parse(readFileSync(join(configDir, 'update-state.json'), 'utf8'));
		expect(state.status).toBe('rolled-back');
		expect(state.previousVersion).toBe('1.0.0');
		expect(state.targetVersion).toBe('2.0.0');
		expect(existsSync(join(configDir, 'update.lock'))).toBe(false);
		const log = readFileSync(join(configDir, 'logs', `${new Date().toISOString().slice(0, 10)}.ndjson`), 'utf8');
		expect(log).toContain('was interrupted');
		expect(log).toContain('repaired');
	});
});
