/**
 * Staged install: real npm, MockRegistry, temp npm prefix, temp config dir. Nothing touches the
 * machine's global prefix (npm_config_prefix points at a temp dir for the whole file).
 *
 * The mock package has a `bin` (answering `cli version`) and an optionalDependency, like the
 * real CLIs with their platform package, so the layout findings are checked on real installs.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { MockRegistry } from './MockRegistry.js';
import { runUpdater, execNpm, verifyInstalled, writeState, stateFilePath } from './index.js';
import { stopTrackedChildren } from './shared/process.js';
import { defaultHealthCheck, stagedInstall, HEALTH_OUTPUT_CAP } from './shared/staged.js';
import type { StagedDeps } from './shared/staged.js';

const PKG = '@test/my-cli';
const PLATFORM_PKG = '@test/my-cli-plat';
const registry = new MockRegistry();

const CLI_SCRIPT = `#!/usr/bin/env node
const a = process.argv.slice(2);
if (a[0] === 'cli' && a[1] === 'version') {
	console.log('my-cli {version} disable=' + process.env.UPDATER_DISABLE + ' force=' + process.env.UPDATER_FORCE + ' selfcheck=' + process.env.UPDATER_SELF_CHECK_CMD + ' home=' + process.env.HOME + ' userprofile=' + process.env.USERPROFILE);
	process.exit(0);
}
process.exit(2);
`;

function setContent(opts: { bin?: Record<string, string>; script?: string } = {}): void {
	registry.setPackageContent(PKG, {
		manifest: { bin: opts.bin ?? { 'my-cli': 'bin/cli.js' }, optionalDependencies: { [PLATFORM_PKG]: '1.0.0' } },
		files: { 'bin/cli.js': opts.script ?? CLI_SCRIPT },
	});
}

let configDir: string;
let npmPrefix: string;

beforeAll(async () => { await registry.start(); });
afterAll(async () => { await registry.stop(); });

beforeEach(() => {
	registry.clear();
	configDir = mkdtempSync(join(tmpdir(), 'staged-cfg-'));
	npmPrefix = mkdtempSync(join(tmpdir(), 'staged-prefix-'));
	process.env['npm_config_registry'] = registry.url;
	process.env['npm_config_prefix'] = npmPrefix;
	process.env['npm_config_cache'] = join(npmPrefix, '.npm-cache');
	process.env['npm_config_fetch_retries'] = '0';
	process.env['npm_config_fetch_retry_mintimeout'] = '0';
	delete process.env['UPDATER_SELF_CHECK_CMD'];
	delete process.env['UPDATER_FORCE'];
	delete process.env['UPDATER_DISABLE'];
});
afterEach(() => {
	for (const k of ['npm_config_registry', 'npm_config_prefix', 'npm_config_cache', 'npm_config_fetch_retries', 'npm_config_fetch_retry_mintimeout', 'UPDATER_SELF_CHECK_CMD', 'UPDATER_FORCE', 'UPDATER_DISABLE']) delete process.env[k];
	rmSync(configDir, { recursive: true, force: true });
	rmSync(npmPrefix, { recursive: true, force: true });
});

/** 1.0.0 installed globally (real npm into the temp prefix); the registry then offers 2.0.0 (1.0.0 stays under 'old'). */
function installOld(): void {
	registry.setLatestVersion(PKG, '1.0.0');
	registry.setLatestVersion(PLATFORM_PKG, '1.0.0');
	execNpm(['install', '-g', `${PKG}@1.0.0`], { timeout: 90_000 });
	registry.setLatestVersion(PKG, '1.0.0', 'old');
	registry.setLatestVersion(PKG, '2.0.0');
	expect(verifyInstalled(PKG, '1.0.0').ok).toBe(true);
}

const pkgDir = (): string => verifyInstalled(PKG).packageDir!;
const installedVersion = (): string | null => verifyInstalled(PKG).installedVersion;
const log = (): string => {
	const f = join(configDir, 'logs', `${new Date().toISOString().slice(0, 10)}.ndjson`);
	return existsSync(f) ? readFileSync(f, 'utf8') : '(no log)';
};
const state = (): Record<string, unknown> => JSON.parse(readFileSync(stateFilePath(configDir), 'utf8'));
const asideDirs = (): string[] => readdirSync(dirname(pkgDir())).filter((n) => n.startsWith('.my-cli-'));
const stages = (): string[] => (existsSync(join(configDir, 'staging')) ? readdirSync(join(configDir, 'staging')) : []);
const update = (extra: Record<string, unknown> = {}, current = '1.0.0'): Promise<void> =>
	runUpdater({ pkgName: PKG, configDir, currentVersion: current, strategy: 'without-daemon', ...extra } as never);
const cliVersion = (): string => spawnSync(process.execPath, [join(pkgDir(), 'bin', 'cli.js'), 'cli', 'version'], { encoding: 'utf8' }).stdout;

