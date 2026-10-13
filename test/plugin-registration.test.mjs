import {testTempFamily} from './test-temp-root.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {inspectRegistration, repairRegistration, ensureRegistration, setRegistrationSource, atomicReplace} from '../scripts/repair-plugin-registration.mjs';
import {coreInventory, runtimeInventory} from '../scripts/release-integrity.mjs';

const TEST_TEMP = testTempFamily('plugin-registration');
fs.mkdirSync(TEST_TEMP, {recursive: true});

function fixture(entry, extra = []) {
  const root = fs.mkdtempSync(path.join(TEST_TEMP, 'plugin-registration-'));
  const marketRoot = path.join(root, 'marketplace');
  const plugin = path.join(marketRoot, 'plugins', 'demo-plugin');
  fs.mkdirSync(path.join(plugin, '.codex-plugin'), {recursive: true});
  fs.mkdirSync(path.join(marketRoot, '.agents', 'plugins'), {recursive: true});
  fs.writeFileSync(path.join(plugin, '.codex-plugin', 'plugin.json'), JSON.stringify({name: 'demo-plugin', version: '1.0.0'}));
  const marketplace = path.join(marketRoot, '.agents', 'plugins', 'marketplace.json');
  fs.writeFileSync(marketplace, JSON.stringify({name: 'test', interface: {displayName: 'Test'}, plugins: [entry, ...extra]}, null, 2) + '\n');
  return {root, plugin, marketRoot, marketplace};
}

function localEntry(name, sourcePath, source = 'local') {
  return {name, source: {source, path: sourcePath}, policy: {installation: 'AVAILABLE', authentication: 'ON_INSTALL'}, category: 'Test'};
}

function opts(f) { return {pluginPath: f.plugin, marketplacePath: f.marketplace, marketplaceRoot: f.marketRoot}; }
function cleanup(f) { fs.rmSync(f.root, {recursive: true, force: true}); }

function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }

function writeRelease(root) {
  fs.writeFileSync(path.join(root, 'release.json'), JSON.stringify({
    schema: 2,
    coreVersion: 'test',
    files: coreInventory(root),
    runtimeFiles: runtimeInventory(root),
  }, null, 2) + '\n');
}

function sealedDistributionFixture() {
  const root = fs.mkdtempSync(path.join(TEST_TEMP, 'sealed-distribution-'));
  const source = path.join(root, 'source');
  const distRoot = path.join(root, 'dist');
  const dist = path.join(distRoot, 'demo-plugin');
  const sourceManifest = {name: 'demo-plugin', version: '1.0.0', interface: {category: 'Test'}};
  const sourceCatalog = {name: 'source', plugins: [{name: 'demo-plugin', source: {source: 'local', path: './'}, policy: {installation: 'AVAILABLE', authentication: 'ON_INSTALL'}, category: 'Test'}]};
  fs.mkdirSync(path.join(source, '.codex-plugin'), {recursive: true});
  fs.mkdirSync(path.join(source, '.agents', 'plugins'), {recursive: true});
  fs.mkdirSync(path.join(source, 'scripts', 'core'), {recursive: true});
  fs.writeFileSync(path.join(source, '.codex-plugin', 'plugin.json'), JSON.stringify(sourceManifest, null, 2) + '\n');
  fs.writeFileSync(path.join(source, '.agents', 'plugins', 'marketplace.json'), JSON.stringify(sourceCatalog, null, 2) + '\n');
  fs.writeFileSync(path.join(source, 'scripts', 'core', 'orchestrate-sdk.mjs'), 'export const marker = "source";\n');
  fs.writeFileSync(path.join(source, 'scripts', 'core', 'contracts.mjs'), "export const CORE_VERSION = 'test';\n");
  fs.writeFileSync(path.join(source, 'scripts', 'release-integrity.mjs'), 'export const verifier = "source";\n');
  const lock = Buffer.from('{"lockfileVersion":3}\n');
  fs.writeFileSync(path.join(source, 'scripts', 'package-lock.json'), lock);
  fs.writeFileSync(path.join(source, 'scripts', 'dependency-integrity.json'), JSON.stringify({schema: 1, packageLockSha256: sha256(lock), files: {}}, null, 2) + '\n');
  writeRelease(source);
  const sourceRelease = fs.readFileSync(path.join(source, 'release.json'));
  const dependency = fs.readFileSync(path.join(source, 'scripts', 'dependency-integrity.json'));
  fs.cpSync(source, dist, {recursive: true});
  const distCatalog = {
    name: 'codex-tui-orchestrator-dist',
    interface: {displayName: 'Codex TUI Orchestrator (Distribution)'},
    plugins: [{name: 'demo-plugin', source: {source: 'local', path: './'}, policy: {installation: 'AVAILABLE', authentication: 'ON_INSTALL'}, category: 'Test'}],
  };
  fs.writeFileSync(path.join(dist, '.agents', 'plugins', 'marketplace.json'), JSON.stringify(distCatalog, null, 2) + '\n');
  fs.writeFileSync(path.join(dist, 'scripts', 'distribution-source-release.json'), sourceRelease);
  fs.writeFileSync(path.join(dist, 'scripts', 'distribution-provenance.json'), JSON.stringify({
    schema: 1,
    sourceReleaseSha256: sha256(sourceRelease),
    sourceDependencyManifestSha256: sha256(dependency),
    packageLockSha256: sha256(lock),
    dependencyFiles: 0,
  }, null, 2) + '\n');
  writeRelease(dist);
  return {root, source, distRoot, dist, marketplace: path.join(dist, '.agents', 'plugins', 'marketplace.json')};
}

