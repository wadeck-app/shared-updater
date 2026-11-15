import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendLog } from './log.js';

// `<cli> cli update` sets UPDATER_FORCE=1 and runs this updater in front of the user: what the log says must also be on the screen, or
// "Running updater..." is the only thing they see, and a failed update looks like a success (exit 0, nothing printed).
describe('appendLog', () => {
	let configDir: string;
	let out: string[];
	let err: string[];
	let previousExitCode: typeof process.exitCode;

	beforeEach(() => {
		configDir = mkdtempSync(join(tmpdir(), 'shared-updater-log-'));
		out = [];
		err = [];
		previousExitCode = process.exitCode;
		process.exitCode = undefined;
		delete process.env['UPDATER_FORCE'];
		vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
			out.push(String(chunk));
			return true;
		});
		vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
			err.push(String(chunk));
			return true;
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env['UPDATER_FORCE'];
		process.exitCode = previousExitCode;
		rmSync(configDir, { recursive: true, force: true });
	});

	const logFileText = (): string => {
		const file = join(configDir, 'logs', `${new Date().toISOString().slice(0, 10)}.ndjson`);
		return existsSync(file) ? readFileSync(file, 'utf8') : '';
	};

	it('stays silent in the background (no explicit update): the log file only', () => {
		appendLog(configDir, 'info', 'a info');
		appendLog(configDir, 'warn', 'a warning');
		appendLog(configDir, 'error', 'an error');
		expect(out).toEqual([]);
		expect(err).toEqual([]);
		expect(process.exitCode).toBeUndefined();
		expect(logFileText()).toContain('an error');
	});

	it('shows the info lines on stdout when the user asked for the update', () => {
		process.env['UPDATER_FORCE'] = '1';
		appendLog(configDir, 'info', '@t/p update available: 1.0.0 → 1.0.1');
		expect(out).toEqual(['@t/p update available: 1.0.0 → 1.0.1\n']);
		expect(err).toEqual([]);
		expect(process.exitCode).toBeUndefined();
		expect(logFileText()).toContain('update available');
	});

	it('shows a warning on stderr without failing the command', () => {
		process.env['UPDATER_FORCE'] = '1';
		appendLog(configDir, 'warn', '@t/p cannot be verified');
		expect(err).toEqual(['[warning] @t/p cannot be verified\n']);
		expect(out).toEqual([]);
		expect(process.exitCode).toBeUndefined();
	});

	it('shows an error on stderr and makes the command exit 1', () => {
		process.env['UPDATER_FORCE'] = '1';
		appendLog(configDir, 'error', '@t/p install of 1.0.1 failed');
		expect(err).toEqual(['[error] @t/p install of 1.0.1 failed\n']);
		expect(process.exitCode).toBe(1);
	});

	it('masks a secret on the screen as it does in the file', () => {
		process.env['UPDATER_FORCE'] = '1';
		appendLog(configDir, 'info', 'registry said _authToken=abcdef123456');
		expect(out.join('')).not.toContain('abcdef123456');
		expect(out.join('')).toContain('_authToken=***');
	});
});
