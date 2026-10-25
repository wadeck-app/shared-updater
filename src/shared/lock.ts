import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';

const LOCK_STALE_MS = 10 * 60 * 1000;

/**
 * True when a process with this pid exists. EPERM means "exists but owned by someone else" (seen
 * on Windows for processes of another session): that is alive, not dead.
 */
export function isPidAlive(pid: unknown): boolean {
	if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === 'EPERM';
	}
}

function lockIsHeld(lockFile: string): boolean {
	try {
		const { pid, ts } = JSON.parse(readFileSync(lockFile, 'utf8'));
		// Dead pid: taken over immediately. Live pid: respected until the lock is older than the
		// stale threshold (guards against pid reuse and a hung holder).
		return Date.now() - ts < LOCK_STALE_MS && isPidAlive(pid);
	} catch {
		return false; // corrupt lock file
	}
}

export function tryAcquireLock(lockFile: string): boolean {
	mkdirSync(dirname(lockFile), { recursive: true });
	const body = JSON.stringify({ pid: process.pid, ts: Date.now() });
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			// 'wx' is atomic: of two racing processes exactly one creates the file.
			writeFileSync(lockFile, body, { flag: 'wx' });
			return true;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
		}
		if (lockIsHeld(lockFile)) return false;
		try { rmSync(lockFile); } catch { /* lost the race to another taker: retry decides */ }
	}
	return false;
}

export function releaseLock(lockFile: string): void {
	try { rmSync(lockFile); } catch { /* ignore */ }
}