test('exactly matched registration passes check', () => {
  const f = fixture(localEntry('demo-plugin', './plugins/demo-plugin')); try {
    assert.deepEqual(inspectRegistration(opts(f)).status, 'matched');
  } finally { cleanup(f); }
});

test('case-only drift is repaired and preserves path, policy, and other entries', () => {
  const other = localEntry('other-plugin', './other');
  const f = fixture(localEntry('Demo-Plugin', './plugins/demo-plugin'), [other]); try {
    const before = JSON.parse(fs.readFileSync(f.marketplace, 'utf8'));
    assert.equal(inspectRegistration(opts(f)).status, 'repairable');
    const result = repairRegistration(opts(f));
    assert.equal(result.status, 'repaired');
    const after = JSON.parse(fs.readFileSync(f.marketplace, 'utf8'));
    assert.equal(after.plugins[0].name, 'demo-plugin');
    assert.equal(after.plugins[0].source.path, before.plugins[0].source.path);
    assert.deepEqual(after.plugins[0].policy, before.plugins[0].policy);
    assert.deepEqual(after.plugins[1], before.plugins[1]);
    assert.equal(inspectRegistration(opts(f)).status, 'matched');
  } finally { cleanup(f); }
});

test('duplicate case-insensitive entries are blocked', () => {
  const f = fixture(localEntry('Demo-Plugin', './plugin'), [localEntry('demo-plugin', './plugin')]); try {
    assert.equal(inspectRegistration(opts(f)).status, 'duplicate_entry');
  } finally { cleanup(f); }
});

test('wrong source path and non-local source are blocked', () => {
  const wrong = fixture(localEntry('Demo-Plugin', './plugins/elsewhere')); try {
    assert.equal(inspectRegistration(opts(wrong)).status, 'source_mismatch');
  } finally { cleanup(wrong); }
  const remote = fixture(localEntry('Demo-Plugin', './plugins/demo-plugin', 'git')); try {
    assert.equal(inspectRegistration(opts(remote)).status, 'source_mismatch');
  } finally { cleanup(remote); }
  const exactWrong = fixture(localEntry('demo-plugin', './plugins/elsewhere')); try {
    assert.equal(inspectRegistration(opts(exactWrong)).status, 'source_mismatch');
  } finally { cleanup(exactWrong); }
});

// Legacy fixture: the release inventory still requires the core entry files.
function coreFixture(pluginDir, marker) {
  const core = path.join(pluginDir, 'scripts', 'core');
  fs.mkdirSync(core, {recursive: true});
  fs.writeFileSync(path.join(core, 'orchestrate-sdk.mjs'), 'export const marker = ' + JSON.stringify(marker) + ';\n');
  fs.writeFileSync(path.join(core, 'contracts.mjs'), 'export const CORE_VERSION = "test";\n');
}

