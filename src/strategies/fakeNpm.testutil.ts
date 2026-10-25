import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface FakeNpmOptions {
	/** Called for every `install -g pkg@ver`; return 'skip' to leave the disk untouched, 'remove' to delete the package (a half-done install). */
	onInstall?: (pkg: string, version: string) => 'skip' | 'remove' | void;
}

/**
 * In-memory stand-in for `execNpm` backed by a real temp "global root": `npm root -g` returns it,
 * `npm install -g pkg@ver` writes <root>/<pkg>/package.json. Lets unit tests exercise the real
 * verifyInstalled() filesystem logic without spawning npm.
 */
export function createFakeNpm(opts: FakeNpmOptions = {}) {
	const root = mkdtempSync(join(tmpdir(), 'fake-npm-root-'));
	const installs: string[] = [];
	const write = (pkg: string, version: string): void => {
		const dir = join(root, ...pkg.split('/'));
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: pkg, version }));
	};
	const impl = (args: string[]): string => {
		if (args[0] === 'root') return root + '\n';
		if (args[0] === 'install' && args[1] === '-g') {
			const spec = args[2]!;
			const at = spec.lastIndexOf('@');
			const pkg = spec.slice(0, at);
			const version = spec.slice(at + 1);
			installs.push(spec);
			const verdict = opts.onInstall?.(pkg, version);
			if (verdict === 'remove') { rmSync(join(root, ...pkg.split('/')), { recursive: true, force: true }); return ''; }
			if (verdict !== 'skip') write(pkg, version);
			return '';
		}
		return '';
	};
	return { root, installs, seed: write, impl };
}
