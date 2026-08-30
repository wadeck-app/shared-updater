/**
 * Returns true if version `a` is less than or equal to version `b`.
 * Handles calver (2026.08.20-142-abc) and semver (1.2.3).
 */
export function semverLte(a: string, b: string): boolean {
	const normalize = (v: string) => v.replace(/^v/, '').split(/[-.]/).map(Number);
	const pa = normalize(a);
	const pb = normalize(b);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const na = pa[i] ?? 0;
		const nb = pb[i] ?? 0;
		if (na < nb) return true;
		if (na > nb) return false;
	}
	return true;
}
