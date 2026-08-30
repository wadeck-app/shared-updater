import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

const LOCK_STALE_MS = 10 * 60 * 1000;

export function tryAcquireLock(lockFile: string): boolean {
	mkdirSync(dirname(lockFile), { recursive: true });
	if (existsSync(lockFile)) {
		try {
			const { pid, ts } = JSON.parse(readFileSync(lockFile, 'utf8'));
			const age = Date.now() - ts;
			if (age < LOCK_STALE_MS) {
				try {
					process.kill(pid, 0);
					return false;
				} catch {
					// process dead — stale lock
				}
			}
		} catch {
			// corrupt lock file — overwrite
		}
	}
	writeFileSync(lockFile, JSON.stringify({ pid: process.pid, ts: Date.now() }));
	return true;
}

export function releaseLock(lockFile: string): void {
	try { rmSync(lockFile); } catch { /* ignore */ }
}