test('a legacy core-only distribution is rejected even when its core matches the checkout', () => {
  const f = fixture(localEntry('demo-plugin', './dist/demo-plugin')); try {
    coreFixture(f.plugin, 'checkout');
    const distRoot = path.join(f.marketRoot, 'dist');
    const dist = path.join(distRoot, 'demo-plugin');
    coreFixture(dist, 'checkout');
    const unsealed = inspectRegistration({...opts(f), distRoot});
    assert.equal(unsealed.status, 'dist_unverified');
    // Core equality cannot rehabilitate a distribution without a source-bound
    // release and provenance proof.
    fs.writeFileSync(path.join(dist, 'scripts', 'core', 'orchestrate-sdk.mjs'), 'export const marker = "stale";\n');
    const stale = inspectRegistration({...opts(f), distRoot});
    assert.equal(stale.status, 'dist_unverified');
    assert.equal(stale.ok, false);
  } finally { cleanup(f); }
});

test('a distribution registration binds every runtime file to the sealed checkout before it can write a catalog', () => {
  const f = sealedDistributionFixture();
  const options = {pluginPath: f.source, source: 'dist', distRoot: f.distRoot, marketplacePath: f.marketplace, marketplaceRoot: f.dist};
  try {
    assert.equal(inspectRegistration(options).status, 'matched');
    fs.writeFileSync(path.join(f.dist, 'scripts', 'release-integrity.mjs'), 'process.stdout.write("altered non-core runtime");\n');
    const originalCatalog = fs.readFileSync(f.marketplace);
    assert.equal(inspectRegistration(options).status, 'dist_unverified');
    assert.equal(ensureRegistration(options).status, 'dist_unverified');
    assert.deepEqual(fs.readFileSync(f.marketplace), originalCatalog, 'ensure must not register a tampered distribution');
    assert.equal(setRegistrationSource(options).status, 'dist_unverified');
    assert.deepEqual(fs.readFileSync(f.marketplace), originalCatalog, 'set-source must not register a tampered distribution');
  } finally { cleanup(f); }
});

test('implicit dist discovery is source-bound and cannot rewrite a catalog after tampering', () => {
  const f = sealedDistributionFixture();
  const options = {pluginPath: f.source, distRoot: f.distRoot, marketplacePath: f.marketplace, marketplaceRoot: f.dist};
  try {
    assert.equal(inspectRegistration(options).status, 'matched');
    fs.writeFileSync(path.join(f.dist, 'scripts', 'release-integrity.mjs'), 'process.stdout.write("altered non-core runtime");\n');
    const originalCatalog = fs.readFileSync(f.marketplace);
    assert.equal(inspectRegistration(options).status, 'dist_unverified');
    assert.equal(ensureRegistration(options).status, 'dist_unverified');
    assert.deepEqual(fs.readFileSync(f.marketplace), originalCatalog, 'ensure must not rewrite an implicitly discovered tampered dist');
    assert.equal(setRegistrationSource(options).status, 'dist_unverified');
    assert.deepEqual(fs.readFileSync(f.marketplace), originalCatalog, 'set-source must not rewrite an implicitly discovered tampered dist');
  } finally { cleanup(f); }
});

test('distribution registration rejects altered source proof, provenance, catalog, and runtime inventory', () => {
  const cases = [
    ['source-release bytes', (f) => fs.appendFileSync(path.join(f.dist, 'scripts', 'distribution-source-release.json'), '\n'), /distribution-source-release/i],
    ['provenance hash', (f) => {
      const file = path.join(f.dist, 'scripts', 'distribution-provenance.json');
      const provenance = JSON.parse(fs.readFileSync(file, 'utf8'));
      provenance.sourceReleaseSha256 = '0'.repeat(64);
      fs.writeFileSync(file, JSON.stringify(provenance, null, 2) + '\n');
    }, /provenance/i],
    ['catalog bytes', (f) => fs.writeFileSync(f.marketplace, JSON.stringify({name: 'unexpected', plugins: []}, null, 2) + '\n'), /canonical distribution catalog/i],
    ['unexpected runtime file', (f) => fs.writeFileSync(path.join(f.dist, 'scripts', 'unexpected-runtime.mjs'), 'export default true;\n'), /runtime inventory/i],
  ];
  for (const [label, tamper, reason] of cases) {
    const f = sealedDistributionFixture();
    try {
      tamper(f);
      const result = inspectRegistration({pluginPath: f.source, source: 'dist', distRoot: f.distRoot, marketplacePath: f.marketplace, marketplaceRoot: f.dist});
      assert.equal(result.status, 'dist_unverified', label);
      assert.match(result.reason, reason, label);
    } finally { cleanup(f); }
  }
});