describe('staged install: happy path', () => {
	it('installs next to the live package, swaps it in, keeps the nested platform package, removes old dir and stage', { timeout: 90_000 }, async () => {
		setContent();
		installOld();
		const seen: Record<string, unknown>[] = [];
		const dir = pkgDir();
		await update({
			stagedDeps: {
				betweenRenames: () => {
					seen.push({ ...state(), oldExists: readdirSync(dirname(dir)).some((n) => n.startsWith('.my-cli-old-')), newInPlace: existsSync(dir) });
				},
			},
		});

		expect(installedVersion()).toBe('2.0.0');
		expect(cliVersion()).toContain('my-cli 2.0.0');
		// Finding: the platform package of a global install is NESTED in the package dir (so it moves with it).
		expect(existsSync(join(dir, 'node_modules', '@test', 'my-cli-plat', 'package.json'))).toBe(true);
		// the only moment the global package is absent: old aside, new not yet in place, journal says 'swapping'
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({ status: 'applying', phase: 'swapping', oldExists: true, newInPlace: false, packageDirPath: dir });
		expect(String(seen[0]!['stagePath'])).toContain(join(configDir, 'staging'));
		expect(String(seen[0]!['oldDirPath'])).toContain('.my-cli-old-');
		expect(asideDirs()).toEqual([]);
		expect(stages()).toEqual([]);
		const s = state();
		expect(s).toMatchObject({ status: 'success', targetVersion: '2.0.0', previousVersion: '1.0.0' });
		expect(s['phase']).toBeUndefined();
		expect(s['stagePath']).toBeUndefined();
		expect(log()).toContain('passed its health test');
		expect(existsSync(join(configDir, 'update.lock'))).toBe(false);
	});

	it('a reader polling the global package every millisecond never sees it missing (single process: the swap is two synchronous renames)', { timeout: 90_000 }, async () => {
		setContent();
		installOld();
		const manifest = join(pkgDir(), 'package.json');
		const observed: Array<string | null> = [];
		let stop = false;
		const poll = (): void => {
			if (stop) return;
			try { observed.push(JSON.parse(readFileSync(manifest, 'utf8')).version); } catch { observed.push(null); }
			setTimeout(poll, 1);
		};
		poll();
		await update();
		// the swap and the end of the run are synchronous: give the reader one turn to see the result
		await new Promise((r) => setTimeout(r, 30));
		stop = true;

		expect(observed.filter((v) => v === null)).toEqual([]);
		expect(new Set(observed)).toEqual(new Set(['1.0.0', '2.0.0']));
		expect(observed.length).toBeGreaterThan(20);
	});

	it('runs the health test isolated: UPDATER_DISABLE=1, no force / self-check variable, temp HOME', { timeout: 90_000 }, async () => {
		setContent();
		installOld();
		process.env['UPDATER_FORCE'] = '1';
		process.env['UPDATER_SELF_CHECK_CMD'] = 'node -e 0';
		let output = '';
		await update({
			healthCheck: async (i: Parameters<typeof defaultHealthCheck>[0]) => {
				const r = await defaultHealthCheck(i);
				output = r.output;
				return r;
			},
		});
		expect(installedVersion()).toBe('2.0.0');
		expect(output).toContain('my-cli 2.0.0');
		expect(output).toContain('disable=1');
		expect(output).toContain('force=undefined');
		expect(output).toContain('selfcheck=undefined');
		// HOME and USERPROFILE point at a fresh temp dir (the user's own is a prefix of tmpdir here)
		const homes = [...output.matchAll(/(?:home|userprofile)=([^\s]+)/g)].map((m) => m[1]!);
		expect(homes).toHaveLength(2);
		for (const h of homes) expect(h.startsWith(join(tmpdir(), 'updater-health-'))).toBe(true);
	});

	it('sweeps leftovers of an earlier staged update at the start of the next one', { timeout: 90_000 }, async () => {
		setContent();
		installOld();
		const leftoverOld = join(dirname(pkgDir()), '.my-cli-old-20200101000000-1');
		const leftoverStage = join(configDir, 'staging', 'stale-stage');
		mkdirSync(leftoverOld, { recursive: true });
		mkdirSync(leftoverStage, { recursive: true });
		writeFileSync(join(leftoverStage, 'x'), 'x');
		await update();
		expect(existsSync(leftoverOld)).toBe(false);
		expect(existsSync(leftoverStage)).toBe(false);
		expect(log()).toContain('removed leftover');
	});

	it('keeps an old dir it cannot delete (a process still runs from it), warns, and the next run removes it', { timeout: 120_000 }, async () => {
		setContent();
		installOld();
		let failDeletes = true;
		await update({
			stagedDeps: {
				removeDir: (p: string) => {
					if (failDeletes && p.includes('.my-cli-old-')) throw Object.assign(new Error('in use'), { code: 'EBUSY' });
					rmSync(p, { recursive: true, force: true });
				},
			},
		});
		expect(installedVersion()).toBe('2.0.0');
		expect(state()['status']).toBe('success');
		expect(asideDirs()).toHaveLength(1);
		expect(log()).toContain('could not delete previous package dir');

		failDeletes = false;
		registry.setLatestVersion(PKG, '3.0.0');
		await update({ skipThrottle: true }, '2.0.0');
		expect(installedVersion()).toBe('3.0.0');
		expect(asideDirs()).toEqual([]);
	});
});

