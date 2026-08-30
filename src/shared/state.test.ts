import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readState, writeState, readCache, writeCache, stateFilePath, cacheFilePath } from './state.js';
import type { UpdateState, UpdateCache } from '../types.js';

let configDir: string;

beforeEach(() => { configDir = mkdtempSync(join(tmpdir(), 'shared-updater-state-')); });
afterEach(() => { rmSync(configDir, { recursive: true, force: true }); });

describe('state', () => {
	it('writeState / readState round-trip', () => {
		const state: UpdateState = { status: 'success', currentVersion: '1.0.0', targetVersion: '1.0.1', previousVersion: '1.0.0', timestamp: 1000 };
		writeState(stateFilePath(configDir), state);
		expect(readState(stateFilePath(configDir))).toEqual(state);
	});

	it('readState returns null for missing file', () => {
		expect(readState(join(configDir, 'missing.json'))).toBeNull();
	});

	it('readState returns null for corrupt file', () => {
		writeFileSync(stateFilePath(configDir), 'not-json');
		expect(readState(stateFilePath(configDir))).toBeNull();
	});
});

describe('cache', () => {
	it('writeCache / readCache round-trip', () => {
		const cache: UpdateCache = { lastCheckedAt: 12345, latestVersion: '2.0.0' };
		writeCache(cacheFilePath(configDir), cache);
		expect(readCache(cacheFilePath(configDir))).toEqual(cache);
	});

	it('readCache returns null for missing file', () => {
		expect(readCache(join(configDir, 'missing.json'))).toBeNull();
	});
});
