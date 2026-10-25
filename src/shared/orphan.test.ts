import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reapOrphanNpm, type OrphanDeps } from './recovery.js';
import type { WithoutDaemonConfig } from '../types.js';

let configDir: string;
beforeEach(() => { configDir = mkdtempSync(join(tmpdir(), 'shared-updater-orphan-')); });
afterEach(() => { rmSync(configDir, { recursive: true, force: true }); });

const cfg = (extra: Partial<WithoutDaemonConfig> = {}): WithoutDaemonConfig =>
	({ pkgName: '@t/p', configDir, currentVersion: '1.0.0', strategy: 'without-daemon', ...extra });

function readLog(): string {
	const f = join(configDir, 'logs', `${new Date().toISOString().slice(0, 10)}.ndjson`);
	return existsSync(f) ? readFileSync(f, 'utf8') : '';
}

/** Virtual clock: sleeping advances time, so the bounded waits are exercised instantly and deterministically. */
function harness(over: Partial<OrphanDeps> & { runningUntil?: number; stopWorks?: boolean } = {}) {
	let t = 10_000_000;
	const stopTree = vi.fn();
	let stopped = false;
	const deps: OrphanDeps = {
		now: () => t,
		sleep: async (ms) => { t += ms; },
		isRunning: () => !stopped && t < (over.runningUntil ?? Infinity),
		stopTree: (pid) => { stopTree(pid); if (over.stopWorks !== false) stopped = true; },
		startMs: () => t,
		...over,
	};
	return { deps, stopTree, started: () => t };
}

describe('reapOrphanNpm', () => {
	it('does nothing when the journal has no npm pid', async () => {
		const h = harness();
		expect(await reapOrphanNpm(cfg(), {}, h.deps)).toBe(true);
		expect(h.stopTree).not.toHaveBeenCalled();
		expect(readLog()).toBe('');
	});

	it('does nothing (and says so) when the recorded npm is already gone', async () => {
		const h = harness({ isRunning: () => false });
		expect(await reapOrphanNpm(cfg(), { npmPid: 4242, npmStartedAt: h.started() }, h.deps)).toBe(true);
		expect(h.stopTree).not.toHaveBeenCalled();
		expect(readLog()).toContain('no longer running');
	});

	it('waits for an orphan that finishes within the bound, without stopping it', async () => {
		const h = harness({ runningUntil: 10_000_000 + 2_000 });
		const ok = await reapOrphanNpm(cfg({ orphanNpmWaitMs: 5_000 }), { npmPid: 4242, npmStartedAt: h.started() }, h.deps);
		expect(ok).toBe(true);
		expect(h.stopTree).not.toHaveBeenCalled();
		expect(readLog()).toContain('finished on its own');
	});

	it('stops the tree of an orphan still running after the bound, loudly', async () => {
		const h = harness();
		const ok = await reapOrphanNpm(cfg({ orphanNpmWaitMs: 1_000 }), { npmPid: 4242, npmStartedAt: h.started() }, h.deps);
		expect(ok).toBe(true);
		expect(h.stopTree).toHaveBeenCalledWith(4242);
		const log = readLog();
		expect(log).toContain('waiting up to 1000ms');
		expect(log).toContain('"level":"error"');
		expect(log).toContain('STOPPING its process tree');
	});

	it('returns false (repair must not race it) when the orphan survives being stopped', async () => {
		const h = harness({ stopWorks: false });
		const ok = await reapOrphanNpm(cfg({ orphanNpmWaitMs: 100 }), { npmPid: 4242, npmStartedAt: h.started() }, h.deps);
		expect(ok).toBe(false);
		expect(readLog()).toContain('STILL running');
		expect(readLog()).toContain('Stop it manually');
	});

	it('does not touch a live pid recorded longer ago than any npm can run (pid reuse)', async () => {
		const h = harness();
		const ok = await reapOrphanNpm(cfg(), { npmPid: 4242, npmStartedAt: h.started() - 10 * 60_000 }, h.deps);
		expect(ok).toBe(true);
		expect(h.stopTree).not.toHaveBeenCalled();
		expect(readLog()).toContain('assuming the pid was reused');
	});

	it('does not touch a live pid recorded without a spawn time', async () => {
		const h = harness();
		expect(await reapOrphanNpm(cfg(), { npmPid: 4242 }, h.deps)).toBe(true);
		expect(h.stopTree).not.toHaveBeenCalled();
		expect(readLog()).toContain('without a spawn time');
	});

	it('does not touch a live pid whose start time is far from the recorded spawn (pid reuse)', async () => {
		const h = harness({ startMs: () => 10_000_000 + 120_000 });
		const ok = await reapOrphanNpm(cfg(), { npmPid: 4242, npmStartedAt: 10_000_000 }, h.deps);
		expect(ok).toBe(true);
		expect(h.stopTree).not.toHaveBeenCalled();
		expect(readLog()).toContain('the pid was reused');
	});

	it('warns and relies on the age bound when the start time cannot be read', async () => {
		const h = harness({ startMs: () => null });
		await reapOrphanNpm(cfg({ orphanNpmWaitMs: 100 }), { npmPid: 4242, npmStartedAt: h.started() }, h.deps);
		expect(readLog()).toContain('identity is unverified');
		expect(h.stopTree).toHaveBeenCalledWith(4242);
	});
});
