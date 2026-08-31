/**
 * Standalone npm registry mock server.
 * Run with: node mock-registry-server.mjs <stateFilePath>
 *
 * Reads package state from <stateFilePath> on each request (file-based sync
 * with the parent test process, which writes the file synchronously via
 * writeFileSync before spawning npm commands).
 *
 * State file format:
 *   { "<pkgName>": { "channels": { "<channel>": "<version>" } } }
 *
 * Communication with parent:
 *   stdout: JSON line {"type":"ready","port":N} when server is listening
 */

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

const stateFile = process.argv[2];
if (!stateFile) {
	process.stderr.write('mock-registry-server: missing stateFile argument\n');
	process.exit(1);
}

function readState() {
	try {
		return JSON.parse(readFileSync(stateFile, 'utf8'));
	} catch {
		return {};
	}
}

// ---- tar helpers ----

function buildTarHeader(filename, fileSize) {
	const buf = Buffer.alloc(512);
	buf.write(filename.slice(0, 99), 0, 'ascii');
	buf.write('0000644\0', 100, 'ascii');
	buf.write('0000000\0', 108, 'ascii');
	buf.write('0000000\0', 116, 'ascii');
	buf.write(fileSize.toString(8).padStart(11, '0') + '\0', 124, 'ascii');
	buf.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136, 'ascii');
	buf.fill(0x20, 148, 156);
	buf[156] = 0x30;
	buf.write('ustar\0', 257, 'ascii');
	buf.write('00', 263, 'ascii');
	let sum = 0;
	for (let i = 0; i < 512; i++) sum += buf[i];
	buf.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
	return buf;
}

function createTarball(name, version) {
	const pkgJson = JSON.stringify({ name, version, description: 'mock' });
	const content = Buffer.from(pkgJson, 'utf8');
	const header = buildTarHeader('package/package.json', content.length);
	const paddedSize = Math.ceil(content.length / 512) * 512;
	const contentPadded = Buffer.alloc(paddedSize);
	content.copy(contentPadded);
	const tar = Buffer.concat([header, contentPadded, Buffer.alloc(1024)]);
	return gzipSync(tar);
}

function computeHashes(buf) {
	const sha1 = createHash('sha1').update(buf).digest('hex');
	const sha512b64 = createHash('sha512').update(buf).digest('base64');
	return { sha1, sha512b64 };
}

// In-memory tarball cache to avoid re-generating
const tarballCache = new Map();

function getTarball(name, version) {
	const key = `${name}@${version}`;
	if (!tarballCache.has(key)) tarballCache.set(key, createTarball(name, version));
	return tarballCache.get(key);
}

// ---- URL helpers ----

/**
 * npm encodes scoped package names as %40scope%2fname (all lowercase).
 * We need to find the package regardless of encoding.
 */
function findPackage(state, encodedPath) {
	// Strip query string
	const pathOnly = encodedPath.includes('?') ? encodedPath.slice(0, encodedPath.indexOf('?')) : encodedPath;

	let decoded;
	try { decoded = decodeURIComponent(pathOnly); } catch { decoded = pathOnly; }

	// Direct match
	if (state[decoded]) return { name: decoded, data: state[decoded] };

	// Case-insensitive match
	const lower = decoded.toLowerCase();
	for (const [name, data] of Object.entries(state)) {
		if (name.toLowerCase() === lower) return { name, data };
	}
	return null;
}

// ---- HTTP server ----

const server = createServer((req, res) => {
	const method = req.method ?? 'GET';
	const rawPath = (req.url ?? '/').slice(1); // strip leading /

	if (method === 'PUT') {
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ ok: true }));
		return;
	}

	if (method !== 'GET') {
		res.writeHead(405);
		res.end(JSON.stringify({ error: 'Method not allowed' }));
		return;
	}

	const state = readState(); // re-read on every request

	// Tarball request: {encodedPkg}/-/{filename}.tgz
	const tarballMatch = /^(.+?)\/-\/(.+\.tgz)/.exec(rawPath);
	if (tarballMatch) {
		const pkg = findPackage(state, tarballMatch[1]);
		if (!pkg) { res.writeHead(404); res.end('Not found'); return; }

		// Simulate install error when configured (for testing npm install failure paths)
		if (pkg.data.installError) {
			res.writeHead(500, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'simulated install error' }));
			return;
		}

		const { name } = pkg;
		const baseName = name.startsWith('@') ? name.split('/')[1] : name;
		// Extract version from filename: <baseName>-<version>.tgz
		const filenamePart = tarballMatch[2];
		const versionMatch = new RegExp(`^${baseName.replace(/[-/]/g, '\\$&')}-(.+)\\.tgz`).exec(filenamePart);
		const version = versionMatch ? versionMatch[1] : null;
		if (!version) { res.writeHead(404); res.end('Version not found'); return; }

		const tarball = getTarball(name, version);
		res.writeHead(200, {
			'Content-Type': 'application/octet-stream',
			'Content-Length': String(tarball.length),
		});
		res.end(tarball);
		return;
	}

	// Metadata request
	const pkg = findPackage(state, rawPath);
	if (!pkg) {
		res.writeHead(404, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Not found', reason: 'no such package' }));
		return;
	}

	const { name, data } = pkg;
	const port = server.address().port;
	const baseUrl = `http://127.0.0.1:${port}`;
	const encodedName = encodeURIComponent(name).toLowerCase();
	const baseName = name.startsWith('@') ? name.split('/')[1] : name;
	const distTags = data.channels ?? {};
	const versions = {};

	for (const version of new Set(Object.values(distTags))) {
		const tarball = getTarball(name, version);
		const { sha1, sha512b64 } = computeHashes(tarball);
		const tarballUrl = `${baseUrl}/${encodedName}/-/${baseName}-${version}.tgz`;
		versions[version] = {
			name,
			version,
			description: 'mock',
			dist: { tarball: tarballUrl, shasum: sha1, integrity: `sha512-${sha512b64}` },
		};
	}

	res.writeHead(200, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify({ name, 'dist-tags': distTags, versions }));
});

server.listen(0, '127.0.0.1', () => {
	const port = server.address().port;
	process.stdout.write(JSON.stringify({ type: 'ready', port }) + '\n');
});

// Keep alive until killed
process.on('SIGTERM', () => server.close());
process.on('SIGINT', () => server.close());
