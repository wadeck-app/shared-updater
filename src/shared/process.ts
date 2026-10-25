import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isPidAlive } from './lock.js';

/**
 * True when the process exists AND is not a zombie. A zombie (exited, not yet reaped) still
 * answers `kill(pid, 0)`; in a container without an init process it would stay "alive" forever.
 */
export function isProcessRunning(pid: number): boolean {
	if (!isPidAlive(pid)) return false;
	if (process.platform === 'linux') {
		try {
			const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
			// "<pid> (<comm>) <state> ...": comm may contain spaces and parens, so cut after the LAST ')'.
			const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3);
			if (state === 'Z' || state === 'X') return false;
		} catch { /* /proc unreadable or process just vanished: keep the kill(0) answer */ }
	}
	return true;
}

/**
 * Stops `pid` and everything it started. Never throws: a process that is already gone is the goal.
 *  - Windows: `taskkill /T /F` (the tree is resolved from ParentProcessId, which survives the death of a parent).
 *  - POSIX: SIGKILL to the process GROUP; the pid must have been spawned `detached` (own group, so
 *    pgid === pid). Falls back to the single pid when no such group exists.
 */
export function killProcessTree(pid: number): void {
	if (!Number.isInteger(pid) || pid <= 0) return;
	if (process.platform === 'win32') {
		spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 15_000 });
		return;
	}
	try {
		process.kill(-pid, 'SIGKILL');
		return;
	} catch { /* ESRCH (no such group) or EPERM: try the pid itself */ }
	try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
}

/** Parses ps `etime` ("[[dd-]hh:]mm:ss") into seconds; null when the shape is unknown. */
export function parseEtime(etime: string): number | null {
	const m = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(etime.trim());
	if (!m) return null;
	const [, d, h, min, s] = m;
	return Number(d ?? 0) * 86_400 + Number(h ?? 0) * 3_600 + Number(min) * 60 + Number(s);
}

/**
 * Epoch ms at which `pid` started, or null when it cannot be determined (process gone, no `ps` /
 * PowerShell, access denied). Resolution is ~1 s. Used to tell the npm we spawned from an
 * unrelated process that later got the same pid.
 */
export function getProcessStartMs(pid: number, now: number = Date.now()): number | null {
	try {
		if (process.platform === 'win32') {
			const r = spawnSync('powershell.exe', [
				'-NoProfile', '-NonInteractive', '-Command',
				`(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`,
			], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
			if (r.status !== 0) return null;
			const t = Date.parse(String(r.stdout).trim());
			return Number.isNaN(t) ? null : t;
		}
		const r = spawnSync('ps', ['-o', 'etime=', '-p', String(pid)], { encoding: 'utf8', timeout: 10_000 });
		if (r.status !== 0) return null;
		const secs = parseEtime(String(r.stdout));
		return secs === null ? null : now - secs * 1000;
	} catch {
		return null;
	}
}

/** npm process trees spawned by this process and still running: stopped by the interrupt guard. */
const tracked = new Set<number>();
export function trackChild(pid: number): void { tracked.add(pid); }
export function untrackChild(pid: number): void { tracked.delete(pid); }

/** Stops the tree of every tracked child; returns their pids. Synchronous (signal handlers, 'exit'). */
export function stopTrackedChildren(): number[] {
	const pids = [...tracked];
	for (const pid of pids) killProcessTree(pid);
	tracked.clear();
	return pids;
}