test('a dist path outside the plugin family is still rejected', () => {
  const f = fixture(localEntry('demo-plugin', './elsewhere/demo-plugin')); try {
    coreFixture(f.plugin, 'checkout');
    const distRoot = path.join(f.marketRoot, 'dist');
    coreFixture(path.join(distRoot, 'demo-plugin'), 'checkout');
    assert.equal(inspectRegistration({...opts(f), distRoot}).status, 'source_mismatch');
  } finally { cleanup(f); }
});

test('check is read-only and CLI emits machine-readable failure', () => {
  const f = fixture(localEntry('Demo-Plugin', './plugins/demo-plugin')); try {
    const before = fs.readFileSync(f.marketplace);
    const script = path.resolve('scripts/repair-plugin-registration.mjs');
    assert.throws(() => execFileSync(process.execPath, [script, f.plugin, '--check', '--marketplace', f.marketplace, '--marketplace-root', f.marketRoot], {encoding: 'utf8'}), (error) => {
      assert.equal(error.status, 1);
      const output = JSON.parse(error.stdout);
      assert.equal(output.status, 'repairable');
      return true;
    });
    assert.deepEqual(fs.readFileSync(f.marketplace), before);
  } finally { cleanup(f); }
});

test('CLI rejects incomplete or conflicting mode options', () => {
  const script = path.resolve('scripts/repair-plugin-registration.mjs');
  for (const args of [['--marketplace'], ['--marketplace-root'], ['--check', '--repair']]) {
    assert.throws(() => execFileSync(process.execPath, [script, ...args], {encoding: 'utf8'}), (error) => {
      assert.equal(error.status, 1);
      assert.equal(JSON.parse(error.stdout).status, 'error');
      return true;
    });
  }
});

test('atomic commit failures preserve the original and clean the temporary file', () => {
  const root = fs.mkdtempSync(path.join(TEST_TEMP, 'plugin-registration-atomic-'));
  const target = path.join(root, 'marketplace.json');
  const original = Buffer.from('{"name":"test"}\n');
  fs.writeFileSync(target, original);
  const rename = fs.renameSync;
  try {
    fs.renameSync = () => { const error = new Error('simulated replace failure'); error.code = 'EEXIST'; throw error; };
    assert.throws(() => atomicReplace(target, '{"name":"changed"}\n', original), /simulated replace failure/);
    assert.deepEqual(fs.readFileSync(target), original);
    assert.deepEqual(fs.readdirSync(root), ['marketplace.json']);
  } finally {
    fs.renameSync = rename;
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test('atomic commit rejects a file changed after temp write without deleting it', () => {
  const root = fs.mkdtempSync(path.join(TEST_TEMP, 'plugin-registration-race-'));
  const target = path.join(root, 'marketplace.json');
  const original = Buffer.from('{"name":"test"}\n');
  fs.writeFileSync(target, original);
  const read = fs.readFileSync;
  let reads = 0;
  try {
    fs.readFileSync = (...args) => {
      reads++;
      if (reads === 2) fs.writeFileSync(target, '{"name":"concurrent"}\n');
      return read.apply(fs, args);
    };
    assert.throws(() => atomicReplace(target, '{"name":"changed"}\n', original), /changed before commit/);
    assert.equal(fs.readFileSync(target, 'utf8'), '{"name":"concurrent"}\n');
    assert.deepEqual(fs.readdirSync(root), ['marketplace.json']);
  } finally {
    fs.readFileSync = read;
    fs.rmSync(root, {recursive: true, force: true});
  }
});
