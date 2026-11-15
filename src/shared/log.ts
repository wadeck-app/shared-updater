import { appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { redactSecrets } from './redact.js';

export function appendLog(configDir: string, level: 'info' | 'warn' | 'error', msg: string): void {
	const today = new Date().toISOString().slice(0, 10);
	const logFile = join(configDir, 'logs', `${today}.ndjson`);
	mkdirSync(dirname(logFile), { recursive: true });
	// Every log line goes through the redaction: npm / child output ends up here in error messages.
	const text = redactSecrets(msg);
	appendFileSync(logFile, JSON.stringify({ ts: new Date().toISOString(), level, msg: text }) + '\n');
	mirrorToScreen(level, text);
}

// UPDATER_FORCE=1 is only ever set by an explicit `<cli> cli update`: the user is in front of this updater and waits for its answer. The log
// file was its only trace: "Running updater..." was all they saw, nobody learnt the versions, and an abandoned update exited 0. In the
// background (no UPDATER_FORCE, stdio ignored by the caller) nothing is printed. An error is also the exit code of the update.
function mirrorToScreen(level: 'info' | 'warn' | 'error', text: string): void {
	if (process.env['UPDATER_FORCE'] !== '1') return;
	if (level === 'info') {
		process.stdout.write(`${text}\n`);
		return;
	}
	process.stderr.write(`[${level === 'warn' ? 'warning' : 'error'}] ${text}\n`);
	if (level === 'error') process.exitCode = 1;
}
