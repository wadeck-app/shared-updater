import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { getProcessStartMs, isProcessRunning, killProcessTree, parseEtime } from './process.js';

const reap: number[] = [];
afterEach(() => { for (const pid of reap.splice(0)) killProcessTree(pid); });

function sleeper(): number {
	const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
		stdio: 'ignore', windowsHide: true, detached: process.platform !== 'win32',
	});
	c.unref();
	reap.push(c.pid!);
	return c.pid!;
}

describe('parseEtime', () => {
	it.each([
		['00:05', 5], ['12:34', 754], ['01:02:03', 3723], ['2-03:04:05', 2 * 86400 + 3 * 3600 + 4 * 60 + 5], ['  07:08\n', 428],
	])('%j -> %i s', (input, secs) => { expect(parseEtime(input)).toBe(secs); });
	it('returns null for an unknown shape', () => { expect(parseEtime('garbage')).toBeNull(); });
});

describe('process helpers (real processes)', () => {
	it('isProcessRunning: true for a live child, false after killProcessTree', async () => {
		const pid = sleeper();
		expect(isProcessRunning(pid)).toBe(true);
		killProcessTree(pid);
		const t0 = Date.now();
		while (isProcessRunning(pid)) {
			if (Date.now() - t0 > 10_000) throw new Error(`pid ${pid} still running 10s after killProcessTree`);
			await new Promise((r) => setTimeout(r, 50));
		}
	});

	it('isProcessRunning is false for a nonsense pid', () => {
		expect(isProcessRunning(0)).toBe(false);
		expect(isProcessRunning(-5)).toBe(false);
	});

	it('getProcessStartMs of a just-spawned process is within 15 s of now', { timeout: 30_000 }, () => {
		const pid = sleeper();
		const start = getProcessStartMs(pid);
		if (start === null) throw new Error(`getProcessStartMs(${pid}) returned null on ${process.platform}: ps / PowerShell unavailable?`);
		expect(Math.abs(start - Date.now())).toBeLessThan(15_000);
	});

	it('getProcessStartMs is null for a pid above every OS limit', { timeout: 30_000 }, () => {
		expect(getProcessStartMs(2 ** 22 + 12345)).toBeNull();
	});
});