describe('staged install: nothing is switched when the stage is not good', () => {
	it('health test fails: global untouched, stage removed, journal failed with the (redacted) output, next check retries', { timeout: 90_000 }, async () => {
		setContent();
		installOld();
		setContent({ script: `console.error('boom ghp_abcdefghijklmnop1234 Bearer abc.def-ghi'); process.exit(1);` });
		await update();

		expect(installedVersion()).toBe('1.0.0');
		expect(asideDirs()).toEqual([]);
		expect(stages()).toEqual([]);
		const s = state();
		expect(s['status']).toBe('failed');
		expect(String(s['error'])).toContain('failed its health test');
		expect(String(s['error'])).toContain('nothing was switched');
		expect(String(s['error'])).toContain('boom');
		expect(String(s['error'])).not.toContain('ghp_abcdefghijklmnop1234');
		expect(String(s['error'])).not.toContain('abc.def-ghi');
		expect(existsSync(join(configDir, 'update.lock'))).toBe(false);
	});

	it('health test answers exit 0 without the staged version: refused', { timeout: 90_000 }, async () => {
		setContent();
		installOld();
		setContent({ script: `console.log('my-cli 9.9.9');` });
		await update();
		expect(installedVersion()).toBe('1.0.0');
		expect(String(state()['error'])).toContain('does not contain the staged version 2.0.0');
	});

	it('health test hangs: timeout aborts, process tree stopped, nothing switched', { timeout: 90_000 }, async () => {
		setContent();
		installOld();
		setContent({ script: `setInterval(() => {}, 1000);` });
		const t0 = Date.now();
		await update({ healthCheckTimeoutMs: 1500 });
		expect(Date.now() - t0).toBeLessThan(60_000);
		expect(installedVersion()).toBe('1.0.0');
		expect(String(state()['error'])).toContain('timed out after 1500ms');
		expect(stages()).toEqual([]);
	});

	it('an injected health check that throws aborts too', { timeout: 90_000 }, async () => {
		setContent();
		installOld();
		await update({ healthCheck: async () => { throw new Error('no network for the check'); } });
		expect(installedVersion()).toBe('1.0.0');
		expect(String(state()['error'])).toContain('no network for the check');
	});

	it('npm cannot install the stage (registry error): global untouched, no restore needed, journal failed', { timeout: 90_000 }, async () => {
		setContent();
		installOld();
		registry.setInstallError(PKG, true);
		await update();
		expect(installedVersion()).toBe('1.0.0');
		expect(String(state()['error'])).toContain('into the staging prefix failed');
		expect(stages()).toEqual([]);
	});
});

