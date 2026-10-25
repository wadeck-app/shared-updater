import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tryAcquireLock, releaseLock, isPidAlive } from './lock.js';

let configDir: string;
let lockFile: string;

beforeEach(() => {
	configDir = mkdtempSync(join(tmpdir(), 'shared-updater-lock-'));
	lockFile = join(configDir, 'update.lock');
});
afterEach(() => { rmSync(configDir, { recursive: true, force: true }); });

describe('tryAcquireLock', () => {
	it('acquires lock when file absent', () => {
		expect(tryAcquireLock(lockFile)).toBe(true);
		expect(existsSync(lockFile)).toBe(true);
	});

	it('rejects second acquire from same living process', () => {
		tryAcquireLock(lockFile);
		expect(tryAcquireLock(lockFile)).toBe(false);
	});

	it('acquires stale lock from dead process', () => {
		const result = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
		const deadPid = result.pid!;
		writeFileSync(lockFile, JSON.stringify({ pid: deadPid, ts: Date.now() }));
		expect(tryAcquireLock(lockFile)).toBe(true);
	});

	it('acquires over corrupt lock file', () => {
		writeFileSync(lockFile, 'not-json');
		expect(tryAcquireLock(lockFile)).toBe(true);
	});

	it('acquires stale lock by age (> 10 min)', () => {
		writeFileSync(lockFile, JSON.stringify({ pid: process.pid, ts: Date.now() - 11 * 60 * 1000 }));
		// stale by time, even if PID matches current process — age check runs first
		expect(tryAcquireLock(lockFile)).toBe(true);
	});

	it('creates parent directories when they do not exist', () => {
		const deepLock = join(configDir, 'nested', 'subdir', 'update.lock');
		expect(tryAcquireLock(deepLock)).toBe(true);
		expect(existsSync(deepLock)).toBe(true);
	});
});

describe('releaseLock', () => {
	it('removes lock file', () => {
		tryAcquireLock(lockFile);
		releaseLock(lockFile);
		expect(existsSync(lockFile)).toBe(false);
	});

	it('does not throw if file already absent', () => {
		expect(() => releaseLock(lockFile)).not.toThrow();
	});
});

describe('tryAcquireLock liveness edge cases', () => {
	it('takes over immediately a lock whose pid is dead, even when it is only seconds old', () => {
		const deadPid = spawnSync(process.execPath, ['-e', '0']).pid!;
		writeFileSync(lockFile, JSON.stringify({ pid: deadPid, ts: Date.now() }));
		expect(tryAcquireLock(lockFile)).toBe(true);
		expect(JSON.parse(readFileSync(lockFile, 'utf8')).pid).toBe(process.pid);
	});

	it('respects a live foreign pid within the stale window (pid reuse is bounded by 10 min)', () => {
		writeFileSync(lockFile, JSON.stringify({ pid: process.ppid, ts: Date.now() }));
		expect(tryAcquireLock(lockFile)).toBe(false);
	});

	it('treats EPERM from process.kill as alive (process of another session), not dead', () => {
		const spy = vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); });
		try {
			expect(isPidAlive(4242)).toBe(true);
		} finally { spy.mockRestore(); }
	});

	it('treats ESRCH and nonsense pids as dead', () => {
		const spy = vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' }); });
		try {
			expect(isPidAlive(4242)).toBe(false);
		} finally { spy.mockRestore(); }
		expect(isPidAlive(undefined)).toBe(false);
		expect(isPidAlive(-1)).toBe(false);
	});

	it('takes over a lock without pid/ts (valid JSON, wrong shape)', () => {
		writeFileSync(lockFile, '{}');
		expect(tryAcquireLock(lockFile)).toBe(true);
	});
});
