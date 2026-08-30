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
	status: 'update-available' | 'success' | 'failed' | 'rolled-back';
	currentVersion: string;
	targetVersion?: string;
	previousVersion?: string;
	error?: string;
	timestamp: number;
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

export interface WithoutDaemonConfig extends UpdaterBaseConfig {
	strategy: 'without-daemon';
}

export type UpdaterConfig = WithoutDaemonConfig | WithDaemonConfig;
