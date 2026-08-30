import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readUpdateConfig } from './config.js';

let configDir: string;

beforeEach(() => { configDir = mkdtempSync(join(tmpdir(), 'shared-updater-config-')); });
afterEach(() => { rmSync(configDir, { recursive: true, force: true }); });

describe('readUpdateConfig', () => {
	it('no config.yml → defaults', () => {
		const cfg = readUpdateConfig(configDir);
		expect(cfg.channel).toBe('latest');
		expect(cfg.checkIntervalMs).toBe(4 * 60 * 60 * 1000);
		expect(cfg.disabled).toBe(false);
	});

	it('channel: edge', () => {
		writeFileSync(join(configDir, 'config.yml'), 'channel: edge\n');
		expect(readUpdateConfig(configDir).channel).toBe('edge');
	});

	it('autoUpdate: false → disabled', () => {
		writeFileSync(join(configDir, 'config.yml'), 'autoUpdate: false\n');
		expect(readUpdateConfig(configDir).disabled).toBe(true);
	});

	it('checkInterval: 30m → 1800000ms', () => {
		writeFileSync(join(configDir, 'config.yml'), 'checkInterval: 30m\n');
		expect(readUpdateConfig(configDir).checkIntervalMs).toBe(30 * 60 * 1000);
	});

	it('checkInterval: 2h → 7200000ms', () => {
		writeFileSync(join(configDir, 'config.yml'), 'checkInterval: 2h\n');
		expect(readUpdateConfig(configDir).checkIntervalMs).toBe(2 * 60 * 60 * 1000);
	});

	it('checkInterval: 1d → 86400000ms', () => {
		writeFileSync(join(configDir, 'config.yml'), 'checkInterval: 1d\n');
		expect(readUpdateConfig(configDir).checkIntervalMs).toBe(24 * 60 * 60 * 1000);
	});

	it('checkInterval: 500ms → 500ms', () => {
		writeFileSync(join(configDir, 'config.yml'), 'checkInterval: 500ms\n');
		expect(readUpdateConfig(configDir).checkIntervalMs).toBe(500);
	});

	it('multiple fields', () => {
		writeFileSync(join(configDir, 'config.yml'), 'channel: edge\ncheckInterval: 30m\nautoUpdate: false\n');
		const cfg = readUpdateConfig(configDir);
		expect(cfg.channel).toBe('edge');
		expect(cfg.checkIntervalMs).toBe(30 * 60 * 1000);
		expect(cfg.disabled).toBe(true);
	});
});
