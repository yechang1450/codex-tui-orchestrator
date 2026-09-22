import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

// 回归（2026-09-23 穷举审计 A/E 组实测抓到，修前皆红）：
// ① `--plan` 把诊断行（disk / cache HIT / generic split / fast path / priority）打在 **stdout**，
//    机器可读调用方拿到的不是纯 JSON；
// ② `install-plugin --json` 成功路径同样把进度行打在 stdout；
// ③ `--source` 非法枚举被静默降级成 dist（装错来源却报成功）；
// ④ `--workspace` 指向"存在但不是目录"的文件时 exit 0，把文件当工作区用。
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(repo, 'scripts', 'orchestrate-sdk.mjs');

function invoke(script, args, {cwd = repo, extra = {}, timeout = 120000} = {}) {
  const env = {...process.env, ...extra};
  delete env.CODEX_THREAD_ID;
  delete env.CODEX_SESSION_ID;
  delete env.ORCH_STATE_DIR;
  delete env.ORCH_RUN_ID;
  delete env.ORCH_ACCEPTANCE_FILE;
  return spawnSync(process.execPath, [path.join(repo, 'scripts', script), ...args], {cwd, env, encoding: 'utf8', windowsHide: true, timeout});
}

test('--plan keeps stdout pure JSON and sends diagnostics to stderr', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-plan-stdout-'));
  try {
    const result = invoke('orchestrate-sdk.mjs', ['--workspace', workspace, '--plan', '只做一件小事：打印 node --version 的结果'], {cwd: workspace});
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.ok(Array.isArray(parsed.blocks) && parsed.blocks.length > 0, 'plan must return blocks');
    assert.doesNotMatch(String(result.stdout), /\[orchestrator\]/, 'stdout must not carry diagnostics');
  } finally {
    fs.rmSync(workspace, {recursive: true, force: true});
  }
});

test('installers reject an illegal --source instead of coercing it to dist', () => {
  for (const script of ['install-plugin.mjs', 'repair-plugin-registration.mjs']) {
    const result = invoke(script, ['--check', '--source', 'bogus', '--json'], {cwd: repo});
    assert.notEqual(result.status, 0, `${script} must fail closed`);
    const body = JSON.parse(String(result.stdout).trim().split('\n').pop());
    assert.equal(body.ok, false, `${script}: ${result.stdout}`);
    assert.match(String(body.reason), /--source must be dist or checkout/, `${script}: ${result.stdout}`);
  }
});

test('a workspace path that exists but is not a directory fails closed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-ws-file-'));
  const file = path.join(dir, 'not-a-directory.txt');
  fs.writeFileSync(file, 'x', 'utf8');
  try {
    const result = invoke('orchestrate-sdk.mjs', ['--workspace', file, '--doctor'], {cwd: dir});
    assert.notEqual(result.status, 0, 'a file as workspace must not pass validation');
    assert.match(String(result.stderr), /WORKSPACE_NOT_A_DIRECTORY/);
    assert.doesNotMatch(String(result.stderr), /\n\s+at /, 'the failure must stay a single FATAL line');
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
