import { appendLog } from './log.js';
import { releaseLock } from './lock.js';
import { stopTrackedChildren } from './process.js';

const SIGNAL_EXIT_CODES: Record<string, number> = { SIGINT: 130, SIGTERM: 143, SIGBREAK: 149 };

export interface InterruptGuardOptions {
	configDir: string;
	pkgName: string;
	lockFile: string;
	/** Injected by tests; defaults to process.exit. */
	exit?: (code: number) => void;
	/** Injected by tests; defaults to stopping every npm tree this process spawned. Returns the pids stopped. */
	stopChildren?: () => number[];
}

/**
 * Stops the npm process tree this updater owns, releases the lock and logs when the updater is
 * interrupted (SIGINT / SIGTERM / SIGBREAK, or an 'exit' while npm is still running).
 *
 * The npm install is asynchronous, so a catchable signal is handled immediately and cuts npm
 * short; the half-done install is then repaired by the next run (the 'applying' state is
 * deliberately left untouched here).
 * SIGKILL, `taskkill /F`, `process.kill()` on Windows and a job-object kill run no handler at
 * all: the npm child survives as an orphan. The 'applying' state records its pid, and the next
 * run waits for / stops it before repairing (repairInterruptedInstall).
 */
export function installInterruptGuard(opts: InterruptGuardOptions): () => void {
	const exit = opts.exit ?? ((code: number) => process.exit(code));
	const signals = ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const;
	const handlers = new Map<string, () => void>();

	const stopChildren = opts.stopChildren ?? stopTrackedChildren;
	const onExit = (): void => {
		stopChildren();
		releaseLock(opts.lockFile);
	};
	let disposed = false;
	const dispose = (): void => {
		if (disposed) return;
		disposed = true;
		for (const [sig, h] of handlers) process.removeListener(sig, h);
		process.removeListener('exit', onExit);
	};

	for (const sig of signals) {
		const h = (): void => {
			let stopped: number[] = [];
			try { stopped = stopChildren(); } catch { /* must never block the release */ }
			try {
				appendLog(
					opts.configDir, 'error',
					`${opts.pkgName} updater interrupted by ${sig}: ${stopped.length > 0 ? `npm process tree(s) ${stopped.join(', ')} stopped, ` : ''}lock released; if an install was in progress the next run verifies the install and repairs it`,
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
