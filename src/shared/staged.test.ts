import { describe, it, expect } from 'vitest';
import { normalizeBin, pickBinEntry } from './staged.js';
import { redactSecrets } from './redact.js';

describe('normalizeBin', () => {
	it('names a string bin after the unscoped package and normalizes the path', () => {
		expect(normalizeBin({ bin: './bin\\cli.js' }, '@scope/my-cli')).toEqual({ 'my-cli': 'bin/cli.js' });
	});
	it('keeps an object bin, ignoring non-string values', () => {
		expect(normalizeBin({ bin: { a: './x.js', b: 3 } }, 'p')).toEqual({ a: 'x.js' });
	});
	it('is empty without bin', () => {
		expect(normalizeBin({}, 'p')).toEqual({});
	});
});

describe('pickBinEntry', () => {
	it('prefers the command named like the package, else the first', () => {
		expect(pickBinEntry({ other: 'o.js', 'my-cli': 'm.js' }, '@s/my-cli')).toBe('m.js');
		expect(pickBinEntry({ other: 'o.js' }, '@s/my-cli')).toBe('o.js');
		expect(pickBinEntry({}, '@s/my-cli')).toBeNull();
	});
});

describe('redactSecrets', () => {
	it('masks known token shapes and bearer / authToken values', () => {
		const out = redactSecrets('ghp_abcdefghij1234 glpat-abcdefgh1234 Bearer s3cr3t.value //r/:_authToken=abc123 password: hunter2');
		expect(out).not.toMatch(/abcdefghij1234|abcdefgh1234|s3cr3t|abc123|hunter2/);
	});
	it('keeps the end of a long output', () => {
		const out = redactSecrets('x'.repeat(5000) + 'THE-END', 100);
		expect(out.length).toBeLessThan(110);
		expect(out.endsWith('THE-END')).toBe(true);
	});
});
