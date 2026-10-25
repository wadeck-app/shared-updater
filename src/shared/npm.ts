import { execFileSync, execSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { killProcessTree, trackChild, untrackChild } from './process.js';

const NPM_CLI_JS = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const USE_NPM_CLI = existsSync(NPM_CLI_JS);

/** Synchronous npm, for short read-only calls (`npm view`, `npm root -g`). Installs use runNpmAsync. */
export function execNpm(args: string[], opts: { cwd?: string; timeout?: number } = {}): string {
	if (USE_NPM_CLI) {
		return execFileSync(process.execPath, [NPM_CLI_JS, ...args], {
			encoding: 'utf8',
			windowsHide: true,
			...opts,
		});
	}
	return execSync(['npm', ...args].join(' '), {
		encoding: 'utf8',
		windowsHide: true,
		...opts,
	});
}

export interface RunNpmOptions {
	cwd?: string;
	/** Stops the whole npm process tree and rejects with `code: 'ETIMEDOUT'` after this many ms. */
	timeout?: number;
	/** Called synchronously with the pid right after spawn, to journal it. If it throws, npm is stopped and the run rejects. */
	onSpawn?: (pid: number) => void;
	/** Injected by tests. */
	spawnFn?: typeof spawn;
}

/**
 * Asynchronous npm: same command line as execNpm, but the child's pid is known (so the caller can
 * journal it and stop the tree). POSIX: the child leads its own process group (`detached`), which
 * is what lets killProcessTree reach `sh` -> npm -> node. Resolves with stdout; rejects with
 * `Command failed: <cmd>\n<stderr>` on a non-zero exit, like execFileSync did.
 * Never waits on a stopped tree: on timeout it rejects right after the kill.
 */
export function runNpmAsync(args: string[], opts: RunNpmOptions = {}): Promise<string> {
	const spawnFn = opts.spawnFn ?? spawn;
	const detached = process.platform !== 'win32';
	const common = { cwd: opts.cwd, detached, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'] };
	const shellLine = ['npm', ...args].join(' ');
	const label = USE_NPM_CLI ? `${process.execPath} ${NPM_CLI_JS} ${args.join(' ')}` : shellLine;

	return new Promise<string>((resolve, reject) => {
		let child: ChildProcess;
		try {
			child = USE_NPM_CLI
				? spawnFn(process.execPath, [NPM_CLI_JS, ...args], common)
				: spawnFn(shellLine, [], { ...common, shell: true });
		} catch (err) {
			reject(err);
			return;
		}
		const pid = child.pid;
		let stdout = '';
		let stderr = '';
		let timer: NodeJS.Timeout | undefined;
		let settled = false;
		const settle = (fn: () => void): void => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			if (pid !== undefined) untrackChild(pid);
			fn();
		};

		child.stdout?.setEncoding('utf8');
		child.stderr?.setEncoding('utf8');
		child.stdout?.on('data', (c: string) => { stdout += c; });
		child.stderr?.on('data', (c: string) => { stderr += c; });
		child.on('error', (err) => settle(() => reject(err)));
		child.on('close', (code, signal) => settle(() => {
			if (code === 0) return resolve(stdout);
			const why = code === null ? `terminated by ${signal}` : `exit code ${code}`;
			const err = new Error(`Command failed: ${label} (${why})\n${stderr}`) as Error & { status?: number | null; stderr?: string };
			err.status = code;
			err.stderr = stderr;
			reject(err);
		}));

		if (pid !== undefined) {
			trackChild(pid);
			try {
				opts.onSpawn?.(pid);
			} catch (err) {
				killProcessTree(pid);
				settle(() => reject(new Error(`npm was spawned (pid ${pid}) but its pid could not be journaled, so it was stopped: ${err instanceof Error ? err.message : String(err)}`)));
				return;
			}
		}
		if (opts.timeout !== undefined && pid !== undefined) {
			timer = setTimeout(() => {
				killProcessTree(pid);
				child.stdout?.destroy();
				child.stderr?.destroy();
				const err = new Error(`Command timed out after ${opts.timeout}ms and its process tree was killed: ${label}`) as Error & { code?: string };
				err.code = 'ETIMEDOUT';
				settle(() => reject(err));
			}, opts.timeout);
		}
	});
}
