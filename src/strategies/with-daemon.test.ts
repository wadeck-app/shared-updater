import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as http from 'node:http';

vi.mock('../shared/fetch.js', () => ({ fetchLatestVersion: vi.fn() }));
vi.mock('../shared/npm.js', () => ({ execNpm: vi.fn(), USE_NPM_CLI: false }));

import { fetchLatestVersion } from '../shared/fetch.js';
import { runWithDaemon } from './with-daemon.js';
import { readState, stateFilePath, cacheFilePath, lockFilePath } from '../shared/state.js';
import { tryAcquireLock, releaseLock } from '../shared/lock.js';

const mockFetch = vi.mocked(fetchLatestVersion);

let configDir: string;

function writePortFile(port: number): void {
	writeFileSync(
		join(configDir, 'config.port'),
		JSON.stringify({ sdkVersion: 1, port, pid: process.pid, startedAt: new Date().toISOString() }),
	);
}

function writeHealthToken(token: string): void {
	writeFileSync(join(configDir, 'health_token'), token);
}

const TOKEN = 'deadbeefdeadbeefdeadbeefdeadbeef';
const cfg = () => ({ pkgName: '@test/pkg', configDir, currentVersion: '1.0.0', strategy: 'with-daemon' as const });

beforeEach(() => {
	configDir = mkdtempSync(join(tmpdir(), 'shared-updater-wd2-'));
	mockFetch.mockReset();
	delete process.env['UPDATER_FORCE'];
});

afterEach(() => {
	rmSync(configDir, { recursive: true, force: true });
	delete process.env['UPDATER_FORCE'];
});

describe('with-daemon strategy', () => {
	it('writes update-available state without POST /quit when no FORCE', async () => {
		mockFetch.mockReturnValue('1.0.1');

		await runWithDaemon(cfg());

		const state = readState(stateFilePath(configDir));
		expect(state?.status).toBe('update-available');
		expect(state?.targetVersion).toBe('1.0.1');
	});

	it('sends POST /quit with correct token when UPDATER_FORCE=1', async () => {
		mockFetch.mockReturnValue('1.0.1');
		process.env['UPDATER_FORCE'] = '1';

		// Start mock health server
		let receivedAuth = '';
		const server = http.createServer((req, res) => {
			receivedAuth = req.headers['authorization'] ?? '';
			res.writeHead(200).end('{}');
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		const port = (server.address() as http.AddressInfo).port;
		writePortFile(port);
		writeHealthToken(TOKEN);

		try {
			await runWithDaemon(cfg());
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}

		expect(receivedAuth).toBe(`Bearer ${TOKEN}`);
		expect(readState(stateFilePath(configDir))?.status).toBe('update-available');
	});

	it('does not write state when already up to date', async () => {
		mockFetch.mockReturnValue('1.0.0');

		await runWithDaemon(cfg());

		expect(readState(stateFilePath(configDir))).toBeNull();
	});

	it('skips POST /quit when no port file and FORCE', async () => {
		mockFetch.mockReturnValue('1.0.1');
		process.env['UPDATER_FORCE'] = '1';
		// no port file written

		await expect(runWithDaemon(cfg())).resolves.not.toThrow();
		// state is still written
		expect(readState(stateFilePath(configDir))?.status).toBe('update-available');
	});

	it('does not crash when port file exists but health_token missing', async () => {
		mockFetch.mockReturnValue('1.0.1');
		process.env['UPDATER_FORCE'] = '1';
		writePortFile(9999);
		// no health_token file

		await expect(runWithDaemon(cfg())).resolves.not.toThrow();
	});

	it('does not crash when POST /quit times out (server never responds)', async () => {
		mockFetch.mockReturnValue('1.0.1');
		process.env['UPDATER_FORCE'] = '1';

		const server = http.createServer((_req, _res) => {
			// never respond — simulate hang
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		const port = (server.address() as http.AddressInfo).port;
		writePortFile(port);
		writeHealthToken(TOKEN);

		// Replace fetch with a fast-failing mock to avoid real 5s wait
		vi.stubGlobal('fetch', () => Promise.reject(Object.assign(new Error('AbortError'), { name: 'AbortError' })));

		try {
			await expect(runWithDaemon(cfg())).resolves.not.toThrow();
		} finally {
			vi.unstubAllGlobals();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

	it('skips version check when cache is fresh', async () => {
		const { writeCache } = await import('../shared/state.js');
		writeCache(cacheFilePath(configDir), { lastCheckedAt: Date.now(), latestVersion: '1.0.0' });

		await runWithDaemon(cfg());

		expect(mockFetch).not.toHaveBeenCalled();
	});

	it('second concurrent run is skipped (lock held)', async () => {
		mockFetch.mockReturnValue('1.0.1');
		tryAcquireLock(lockFilePath(configDir));
		try {
			await runWithDaemon(cfg());
			expect(mockFetch).not.toHaveBeenCalled();
		} finally {
			releaseLock(lockFilePath(configDir));
		}
	});
});
