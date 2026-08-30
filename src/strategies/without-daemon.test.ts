import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../shared/fetch.js', () => ({ fetchLatestVersion: vi.fn() }));
vi.mock('../shared/npm.js', () => ({ execNpm: vi.fn(), USE_NPM_CLI: false }));

import { fetchLatestVersion } from '../shared/fetch.js';
import { execNpm } from '../shared/npm.js';
import { runWithoutDaemon } from './without-daemon.js';
import { readState, readCache, stateFilePath, cacheFilePath, lockFilePath } from '../shared/state.js';
import { tryAcquireLock, releaseLock } from '../shared/lock.js';

const mockFetch = vi.mocked(fetchLatestVersion);
const mockExecNpm = vi.mocked(execNpm);

let configDir: string;

beforeEach(() => {
	configDir = mkdtempSync(join(tmpdir(), 'shared-updater-wd-'));
	mockFetch.mockReset();
	mockExecNpm.mockReset();
	delete process.env['UPDATER_FORCE'];
	delete process.env['UPDATER_SELF_CHECK_CMD'];
});

afterEach(() => {
	rmSync(configDir, { recursive: true, force: true });
	delete process.env['UPDATER_FORCE'];
	delete process.env['UPDATER_SELF_CHECK_CMD'];
});

const cfg = () => ({ pkgName: '@test/pkg', configDir, currentVersion: '1.0.0', strategy: 'without-daemon' as const });

describe('without-daemon strategy', () => {
	it('installs and writes success state when update available', async () => {
		mockFetch.mockReturnValue('1.0.1');
		mockExecNpm.mockReturnValue('');

		await runWithoutDaemon(cfg());

		expect(mockExecNpm).toHaveBeenCalledWith(
			['install', '-g', '@test/pkg@1.0.1'],
			expect.objectContaining({ timeout: expect.any(Number) }),
		);
		const state = readState(stateFilePath(configDir));
		expect(state?.status).toBe('success');
		expect(state?.targetVersion).toBe('1.0.1');
		expect(state?.previousVersion).toBe('1.0.0');
	});

	it('skips install when already up to date', async () => {
		mockFetch.mockReturnValue('1.0.0');

		await runWithoutDaemon(cfg());

		expect(mockExecNpm).not.toHaveBeenCalledWith(
			expect.arrayContaining(['install']),
			expect.anything(),
		);
		expect(readState(stateFilePath(configDir))).toBeNull();
	});

	it('skips version check when cache is fresh', async () => {
		// prime the cache with a very recent timestamp
		const { writeCache } = await import('../shared/state.js');
		writeCache(cacheFilePath(configDir), { lastCheckedAt: Date.now(), latestVersion: '1.0.0' });

		await runWithoutDaemon(cfg());

		expect(mockFetch).not.toHaveBeenCalled();
	});

	it('UPDATER_FORCE bypasses fresh cache', async () => {
		const { writeCache } = await import('../shared/state.js');
		writeCache(cacheFilePath(configDir), { lastCheckedAt: Date.now(), latestVersion: '1.0.0' });
		mockFetch.mockReturnValue('1.0.0');
		process.env['UPDATER_FORCE'] = '1';

		await runWithoutDaemon(cfg());

		expect(mockFetch).toHaveBeenCalled();
	});

	it('writes failed state when npm install throws', async () => {
		mockFetch.mockReturnValue('1.0.1');
		mockExecNpm.mockImplementation((args) => {
			if (args.includes('install')) throw new Error('npm install failed');
			return '';
		});

		await runWithoutDaemon(cfg());

		const state = readState(stateFilePath(configDir));
		expect(state?.status).toBe('failed');
		expect(state?.error).toContain('npm install failed');
	});

	it('rolls back when self-check fails', async () => {
		mockFetch.mockReturnValue('1.0.1');
		mockExecNpm.mockReturnValue('');
		// self-check exits 1
		process.env['UPDATER_SELF_CHECK_CMD'] = `"${process.execPath}" -e "process.exit(1)"`;

		await runWithoutDaemon(cfg());

		// second execNpm call is the rollback to 1.0.0
		const calls = mockExecNpm.mock.calls;
		expect(calls.length).toBeGreaterThanOrEqual(2);
		expect(calls[1]![0]).toContain('@test/pkg@1.0.0');
		expect(readState(stateFilePath(configDir))?.status).toBe('rolled-back');
	});

	it('second concurrent run is skipped (lock held)', async () => {
		mockFetch.mockReturnValue('1.0.1');
		mockExecNpm.mockReturnValue('');

		// Pre-acquire the lock as if another process holds it
		tryAcquireLock(lockFilePath(configDir));
		try {
			await runWithoutDaemon(cfg());
			// fetchLatestVersion should NOT have been called
			expect(mockFetch).not.toHaveBeenCalled();
		} finally {
			releaseLock(lockFilePath(configDir));
		}
	});

	it('does not crash when npm view fails', async () => {
		mockFetch.mockImplementation(() => { throw new Error('network error'); });

		await expect(runWithoutDaemon(cfg())).resolves.not.toThrow();
		expect(readState(stateFilePath(configDir))).toBeNull();
	});
});
