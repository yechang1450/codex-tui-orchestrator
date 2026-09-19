import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {inspectRegistration, repairRegistration, atomicReplace} from '../scripts/repair-plugin-registration.mjs';

const TEST_TEMP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'temp');
fs.mkdirSync(TEST_TEMP, {recursive: true});

function fixture(entry, extra = []) {
  const root = fs.mkdtempSync(path.join(TEST_TEMP, 'plugin-registration-'));
  const plugin = path.join(root, 'plugin');
  const marketRoot = path.join(root, 'home');
  fs.mkdirSync(path.join(plugin, '.codex-plugin'), {recursive: true});
  fs.mkdirSync(marketRoot, {recursive: true});
  fs.writeFileSync(path.join(plugin, '.codex-plugin', 'plugin.json'), JSON.stringify({name: 'demo-plugin', version: '1.0.0'}));
  const marketplace = path.join(marketRoot, 'marketplace.json');
  fs.writeFileSync(marketplace, JSON.stringify({name: 'test', interface: {displayName: 'Test'}, plugins: [entry, ...extra]}, null, 2) + '\n');
  return {root, plugin, marketRoot, marketplace};
}

function localEntry(name, sourcePath, source = 'local') {
  return {name, source: {source, path: sourcePath}, policy: {installation: 'AVAILABLE', authentication: 'ON_INSTALL'}, category: 'Test'};
}

function opts(f) { return {pluginPath: f.plugin, marketplacePath: f.marketplace, marketplaceRoot: f.marketRoot}; }
function cleanup(f) { fs.rmSync(f.root, {recursive: true, force: true}); }

test('exactly matched registration passes check', () => {
  const f = fixture(localEntry('demo-plugin', '../plugin')); try {
    assert.deepEqual(inspectRegistration(opts(f)).status, 'matched');
  } finally { cleanup(f); }
});

test('case-only drift is repaired and preserves path, policy, and other entries', () => {
  const other = localEntry('other-plugin', './other');
  const f = fixture(localEntry('Demo-Plugin', '../plugin'), [other]); try {
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
  const wrong = fixture(localEntry('Demo-Plugin', '../elsewhere')); try {
    assert.equal(inspectRegistration(opts(wrong)).status, 'source_mismatch');
  } finally { cleanup(wrong); }
  const remote = fixture(localEntry('Demo-Plugin', '../plugin', 'git')); try {
    assert.equal(inspectRegistration(opts(remote)).status, 'source_mismatch');
  } finally { cleanup(remote); }
  const exactWrong = fixture(localEntry('demo-plugin', '../elsewhere')); try {
    assert.equal(inspectRegistration(opts(exactWrong)).status, 'source_mismatch');
  } finally { cleanup(exactWrong); }
});

// 干净分发：coreInventory 需要 scripts/core 下的入口文件存在
function coreFixture(pluginDir, marker) {
  const core = path.join(pluginDir, 'scripts', 'core');
  fs.mkdirSync(core, {recursive: true});
  fs.writeFileSync(path.join(core, 'orchestrate-sdk.mjs'), 'export const marker = ' + JSON.stringify(marker) + ';\n');
  fs.writeFileSync(path.join(core, 'contracts.mjs'), 'export const CORE_VERSION = "test";\n');
}

test('a clean distribution is accepted as install source only while its core matches the checkout', () => {
  const f = fixture(localEntry('demo-plugin', '../dist/demo-plugin')); try {
    coreFixture(f.plugin, 'checkout');
    const distRoot = path.join(f.root, 'dist');
    const dist = path.join(distRoot, 'demo-plugin');
    coreFixture(dist, 'checkout');
    const matched = inspectRegistration({...opts(f), distRoot});
    assert.equal(matched.status, 'matched');
    assert.equal(matched.sourceKind, 'dist');
    // 分发和 checkout 不同核心 → 陈旧分发，必须先重建再安装
    fs.writeFileSync(path.join(dist, 'scripts', 'core', 'orchestrate-sdk.mjs'), 'export const marker = "stale";\n');
    const stale = inspectRegistration({...opts(f), distRoot});
    assert.equal(stale.status, 'stale_dist');
    assert.equal(stale.ok, false);
  } finally { cleanup(f); }
});

test('a dist path outside the plugin family is still rejected', () => {
  const f = fixture(localEntry('demo-plugin', '../elsewhere/demo-plugin')); try {
    coreFixture(f.plugin, 'checkout');
    const distRoot = path.join(f.root, 'dist');
    coreFixture(path.join(distRoot, 'demo-plugin'), 'checkout');
    assert.equal(inspectRegistration({...opts(f), distRoot}).status, 'source_mismatch');
  } finally { cleanup(f); }
});

test('check is read-only and CLI emits machine-readable failure', () => {
  const f = fixture(localEntry('Demo-Plugin', '../plugin')); try {
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
