/**
 * Reproduces the incident: the updater process is killed while `npm install -g` is in flight.
 *
 * A real updater runs as a child process (built dist/), against MockRegistry and a temp npm
 * prefix. The registry stalls the 2.0.0 tarball so the kill lands mid-install; no handler can run
 * (hard kill), so only the persisted 'applying' state lets the next run repair.
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
import { runUpdater, verifyInstalled, execNpm } from './index.js';

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
	await registry.stop();
	for (const k of ['npm_config_registry', 'npm_config_prefix', 'npm_config_cache', 'npm_config_fetch_retries', 'npm_config_fetch_retry_mintimeout']) delete process.env[k];
	for (const d of [configDir, npmPrefix, scriptDir]) rmSync(d, { recursive: true, force: true });
});


describe('updater killed mid-install', () => {
	it('is repaired by the next run: previous version reinstalled, state finalised, lock taken over', { timeout: 120_000 }, async () => {
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
		const child = spawn(process.execPath, [childScript], { stdio: 'ignore', env: process.env });
		const exited = new Promise<void>((r) => child.on('exit', () => r()));
		await waitFor(() => applyingState() !== null, "the child to persist an 'applying' state");
		const applying = applyingState()!;
		expect(applying).toMatchObject({ previousVersion: '1.0.0', targetVersion: '2.0.0', pid: child.pid });
		// give npm time to open the stalled tarball request
		await new Promise((r) => setTimeout(r, 3_000));

		// 3. Hard kill (no handler can run). Stopping the registry also makes the orphaned npm fail.
		child.kill('SIGKILL');
		await exited;
		await registry.stop();
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
