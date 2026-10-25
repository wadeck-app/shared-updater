import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execNpm } from './npm.js';

export interface InstalledCheck {
	/** True when the package is present under the global root (and equals `expectedVersion` when given). */
	ok: boolean;
	installedVersion: string | null;
	packageDir: string | null;
	/**
	 * True when `npm root -g` could not be resolved: nothing is known about the install, which is
	 * different from "known to be missing". Callers must not roll back on this alone.
	 */
	unverifiable?: boolean;
	/** Human-readable explanation when `ok` is false. */
	reason?: string;
}

/** Resolves `npm root -g` (honours NPM_CONFIG_PREFIX). Throws when npm cannot answer. */
export function globalRoot(): string {
	const root = String(execNpm(['root', '-g'], { timeout: 30_000 })).trim();
	if (!root) throw new Error('`npm root -g` returned an empty path');
	return root;
}

/**
 * Checks, from the filesystem rather than from npm's exit code, that `pkgName` is installed
 * globally (and at `expectedVersion` when given). Exported for consumers: a CLI whose own binary
 * is missing cannot run the updater, but a scheduler / launcher can call this and trigger a repair.
 */
export function verifyInstalled(pkgName: string, expectedVersion?: string): InstalledCheck {
	let root: string;
	try {
		root = globalRoot();
	} catch (err) {
		return {
			ok: false, installedVersion: null, packageDir: null, unverifiable: true,
			reason: `cannot resolve the npm global root: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
	const packageDir = join(root, ...pkgName.split('/'));
	const manifest = join(packageDir, 'package.json');
	if (!existsSync(manifest)) {
		return { ok: false, installedVersion: null, packageDir, reason: `${manifest} does not exist: ${pkgName} is not installed globally` };
	}
	let version: string;
	try {
		version = String(JSON.parse(readFileSync(manifest, 'utf8')).version ?? '');
	} catch (err) {
		return { ok: false, installedVersion: null, packageDir, reason: `${manifest} is unreadable: ${err instanceof Error ? err.message : String(err)}` };
	}
	if (expectedVersion !== undefined && version !== expectedVersion) {
		return { ok: false, installedVersion: version, packageDir, reason: `installed version is ${version}, expected ${expectedVersion}` };
	}
	return { ok: true, installedVersion: version, packageDir };
}

/**
 * npm moves the old package aside as `.<name>-XXXXXXXX` next to it while it replaces it, and a
 * crash leaves that directory behind. Report-only: the updater never deletes these (they may be
 * the only copy of the previous version).
 */
export function findLeftoverTempDirs(pkgName: string): string[] {
	try {
		const parts = pkgName.split('/');
		const base = parts[parts.length - 1]!;
		const parent = join(globalRoot(), ...parts.slice(0, -1));
		return readdirSync(parent).filter((n) => n.startsWith(`.${base}-`)).map((n) => join(parent, n));
	} catch {
		return [];
	}
}