describe('staged install: the two renames', () => {
	/** A clock the injected sleep advances, so a 10 s retry budget costs no real time. */
	function fakeClock(): Pick<StagedDeps, 'now' | 'sleep'> & { sleeps: number[] } {
		let t = 1_000_000;
		const sleeps: number[] = [];
		return { now: () => t, sleep: async (ms: number) => { sleeps.push(ms); t += ms; }, sleeps };
	}
	const eperm = (): Error => Object.assign(new Error('operation not permitted'), { code: 'EPERM' });

	it('first rename blocked for good: retried with backoff for the whole budget, then aborted, nothing changed, actionable message', { timeout: 90_000 }, async () => {
		setContent();
		installOld();
		const dir = pkgDir();
		const clock = fakeClock();
		let attempts = 0;
		await update({
			stagedDeps: { ...clock, renameSync: (from: string, to: string) => { if (from === dir) { attempts++; throw eperm(); } renameSync(from, to); } },
		});

		expect(attempts).toBeGreaterThan(4);
		expect(clock.sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(10_000);
		expect(clock.sleeps.slice(0, 3)).toEqual([50, 100, 200]);
		expect(installedVersion()).toBe('1.0.0');
		expect(asideDirs()).toEqual([]);
		expect(stages()).toEqual([]);
		const s = state();
		expect(s['status']).toBe('failed');
		expect(String(s['error'])).toContain('could not be renamed');
		expect(String(s['error'])).toContain('close every running my-cli process');
		expect(s['phase']).toBeUndefined();
	});

	it('first rename blocked briefly (Windows lock released): retried and the update completes', { timeout: 90_000 }, async () => {
		setContent();
		installOld();
		const dir = pkgDir();
		let attempts = 0;
		await update({
			stagedDeps: { ...fakeClock(), renameSync: (from: string, to: string) => { if (from === dir && ++attempts < 4) throw eperm(); renameSync(from, to); } },
		});
		expect(attempts).toBe(4);
		expect(installedVersion()).toBe('2.0.0');
		expect(state()['status']).toBe('success');
	});

	it('second rename fails: the previous version is renamed back, stage removed, journal failed', { timeout: 90_000 }, async () => {
		setContent();
		installOld();
		const dir = pkgDir();
		await update({
			stagedDeps: { ...fakeClock(), renameSync: (from: string, to: string) => { if (to === dir && from.includes('staging')) throw eperm(); renameSync(from, to); } },
		});
		expect(installedVersion()).toBe('1.0.0');
		expect(cliVersion()).toContain('my-cli 1.0.0');
		expect(asideDirs()).toEqual([]);
		expect(stages()).toEqual([]);
		expect(state()['status']).toBe('failed');
		expect(String(state()['error'])).toContain('previous version was put back');
	});

	it('second rename fails AND the restore fails: journal stays for the repair, which then puts the previous version back', { timeout: 90_000 }, async () => {
		setContent();
		installOld();
		const dir = pkgDir();
		await update({
			stagedDeps: {
				...fakeClock(),
				renameSync: (from: string, to: string) => {
					if (to === dir) throw eperm(); // both the staged -> place and the aside -> place renames
					renameSync(from, to);
				},
			},
		});
		expect(existsSync(dir)).toBe(false);
		expect(asideDirs()).toHaveLength(1);
		expect(state()).toMatchObject({ status: 'applying', phase: 'swapping' });
		expect(log()).toContain('The CLI is MISSING');

		// next run, real file system
		await update();
		expect(installedVersion()).toBe('1.0.0');
		expect(asideDirs()).toEqual([]);
		expect(stages()).toEqual([]);
		expect(state()['status']).toBe('rolled-back');
		expect(log()).toContain('restored the previous version');
	});
});

describe('staged install: when it does not apply', () => {
	it('bin entries differ: refused before any change, logged, the old direct npm path is used', { timeout: 90_000 }, async () => {
		setContent();
		installOld();
		setContent({ bin: { 'my-cli': 'bin/cli.js', 'my-cli-extra': 'bin/cli.js' } });
		await update();
		expect(installedVersion()).toBe('2.0.0');
		expect(state()['status']).toBe('success');
		const l = log();
		expect(l).toContain('staged install not used');
		expect(l).toContain('entries changed');
		expect(l).toContain('falling back to a direct npm install -g');
		expect(l).not.toContain('passed its health test');
		expect(stages()).toEqual([]);
	});

	it('the package is not installed globally: direct npm install, logged', { timeout: 90_000 }, async () => {
		setContent();
		registry.setLatestVersion(PKG, '2.0.0');
		registry.setLatestVersion(PLATFORM_PKG, '1.0.0');
		await update();
		expect(installedVersion()).toBe('2.0.0');
		expect(log()).toContain('is not installed globally');
	});

	it('stagedInstall: false keeps the direct npm install', { timeout: 90_000 }, async () => {
		setContent();
		installOld();
		await update({ stagedInstall: false });
		expect(installedVersion()).toBe('2.0.0');
		expect(log()).not.toContain('staging prefix');
	});

	it('stage on another volume than the global packages: staged next to them instead', { timeout: 90_000 }, async () => {
		setContent();
		installOld();
		const seen: string[] = [];
		await update({
			stagedDeps: {
				sameVolume: (a: string, b: string) => !a.startsWith(configDir) && !b.startsWith(configDir),
				betweenRenames: () => { seen.push(String(state()['stagePath'])); },
			},
		});
		expect(installedVersion()).toBe('2.0.0');
		expect(seen[0]).toContain('.staging-my-cli-');
		expect(seen[0]).toContain(dirname(dirname(pkgDir())));
		expect(log()).toContain('is on another volume');
		expect(readdirSync(dirname(dirname(pkgDir()))).filter((n) => n.startsWith('.staging-'))).toEqual([]);
	});

	it('no usable same-volume stage: clear error naming both paths, nothing changed, no download', { timeout: 90_000 }, async () => {
		setContent();
		installOld();
		await update({ stagedDeps: { sameVolume: () => false } });
		expect(installedVersion()).toBe('1.0.0');
		const s = state();
		expect(s['status']).toBe('failed');
		expect(String(s['error'])).toContain(join(configDir, 'staging'));
		expect(String(s['error'])).toContain('.staging-my-cli-');
		expect(String(s['error'])).toContain('not atomic');
		expect(log()).not.toContain('installing 2.0.0 into the staging prefix');
	});
});

describe('staged install: repair of a crash in each journal phase', () => {
	function deadPid(): number { return spawnSync(process.execPath, ['-e', '0']).pid!; }
	function writePkg(dir: string, version: string, script = CLI_SCRIPT): void {
		mkdirSync(join(dir, 'bin'), { recursive: true });
		writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: PKG, version, bin: { 'my-cli': 'bin/cli.js' } }));
		writeFileSync(join(dir, 'bin', 'cli.js'), script.split('{version}').join(version));
	}
	/** Hand-built disk + journal, as a crash would leave them; `npm root -g` is real (temp prefix). */
	function crashed(phase: 'staging' | 'staged' | 'swapping' | 'swapped', disk: { pkg?: string; aside?: string; stage?: boolean; pkgScript?: string; pkgManifest?: string }) {
		const root = String(execNpm(['root', '-g'])).trim();
		const dir = join(root, '@test', 'my-cli');
		const oldDir = join(root, '@test', '.my-cli-old-20260101000000-1');
		const stage = join(configDir, 'staging', '20260101000000-1');
		mkdirSync(join(root, '@test'), { recursive: true });
		if (disk.pkg) writePkg(dir, disk.pkg, disk.pkgScript);
		if (disk.pkgManifest !== undefined) writeFileSync(join(dir, 'package.json'), disk.pkgManifest);
		if (disk.aside) writePkg(oldDir, disk.aside);
		if (disk.stage) { writePkg(join(stage, 'node_modules', '@test', 'my-cli'), '2.0.0'); }
		writeState(stateFilePath(configDir), {
			status: 'applying', currentVersion: '1.0.0', targetVersion: '2.0.0', previousVersion: '1.0.0', pid: deadPid(), timestamp: Date.now(),
			phase, stagePath: stage, packageDirPath: dir, oldDirPath: oldDir,
		});
		// a dead updater leaves its lock behind too
		writeFileSync(join(configDir, 'update.lock'), JSON.stringify({ pid: deadPid(), ts: Date.now() }));
		return { dir, oldDir, stage };
	}

	for (const phase of ['staging', 'staged'] as const) {
		it(`phase ${phase}: the stage is deleted, the previous version is untouched`, { timeout: 60_000 }, async () => {
			const { stage } = crashed(phase, { pkg: '1.0.0', stage: true });
			await update();
			expect(existsSync(stage)).toBe(false);
			expect(installedVersion()).toBe('1.0.0');
			expect(state()['status']).toBe('rolled-back');
			expect(log()).toContain(`interrupted in phase '${phase}'`);
			expect(log()).toContain('removed the stage');
		});
	}

	it('phase swapping, previous dir renamed aside and the new one not in place: it is renamed back', { timeout: 60_000 }, async () => {
		const { dir, oldDir, stage } = crashed('swapping', { aside: '1.0.0', stage: true });
		expect(existsSync(dir)).toBe(false);
		await update();
		expect(installedVersion()).toBe('1.0.0');
		expect(existsSync(oldDir)).toBe(false);
		expect(existsSync(stage)).toBe(false);
		expect(cliVersion()).toContain('my-cli 1.0.0');
		expect(state()['status']).toBe('rolled-back');
		expect(log()).toContain('restored the previous version');
	});

	it('phase swapping, the first rename never happened: the stage is deleted, the package untouched', { timeout: 60_000 }, async () => {
		const { oldDir, stage } = crashed('swapping', { pkg: '1.0.0', stage: true });
		await update();
		expect(installedVersion()).toBe('1.0.0');
		expect(existsSync(oldDir)).toBe(false);
		expect(existsSync(stage)).toBe(false);
		expect(log()).toContain('was never moved');
	});

	for (const phase of ['swapping', 'swapped'] as const) {
		it(`phase ${phase}, both renames done: the new version is kept, the previous dir deleted`, { timeout: 60_000 }, async () => {
			const { oldDir, stage } = crashed(phase, { pkg: '2.0.0', aside: '1.0.0', stage: false });
			await update();
			expect(installedVersion()).toBe('2.0.0');
			expect(existsSync(oldDir)).toBe(false);
			expect(existsSync(stage)).toBe(false);
			expect(state()['status']).toBe('success');
			expect(state()['phase']).toBeUndefined();
			expect(log()).toContain('new version is healthy');
		});
	}

	it('phase swapped but the new version fails the self-check: the previous version is reinstalled by npm (the existing rollback)', { timeout: 90_000 }, async () => {
		registry.setLatestVersion(PKG, '1.0.0', 'old');
		registry.setLatestVersion(PKG, '2.0.0');
		setContent();
		crashed('swapped', { pkg: '2.0.0', aside: '1.0.0' });
		process.env['UPDATER_SELF_CHECK_CMD'] = 'node -e "process.exit(1)"';
		await update();
		expect(installedVersion()).toBe('1.0.0');
		expect(state()['status']).toBe('rolled-back');
		expect(log()).toContain('is not trusted (it fails the self-check)');
		expect(log()).toContain('restored the previous version');
	});

	it('phase swapped, the new dir fails its health test: the previous version is renamed back (no npm needed)', { timeout: 60_000 }, async () => {
		const { oldDir } = crashed('swapped', { pkg: '2.0.0', aside: '1.0.0', pkgScript: 'process.exit(1);' });
		await update();
		expect(installedVersion()).toBe('1.0.0');
		expect(existsSync(oldDir)).toBe(false);
		expect(asideDirs()).toEqual([]);
		expect(log()).toContain('its health test failed');
		expect(state()['status']).toBe('rolled-back');
	});

	it('phase swapped, the new dir has an unreadable package.json: the previous version is renamed back', { timeout: 60_000 }, async () => {
		crashed('swapped', { pkg: '2.0.0', aside: '1.0.0', pkgManifest: '{not json' });
		await update();
		expect(installedVersion()).toBe('1.0.0');
		expect(asideDirs()).toEqual([]);
		expect(log()).toContain('is missing or unreadable');
	});

	it('phase swapped, the new dir is a different version than the target: the previous version is renamed back', { timeout: 60_000 }, async () => {
		crashed('swapped', { pkg: '2.5.0', aside: '1.0.0' });
		await update();
		expect(installedVersion()).toBe('1.0.0');
		expect(log()).toContain('the update targeted 2.0.0');
	});
});

