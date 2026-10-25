import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../shared/fetch.js', () => ({ fetchLatestVersion: vi.fn() }));
vi.mock('../shared/npm.js', () => ({ execNpm: vi.fn(), runNpmAsync: vi.fn(), USE_NPM_CLI: false }));

import { fetchLatestVersion } from '../shared/fetch.js';
import { execNpm, runNpmAsync } from '../shared/npm.js';
import { runWithoutDaemon } from './without-daemon.js';
import { readState, writeState, stateFilePath, lockFilePath } from '../shared/state.js';
import { verifyInstalled } from '../shared/installed.js';
import { createFakeNpm } from './fakeNpm.testutil.js';
import { isProcessRunning, killProcessTree } from '../shared/process.js';

const mockFetch = vi.mocked(fetchLatestVersion);
const mockExecNpm = vi.mocked(execNpm);
const mockRunNpm = vi.mocked(runNpmAsync);
const PKG = '@test/pkg';

let configDir: string;
let fakeRoot: string;

function readLog(): string {
	const f = join(configDir, 'logs', `${new Date().toISOString().slice(0, 10)}.ndjson`);
	return existsSync(f) ? readFileSync(f, 'utf8') : '';
}

/** A pid that is certainly dead: a child that already exited. */
let cachedDeadPid: number | undefined;
function deadPid(): number {
	cachedDeadPid ??= spawnSync(process.execPath, ['-e', '0']).pid!;
	return cachedDeadPid;
}

function removePackage(root: string): void {
	rmSync(join(root, '@test', 'pkg'), { recursive: true, force: true });
}

function setup(opts?: Parameters<typeof createFakeNpm>[0]) {
	const fake = createFakeNpm(opts);
	fake.seed(PKG, '1.0.0');
	fakeRoot = fake.root;
	mockExecNpm.mockImplementation((args) => fake.impl(args));
	mockRunNpm.mockImplementation(async (args) => fake.impl(args));
	return fake;
}

const cfg = () => ({ pkgName: PKG, configDir, currentVersion: '1.0.0', strategy: 'without-daemon' as const });
const installed = () => verifyInstalled(PKG).installedVersion;

beforeEach(() => {
	configDir = mkdtempSync(join(tmpdir(), 'shared-updater-rec-'));
	mockFetch.mockReset();
	mockExecNpm.mockReset();
	mockRunNpm.mockReset();
	delete process.env['UPDATER_FORCE'];
	delete process.env['UPDATER_SELF_CHECK_CMD'];
});
afterEach(() => {
	rmSync(configDir, { recursive: true, force: true });
	rmSync(fakeRoot, { recursive: true, force: true });
});

describe('install failure restores the previous version', () => {
	it('reinstalls the previous version when npm removed it then failed, and says so', async () => {
		const fake = setup({
			onInstall: (_pkg, version) => {
				if (version !== '1.0.1') return;
				// npm removed the old package, then died before placing the new one
				removePackage(fake.root);
				throw new Error('npm killed');
			},
		});
		mockFetch.mockReturnValue('1.0.1');

		await runWithoutDaemon(cfg());

		expect(installed()).toBe('1.0.0');
		const state = readState(stateFilePath(configDir));
		expect(state?.status).toBe('failed');
		expect(state?.error).toContain('npm killed');
		expect(fake.installs).toEqual(['@test/pkg@1.0.1', '@test/pkg@1.0.0']);
		const log = readLog();
		expect(log).toContain('install of 1.0.1 failed');
		expect(log).toContain('1.0.0 is installed again');
		expect(existsSync(lockFilePath(configDir))).toBe(false);
	});

	it('does not reinstall when the previous version is still intact', async () => {
		const fake = setup({ onInstall: () => { throw new Error('registry 500'); } });
		mockFetch.mockReturnValue('1.0.1');

		await runWithoutDaemon(cfg());

		expect(fake.installs).toEqual(['@test/pkg@1.0.1']);
		expect(readState(stateFilePath(configDir))?.status).toBe('failed');
		expect(readLog()).toContain('already installed');
	});

	it('reports loudly when the previous version cannot be restored either', async () => {
		const fake = setup({
			onInstall: () => {
				removePackage(fake.root);
				throw new Error('npm down');
			},
		});
		mockFetch.mockReturnValue('1.0.1');

		await runWithoutDaemon(cfg());

		const state = readState(stateFilePath(configDir));
		expect(state?.status).toBe('failed');
		expect(state?.error).toContain('Fix manually: npm install -g @test/pkg@1.0.0');
		expect(readLog()).toContain('RESTORE FAILED');
	});
});

