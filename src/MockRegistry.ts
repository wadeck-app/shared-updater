/**
 * MockRegistry — spawns a standalone npm registry HTTP server in a child
 * process so it can handle requests even while the test thread is blocked on
 * synchronous npm calls (execFileSync).
 *
 * State is shared via a JSON file that the main process writes synchronously
 * (writeFileSync) and the server process reads on every incoming request.
 *
 * Usage:
 *   const registry = new MockRegistry();
 *   await registry.start();
 *   registry.setLatestVersion('@my/pkg', '2.0.0');
 *   process.env['npm_config_registry'] = registry.url;
 *   await registry.stop();
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_SCRIPT = join(__dirname, 'mock-registry-server.mjs');

interface RegistryState {
	[pkgName: string]: {
		channels: Record<string, string>;
		installError?: boolean;
	};
}

export class MockRegistry {
	private serverProcess: ChildProcess | null = null;
	private stateDir: string = '';
	private stateFile: string = '';
	private state: RegistryState = {};
	private _port: number = 0;

	/** Port the server is listening on. Undefined until start() resolves. */
	get port(): number {
		if (!this._port) throw new Error('MockRegistry is not started');
		return this._port;
	}

	/** Base URL of the mock registry, e.g. "http://127.0.0.1:12345". */
	get url(): string {
		return `http://127.0.0.1:${this.port}`;
	}

	/**
	 * Configure the version for a given package and channel.
	 * Writes state synchronously so it's visible before any subsequent
	 * synchronous npm invocation.
	 */
	setLatestVersion(pkg: string, version: string, channel = 'latest'): void {
		if (!this.state[pkg]) this.state[pkg] = { channels: {} };
		this.state[pkg]!.channels[channel] = version;
		this.writeState();
	}

	/**
	 * Configure the tarball endpoint for a package to return HTTP 500.
	 * When shouldFail is true, npm install will fail with a registry error.
	 * Writes state synchronously.
	 */
	setInstallError(pkg: string, shouldFail: boolean): void {
		if (!this.state[pkg]) this.state[pkg] = { channels: {} };
		this.state[pkg]!.installError = shouldFail ? true : undefined;
		this.writeState();
	}

	/** Clear all registered packages. Writes state synchronously. */
	clear(): void {
		this.state = {};
		this.writeState();
	}

	/** Start the server process. Resolves once it is listening. */
	start(): Promise<void> {
		this.stateDir = mkdtempSync(join(tmpdir(), 'mock-registry-'));
		this.stateFile = join(this.stateDir, 'state.json');
		this.writeState();

		return new Promise((resolve, reject) => {
			this.serverProcess = spawn(process.execPath, [SERVER_SCRIPT, this.stateFile], {
				stdio: ['ignore', 'pipe', 'pipe'],
			});

			let buffer = '';
			this.serverProcess.stdout!.on('data', (chunk: Buffer) => {
				buffer += chunk.toString();
				const lines = buffer.split('\n');
				buffer = lines.pop() ?? '';
				for (const line of lines) {
					if (!line.trim()) continue;
					try {
						const msg = JSON.parse(line) as { type: string; port: number };
						if (msg.type === 'ready') {
							this._port = msg.port;
							resolve();
						}
					} catch {
						// ignore non-JSON lines
					}
				}
			});

			this.serverProcess.stderr!.on('data', (chunk: Buffer) => {
				process.stderr.write(`[MockRegistry] ${chunk.toString()}`);
			});

			this.serverProcess.on('error', reject);
			this.serverProcess.on('exit', (code) => {
				if (code !== 0 && code !== null) {
					reject(new Error(`MockRegistry server exited with code ${code}`));
				}
			});
		});
	}

	/** Stop the server process and clean up state files. */
	stop(): Promise<void> {
		return new Promise((resolve) => {
			if (!this.serverProcess) return resolve();
			this.serverProcess.on('exit', () => {
				try { rmSync(this.stateDir, { recursive: true, force: true }); } catch { /* ignore */ }
				resolve();
			});
			this.serverProcess.kill('SIGTERM');
			this.serverProcess = null;
		});
	}

	private writeState(): void {
		if (this.stateFile) {
			writeFileSync(this.stateFile, JSON.stringify(this.state), 'utf8');
		}
	}
}