describe('UPDATER_DISABLE', () => {
	it('makes the updater do nothing but log', async () => {
		process.env['UPDATER_DISABLE'] = '1';
		await update();
		expect(existsSync(stateFilePath(configDir))).toBe(false);
		expect(existsSync(join(configDir, 'update.lock'))).toBe(false);
		expect(log()).toContain('UPDATER_DISABLE=1');
		await runUpdater({ pkgName: PKG, configDir, currentVersion: '1.0.0', strategy: 'with-daemon' });
		expect(existsSync(stateFilePath(configDir))).toBe(false);
	});
});

describe('review fixes: quoting', () => {
	it('works when the config dir AND the npm prefix contain spaces', { timeout: 90_000 }, async () => {
		setContent();
		const spacedCfg = mkdtempSync(join(tmpdir(), 'staged cfg with space-'));
		const spacedPrefix = mkdtempSync(join(tmpdir(), 'staged prefix with space-'));
		const oldCfg = configDir;
		const oldPrefix = npmPrefix;
		try {
			configDir = spacedCfg;
			npmPrefix = spacedPrefix;
			process.env['npm_config_prefix'] = spacedPrefix;
			process.env['npm_config_cache'] = join(spacedPrefix, '.npm-cache');
			installOld();
			await update();
			expect(installedVersion()).toBe('2.0.0');
			expect(state()['status']).toBe('success');
			expect(log()).toContain('passed its health test');
			expect(pkgDir()).toContain(' ');
		} finally {
			configDir = oldCfg;
			npmPrefix = oldPrefix;
			rmSync(spacedCfg, { recursive: true, force: true });
			rmSync(spacedPrefix, { recursive: true, force: true });
		}
	});
});

