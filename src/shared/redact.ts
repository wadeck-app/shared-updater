const SECRET_PATTERNS: Array<[RegExp, string]> = [
	[/\b(ghp_|gho_|ghs_|ghu_|github_pat_|glpat-)[A-Za-z0-9_-]{8,}/g, '$1***'],
	// a real npm token is `npm_` + 36 alphanumerics; `npm_config_registry` and friends are not tokens
	[/\b(npm_)[A-Za-z0-9]{20,}/g, '$1***'],
	[/(Bearer\s+)[^\s"']+/gi, '$1***'],
	[/(_authToken\s*=\s*)[^\s"']+/gi, '$1***'],
	[/((?:token|password|secret|api[-_]?key)["']?\s*[:=]\s*["']?)[^\s"',;]+/gi, '$1***'],
];

/**
 * Masks known token shapes in a text that is about to be logged or journaled. `max` keeps only
 * the tail of a longer text (default: no limit).
 */
export function redactSecrets(text: string, max = Infinity): string {
	let out = text;
	for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep);
	return out.length > max ? `...${out.slice(out.length - max)}` : out;
}
