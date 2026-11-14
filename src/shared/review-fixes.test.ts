import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildNpmCommand, quoteCmdArg, runNpmAsync } from './npm.js';
import { journalApplying, readState, writeState } from './state.js';
import { redactSecrets } from './redact.js';
import { appendLog } from './log.js';
import { containsVersionToken, planBin } from './staged.js';

const dirs: string[] = [];
function tmp(): string {
	const d = mkdtempSync(join(tmpdir(), 'review-fixes-'));
	dirs.push(d);
	return d;
}
afterEach(() => {
	for (const d of dirs.splice(0)) {
		rmSync(d, { recursive: true, force: true });
	}
});

const SPACED = 'C:\\Users\\John Doe\\AppData\\staging\\20260101-1';

describe('npm command quoting (node install without a sibling npm-cli.js)', () => {
	it('Windows: every argument is quoted for cmd.exe, a path with a space stays one argument', () => {
		const c = buildNpmCommand(['install', '-g', '--prefix', SPACED, '@s/pkg@1.0.0'], { useNpmCli: false, platform: 'win32' });
		expect(c.shell).toBe(true);
		expect(c.file).toBe(`npm install -g --prefix "${SPACED}" @s/pkg@1.0.0`);
	});

	it('POSIX: no shell at all, the argv array is passed as is', () => {
		const c = buildNpmCommand(['install', '-g', '--prefix', '/home/john doe/stage', 'p@1'], { useNpmCli: false, platform: 'linux' });
		expect(c).toEqual({ file: 'npm', args: ['install', '-g', '--prefix', '/home/john doe/stage', 'p@1'], shell: false });
	});

	it('with npm-cli.js beside node: argv spawn of node', () => {
		const c = buildNpmCommand(['root', '-g', '--prefix', SPACED], { useNpmCli: true, platform: 'win32' });
		expect(c.shell).toBe(false);
		expect(c.file).toBe(process.execPath);
		expect(c.args.slice(1)).toEqual(['root', '-g', '--prefix', SPACED]);
	});

	it('refuses an argument that cannot be quoted for cmd.exe instead of passing it on', () => {
		expect(() => quoteCmdArg('C:\\a"b')).toThrow(/cannot pass/);
		expect(() => quoteCmdArg('C:\\%PATH%')).toThrow(/cannot pass/);
		expect(quoteCmdArg('plain-1.0.0')).toBe('plain-1.0.0');
		expect(quoteCmdArg('@scope/pkg@1.0.0')).toBe('@scope/pkg@1.0.0');
	});

	it('runNpmAsync spawns what the builder says (spawn seam, no real npm)', async () => {
		const calls: Array<{ file: string; args: readonly string[]; shell: unknown }> = [];
		const fake = ((file: string, args: readonly string[], opts: { shell?: unknown }) => {
			calls.push({ file, args, shell: opts.shell });
			return spawn(process.execPath, ['-e', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
		}) as unknown as typeof spawn;
		await runNpmAsync(['root', '-g', '--prefix', SPACED], { spawnFn: fake, useNpmCli: false, platform: 'win32' });
		await runNpmAsync(['root', '-g', '--prefix', '/a b/c'], { spawnFn: fake, useNpmCli: false, platform: 'linux' });
		expect(calls[0]).toEqual({ file: `npm root -g --prefix "${SPACED}"`, args: [], shell: true });
		expect(calls[1]).toEqual({ file: 'npm', args: ['root', '-g', '--prefix', '/a b/c'], shell: undefined });
	});
});

describe('journalApplying throws when it cannot journal', () => {
	const base = { currentVersion: '1.0.0', timestamp: 1 };

	it('missing state file', () => {
		expect(() => journalApplying(join(tmp(), 'update-state.json'), { phase: 'staging' })).toThrow(/missing, unreadable or corrupt/);
	});
	it('corrupt state file', () => {
		const f = join(tmp(), 'update-state.json');
		writeFileSync(f, '{nope');
		expect(() => journalApplying(f, { phase: 'staging' })).toThrow(/missing, unreadable or corrupt/);
	});
	it('state that is not applying', () => {
		const f = join(tmp(), 'update-state.json');
		writeState(f, { status: 'success', ...base });
		expect(() => journalApplying(f, { phase: 'staging' })).toThrow(/expected 'applying'/);
	});
	it('applying: merged and written', () => {
		const f = join(tmp(), 'update-state.json');
		writeState(f, { status: 'applying', ...base, pid: 7 });
		journalApplying(f, { phase: 'staged', stagePath: '/s' });
		expect(readState(f)).toMatchObject({ status: 'applying', pid: 7, phase: 'staged', stagePath: '/s' });
	});
});

describe('redaction', () => {
	it('masks real tokens, including an npm token of 20+ alphanumerics', () => {
		const out = redactSecrets(`npm_${'a1B2'.repeat(9)} ghp_abcdefghij1234 Bearer abc.def`);
		expect(out).toContain('npm_***');
		expect(out).not.toMatch(/a1B2a1B2|abcdefghij1234|abc\.def/);
	});

	it('leaves npm_config_* variable names and short npm_ words alone', () => {
		const text = 'npm_config_registry=http://127.0.0.1:1 npm_config_prefix npm_execpath npm_short';
		expect(redactSecrets(text)).toBe(text);
	});

	it('writeState masks the error field', () => {
		const f = join(tmp(), 'update-state.json');
		writeState(f, { status: 'failed', currentVersion: '1.0.0', timestamp: 1, error: 'install failed: _authToken=SECRETVALUE and npm_config_registry stays' });
		const raw = readFileSync(f, 'utf8');
		expect(raw).not.toContain('SECRETVALUE');
		expect(raw).toContain('npm_config_registry');
	});

	it('appendLog masks the message', () => {
		const d = tmp();
		appendLog(d, 'error', `npm said: Bearer topsecret.value and ghp_abcdefghij1234`);
		const day = new Date().toISOString().slice(0, 10);
		const raw = readFileSync(join(d, 'logs', `${day}.ndjson`), 'utf8');
		expect(raw).not.toMatch(/topsecret|abcdefghij1234/);
	});
});

describe('containsVersionToken', () => {
	it('is a whole token, not a substring', () => {
		expect(containsVersionToken('my-cli 1.0.1', '1.0.1')).toBe(true);
		expect(containsVersionToken('my-cli 1.0.10', '1.0.1')).toBe(false);
		expect(containsVersionToken('my-cli 11.0.1', '1.0.1')).toBe(false);
		expect(containsVersionToken('my-cli 1.0.1.2', '1.0.1')).toBe(false);
		expect(containsVersionToken('my-cli 1.0.1-beta', '1.0.1')).toBe(false);
	});
	it('accepts the usual decorations', () => {
		expect(containsVersionToken('v1.0.1', '1.0.1')).toBe(true);
		expect(containsVersionToken('my-cli (1.0.1).', '1.0.1')).toBe(true);
		expect(containsVersionToken('version: 1.0.1\n', '1.0.1')).toBe(true);
		expect(containsVersionToken('2026.11.8-292-abcdef1 ok', '2026.11.8-292-abcdef1')).toBe(true);
	});
});

describe('planBin', () => {
	const bin = { 'my-cli': 'bin/cli' };
	function pkg(file: string, content: Buffer | string): string {
		const d = tmp();
		mkdirSync(join(d, 'bin'), { recursive: true });
		writeFileSync(join(d, file), content);
		return d;
	}
	it('a .js file is runnable, whatever it contains', () => {
		expect(planBin(pkg('bin/cli.js', 'x'), { 'my-cli': 'bin/cli.js' }, '@s/my-cli').runnable).toBe(true);
	});
	it('extensionless: node shebang yes, shell shebang / native binary / no shebang no', () => {
		expect(planBin(pkg('bin/cli', '#!/usr/bin/env node\n'), bin, '@s/my-cli').runnable).toBe(true);
		expect(planBin(pkg('bin/cli', '#!/bin/sh\necho\n'), bin, '@s/my-cli').runnable).toBe(false);
		expect(planBin(pkg('bin/cli', Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 1])), bin, '@s/my-cli').runnable).toBe(false);
		expect(planBin(pkg('bin/cli', 'echo hi'), bin, '@s/my-cli').runnable).toBe(false);
	});
	it('no bin or a missing file: not runnable, with the reason', () => {
		const d = tmp();
		const none = planBin(d, {}, '@s/my-cli');
		expect(none).toMatchObject({ runnable: false });
		const missing = planBin(d, bin, '@s/my-cli');
		expect(missing).toMatchObject({ runnable: false });
		expect((missing as { reason: string }).reason).toContain('does not exist');
	});
});
