/**
 * Integration tests for the without-daemon update strategy.
 *
 * Uses a real MockRegistry HTTP server serving valid npm tarballs.
 * No vi.mock — real npm processes are spawned.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockRegistry } from './MockRegistry.js';
import { runUpdater } from '../index.js';

// ---------------------------------------------------------------------------
// Registry shared across tests (started once)
// ---------------------------------------------------------------------------

const registry = new MockRegistry();

beforeAll(async () => {
	await registry.start();
});

afterAll(async () => {
	await registry.stop();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** npm global node_modules prefix is platform-dependent */
function getGlobalModulesDir(prefix: string): string {
	return process.platform === 'win32'
		? join(prefix, 'node_modules')
		: join(prefix, 'lib', 'node_modules');
}

function isInstalled(prefix: string, pkgName: string): boolean {
	const modsDir = getGlobalModulesDir(prefix);
	if (pkgName.startsWith('@')) {
		const parts = pkgName.slice(1).split('/') as [string, string];
		return existsSync(join(modsDir, `@${parts[0]}`, parts[1]));
	}
	return existsSync(join(modsDir, pkgName));
}

function readState(configDir: string): Record<string, unknown> {
	const path = join(configDir, 'update-state.json');
	if (!existsSync(path)) throw new Error(`update-state.json not found in ${configDir}`);
	return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

function readCache(configDir: string): Record<string, unknown> {
	const path = join(configDir, 'update-cache.json');
	if (!existsSync(path)) throw new Error(`update-cache.json not found in ${configDir}`);
	return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

const PKG = '@test/my-cli';

// ---------------------------------------------------------------------------
// Per-test setup/teardown
// ---------------------------------------------------------------------------

let configDir: string;
let npmPrefix: string;

beforeEach(() => {
	registry.clear();
	configDir = mkdtempSync(join(tmpdir(), 'updater-test-'));
	npmPrefix = mkdtempSync(join(tmpdir(), 'npm-prefix-'));
	// Point real npm at MockRegistry
	process.env['npm_config_registry'] = registry.url;
	process.env['npm_config_prefix'] = npmPrefix;
	process.env['npm_config_cache'] = join(npmPrefix, '.npm-cache');
	// Disable npm retries to keep tests fast (especially for 4xx/5xx failure paths)
	process.env['npm_config_fetch_retries'] = '0';
	process.env['npm_config_fetch_retry_mintimeout'] = '0';
	// selfCheck: no UPDATER_SELF_CHECK_CMD → returns true immediately
	delete process.env['UPDATER_SELF_CHECK_CMD'];
	delete process.env['UPDATER_FORCE'];
});

afterEach(() => {
	delete process.env['npm_config_registry'];
	delete process.env['npm_config_prefix'];
	delete process.env['npm_config_cache'];
	delete process.env['npm_config_fetch_retries'];
	delete process.env['npm_config_fetch_retry_mintimeout'];
	rmSync(configDir, { recursive: true, force: true });
	rmSync(npmPrefix, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('without-daemon strategy', () => {
	describe('version detection', () => {
		it('detects newer version via npm view', { timeout: 30_000 }, async () => {
			registry.setLatestVersion(PKG, '2.0.0');

			await runUpdater({
				pkgName: PKG,
				configDir,
				currentVersion: '1.0.0',
				strategy: 'without-daemon',
			});

			const state = readState(configDir);
			expect(state['status']).toBe('success');
			expect(state['targetVersion']).toBe('2.0.0');
			expect(state['currentVersion']).toBe('1.0.0');
		});

		it('considers itself up-to-date when versions match', { timeout: 30_000 }, async () => {
			registry.setLatestVersion(PKG, '1.0.0');

			await runUpdater({
				pkgName: PKG,
				configDir,
				currentVersion: '1.0.0',
				strategy: 'without-daemon',
			});

			// No state file written when up-to-date
			expect(existsSync(join(configDir, 'update-state.json'))).toBe(false);
			// Cache should still be written
			const cache = readCache(configDir);
			expect(cache['latestVersion']).toBe('1.0.0');
		});

		it('handles npm view failure gracefully (no state written)', { timeout: 30_000 }, async () => {
			// No version registered → registry returns 404 → npm view throws → caught
			await runUpdater({
				pkgName: PKG,
				configDir,
				currentVersion: '1.0.0',
				strategy: 'without-daemon',
			});

			expect(existsSync(join(configDir, 'update-state.json'))).toBe(false);
		});
	});

	describe('installation', () => {
		it('installs package when update available', { timeout: 30_000 }, async () => {
			registry.setLatestVersion(PKG, '3.0.0');

			await runUpdater({
				pkgName: PKG,
				configDir,
				currentVersion: '1.0.0',
				strategy: 'without-daemon',
			});

			expect(isInstalled(npmPrefix, PKG)).toBe(true);
			const state = readState(configDir);
			expect(state['status']).toBe('success');
			expect(state['targetVersion']).toBe('3.0.0');
		});

		it('writes success state after install', { timeout: 30_000 }, async () => {
			registry.setLatestVersion(PKG, '2.5.0');

			await runUpdater({
				pkgName: PKG,
				configDir,
				currentVersion: '2.0.0',
				strategy: 'without-daemon',
			});

			const state = readState(configDir);
			expect(state['status']).toBe('success');
			expect(state['targetVersion']).toBe('2.5.0');
			expect(state['previousVersion']).toBe('2.0.0');
			expect(typeof state['timestamp']).toBe('number');
		});

		it('does not install when up to date', { timeout: 30_000 }, async () => {
			registry.setLatestVersion(PKG, '1.0.0');

			await runUpdater({
				pkgName: PKG,
				configDir,
				currentVersion: '1.0.0',
				strategy: 'without-daemon',
			});

			expect(isInstalled(npmPrefix, PKG)).toBe(false);
		});
	});

	describe('onUpdateAvailable callback', () => {
		it('calls callback before install', { timeout: 30_000 }, async () => {
			registry.setLatestVersion(PKG, '2.0.0');
			let callbackVersion: string | null = null;

			await runUpdater({
				pkgName: PKG,
				configDir,
				currentVersion: '1.0.0',
				strategy: 'without-daemon',
				onUpdateAvailable: async (v) => {
					callbackVersion = v;
					return 'apply-now';
				},
			});

			expect(callbackVersion).toBe('2.0.0');
			expect(isInstalled(npmPrefix, PKG)).toBe(true);
		});

		it('defers when callback returns defer', { timeout: 30_000 }, async () => {
			registry.setLatestVersion(PKG, '2.0.0');

			await runUpdater({
				pkgName: PKG,
				configDir,
				currentVersion: '1.0.0',
				strategy: 'without-daemon',
				onUpdateAvailable: async () => ({ defer: true, retryIn: 60_000 }),
			});

			expect(isInstalled(npmPrefix, PKG)).toBe(false);
			const state = readState(configDir);
			expect(state['status']).toBe('deferred');
			expect(state['targetVersion']).toBe('2.0.0');
		});

		it('writes deferred state with correct retryAt', { timeout: 30_000 }, async () => {
			registry.setLatestVersion(PKG, '2.0.0');
			const before = Date.now();

			await runUpdater({
				pkgName: PKG,
				configDir,
				currentVersion: '1.0.0',
				strategy: 'without-daemon',
				onUpdateAvailable: async () => ({ defer: true, retryIn: 60_000 }),
			});

			const after = Date.now();
			const state = readState(configDir);
			expect(state['status']).toBe('deferred');
			expect(state['targetVersion']).toBe('2.0.0');
			expect(state['retryAt']).toBeGreaterThanOrEqual(before + 60_000);
			expect(state['retryAt']).toBeLessThanOrEqual(after + 60_000 + 5_000);
		});

		it('proceeds with apply-now result', { timeout: 30_000 }, async () => {
			registry.setLatestVersion(PKG, '2.0.0');

			await runUpdater({
				pkgName: PKG,
				configDir,
				currentVersion: '1.0.0',
				strategy: 'without-daemon',
				onUpdateAvailable: async () => 'apply-now',
			});

			expect(isInstalled(npmPrefix, PKG)).toBe(true);
			const state = readState(configDir);
			expect(state['status']).toBe('success');
		});
	});

	describe('self-check rollback', () => {
		it('rolls back and writes rolled-back state when self-check fails', { timeout: 30_000 }, async () => {
			registry.setLatestVersion(PKG, '2.0.0');
			// Also register 1.0.0 under a secondary channel so the rollback npm install can succeed
			registry.setLatestVersion(PKG, '1.0.0', 'v1');

			// Self-check always fails
			process.env['UPDATER_SELF_CHECK_CMD'] =
				`${process.execPath} -e "process.exit(1)"`;

			await runUpdater({
				pkgName: PKG,
				configDir,
				currentVersion: '1.0.0',
				strategy: 'without-daemon',
			});

			const state = readState(configDir);
			expect(state['status']).toBe('rolled-back');
			expect(state['targetVersion']).toBe('2.0.0');
			expect(state['previousVersion']).toBe('1.0.0');
		});
	});

	describe('install failure', () => {
		it('writes failed state when npm install fails', { timeout: 30_000 }, async () => {
			registry.setLatestVersion(PKG, '2.0.0');
			// Tarball returns 500, so npm install will fail
			registry.setInstallError(PKG, true);

			await runUpdater({
				pkgName: PKG,
				configDir,
				currentVersion: '1.0.0',
				strategy: 'without-daemon',
			});

			const state = readState(configDir);
			expect(state['status']).toBe('failed');
		});
	});

	describe('lock', () => {
		it('lock prevents concurrent installs', { timeout: 30_000 }, async () => {
			registry.setLatestVersion(PKG, '2.0.0');

			// Run two updaters simultaneously on the same configDir
			await Promise.all([
				runUpdater({ pkgName: PKG, configDir, currentVersion: '1.0.0', strategy: 'without-daemon' }),
				runUpdater({ pkgName: PKG, configDir, currentVersion: '1.0.0', strategy: 'without-daemon' }),
			]);

			// Exactly one successful update, not two
			const state = readState(configDir);
			expect(state['status']).toBe('success');

			// Verify the log doesn't show two install lines
			const today = new Date().toISOString().slice(0, 10);
			const log = readFileSync(join(configDir, 'logs', `${today}.ndjson`), 'utf8');
			const installLines = log.split('\n').filter(l => l.includes('updated to'));
			expect(installLines.length).toBe(1); // exactly one install happened
		});
	});

	describe('UPDATER_FORCE', () => {
		it('UPDATER_FORCE bypasses fresh cache and re-checks', { timeout: 30_000 }, async () => {
			registry.setLatestVersion(PKG, '2.0.0');

			// Prime the cache as "fresh" (just checked, same version as current)
			writeFileSync(join(configDir, 'update-cache.json'), JSON.stringify({
				lastCheckedAt: Date.now(), // very fresh
				latestVersion: '1.0.0',   // same as current
			}));

			// Without force: no update (cache says up-to-date)
			await runUpdater({ pkgName: PKG, configDir, currentVersion: '1.0.0', strategy: 'without-daemon' });
			expect(existsSync(join(configDir, 'update-state.json'))).toBe(false);

			// With force: bypasses cache, detects 2.0.0
			process.env['UPDATER_FORCE'] = '1';
			await runUpdater({ pkgName: PKG, configDir, currentVersion: '1.0.0', strategy: 'without-daemon' });

			const state = readState(configDir);
			expect(state['status']).toBe('success');
			expect(state['targetVersion']).toBe('2.0.0');
		});
	});

	describe('cache', () => {
		it('skips npm view if cache is fresh', { timeout: 30_000 }, async () => {
			// No version registered — if npm view fires, the 404 would cause an error
			// Cache is fresh so npm view must NOT be called
			const cacheData = { lastCheckedAt: Date.now(), latestVersion: '1.0.0' };
			writeFileSync(join(configDir, 'update-cache.json'), JSON.stringify(cacheData), 'utf8');

			await runUpdater({
				pkgName: PKG,
				configDir,
				currentVersion: '1.0.0',
				strategy: 'without-daemon',
			});

			// No state file: cache hit + versions equal → nothing to do
			expect(existsSync(join(configDir, 'update-state.json'))).toBe(false);
		});

		it('re-checks when cache is expired', { timeout: 30_000 }, async () => {
			registry.setLatestVersion(PKG, '2.0.0');

			// Write an expired cache: lastCheckedAt = 5 hours ago (> 4h default interval)
			const fiveHoursAgo = Date.now() - 5 * 60 * 60 * 1000;
			const cacheData = { lastCheckedAt: fiveHoursAgo, latestVersion: '1.0.0' };
			writeFileSync(join(configDir, 'update-cache.json'), JSON.stringify(cacheData), 'utf8');

			await runUpdater({
				pkgName: PKG,
				configDir,
				currentVersion: '1.0.0',
				strategy: 'without-daemon',
			});

			expect(isInstalled(npmPrefix, PKG)).toBe(true);
			const state = readState(configDir);
			expect(state['status']).toBe('success');
			expect(state['targetVersion']).toBe('2.0.0');
		});
	});
});