describe('state is persisted before npm runs', () => {
	it("writes 'applying' with pid, previous and target before npm install", async () => {
		let seen: ReturnType<typeof readState> = null;
		setup({ onInstall: () => { seen = readState(stateFilePath(configDir)); } });
		mockFetch.mockReturnValue('1.0.1');

		await runWithoutDaemon(cfg());

		expect(seen).toMatchObject({ status: 'applying', pid: process.pid, previousVersion: '1.0.0', targetVersion: '1.0.1' });
		expect(readState(stateFilePath(configDir))?.status).toBe('success');
	});
});

describe('verify after install', () => {
	it('rolls back when the installed version is not the target even though npm succeeded', async () => {
		const fake = setup({
			onInstall: (pkg, version) => {
				if (version === '1.0.1') { fake.seed(pkg, '9.9.9'); return 'skip'; }
			},
		});
		mockFetch.mockReturnValue('1.0.1');

		await runWithoutDaemon(cfg());

		expect(installed()).toBe('1.0.0');
		const state = readState(stateFilePath(configDir));
		expect(state?.status).toBe('rolled-back');
		expect(state?.error).toContain('installed version is 9.9.9, expected 1.0.1');
	});

	it('rolls back when the package directory is gone after a "successful" install', async () => {
		const fake = setup({
			onInstall: (_p, version) => {
				if (version === '1.0.1') { removePackage(fake.root); return 'skip'; }
			},
		});
		mockFetch.mockReturnValue('1.0.1');

		await runWithoutDaemon(cfg());

		expect(installed()).toBe('1.0.0');
		expect(readState(stateFilePath(configDir))?.status).toBe('rolled-back');
	});

	it('records a failed state (not a stale applying) when the self-check rollback itself fails', { timeout: 30_000 }, async () => {
		setup({ onInstall: (_p, version) => { if (version === '1.0.0') throw new Error('rollback boom'); } });
		mockFetch.mockReturnValue('1.0.1');
		process.env['UPDATER_SELF_CHECK_CMD'] = `"${process.execPath}" -e "process.exit(1)"`;

		await runWithoutDaemon(cfg());

		const state = readState(stateFilePath(configDir));
		expect(state?.status).toBe('failed');
		expect(state?.error).toContain('rollback boom');
	});
});

