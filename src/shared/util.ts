export function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export function errorCode(err: unknown): string {
	return (err as NodeJS.ErrnoException | undefined)?.code ?? 'UNKNOWN';
}

/** `@scope/name` -> `name`. */
export function packageBaseName(pkgName: string): string {
	const parts = pkgName.split('/');
	return parts[parts.length - 1]!;
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
