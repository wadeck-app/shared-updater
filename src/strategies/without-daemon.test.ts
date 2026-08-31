import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

	it('skips entirely when autoUpdate: false in config', async () => {
		const { writeFileSync } = await import('node:fs');
		const { mkdirSync } = await import('node:fs');
		mkdirSync(configDir, { recursive: true });
		writeFileSync(`${configDir}/config.yml`, 'autoUpdate: false\n');

		await runWithoutDaemon(cfg());

		expect(mockFetch).not.toHaveBeenCalled();
		expect(readState(stateFilePath(configDir))).toBeNull();
	});

	it('succeeds without self-check when UPDATER_SELF_CHECK_CMD is not set', async () => {
		mockFetch.mockReturnValue('1.0.1');
		mockExecNpm.mockReturnValue('');
		delete process.env['UPDATER_SELF_CHECK_CMD'];

		await runWithoutDaemon(cfg());

		const state = readState(stateFilePath(configDir));
		expect(state?.status).toBe('success');
	});

	describe('onUpdateAvailable', () => {
		it('proceeds with install when callback returns apply-now', async () => {
			mockFetch.mockReturnValue('1.0.1');
			mockExecNpm.mockReturnValue('');

			await runWithoutDaemon({
				...cfg(),
				onUpdateAvailable: async () => 'apply-now',
			});

			expect(mockExecNpm).toHaveBeenCalledWith(
				['install', '-g', '@test/pkg@1.0.1'],
				expect.objectContaining({ timeout: expect.any(Number) }),
			);
			const state = readState(stateFilePath(configDir));
			expect(state?.status).toBe('success');
		});

		it('defers install when callback returns { defer: true } (default retryIn)', async () => {
			mockFetch.mockReturnValue('1.0.1');

			await runWithoutDaemon({
				...cfg(),
				onUpdateAvailable: async () => ({ defer: true }),
			});

			expect(mockExecNpm).not.toHaveBeenCalled();
			const state = readState(stateFilePath(configDir));
			expect(state?.status).toBe('deferred');
			expect(state?.targetVersion).toBe('1.0.1');
			// retryAt should be in the future
			expect(state?.retryAt).toBeGreaterThan(Date.now() - 1000);
		});

		it('defers with custom retryIn when callback returns { defer: true, retryIn }', async () => {
			mockFetch.mockReturnValue('1.0.1');
			const before = Date.now();

			await runWithoutDaemon({
				...cfg(),
				onUpdateAvailable: async () => ({ defer: true, retryIn: 300_000 }),
			});

			expect(mockExecNpm).not.toHaveBeenCalled();
			const state = readState(stateFilePath(configDir));
			expect(state?.status).toBe('deferred');
			expect(state?.targetVersion).toBe('1.0.1');
			// retryAt should be approximately before + 300_000
			expect(state?.retryAt).toBeGreaterThanOrEqual(before + 300_000 - 100);
			expect(state?.retryAt).toBeLessThanOrEqual(Date.now() + 300_000 + 100);
		});
	});

	describe('deferred retryAt', () => {
		it('re-checks when deferred state retryAt has passed, even if cache is fresh', async () => {
			mockFetch.mockReturnValue('1.0.1');
			mockExecNpm.mockReturnValue('');

			// Set fresh cache (would normally prevent re-check)
			writeFileSync(join(configDir, 'update-cache.json'), JSON.stringify({
				lastCheckedAt: Date.now(),
				latestVersion: '1.0.0',
			}));

			// Set deferred state with retryAt in the past
			writeFileSync(join(configDir, 'update-state.json'), JSON.stringify({
				status: 'deferred',
				targetVersion: '1.0.1',
				retryAt: Date.now() - 1000, // already past
			}));

			await runWithoutDaemon(cfg());

			const state = readState(join(configDir, 'update-state.json'));
			// Should have re-checked and installed
			expect(state?.status).toBe('success');
			expect(mockFetch).toHaveBeenCalled();
			expect(mockExecNpm).toHaveBeenCalledWith(
				expect.arrayContaining(['install']),
				expect.anything(),
			);
		});

		it('does NOT re-check when deferred retryAt is still in the future', async () => {
			mockFetch.mockReturnValue('1.0.1');

			writeFileSync(join(configDir, 'update-cache.json'), JSON.stringify({
				lastCheckedAt: Date.now(),
				latestVersion: '1.0.0',
			}));

			writeFileSync(join(configDir, 'update-state.json'), JSON.stringify({
				status: 'deferred',
				targetVersion: '1.0.1',
				retryAt: Date.now() + 300_000, // still in the future
			}));

			await runWithoutDaemon(cfg());

			// Cache is fresh AND retryAt is future → no re-check
			expect(mockFetch).not.toHaveBeenCalled();
		});
	});

	describe('restartDaemon', () => {
		it('writes config.restart sentinel and sends POST /quit when daemon is running', async () => {
			const { writeFileSync } = await import('node:fs');
			const { join } = await import('node:path');

			// Write fake port file and health_token
			writeFileSync(join(configDir, 'config.port'), JSON.stringify({ port: 49876, pid: 99999 }));
			writeFileSync(join(configDir, 'health_token'), 'test-token');

			const mockFetchImpl = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
			vi.stubGlobal('fetch', mockFetchImpl);

			mockFetch.mockReturnValue('1.0.1');
			mockExecNpm.mockReturnValue('');

			await runWithoutDaemon({
				...cfg(),
				restartDaemon: {
					portFile: join(configDir, 'config.port'),
					healthTokenFile: join(configDir, 'health_token'),
				},
			});

			// State should be success
			const state = readState(stateFilePath(configDir));
			expect(state?.status).toBe('success');

			// config.restart sentinel should be written
			const { existsSync, readFileSync } = await import('node:fs');
			expect(existsSync(join(configDir, 'config.restart'))).toBe(true);
			expect(readFileSync(join(configDir, 'config.restart'), 'utf8')).toBe('1');

			// POST /quit should have been sent
			expect(mockFetchImpl).toHaveBeenCalledWith(
				'http://127.0.0.1:49876/quit',
				expect.objectContaining({ method: 'POST' }),
			);

			vi.unstubAllGlobals();
		});

		it('skips POST /quit when daemon port file is missing but still writes sentinel', async () => {
			const { writeFileSync } = await import('node:fs');
			const { join } = await import('node:path');

			const mockFetchImpl = vi.fn();
			vi.stubGlobal('fetch', mockFetchImpl);

			mockFetch.mockReturnValue('1.0.1');
			mockExecNpm.mockReturnValue('');

			await runWithoutDaemon({
				...cfg(),
				restartDaemon: {
					portFile: join(configDir, 'config.port'), // does not exist
					healthTokenFile: join(configDir, 'health_token'),
				},
			});

			const state = readState(stateFilePath(configDir));
			expect(state?.status).toBe('success');

			// Sentinel written even without daemon
			const { existsSync } = await import('node:fs');
			expect(existsSync(join(configDir, 'config.restart'))).toBe(true);

			// No POST /quit attempted
			expect(mockFetchImpl).not.toHaveBeenCalled();

			vi.unstubAllGlobals();
		});
	});
});
