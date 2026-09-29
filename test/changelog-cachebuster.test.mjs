import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(repo, rel), 'utf8'));
}

test('CHANGELOG records the RC version that plugin.json currently ships', () => {
  const manifest = readJson(path.join('.codex-plugin', 'plugin.json'));
  const changelog = fs.readFileSync(path.join(repo, 'CHANGELOG.md'), 'utf8');

  assert.match(manifest.version, /^\d+\.\d+\.\d+-rc\.\d+$/, `plugin.json 应使用标准 RC 版本，实际为 ${manifest.version}`);

  assert.ok(
    changelog.includes(`## ${manifest.version}`),
    `CHANGELOG 必须记录当前 RC 版本 ${manifest.version}（每次递增都留痕，便于排障时确认运行版本）`
  );
});

test('RC version stays in sync across the three release manifests', () => {
  const manifest = readJson(path.join('.codex-plugin', 'plugin.json')).version;
  const pkg = readJson(path.join('scripts', 'package.json')).version;
  const lockfile = readJson(path.join('scripts', 'package-lock.json'));
  const lock = lockfile.version;

  assert.equal(pkg, manifest, `scripts/package.json 版本应与 plugin.json 一致（${pkg} vs ${manifest}）`);
  assert.equal(lock, manifest, `scripts/package-lock.json 版本应与 plugin.json 一致（${lock} vs ${manifest}）`);
  assert.equal(lockfile.packages[''].version, manifest, 'package-lock 根包版本应与 plugin.json 一致');
});
