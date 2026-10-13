import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {nextRcVersion, normalizeRcVersion, parseRcVersion, readPluginVersion, writePluginVersion} from '../scripts/bump-version.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-orch-version-'));
  fs.mkdirSync(path.join(root, '.codex-plugin'), {recursive: true});
  fs.mkdirSync(path.join(root, 'scripts'), {recursive: true});
  fs.mkdirSync(path.join(root, 'docs'), {recursive: true});
  const version = '0.9.28-rc.7';
  fs.writeFileSync(path.join(root, '.codex-plugin', 'plugin.json'), JSON.stringify({name: 'fixture', version}) + '\n');
  fs.writeFileSync(path.join(root, 'scripts', 'package.json'), JSON.stringify({name: 'fixture', version}) + '\n');
  fs.writeFileSync(path.join(root, 'scripts', 'package-lock.json'), JSON.stringify({
    name: 'fixture',
    version,
    lockfileVersion: 3,
    packages: {'': {name: 'fixture', version, dependencies: {}}}
  }) + '\n');
  fs.writeFileSync(path.join(root, 'docs', 'release-policy.md'), `# Release policy\n\nCurrent candidate: core test, plugin ${version}.\n`);
  return root;
}

test('RC parser normalizes build metadata and increments only the RC number', () => {
  assert.deepEqual(parseRcVersion('0.5.0-rc.1+codex.20260929103036'), {major: 0, minor: 5, patch: 0, rc: 1});
  assert.equal(normalizeRcVersion('0.9.29-rc.1+local'), '0.9.29-rc.1');
  assert.equal(nextRcVersion('0.9.29-rc.1'), '0.9.29-rc.2');
  assert.throws(() => parseRcVersion('0.9.29'), /expected/);
});

test('version writer updates all release manifests and is idempotent', () => {
  const root = fixture();
  try {
    assert.equal(readPluginVersion(root), '0.9.28-rc.7');
    assert.deepEqual(writePluginVersion(root, '0.9.29-rc.1'), {
      previous: '0.9.28-rc.7',
      version: '0.9.29-rc.1',
      changed: true
    });
    assert.equal(readPluginVersion(root), '0.9.29-rc.1');
    assert.match(fs.readFileSync(path.join(root, 'docs', 'release-policy.md'), 'utf8'), /Current candidate: core test, plugin 0\.9\.29-rc\.1\./);
    assert.deepEqual(writePluginVersion(root, '0.9.29-rc.1'), {
      previous: '0.9.29-rc.1',
      version: '0.9.29-rc.1',
      changed: false
    });
    assert.equal(readPluginVersion(root), '0.9.29-rc.1');
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});