describe('review fixes: the previous version is kept until the post-checks pass', () => {
	const checkScript = (): string => {
		const f = join(configDir, 'selfcheck.cjs');
		writeFileSync(f, `const fs=require('fs');const p=process.env.ASIDE_PARENT;process.exit(fs.readdirSync(p).some((n)=>n.startsWith('.my-cli-old-'))?0:1);`);
		return f;
	};

	it('the self-check runs while the previous dir still exists; it is deleted only after the check passed', { timeout: 90_000 }, async () => {
		setContent();
		installOld();
		process.env['ASIDE_PARENT'] = dirname(pkgDir());
		process.env['UPDATER_SELF_CHECK_CMD'] = `node "${checkScript()}"`;
		try {
			await update();
		} finally {
			delete process.env['ASIDE_PARENT'];
		}
		expect(state()['status']).toBe('success');
		expect(installedVersion()).toBe('2.0.0');
		expect(asideDirs()).toEqual([]);
	});

	it('self-check fails: the previous version is renamed back with NO npm (the registry cannot even serve it)', { timeout: 90_000 }, async () => {
		setContent();
		installOld();
		// the registry no longer offers 1.0.0: an npm reinstall of it would fail
		registry.clear();
		setContent();
		registry.setLatestVersion(PKG, '2.0.0');
		registry.setLatestVersion(PLATFORM_PKG, '1.0.0');
		process.env['UPDATER_SELF_CHECK_CMD'] = 'node -e "process.exit(1)"';
		await update();

		expect(installedVersion()).toBe('1.0.0');
		expect(cliVersion()).toContain('my-cli 1.0.0');
		expect(asideDirs()).toEqual([]);
		expect(stages()).toEqual([]);
		expect(state()).toMatchObject({ status: 'rolled-back' });
		const l = log();
		expect(l).toContain('renamed, no download');
		expect(l).not.toContain('reinstalling it with npm');
		expect(l).not.toContain('is installed again');
	});

	it('self-check fails and the rename-back is blocked: npm reinstalls the previous version (last resort)', { timeout: 120_000 }, async () => {
		setContent();
		installOld();
		const dir = pkgDir();
		let swapped = false;
		let t = 1_000_000;
		process.env['UPDATER_SELF_CHECK_CMD'] = 'node -e "process.exit(1)"';
		await update({
			stagedDeps: {
				now: () => t,
				sleep: async (ms: number) => { t += ms; },
				betweenRenames: () => { swapped = true; },
				renameSync: (from: string, to: string) => {
					if (swapped && from === dir) {
						throw Object.assign(new Error('locked'), { code: 'EPERM' });
					}
					renameSync(from, to);
				},
			},
		});
		expect(installedVersion()).toBe('1.0.0');
		expect(log()).toContain('reinstalling it with npm');
		expect(state()['status']).toBe('rolled-back');
	});
});

