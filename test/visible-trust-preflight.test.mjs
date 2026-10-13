import {testTempFamily} from './test-temp-root.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {workspaceTrustState, trustConfigPath} from '../scripts/core/orchestrate-sdk.mjs';

const TEST_TEMP = testTempFamily('visible-trust-preflight');
fs.mkdirSync(TEST_TEMP, {recursive: true});

function configFixture(content) {
  const dir = fs.mkdtempSync(path.join(TEST_TEMP, 'visible-trust-'));
  const file = path.join(dir, 'config.toml');
  fs.writeFileSync(file, content);
  return {dir, file};
}

test('workspace trust preflight reads the same project entries the CLI writes', () => {
  const f = configFixture([
    'model = "deepseek-flash"',
    '',
    "[projects.'c:\\fixture-root\\proj one']",
    'trust_level = "trusted"',
    '',
    "[projects.'c:\\fixture-root\\other']",
    'trust_level = "untrusted"',
    '',
  ].join('\n'));
  try {
    assert.equal(workspaceTrustState('C:\\Fixture-Root\\Proj One', {configPath: f.file}), 'trusted');
    assert.equal(workspaceTrustState('c:/fixture-root/proj one/', {configPath: f.file}), 'trusted');
    assert.equal(workspaceTrustState('C:\\Fixture-Root\\Other', {configPath: f.file}), 'untrusted');
    assert.equal(workspaceTrustState('C:\\Fixture-Root\\Missing', {configPath: f.file}), 'untrusted');
    assert.equal(workspaceTrustState('C:\\x', {configPath: path.join(f.dir, 'nope.toml')}), 'unknown');
  } finally {
    fs.rmSync(f.dir, {recursive: true, force: true});
  }
});

test('workspace trust preflight decodes TOML basic-string project keys', () => {
  const f = configFixture([
    '[projects."C:\\\\Fixture-Root\\\\Proj One"]',
    'trust_level = "trusted"',
    '',
    '[projects."C:\\\\Fixture-Root\\\\Project \\\"Quoted\\\""]',
    'trust_level = "trusted"',
    '',
  ].join('\n'));
  try {
    assert.equal(workspaceTrustState('C:\\Fixture-Root\\Proj One', {configPath: f.file}), 'trusted');
    assert.equal(workspaceTrustState('C:\\Fixture-Root\\Project "Quoted"', {configPath: f.file}), 'trusted');
  } finally {
    fs.rmSync(f.dir, {recursive: true, force: true});
  }
});

test('workspace trust preflight does not read trust from an adjacent section', () => {
  const f = configFixture([
    '[projects."adjacent-target"]',
    '[profiles.local]',
    'trust_level = "trusted"',
    '',
  ].join('\n'));
  try {
    assert.equal(workspaceTrustState('adjacent-target', {configPath: f.file}), 'untrusted');
  } finally {
    fs.rmSync(f.dir, {recursive: true, force: true});
  }
});

test('workspace trust preflight rejects invalid TOML basic-string escapes', () => {
  const f = configFixture([
    String.raw`[projects."C:\fixture-root\Invalid"]`,
    'trust_level = "trusted"',
    '',
  ].join('\n'));
  try {
    assert.equal(workspaceTrustState('C:\\Fixture-Root\\Invalid', {configPath: f.file}), 'untrusted');
  } finally {
    fs.rmSync(f.dir, {recursive: true, force: true});
  }
});

test('trust config path follows CODEX_HOME', () => {
  const previous = process.env.CODEX_HOME;
  try {
    process.env.CODEX_HOME = 'D:\\codex-home';
    assert.equal(trustConfigPath(), path.join('D:\\codex-home', 'config.toml'));
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
  }
});

test('trust config path resolves a relative CODEX_HOME from the visible child workspace', () => {
  const workspace=path.join(TEST_TEMP,'relative-home-workspace');
  assert.equal(
    trustConfigPath({CODEX_HOME:'relative-codex-home'},{workspace}),
    path.join(workspace,'relative-codex-home','config.toml')
  );
});

test('trust preflight rejects drive-dependent Windows CODEX_HOME forms', () => {
  if(process.platform!=='win32') return;
  const workspace='C:\\workspace\\visible-worker';
  for(const codexHome of ['\\root-relative','/root-relative','C:drive-relative']){
    assert.throws(()=>trustConfigPath({CODEX_HOME:codexHome},{workspace}),/CODEX_HOME_PATH_UNSAFE/,codexHome);
  }
});
