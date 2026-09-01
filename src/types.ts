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
	status: 'update-available' | 'success' | 'failed' | 'rolled-back' | 'deferred';
	currentVersion: string;
	targetVersion?: string;
	previousVersion?: string;
	error?: string;
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
}

export type UpdaterConfig = WithoutDaemonConfig | WithDaemonConfig;
