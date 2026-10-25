import { appendLog } from './log.js';
import { releaseLock } from './lock.js';

const SIGNAL_EXIT_CODES: Record<string, number> = { SIGINT: 130, SIGTERM: 143, SIGBREAK: 149 };

export interface InterruptGuardOptions {
	configDir: string;
	pkgName: string;
	lockFile: string;
	/** Injected by tests; defaults to process.exit. */
	exit?: (code: number) => void;
}

/**
 * Releases the lock and logs when the updater is interrupted.
 *
 * Limits, by design:
 *  - Node only runs a signal handler when the event loop is free, and the npm install is a
 *    synchronous call: a signal that arrives during it is delivered once npm has returned.
 *    That is the safe direction (npm is never cut in half by a catchable signal).
 *  - SIGKILL, `taskkill /F`, `process.kill()` on Windows and a job-object kill run no handler at
 *    all. That case is covered by the persisted 'applying' state, repaired by the next run.
 * The 'applying' state is deliberately left untouched here so the next run still sees it.
 */
export function installInterruptGuard(opts: InterruptGuardOptions): () => void {
	const exit = opts.exit ?? ((code: number) => process.exit(code));
	const signals = ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const;
	const handlers = new Map<string, () => void>();

	const onExit = (): void => releaseLock(opts.lockFile);
	let disposed = false;
	const dispose = (): void => {
		if (disposed) return;
		disposed = true;
		for (const [sig, h] of handlers) process.removeListener(sig, h);
		process.removeListener('exit', onExit);
	};

	for (const sig of signals) {
		const h = (): void => {
			try {
				appendLog(
					opts.configDir, 'error',
					`${opts.pkgName} updater interrupted by ${sig}: lock released; if an install was in progress the next run verifies the install and repairs it`,
				);
			} catch { /* logging must never block the release */ }
			releaseLock(opts.lockFile);
			dispose();
			exit(SIGNAL_EXIT_CODES[sig] ?? 1);
		};
		handlers.set(sig, h);
		process.on(sig, h);
	}
	process.on('exit', onExit);
	return dispose;
}
