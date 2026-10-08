import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';

const scriptsDir = fileURLToPath(new URL('.', import.meta.url));
const MANIFEST_NAME = 'dependency-integrity.json';
const MANIFEST_SCHEMA = 1;
const DEFAULT_MAX_FILES = 20_000;
const DEFAULT_MAX_BYTES = 400 * 1024 * 1024;
const SHA256_HEX = /^[0-9a-f]{64}$/;
// npm's cmd-shim version changes these generated launchers between Node/npm
// releases. The orchestrator resolves the native CLI itself and never invokes
// them; the published package files remain byte-sealed below.
const GENERATED_CODEX_SHIMS = new Set(['.bin/codex', '.bin/codex.cmd', '.bin/codex.ps1']);

function sha256File(file) {
  const hash = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (let bytes; (bytes = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0;) {
      hash.update(chunk.subarray(0, bytes));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function normalize(relative) {
  return relative.split(path.sep).join('/');
}

function inventoryNodeModules(root, {maxFiles = DEFAULT_MAX_FILES, maxBytes = DEFAULT_MAX_BYTES} = {}) {
  const rows = [];
  let totalBytes = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) throw new Error('dependency tree contains a symbolic link');
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(file);
        continue;
      }
      if (!entry.isFile()) throw new Error('dependency tree contains a non-file entry');
      const relative = normalize(path.relative(root, file));
      // npm writes this generated metadata file after installs. It contains
      // no executable package content and is intentionally outside the seal.
      if (relative === '.package-lock.json') continue;
      if (GENERATED_CODEX_SHIMS.has(relative)) continue;
      const size = fs.statSync(file).size;
      totalBytes += size;
      if (totalBytes > maxBytes) throw new Error('dependency tree exceeds the size limit');
      rows.push([relative, sha256File(file)]);
      if (rows.length > maxFiles) throw new Error('dependency tree exceeds the file limit');
    }
  };
  if (!fs.statSync(root).isDirectory()) throw new Error('node_modules is missing');
  walk(root);
  return Object.fromEntries(rows);
}

function integrityFailure(message) {
  return {ok: false, code: 'RELEASE_DEPENDENCY_INTEGRITY', message: `RELEASE_DEPENDENCY_INTEGRITY: ${message}`};
}

function validRelativePath(value) {
  return typeof value === 'string'
    && value.length > 0
    && !value.includes('\\')
    && !value.includes('\0')
    && !value.startsWith('/')
    && !value.split('/').some(part => !part || part === '.' || part === '..');
}

export function dependencyIntegrityManifestPath(dir = scriptsDir) {
  return path.join(dir, MANIFEST_NAME);
}

export function readDependencyIntegrityManifest({dir = scriptsDir} = {}) {
  const manifestPath = dependencyIntegrityManifestPath(dir);
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return integrityFailure('dependency-integrity.json is missing or invalid; restore with npm ci');
  }
  if (manifest?.schema !== MANIFEST_SCHEMA || typeof manifest.packageLockSha256 !== 'string' || !SHA256_HEX.test(manifest.packageLockSha256) || !manifest.files || Array.isArray(manifest.files) || typeof manifest.files !== 'object') {
    return integrityFailure('dependency-integrity.json has an unsupported schema; restore with npm ci');
  }
  for (const [name, digest] of Object.entries(manifest.files)) {
    if (!validRelativePath(name) || typeof digest !== 'string' || !SHA256_HEX.test(digest)) {
      return integrityFailure('dependency-integrity.json has invalid file hashes; restore with npm ci');
    }
  }
  return {ok: true, code: null, message: null, manifest, manifestPath};
}

export function verifyDependencyTree({dir = scriptsDir, maxFiles = DEFAULT_MAX_FILES, maxBytes = DEFAULT_MAX_BYTES} = {}) {
  const lockPath = path.join(dir, 'package-lock.json');
  const nodeModules = path.join(dir, 'node_modules');
  const parsed = readDependencyIntegrityManifest({dir});
  if (!parsed.ok) return parsed;
  const {manifest} = parsed;
  let lockHash;
  try {
    lockHash = sha256File(lockPath);
  } catch {
    return integrityFailure('package-lock.json is missing or unreadable; restore with npm ci');
  }
  if (lockHash !== manifest.packageLockSha256) return integrityFailure('package-lock.json does not match the sealed dependency tree; restore with npm ci');
  let files;
  try {
    files = inventoryNodeModules(nodeModules, {maxFiles, maxBytes});
  } catch (error) {
    return integrityFailure(`${error.message}; restore with npm ci`);
  }
  const expectedNames = Object.keys(manifest.files).sort();
  const actualNames = Object.keys(files).sort();
  if (expectedNames.length !== actualNames.length || expectedNames.some((name, index) => name !== actualNames[index])) {
    return integrityFailure('installed dependency files differ from the sealed tree; restore with npm ci');
  }
  for (const name of expectedNames) {
    if (files[name] !== manifest.files[name]) {
      return integrityFailure(`installed dependency file differs from the sealed tree: ${name}; restore with npm ci`);
    }
  }
  return {ok: true, code: null, message: null, files: actualNames.length, packageLockSha256: lockHash};
}

export function sealDependencyTree({dir = scriptsDir, maxFiles = DEFAULT_MAX_FILES, maxBytes = DEFAULT_MAX_BYTES} = {}) {
  const lockPath = path.join(dir, 'package-lock.json');
  const nodeModules = path.join(dir, 'node_modules');
  const manifest = {
    schema: MANIFEST_SCHEMA,
    packageLockSha256: sha256File(lockPath),
    files: inventoryNodeModules(nodeModules, {maxFiles, maxBytes}),
  };
  const manifestPath = dependencyIntegrityManifestPath(dir);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return {ok: true, path: manifestPath, files: Object.keys(manifest.files).length, packageLockSha256: manifest.packageLockSha256};
}

const invokedPath = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedPath && import.meta.url === invokedPath && process.argv[2] === '--seal') {
  const result = sealDependencyTree();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
