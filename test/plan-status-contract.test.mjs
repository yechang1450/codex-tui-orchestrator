import {testTempFamily} from './test-temp-root.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(repo, 'scripts', 'orchestrate-sdk.mjs');

function findLocalCodexCli() {
  const roots = [
    path.join(process.env.LOCALAPPDATA || '', 'OpenAI', 'Codex', 'bin'),
    path.join(process.env.USERPROFILE || '', '.codex', 'packages'),
    path.join(process.env.PLUGIN_DATA || '', 'runtime', 'cli'),
  ].filter(Boolean);
  const pending = [...roots];
  while (pending.length) {
    const current = pending.shift();
    let entries;
    try { entries = fs.readdirSync(current, {withFileTypes: true}); } catch { continue; }
    for (const entry of entries) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile() && entry.name.toLowerCase() === 'codex.exe') return candidate;
    }
  }
  throw new Error('plan/status contract test requires an installed Codex CLI');
}

function cliEnv(workspace) {
  const env = {
    ...process.env,
    ORCH_AGENT: 'codex',
    ORCH_CLI: findLocalCodexCli(),
    ORCH_ALLOW_UNVERIFIED_CLI: '1',
    ORCH_AUTO_INSTALL_CLI: '0',
    ORCH_AUTO_INSTALL_DEPS: '0',
    ORCH_SANDBOX: 'danger-full-access',
    ORCH_APPROVAL: 'never',
    WORKSPACE_DIR: workspace,
  };
  for (const key of ['CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'ORCH_RUN_ID', 'ORCH_ACCEPTANCE_FILE', 'ORCH_STATE_DIR']) {
    delete env[key];
  }
  return env;
}

test('empty --plan fails closed instead of creating an executable empty task', () => {
  const workspace = fs.mkdtempSync(path.join(testTempFamily('plan-status-contract'), 'empty-plan-'));
  try {
    const result = spawnSync(process.execPath, [entry, '--workspace', workspace, '--plan', ''], {
      cwd: workspace,
      env: cliEnv(workspace),
      encoding: 'utf8',
      windowsHide: true,
      timeout: 120000,
    });
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /Plan needs a request|PLAN_REQUEST_EMPTY/);
    assert.doesNotMatch(result.stdout, /autosafe-serialized/);
  } finally {
    fs.rmSync(workspace, {recursive: true, force: true});
  }
});

test('public --status --json stays machine-readable when no run id exists', () => {
  const workspace = fs.mkdtempSync(path.join(testTempFamily('plan-status-contract'), 'empty-status-'));
  try {
    const result = spawnSync(process.execPath, [entry, '--workspace', workspace, '--status', '--json', '--readonly'], {
      cwd: workspace,
      env: cliEnv(workspace),
      encoding: 'utf8',
      windowsHide: true,
      timeout: 120000,
    });
    assert.equal(result.status, 0, result.stderr);
    const state = JSON.parse(result.stdout);
    assert.equal(state.type, 'empty');
    assert.equal(state.runId, null);
    assert.doesNotMatch(result.stdout, /alive agent TUI windows|Usage:/);
  } finally {
    fs.rmSync(workspace, {recursive: true, force: true});
  }
});
