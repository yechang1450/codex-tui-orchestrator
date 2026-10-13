import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

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

test('the coverage entry point exists and is documented only in the source-maintainer policy', () => {
  assert.equal(fs.existsSync(script), true, 'scripts/coverage.mjs must exist');
  const policy = fs.readFileSync(path.join(root, 'docs', 'release-policy.md'), 'utf8');
  const contract = fs.readFileSync(path.join(root, 'docs', 'execution-contract.md'), 'utf8');
  assert.match(policy, /scripts\/coverage\.mjs|scripts\\coverage\.mjs/);
  assert.doesNotMatch(contract, /scripts\/coverage\.mjs|scripts\\coverage\.mjs/);
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

test('coverage isolates inherited desktop authority before it runs offline fixtures', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-coverage-host-context-'));
  const fixture = path.join(dir, 'fixture.test.mjs');
  const out = path.join(dir, 'lcov.info');
  const initiatorContext = pathToFileURL(path.join(root, 'scripts', 'core', 'initiator-context.mjs')).href;
  fs.writeFileSync(fixture, [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    `import {PROCESS_INITIATOR_CONTEXT} from ${JSON.stringify(initiatorContext)};`,
    "test('fixture sees no desktop authority', () => assert.equal(PROCESS_INITIATOR_CONTEXT.threadId, ''));",
    '',
  ].join('\n'));
  try {
    const result = spawnSync(
      process.execPath,
      [script, '--test', fixture, '--out', out, '--quiet'],
      {
        cwd: root,
        encoding: 'utf8',
        windowsHide: true,
        env: {
          ...process.env,
          CODEX_THREAD_ID: '11111111-1111-1111-1111-111111111111',
          CODEX_SESSION_ID: '22222222-2222-2222-2222-222222222222',
          CODEX_PERMISSION_PROFILE: 'danger-full-access',
          CODEX_TASK_WORKSPACE_VERIFYING_IDENTITY: 'desktop-binding',
          WORKSPACE_DIR: path.join(dir, 'desktop-workspace'),
        },
      },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('coverage rejects an unknown option instead of silently ignoring it', () => {
  const result = spawnSync(process.execPath, [script, '--nope'], { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /unknown option/i);
});
