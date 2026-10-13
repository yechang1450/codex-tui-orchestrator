import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {sealDependencyTree, verifyDependencyTree} from '../scripts/dependency-integrity.mjs';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dependencyCli = path.join(sourceRoot, 'scripts', 'dependency-integrity.mjs');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-dep-integrity-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  fs.writeFileSync(path.join(dir, 'package-lock.json'), '{"lockfileVersion":3}\n');
  const packageDir = path.join(dir, 'node_modules', '@openai', 'codex-sdk');
  fs.mkdirSync(packageDir, {recursive: true});
  fs.writeFileSync(path.join(packageDir, 'package.json'), '{"name":"@openai/codex-sdk"}\n');
  fs.writeFileSync(path.join(packageDir, 'index.js'), 'export const ready = true;\n');
  return {dir, packageDir};
}

function skipUnavailableDirectoryLink(t, error, label) {
  if (process.platform === 'win32' && ['EACCES', 'EPERM'].includes(error?.code)) {
    t.skip(`this Windows account cannot create a ${label}`);
    return true;
  }
  return false;
}

test('locked dependency seal accepts the exact installed tree', t => {
  const {dir} = fixture(t);
  const seal = sealDependencyTree({dir});
  assert.equal(seal.files, 2);
  const result = verifyDependencyTree({dir});
  assert.equal(result.ok, true);
  assert.equal(result.files, 2);
});

test('dependency integrity CLI verifies a sealed tree and rejects inert arguments', () => {
  const verify = spawnSync(process.execPath, [dependencyCli, '--verify'], {
    cwd: sourceRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(verify.status, 0, verify.stderr);
  const report = JSON.parse(verify.stdout);
  assert.equal(report.ok, true);
  assert.ok(Number.isSafeInteger(report.files) && report.files > 0);

  for (const args of [['--unknown'], ['--seal', '--verify']]) {
    const rejected = spawnSync(process.execPath, [dependencyCli, ...args], {
      cwd: sourceRoot,
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.notEqual(rejected.status, 0, `${args.join(' ')} must not silently succeed`);
    assert.match(rejected.stderr, /unknown option|cannot be combined/i);
  }
});

test('npm generated codex shims can vary while package bytes stay sealed', t => {
  const {dir} = fixture(t);
  const bin = path.join(dir, 'node_modules', '.bin');
  fs.mkdirSync(bin);
  const shim = path.join(bin, 'codex.cmd');
  fs.writeFileSync(shim, '@echo off\r\nrem npm A\r\n');
  const seal = sealDependencyTree({dir});
  assert.equal(seal.files, 2);
  fs.writeFileSync(shim, '@echo off\r\nrem npm B\r\n');
  assert.equal(verifyDependencyTree({dir}).ok, true);
  fs.writeFileSync(path.join(bin, 'other.cmd'), '@echo off\r\n');
  assert.equal(verifyDependencyTree({dir}).code, 'RELEASE_DEPENDENCY_INTEGRITY');
});

test('locked dependency seal rejects modified, added, or removed package bytes', t => {
  const {dir, packageDir} = fixture(t);
  sealDependencyTree({dir});
  const entry = path.join(packageDir, 'index.js');
  const original = fs.readFileSync(entry);
  fs.writeFileSync(entry, 'export const ready = false;\n');
  assert.equal(verifyDependencyTree({dir}).code, 'RELEASE_DEPENDENCY_INTEGRITY');
  fs.writeFileSync(entry, original);
  const added = path.join(packageDir, 'extra.js');
  fs.writeFileSync(added, 'unsealed');
  assert.equal(verifyDependencyTree({dir}).code, 'RELEASE_DEPENDENCY_INTEGRITY');
  fs.unlinkSync(added);
  fs.unlinkSync(entry);
  assert.equal(verifyDependencyTree({dir}).code, 'RELEASE_DEPENDENCY_INTEGRITY');
});

test('locked dependency seal rejects a changed package lock and symbolic links', t => {
  const {dir, packageDir} = fixture(t);
  sealDependencyTree({dir});
  fs.writeFileSync(path.join(dir, 'package-lock.json'), '{"lockfileVersion":4}\n');
  assert.equal(verifyDependencyTree({dir}).code, 'RELEASE_DEPENDENCY_INTEGRITY');
  fs.writeFileSync(path.join(dir, 'package-lock.json'), '{"lockfileVersion":3}\n');
  const target = path.join(dir, 'linked-target');
  fs.mkdirSync(target);
  const link = path.join(packageDir, 'linked-directory');
  try { fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (error.code === 'EPERM') { t.diagnostic('this Windows account cannot create test reparse points'); return; }
    throw error;
  }
  assert.equal(verifyDependencyTree({dir}).code, 'RELEASE_DEPENDENCY_INTEGRITY');
});

for (const {label, type} of process.platform === 'win32'
  ? [{label: 'junction', type: 'junction'}, {label: 'directory symbolic link', type: 'dir'}]
  : [{label: 'directory symbolic link', type: 'dir'}]) {
  test(`locked dependency verification rejects a root node_modules ${label}`, t => {
    const {dir} = fixture(t);
    sealDependencyTree({dir});
    const nodeModules = path.join(dir, 'node_modules');
    const target = path.join(dir, 'sealed-node_modules');
    fs.renameSync(nodeModules, target);
    try {
      fs.symlinkSync(target, nodeModules, type);
    } catch (error) {
      if (skipUnavailableDirectoryLink(t, error, label)) return;
      throw error;
    }
    assert.equal(fs.lstatSync(nodeModules).isSymbolicLink(), true, 'fixture must be a real reparse point');
    const result = verifyDependencyTree({dir});
    assert.equal(result.code, 'RELEASE_DEPENDENCY_INTEGRITY');
    assert.match(result.message, /node_modules.*(?:symbolic link|junction)|(?:symbolic link|junction).*node_modules/i);
  });
}
