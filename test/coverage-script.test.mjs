import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const script = path.join(root, 'scripts', 'coverage.mjs');

function readLcov(file) {
  return fs.readFileSync(file, 'utf8').split('\n');
}

function total(lines, prefix) {
  return lines
    .filter((line) => line.startsWith(prefix))
    .reduce((sum, line) => sum + Number(line.slice(prefix.length)), 0);
}

test('the coverage entry point exists and is part of the documented regression commands', () => {
  assert.equal(fs.existsSync(script), true, 'scripts/coverage.mjs must exist');
  const contract = fs.readFileSync(path.join(root, 'docs', 'execution-contract.md'), 'utf8');
  assert.match(contract, /scripts\/coverage\.mjs|scripts\\coverage\.mjs/);
});

test('coverage writes lcov line records for the sources a test file exercises', () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-coverage-')), 'lcov.info');
  try {
    const result = spawnSync(
      process.execPath,
      [script, '--test', 'test/network-policy.test.mjs', '--out', out],
      { cwd: root, encoding: 'utf8', windowsHide: true },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const lines = readLcov(out);
    const sources = lines.filter((line) => line.startsWith('SF:'));
    assert.ok(sources.length > 0, 'lcov must contain SF records');
    assert.ok(sources.every((line) => !line.includes('\\')), 'lcov source paths must use forward slashes');
    assert.ok(total(lines, 'LF:') > 0, 'lcov must report findable lines');
  } finally {
    fs.rmSync(path.dirname(out), { recursive: true, force: true });
  }
});

test('coverage rejects an unknown option instead of silently ignoring it', () => {
  const result = spawnSync(process.execPath, [script, '--nope'], { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /unknown option/i);
});