describe('review fixes: the journal must be writable', () => {
	const cases: Array<[string, () => void]> = [
		['missing', () => {}],
		['corrupt', () => writeFileSync(stateFilePath(configDir), '{nope')],
		['not applying', () => writeState(stateFilePath(configDir), { status: 'success', currentVersion: '1.0.0', timestamp: Date.now() })],
	];
	for (const [name, arrange] of cases) {
		it(`state file ${name}: the staged install stops before touching anything and says why`, { timeout: 90_000 }, async () => {
			setContent();
			installOld();
			arrange();
			const res = await stagedInstall({ pkgName: PKG, configDir, currentVersion: '1.0.0', strategy: 'without-daemon' }, '2.0.0');
			expect(res.kind).toBe('failed');
			expect((res as { why: string }).why).toContain('cannot journal the update');
			expect((res as { why: string }).why).toContain('nothing was switched');
			expect(installedVersion()).toBe('1.0.0');
			expect(stages()).toEqual([]);
			expect(log()).not.toContain('into the staging prefix');
		});
	}
});

describe('review fixes: permissions are not a lock', () => {
	const eacces = (): Error => Object.assign(new Error('permission denied'), { code: 'EACCES' });

	it('EACCES on the first rename fails at once with a permissions message', { timeout: 90_000 }, async () => {
		setContent();
		installOld();
		const dir = pkgDir();
		const sleeps: number[] = [];
		let attempts = 0;
		await update({
			stagedDeps: {
				sleep: async (ms: number) => { sleeps.push(ms); },
				renameSync: (from: string, to: string) => {
					if (from === dir) {
						attempts++;
						throw eacces();
					}
					renameSync(from, to);
				},
			},
		});
		expect(attempts).toBe(1);
		expect(sleeps).toEqual([]);
		const e = String(state()['error']);
		expect(e).toContain('permission denied');
		expect(e).toContain('user-owned npm prefix');
		expect(e).not.toContain('close every running');
		expect(installedVersion()).toBe('1.0.0');
		expect(stages()).toEqual([]);
	});

	it('EACCES on the second rename: the previous version is put back, permissions message', { timeout: 90_000 }, async () => {
		setContent();
		installOld();
		const dir = pkgDir();
		await update({
			stagedDeps: {
				renameSync: (from: string, to: string) => {
					if (to === dir && from.includes('staging')) {
						throw eacces();
					}
					renameSync(from, to);
				},
			},
		});
		expect(installedVersion()).toBe('1.0.0');
		expect(String(state()['error'])).toContain('permission denied');
		expect(String(state()['error'])).not.toContain('close every running');
	});

	it('an unwritable global directory is detected BEFORE the download', { timeout: 90_000 }, async () => {
		setContent();
		installOld();
		await update({ stagedDeps: { probeWritable: () => { throw eacces(); } } });
		expect(installedVersion()).toBe('1.0.0');
		const e = String(state()['error']);
		expect(e).toContain('permission denied');
		expect(e).toContain('Nothing was downloaded');
		expect(log()).not.toContain('into the staging prefix');
		expect(stages()).toEqual([]);
	});
});

