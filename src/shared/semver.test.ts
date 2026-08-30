import { describe, it, expect } from 'vitest';
import { semverLte } from './semver.js';

describe('semverLte', () => {
	it('older < newer → true', () => expect(semverLte('1.0.0', '1.0.1')).toBe(true));
	it('newer > older → false', () => expect(semverLte('1.0.1', '1.0.0')).toBe(false));
	it('same version → true', () => expect(semverLte('1.0.0', '1.0.0')).toBe(true));
	it('calver day earlier → true', () => expect(semverLte('2026.08.20', '2026.08.21')).toBe(true));
	it('calver build number earlier → true', () => expect(semverLte('2026.08.20-142-abc', '2026.08.20-143-def')).toBe(true));
	it('calver same build → true', () => expect(semverLte('2026.08.20-142-abc', '2026.08.20-142-abc')).toBe(true));
	it('calver build newer → false', () => expect(semverLte('2026.08.20-143-abc', '2026.08.20-142-abc')).toBe(false));
	it('strips leading v', () => expect(semverLte('v1.0.0', 'v1.0.1')).toBe(true));
	it('minor version bump → true', () => expect(semverLte('1.1.0', '1.2.0')).toBe(true));
	it('major version bump → true', () => expect(semverLte('1.9.9', '2.0.0')).toBe(true));
});