describe('repair of an interrupted install (state stays applying)', () => {
	function interruptedState(extra: Record<string, unknown> = {}): void {
		writeState(stateFilePath(configDir), {
			status: 'applying', currentVersion: '1.0.0', previousVersion: '1.0.0', targetVersion: '1.0.1',
			pid: deadPid(), timestamp: Date.now() - 60_000, ...extra,
		});
	}

	it('reinstalls the previous version when the package vanished, and finalises the state', async () => {
		const fake = setup();
		removePackage(fake.root);
		interruptedState();

		await runWithoutDaemon(cfg());

		expect(installed()).toBe('1.0.0');
		expect(fake.installs).toEqual(['@test/pkg@1.0.0']);
		const state = readState(stateFilePath(configDir));
		expect(state?.status).toBe('rolled-back');
		expect(state?.error).toContain('repaired');
		// repair does not go on to check for updates
		expect(mockFetch).not.toHaveBeenCalled();
		const log = readLog();
		expect(log).toContain('was interrupted');
		expect(log).toContain('repaired');
	});

	it('repairs even with autoUpdate: false and a fresh throttle cache', async () => {
		const fake = setup();
		removePackage(fake.root);
		writeFileSync(join(configDir, 'config.yml'), 'autoUpdate: false\n');
		writeFileSync(join(configDir, 'update-cache.json'), JSON.stringify({ lastCheckedAt: Date.now(), latestVersion: '1.0.0' }));
		interruptedState();

		await runWithoutDaemon(cfg());

		expect(installed()).toBe('1.0.0');
	});

	it('leaves an intact previous version alone (no npm install)', async () => {
		const fake = setup();
		interruptedState();

		await runWithoutDaemon(cfg());

		expect(fake.installs).toEqual([]);
		expect(readState(stateFilePath(configDir))?.status).toBe('rolled-back');
	});

	it('keeps the target when it was fully installed and passes self-check', async () => {
		const fake = setup();
		fake.seed(PKG, '1.0.1');
		interruptedState();

		await runWithoutDaemon(cfg());

		expect(installed()).toBe('1.0.1');
		expect(fake.installs).toEqual([]);
		expect(readState(stateFilePath(configDir))?.status).toBe('success');
	});

	it('restores the previous version when the fully installed target fails self-check', { timeout: 30_000 }, async () => {
		const fake = setup();
		fake.seed(PKG, '1.0.1');
		process.env['UPDATER_SELF_CHECK_CMD'] = `"${process.execPath}" -e "process.exit(1)"`;
		interruptedState();

		await runWithoutDaemon(cfg());

		expect(installed()).toBe('1.0.0');
		expect(fake.installs).toEqual(['@test/pkg@1.0.0']);
		expect(readState(stateFilePath(configDir))?.status).toBe('rolled-back');
	});

	it('reinstalls the target when no previous version was recorded', async () => {
		const fake = setup();
		removePackage(fake.root);
		writeState(stateFilePath(configDir), {
			status: 'applying', currentVersion: undefined as unknown as string, targetVersion: '1.0.1', pid: deadPid(), timestamp: Date.now(),
		});

		await runWithoutDaemon(cfg());

		expect(installed()).toBe('1.0.1');
	});

	it('reports failed with a manual command when the repair itself fails', async () => {
		const fake = setup({ onInstall: () => { throw new Error('offline'); } });
		removePackage(fake.root);
		interruptedState();

		await runWithoutDaemon(cfg());

		const state = readState(stateFilePath(configDir));
		expect(state?.status).toBe('failed');
		expect(state?.error).toContain('Fix manually: npm install -g @test/pkg@1.0.0');
		expect(readLog()).toContain('REPAIR FAILED');
	});

	it('does not touch an applying state whose pid is alive and recent', async () => {
		const fake = setup();
		removePackage(fake.root);
		interruptedState({ pid: process.ppid });

		await runWithoutDaemon(cfg());

		expect(fake.installs).toEqual([]);
		expect(readState(stateFilePath(configDir))?.status).toBe('applying');
		expect(readLog()).toContain('still alive');
	});

	it('repairs an applying state older than 15 min even if its pid looks alive (pid reuse)', async () => {
		const fake = setup();
		removePackage(fake.root);
		interruptedState({ pid: process.ppid, timestamp: Date.now() - 20 * 60_000 });

		await runWithoutDaemon(cfg());

		expect(installed()).toBe('1.0.0');
	});

	it('takes over a lock left by the dead updater (dead pid, fresh timestamp)', async () => {
		const fake = setup();
		removePackage(fake.root);
		writeFileSync(lockFilePath(configDir), JSON.stringify({ pid: deadPid(), ts: Date.now() }));
		interruptedState();

		await runWithoutDaemon(cfg());

		expect(installed()).toBe('1.0.0');
		expect(existsSync(lockFilePath(configDir))).toBe(false);
	});

	it('warns about leftover npm temp dirs without deleting them', async () => {
		const fake = setup();
		const leftover = join(fake.root, '@test', '.pkg-AbCd1234');
		mkdirSync(leftover, { recursive: true });
		interruptedState();

		await runWithoutDaemon(cfg());

		expect(existsSync(leftover)).toBe(true);
		expect(readLog()).toContain('leftover npm temp dir');
	});
});

