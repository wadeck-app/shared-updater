import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tryAcquireLock, releaseLock } from './lock.js';

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
