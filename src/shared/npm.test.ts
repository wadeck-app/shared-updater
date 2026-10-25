import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runNpmAsync } from './npm.js';
import { isProcessRunning, killProcessTree, stopTrackedChildren } from './process.js';

/** Stand-in for child_process.spawn: ignores the npm command line and runs `script` under node instead. */
function fakeSpawn(script: string): typeof spawn {
	return ((_cmd: string, _args: readonly string[], opts: Record<string, unknown>) => {
		const { shell: _shell, ...rest } = opts;
		return spawn(process.execPath, ['-e', script], rest);
	}) as unknown as typeof spawn;
}

async function waitFor(cond: () => boolean, what: string, ms = 20_000): Promise<void> {
	const t0 = Date.now();
	while (!cond()) {
		if (Date.now() - t0 > ms) throw new Error(`timed out after ${ms}ms waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 50));
	}
}

const reap: number[] = [];
const dirs: string[] = [];
afterEach(() => {
	for (const pid of reap.splice(0)) killProcessTree(pid);
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('runNpmAsync', () => {
	it('resolves with stdout', async () => {
		const out = await runNpmAsync(['root', '-g'], { spawnFn: fakeSpawn('process.stdout.write("hello")') });
		expect(out).toBe('hello');
	});

	it('rejects with "Command failed" and the stderr on a non-zero exit', async () => {
		const p = runNpmAsync(['install', '-g', 'x@1'], { spawnFn: fakeSpawn('console.error("registry exploded"); process.exit(3)') });
		await expect(p).rejects.toThrow(/Command failed: .*exit code 3\)\nregistry exploded/s);
	});

	it('reports the spawned pid synchronously through onSpawn', async () => {
		let reported: number | undefined;
		await runNpmAsync(['root', '-g'], { spawnFn: fakeSpawn('0'), onSpawn: (pid) => { reported = pid; } });
		expect(reported).toBeGreaterThan(0);
		expect(reported).not.toBe(process.pid);
	});

	it('stops npm and rejects when onSpawn (the journal write) throws', async () => {
		let pid = 0;
		const p = runNpmAsync(['install', '-g', 'x@1'], {
			spawnFn: fakeSpawn('setInterval(() => {}, 1000)'),
			onSpawn: (p2) => { pid = p2; throw new Error('disk full'); },
		});
		await expect(p).rejects.toThrow(/could not be journaled.*disk full/);
		await waitFor(() => !isProcessRunning(pid), `pid ${pid} to stop after a failed journal write`);
	});

	it('on timeout: rejects with code ETIMEDOUT and the child is gone', async () => {
		let pid = 0;
		const p = runNpmAsync(['install', '-g', 'x@1'], {
			spawnFn: fakeSpawn('setInterval(() => {}, 1000)'),
			timeout: 400,
			onSpawn: (p2) => { pid = p2; reap.push(p2); },
		});
		await expect(p).rejects.toMatchObject({ code: 'ETIMEDOUT' });
		await waitFor(() => !isProcessRunning(pid), `timed-out npm pid ${pid} to stop`);
	});

	it('stopTrackedChildren stops the whole tree (child and grandchild), not only the child', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'shared-updater-npm-'));
		dirs.push(dir);
		const pidFile = join(dir, 'grandchild.pid');
		// child (like sh/npm) -> grandchild (like the node that runs the install), both sleeping
		const script = `
const { spawn } = require('node:child_process');
const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));
setInterval(() => {}, 1000);`;
		let childPid = 0;
		const p = runNpmAsync(['install', '-g', 'x@1'], {
			spawnFn: fakeSpawn(script),
			onSpawn: (pid) => { childPid = pid; reap.push(pid); },
		});
		p.catch(() => { /* rejected on purpose below */ });
		await waitFor(() => existsSync(pidFile), 'the grandchild to publish its pid');
		const grandchildPid = Number(readFileSync(pidFile, 'utf8'));
		reap.push(grandchildPid);
		expect(isProcessRunning(childPid)).toBe(true);
		expect(isProcessRunning(grandchildPid)).toBe(true);

		const stopped = stopTrackedChildren();

		expect(stopped).toContain(childPid);
		await waitFor(() => !isProcessRunning(childPid), `child ${childPid} to stop`);
		await waitFor(() => !isProcessRunning(grandchildPid), `grandchild ${grandchildPid} to stop (tree kill)`);
		await expect(p).rejects.toThrow(/Command failed/);
	});
});
