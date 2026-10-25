import { mkdirSync, writeFileSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import type { UpdateCache, UpdateState } from '../types.js';

export function readState(stateFile: string): UpdateState | null {
	try {
		return JSON.parse(readFileSync(stateFile, 'utf8'));
	} catch { return null; }
}

export function writeState(stateFile: string, state: UpdateState): void {
	mkdirSync(dirname(stateFile), { recursive: true });
	const body = JSON.stringify(state, null, 2);
	// Write-then-rename: a kill mid-write must not leave a truncated file, because the 'applying'
	// record is what lets the next run detect an interrupted install.
	const tmp = `${stateFile}.${process.pid}.tmp`;
	try {
		writeFileSync(tmp, body);
		renameSync(tmp, stateFile);
	} catch {
		try { rmSync(tmp); } catch { /* ignore */ }
		writeFileSync(stateFile, body);
	}
}

/**
 * Journals (or clears, with `npm: null`) the pid of the npm child in an 'applying' state. No-op
 * when the state is not 'applying'. Throws when the write fails: an npm pid that cannot be
 * journaled must not be left running unrecorded (runNpmAsync stops it).
 */
export function journalNpmChild(stateFile: string, npm: { pid: number; startedAt: number } | null): void {
	const state = readState(stateFile);
	if (!state || state.status !== 'applying') return;
	const { npmPid: _p, npmStartedAt: _s, ...rest } = state;
	writeState(stateFile, npm ? { ...rest, npmPid: npm.pid, npmStartedAt: npm.startedAt } : rest);
}

export function readCache(cacheFile: string): UpdateCache | null {
	try {
		return JSON.parse(readFileSync(cacheFile, 'utf8'));
	} catch { return null; }
}

export function writeCache(cacheFile: string, cache: UpdateCache): void {
	mkdirSync(dirname(cacheFile), { recursive: true });
	writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
}

export function stateFilePath(configDir: string): string {
	return `${configDir}/update-state.json`;
}

export function cacheFilePath(configDir: string): string {
	return `${configDir}/update-cache.json`;
}

export function lockFilePath(configDir: string): string {
	return `${configDir}/update.lock`;
}
