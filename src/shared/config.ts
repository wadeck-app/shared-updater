import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { UpdateConfig } from '../types.js';

const DEFAULT_CHANNEL = 'latest';
const DEFAULT_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

export function readUpdateConfig(configDir: string): UpdateConfig {
	const configFile = join(configDir, 'config.yml');
	if (!existsSync(configFile)) {
		return { channel: DEFAULT_CHANNEL, checkIntervalMs: DEFAULT_CHECK_INTERVAL_MS, disabled: false };
	}
	const raw = readFileSync(configFile, 'utf8');
	const channel = raw.match(/^channel:\s*(\S+)/m)?.[1] ?? DEFAULT_CHANNEL;
	const intervalRaw = raw.match(/^checkInterval:\s*(\S+)/m)?.[1];
	const disabled = /^autoUpdate:\s*false/m.test(raw);
	return {
		channel,
		checkIntervalMs: intervalRaw ? parseIntervalMs(intervalRaw) : DEFAULT_CHECK_INTERVAL_MS,
		disabled,
	};
}

function parseIntervalMs(s: string): number {
	const match = s.match(/^(\d+)(ms|s|m|h|d)?$/);
	if (!match) return DEFAULT_CHECK_INTERVAL_MS;
	const n = parseInt(match[1], 10);
	switch (match[2]) {
		case 'ms': return n;
		case 's':  return n * 1000;
		case 'm':  return n * 60 * 1000;
		case 'h':  return n * 60 * 60 * 1000;
		case 'd':  return n * 24 * 60 * 60 * 1000;
		default:   return n;
	}
}
