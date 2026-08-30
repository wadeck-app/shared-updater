import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { UpdateCache, UpdateState } from '../types.js';

export function readState(stateFile: string): UpdateState | null {
	try {
		return JSON.parse(readFileSync(stateFile, 'utf8'));
	} catch { return null; }
}

export function writeState(stateFile: string, state: UpdateState): void {
	mkdirSync(dirname(stateFile), { recursive: true });
	writeFileSync(stateFile, JSON.stringify(state, null, 2));
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
