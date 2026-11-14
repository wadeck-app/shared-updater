export interface UpdateConfig {
	channel: string;
	checkIntervalMs: number;
	disabled: boolean;
}

export interface UpdateCache {
	lastCheckedAt: number;
	latestVersion: string | null;
}

export interface UpdateState {
	/**
	 * 'applying': written BEFORE `npm install -g`, replaced by success / failed / rolled-back when
	 * the install is finalised. Still present on a later run = the install was interrupted; that
	 * run verifies the install and repairs it. Consumers (shared-cli UpdateManager) already treat
	 * 'applying' as "updater still running" and do not clear it.
	 */
	status: 'update-available' | 'success' | 'failed' | 'rolled-back' | 'deferred' | 'applying';
	currentVersion: string;
	targetVersion?: string;
	previousVersion?: string;
	error?: string;
	/** Set when status is 'applying': pid of the updater process performing the install. */
	pid?: number;
	/**
	 * Staged install (without-daemon), only with status 'applying': the step the updater reached.
	 * 'staging' (new version being installed into a private prefix) and 'staged' (installed, being
	 * health-tested): the global install is untouched. 'swapping': the global package dir is being
	 * renamed aside and the staged one renamed into place. 'swapped': new version in place, the old
	 * dir and the stage are being deleted. A later run repairs each case (see recovery.ts).
	 */
	phase?: 'staging' | 'staged' | 'swapping' | 'swapped';
	/** Staged install: the private prefix the new version is installed into. */
	stagePath?: string;
	/** Staged install: the global package directory (<npm root -g>/<pkg>). */
	packageDirPath?: string;
	/** Staged install: where the previous package dir is moved aside during the swap. */
	oldDirPath?: string;
	/** While an npm install of this journal runs: its pid, so a later run can stop an orphan. */
	npmPid?: number;
	/** Epoch ms at which npmPid was spawned; detects pid reuse. */
	npmStartedAt?: number;
	timestamp: number;
	/** Set when status is 'deferred': epoch ms at which the update should be retried. */
	retryAt?: number;
}

export type Strategy = 'without-daemon' | 'with-daemon';

export interface UpdaterBaseConfig {
	pkgName: string;
	configDir: string;
	currentVersion: string;
	strategy: Strategy;
	/**
	 * Skips the cache.lastCheckedAt/checkIntervalMs throttle. For a caller that already owns its
	 * own invocation cadence (a long-running daemon with its own timer, e.g. orchestrator,
	 * wdrive) -- the throttle exists to protect npm from CLIs that re-invoke the updater on every
	 * command (queue, the scrapers), which has no schedule of its own to rely on. A daemon setting
	 * this to true and ALSO matching its spawn interval to checkIntervalMs is how a stale version
	 * sat unnoticed on orchestrator for days: the two intervals beat against each other and the
	 * throttle silently skipped every other spawn. autoUpdate: false and the in-flight lock still
	 * apply -- this only removes the time-based gate.
	 */
	skipThrottle?: boolean;
}

export interface WithDaemonConfig extends UpdaterBaseConfig {
	strategy: 'with-daemon';
	// Port and health token are auto-discovered from configDir:
	//   port:  configDir/config.port   (singleton-daemon-kit PortFileData)
	//   token: configDir/health_token  (written by singleton-daemon-kit health-server)
	// No extra fields needed.
}

export interface RestartDaemonConfig {
	/** Path to configDir/config.port (singleton-daemon-kit PortFileData). */
	portFile: string;
	/** Path to configDir/health_token (singleton-daemon-kit health-server). */
	healthTokenFile: string;
}

export interface WithoutDaemonConfig extends UpdaterBaseConfig {
	strategy: 'without-daemon';
	/**
	 * When set, writes config.restart sentinel then POST /quit after a successful
	 * npm install so the Go launcher restarts the daemon with the new version.
	 * Use for CLIs that have a long-running daemon managed by singleton-daemon-kit.
	 */
	restartDaemon?: RestartDaemonConfig;
	/**
	 * Called when a new version is detected, before the update is applied.
	 * Return 'apply-now' to proceed immediately, or { defer: true, retryIn? }
	 * to skip this run and retry after retryIn ms (default: checkIntervalMs).
	 *
	 * Use cases:
	 *   - flow-cli: defer if a flow is currently running
	 *   - wdrive: defer if a sync is active (retryIn: 5 * 60_000)
	 *   - orchestrator: defer if critical jobs are running
	 */
	onUpdateAvailable?: (newVersion: string) => Promise<
		| 'apply-now'
		| { defer: true; retryIn?: number }
	>;
	/**
	 * Extra flags passed to `npm install -g` during update and rollback.
	 * Use ['--ignore-scripts'] for packages with problematic postinstall scripts
	 * (e.g. whatsapp-web.js runs husky on install which fails in non-interactive env).
	 */
	npmInstallFlags?: string[];
	/**
	 * Repair of an interrupted install: how long to wait for a still-running npm orphaned by the
	 * dead updater to finish on its own before its process tree is stopped. Default 30 000 ms.
	 */
	orphanNpmWaitMs?: number;
	/**
	 * Install the new version into a private staging prefix, health-test it, then swap it in by
	 * directory rename, so the global CLI is never missing during the download. Default true.
	 * false = the old direct `npm install -g` (the CLI is missing for the duration of the download).
	 * The staged path is also skipped, with a log line saying why, when it cannot apply (package not
	 * installed globally, no `bin`, `bin` entries differ from the installed ones).
	 */
	stagedInstall?: boolean;
	/**
	 * Health test of the staged package, run before anything is switched. Default: run the staged
	 * package's own bin entry with the node running the updater: `<bin> cli version`, isolated
	 * environment (UPDATER_DISABLE=1, temp HOME / XDG_CONFIG_HOME / APPDATA), must exit 0 and print the
	 * staged version. Return `{ ok: false, output }` (or throw) to abort the update: nothing is switched.
	 */
	healthCheck?: HealthCheck;
	/** Time allowed to the default health check. Default 15 000 ms. */
	healthCheckTimeoutMs?: number;
	/**
	 * Injection points of the staged install (file system, clock, sleep, volume check, a hook between
	 * the two renames). For tests: leave unset.
	 * @internal
	 */
	stagedDeps?: Partial<import('./shared/staged.js').StagedDeps>;
}

export interface HealthCheckInput {
	pkgName: string;
	/** The version the stage must report. */
	version: string;
	/** Directory of the staged package. */
	packageDir: string;
	/** Absolute path of the staged package's bin entry (the file to run with node). */
	entry: string;
	/** The CLI's config dir (the check must not write there). */
	configDir: string;
	timeoutMs: number;
}
export interface HealthCheckResult {
	ok: boolean;
	/** What to show the user when ok is false (the default check puts exit code + output here). */
	output: string;
}
export type HealthCheck = (input: HealthCheckInput) => Promise<HealthCheckResult>;

export type UpdaterConfig = WithoutDaemonConfig | WithDaemonConfig;
