import {testTempFamily} from './test-temp-root.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(repo, 'scripts', 'orchestrate-sdk.mjs');
fs.mkdirSync(testTempFamily('project-resource-conflicts'), {recursive: true});

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
  throw new Error('project-resource-conflicts test requires an installed Codex CLI');
}

function planRequest(request) {
  const workspace = fs.mkdtempSync(path.join(testTempFamily('project-resource-conflicts'), 'project-resource-'));
  try {
    const env = {...process.env, ORCH_CLI: findLocalCodexCli(), ORCH_ALLOW_UNVERIFIED_CLI: '1', ORCH_SANDBOX: 'danger-full-access', ORCH_APPROVAL: 'never', ORCH_STATE_DIR: 'state'};
    for (const name of ['CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'ORCH_RUN_ID', 'ORCH_ACCEPTANCE_FILE']) delete env[name];
    const result = spawnSync(process.execPath, [entry, '--workspace', workspace, '--plan', request],
      {cwd: workspace, env, encoding: 'utf8', windowsHide: true, timeout: 120000});
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout).blocks;
  } finally {
    fs.rmSync(workspace, {recursive: true, force: true});
  }
}

test('shared absolute files at Chinese sentence boundaries form one serial component', () => {
  const blocks = planRequest('项目501：写 C:\\exam\\shared.txt；项目502：写 C:\\exam\\shared.txt；项目503：写 C:\\exam\\other.txt');
  assert.equal(blocks.length, 2);
  const serial = blocks.find(block => block.type === 'linked');
  assert.equal(serial?.tasks.length, 2);
  assert.ok(serial.conflictKeys.includes('file:c:/exam/shared.txt'));
});

test('explicit relative shared files cannot run in parallel across project labels', () => {
  const blocks = planRequest('项目501：写 fixture/output/shared.json；项目502：写 fixture/output/shared.json；项目503：写 fixture/output/other.json');
  assert.equal(blocks.length, 2);
  assert.equal(blocks.find(block => block.type === 'linked')?.tasks.length, 2);
});

test('quoted shared paths preserve spaces and Unicode in conflict grouping', () => {
  const blocks = planRequest('项目501：写 "C:\\考试 folder\\共享.json"；项目502：写 "C:\\考试 folder\\共享.json"；项目503：写 "C:\\考试 folder\\独立.json"');
  assert.equal(blocks.length, 2);
  const serial = blocks.find(block => block.type === 'linked');
  assert.equal(serial?.tasks.length, 2);
  assert.ok(serial.conflictKeys.includes('file:c:/考试 folder/共享.json'));
});

test('distinct sibling relative files retain independent blocks', () => {
  const blocks = planRequest('项目501：写 alpha/result.json；项目502：写 beta/result.json');
  assert.equal(blocks.length, 2);
  assert.ok(blocks.every(block => block.type === 'independent'));
});

test('explicit dependencies bypass the project-only fast path', () => {
  const blocks = planRequest('项目501：T001 创建 alpha.json；项目502：T002 depends on T001 创建 beta.json');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'linked');
  assert.equal(blocks[0].tasks.length, 2);
});
