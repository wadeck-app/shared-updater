import { appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { redactSecrets } from './redact.js';

export function appendLog(configDir: string, level: 'info' | 'warn' | 'error', msg: string): void {
	const today = new Date().toISOString().slice(0, 10);
	const logFile = join(configDir, 'logs', `${today}.ndjson`);
	mkdirSync(dirname(logFile), { recursive: true });
	// Every log line goes through the redaction: npm / child output ends up here in error messages.
	appendFileSync(logFile, JSON.stringify({ ts: new Date().toISOString(), level, msg: redactSecrets(msg) }) + '\n');
}
