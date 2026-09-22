import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {workspaceTrustState, trustConfigPath} from '../scripts/core/orchestrate-sdk.mjs';

const TEST_TEMP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'temp');
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
    "[projects.'c:\\users\\me\\proj one']",
    'trust_level = "trusted"',
    '',
    "[projects.'c:\\users\\me\\other']",
    'trust_level = "untrusted"',
    '',
  ].join('\n'));
  try {
    assert.equal(workspaceTrustState('C:\\Users\\Me\\Proj One', {configPath: f.file}), 'trusted');
    assert.equal(workspaceTrustState('c:/users/me/proj one/', {configPath: f.file}), 'trusted');
    assert.equal(workspaceTrustState('C:\\Users\\Me\\Other', {configPath: f.file}), 'untrusted');
    assert.equal(workspaceTrustState('C:\\Users\\Me\\Missing', {configPath: f.file}), 'untrusted');
    assert.equal(workspaceTrustState('C:\\x', {configPath: path.join(f.dir, 'nope.toml')}), 'unknown');
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