describe('npm child pid is journaled', () => {
	it("records npmPid/npmStartedAt in the 'applying' state while npm runs, and clears them afterwards", async () => {
		const fake = setup();
		let during: ReturnType<typeof readState> = null;
		mockRunNpm.mockImplementation(async (args, opts) => {
			opts?.onSpawn?.(4242);
			during = readState(stateFilePath(configDir));
			return fake.impl(args);
		});
		mockFetch.mockReturnValue('1.0.1');

		await runWithoutDaemon(cfg());

		expect(during).toMatchObject({ status: 'applying', npmPid: 4242, pid: process.pid });
		expect(during!.npmStartedAt).toBeGreaterThan(Date.now() - 60_000);
		const after = readState(stateFilePath(configDir));
		expect(after?.status).toBe('success');
		expect(after?.npmPid).toBeUndefined();
	});

	it('clears the npm pid from the journal when npm fails, before the restore runs', async () => {
		const fake = setup();
		const seen: Array<number | undefined> = [];
		mockRunNpm.mockImplementation(async (args, opts) => {
			seen.push(readState(stateFilePath(configDir))?.npmPid);
			opts?.onSpawn?.(4000 + seen.length);
			if (args.includes('@test/pkg@1.0.1')) throw new Error('boom');
			return fake.impl(args);
		});
		mockFetch.mockReturnValue('1.0.1');

		await runWithoutDaemon(cfg());

		// the restore step (2nd npm call, only if needed) never sees the failed npm's pid
		expect(seen[0]).toBeUndefined();
		expect(readState(stateFilePath(configDir))?.npmPid).toBeUndefined();
	});
});

describe('repair stops an npm orphaned by the dead updater (real process)', () => {
	const sleepers: number[] = [];
	afterEach(() => { for (const pid of sleepers.splice(0)) killProcessTree(pid); });

	function orphan(): number {
		const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
			stdio: 'ignore', windowsHide: true, detached: process.platform !== 'win32',
		});
		c.unref();
		sleepers.push(c.pid!);
		return c.pid!;
	}

	async function gone(pid: number): Promise<void> {
		const t0 = Date.now();
		while (isProcessRunning(pid)) {
			if (Date.now() - t0 > 10_000) throw new Error(`orphan pid ${pid} still running 10s after the repair`);
			await new Promise((r) => setTimeout(r, 50));
		}
	}

	it('stops it (after the bounded wait) BEFORE reinstalling the previous version', async () => {
		const fake = setup();
		removePackage(fake.root);
		const pid = orphan();
		let orphanRunningAtInstall: boolean | undefined;
		mockRunNpm.mockImplementation(async (args) => {
			orphanRunningAtInstall = isProcessRunning(pid);
			return fake.impl(args);
		});
		writeState(stateFilePath(configDir), {
			status: 'applying', currentVersion: '1.0.0', previousVersion: '1.0.0', targetVersion: '1.0.1',
			pid: deadPid(), npmPid: pid, npmStartedAt: Date.now(), timestamp: Date.now() - 60_000,
		});

		await runWithoutDaemon({ ...cfg(), orphanNpmWaitMs: 300 });

		await gone(pid);
		expect(orphanRunningAtInstall).toBe(false);
		expect(installed()).toBe('1.0.0');
		expect(readState(stateFilePath(configDir))?.status).toBe('rolled-back');
		expect(readLog()).toContain('STOPPING its process tree');
	});

	it('leaves the orphan, the state and the disk alone while the journaled updater pid is alive and recent', async () => {
		const fake = setup();
		removePackage(fake.root);
		const pid = orphan();
		writeState(stateFilePath(configDir), {
			status: 'applying', currentVersion: '1.0.0', previousVersion: '1.0.0', targetVersion: '1.0.1',
			pid: process.ppid, npmPid: pid, npmStartedAt: Date.now(), timestamp: Date.now() - 1000,
		});

		await runWithoutDaemon({ ...cfg(), orphanNpmWaitMs: 300 });

		expect(isProcessRunning(pid)).toBe(true);
		expect(fake.installs).toEqual([]);
		expect(readState(stateFilePath(configDir))?.status).toBe('applying');
	});

	it('does not touch a live pid recorded as npm long ago (pid reuse) and still repairs', async () => {
		const fake = setup();
		removePackage(fake.root);
		const pid = orphan();
		writeState(stateFilePath(configDir), {
			status: 'applying', currentVersion: '1.0.0', previousVersion: '1.0.0', targetVersion: '1.0.1',
			pid: deadPid(), npmPid: pid, npmStartedAt: Date.now() - 30 * 60_000, timestamp: Date.now() - 60_000,
		});

		await runWithoutDaemon({ ...cfg(), orphanNpmWaitMs: 300 });

		expect(isProcessRunning(pid)).toBe(true);
		expect(installed()).toBe('1.0.0');
		expect(readLog()).toContain('assuming the pid was reused');
	});
});
