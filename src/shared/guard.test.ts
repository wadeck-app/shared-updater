import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installInterruptGuard } from './guard.js';
import { tryAcquireLock } from './lock.js';

let configDir: string;
let lockFile: string;

beforeEach(() => {
	configDir = mkdtempSync(join(tmpdir(), 'shared-updater-guard-'));
	lockFile = join(configDir, 'update.lock');
});
afterEach(() => { rmSync(configDir, { recursive: true, force: true }); });

// process.emit('SIGTERM') would also fire the test runner's own listeners: call only ours.
function ourListener(signal: string, install: () => () => void): { fire: () => void; dispose: () => void } {
	const sig = signal as NodeJS.Signals;
	const before = new Set(process.listeners(sig));
	const dispose = install();
	const mine = process.listeners(sig).find((l) => !before.has(l));
	if (!mine) throw new Error(`guard did not register a ${signal} listener`);
	return { fire: () => (mine as () => void)(), dispose };
}

describe('installInterruptGuard', () => {
	for (const [signal, code] of [['SIGTERM', 143], ['SIGINT', 130], ['SIGBREAK', 149]] as const) {
		it(`${signal}: releases the lock, logs the interruption, exits ${code}`, () => {
			expect(tryAcquireLock(lockFile)).toBe(true);
			const exit = vi.fn();
			const { fire, dispose } = ourListener(signal, () => installInterruptGuard({ configDir, pkgName: '@t/p', lockFile, exit }));

			fire();

			expect(existsSync(lockFile)).toBe(false);
			expect(exit).toHaveBeenCalledWith(code);
			const log = readFileSync(join(configDir, 'logs', `${new Date().toISOString().slice(0, 10)}.ndjson`), 'utf8');
			expect(log).toContain(`interrupted by ${signal}`);
			dispose();
		});
	}

	it('dispose removes the listeners', () => {
		const before = process.listenerCount('SIGTERM');
		const dispose = installInterruptGuard({ configDir, pkgName: '@t/p', lockFile, exit: vi.fn() });
		expect(process.listenerCount('SIGTERM')).toBe(before + 1);
		dispose();
		expect(process.listenerCount('SIGTERM')).toBe(before);
	});
});