describe('review fixes: health check contract', () => {
	it('a bin that is a shell script cannot be run by node: logged fallback to the direct npm install, no abort', { timeout: 90_000 }, async () => {
		registry.setPackageContent(PKG, { manifest: { bin: { 'my-cli': 'bin/cli.sh' } }, files: { 'bin/cli.sh': '#!/bin/sh\necho my-cli {version}\n' } });
		installOld();
		await update();
		expect(installedVersion()).toBe('2.0.0');
		expect(state()['status']).toBe('success');
		const l = log();
		expect(l).toContain('staged install not used');
		expect(l).toContain('not a JavaScript file for node');
		expect(l).not.toContain('passed its health test');
	});

	it('an extensionless bin with a node shebang IS health-tested', { timeout: 90_000 }, async () => {
		registry.setPackageContent(PKG, { manifest: { bin: { 'my-cli': 'bin/cli' } }, files: { 'bin/cli': CLI_SCRIPT } });
		installOld();
		await update();
		expect(installedVersion()).toBe('2.0.0');
		expect(log()).toContain('passed its health test');
	});

	it('a runnable bin that prints another version still aborts the update (version must be a whole token)', { timeout: 90_000 }, async () => {
		setContent();
		installOld();
		setContent({ script: `console.log('my-cli 12.0.0 and 2.0.0.1');` });
		await update();
		expect(installedVersion()).toBe('1.0.0');
		expect(String(state()['error'])).toContain('as a whole token');
	});

	it('the health child is tracked (the interrupt guard stops it) and its output is capped', { timeout: 60_000 }, async () => {
		const dir = mkdtempSync(join(tmpdir(), 'health-unit-'));
		try {
			const hang = join(dir, 'hang.cjs');
			writeFileSync(hang, 'setInterval(() => {}, 1000);');
			const noisy = join(dir, 'noisy.cjs');
			writeFileSync(noisy, `console.log('my-cli 2.0.0'); process.stdout.write('x'.repeat(${HEALTH_OUTPUT_CAP * 4}));`);
			const input = { pkgName: PKG, version: '2.0.0', packageDir: dir, configDir, timeoutMs: 30_000 };

			const pending = defaultHealthCheck({ ...input, entry: hang });
			await new Promise((r) => setTimeout(r, 700));
			const stopped = stopTrackedChildren();
			expect(stopped).toHaveLength(1);
			const res = await pending;
			expect(res.ok).toBe(false);

			const big = await defaultHealthCheck({ ...input, entry: noisy });
			expect(big.ok).toBe(true);
			expect(big.output.length).toBeLessThan(HEALTH_OUTPUT_CAP + 200);
			expect(big.output).toContain('output truncated');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('review fixes: what is moved is re-checked right before the rename', () => {
	it('a symlinked global package (npm link) is not swapped: aborted before the download', { timeout: 90_000 }, async () => {
		setContent();
		installOld();
		const dir = pkgDir();
		const real = mkdtempSync(join(tmpdir(), 'linked-pkg-'));
		try {
			renameSync(dir, join(real, 'pkg'));
			symlinkSync(join(real, 'pkg'), dir, 'junction');
			await update();
			expect(lstatSync(dir).isSymbolicLink()).toBe(true);
			expect(String(state()['error'])).toContain('symlink (npm link): update it manually');
			expect(log()).not.toContain('into the staging prefix');
		} finally {
			rmSync(dir, { recursive: true, force: true });
			rmSync(real, { recursive: true, force: true });
		}
	});

	it('the package becomes a symlink while the stage is health-tested: aborted, stage removed, link untouched', { timeout: 90_000 }, async () => {
		setContent();
		installOld();
		const dir = pkgDir();
		const real = mkdtempSync(join(tmpdir(), 'linked-pkg-'));
		try {
			await update({
				healthCheck: async () => {
					renameSync(dir, join(real, 'pkg'));
					symlinkSync(join(real, 'pkg'), dir, 'junction');
					return { ok: true, output: 'my-cli 2.0.0' };
				},
			});
			expect(lstatSync(dir).isSymbolicLink()).toBe(true);
			expect(String(state()['error'])).toContain('symlink (npm link)');
			expect(stages()).toEqual([]);
			expect(asideDirs()).toEqual([]);
			expect(state()['status']).toBe('failed');
		} finally {
			rmSync(dir, { recursive: true, force: true });
			rmSync(real, { recursive: true, force: true });
		}
	});

	for (const [what, mutate] of [
		['the version', (m: Record<string, unknown>) => { m['version'] = '1.5.0'; }],
		['the bin set', (m: Record<string, unknown>) => { m['bin'] = { 'my-cli': 'bin/cli.js', extra: 'bin/cli.js' }; }],
	] as const) {
		it(`${what} changes while the stage is health-tested (someone ran npm i -g): aborted cleanly, next check retries`, { timeout: 90_000 }, async () => {
			setContent();
			installOld();
			const dir = pkgDir();
			await update({
				healthCheck: async () => {
					const f = join(dir, 'package.json');
					const m = JSON.parse(readFileSync(f, 'utf8'));
					mutate(m);
					writeFileSync(f, JSON.stringify(m));
					return { ok: true, output: 'my-cli 2.0.0' };
				},
			});
			const s = state();
			expect(s['status']).toBe('failed');
			expect(String(s['error'])).toContain('changed while 2.0.0 was staged');
			expect(stages()).toEqual([]);
			expect(asideDirs()).toEqual([]);
			expect(existsSync(join(dir, 'package.json'))).toBe(true);
		});
	}
});
