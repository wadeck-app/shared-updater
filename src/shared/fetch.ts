import { execNpm } from './npm.js';

export function fetchLatestVersion(pkgName: string, channel: string): string {
	const tag = channel === 'latest' ? 'latest' : channel;
	const raw = execNpm(['view', pkgName, `dist-tags.${tag}`], { timeout: 30_000 });
	return raw.trim();
}
