import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(repo, rel), 'utf8'));
}

test('CHANGELOG records the cachebuster that plugin.json currently ships', () => {
  const manifest = readJson(path.join('.codex-plugin', 'plugin.json'));
  const changelog = fs.readFileSync(path.join(repo, 'CHANGELOG.md'), 'utf8');

  const match = /\+codex\.\d{14}/.exec(manifest.version);
  assert.ok(match, `plugin.json 版本里应带 cachebuster，实际为 ${manifest.version}`);
  const cachebuster = match[0];

  assert.ok(
    changelog.includes(cachebuster),
    `CHANGELOG 必须记录当前 cachebuster ${cachebuster}（发布纪律：每次升 cachebuster 都留痕，否则排障时会误判在跑哪个版本）`
  );
});

test('cachebuster stays in sync across the three release manifests', () => {
  const manifest = readJson(path.join('.codex-plugin', 'plugin.json')).version;
  const pkg = readJson(path.join('scripts', 'package.json')).version;
  const lock = readJson(path.join('scripts', 'package-lock.json')).version;

  assert.equal(pkg, manifest, `scripts/package.json 版本应与 plugin.json 一致（${pkg} vs ${manifest}）`);
  assert.equal(lock, manifest, `scripts/package-lock.json 版本应与 plugin.json 一致（${lock} vs ${manifest}）`);
});
