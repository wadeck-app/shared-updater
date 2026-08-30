import { execFileSync, execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

const NPM_CLI_JS = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const USE_NPM_CLI = existsSync(NPM_CLI_JS);

export function execNpm(args: string[], opts: { cwd?: string; timeout?: number } = {}): string {
	if (USE_NPM_CLI) {
		return execFileSync(process.execPath, [NPM_CLI_JS, ...args], {
			encoding: 'utf8',
			windowsHide: true,
			...opts,
		});
	}
	return execSync(['npm', ...args].join(' '), {
		encoding: 'utf8',
		windowsHide: true,
		...opts,
	});
}
