import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scripts = path.resolve(__dirname, '..', 'scripts');

// ---------- poll-windows: status sets + summary logic ----------
const importUrl = (p) => pathToFileURL(p).href;
const runNode = (file, args, opts = {}) => {
  try {
    const out = execFileSync(process.execPath, [file, ...args], { encoding: 'utf8', ...opts });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: String(e.stdout || '') };
  }
};
const { TERMINAL, SUCCESS, summaryComplete, failures } = await import(importUrl(path.join(scripts, 'poll-windows.mjs')));
test('poll-windows TERMINAL/SUCCESS sets', () => {
  assert.equal(TERMINAL.has('done'), true);
  assert.equal(TERMINAL.has('failed'), true);   // fixed: failed is terminal
  assert.equal(TERMINAL.has('pending'), false);
  assert.equal(SUCCESS.has('done'), true);
  assert.equal(SUCCESS.has('failed'), false);   // failed is NOT success
});
test('poll-windows summaryComplete', () => {
  const requireAll = process.argv.includes('--require-all-success');
  const allDone = { results: { B1: { status: 'done' }, B2: { status: 'ok' } } };
  const oneFailed = { results: { B1: { status: 'done' }, B2: { status: 'failed' } } };
  assert.equal(summaryComplete(allDone), true);
  // In default (non require-all-success) mode, failed is terminal -> complete.
  // In --require-all-success mode, failed is not in SUCCESS -> incomplete.
  if (requireAll) assert.equal(summaryComplete(oneFailed), false);
  else assert.equal(summaryComplete(oneFailed), true);
  assert.equal(summaryComplete(null), false);
  assert.equal(summaryComplete({ results: {} }), false);
});
test('poll-windows failures lists non-success blocks', () => {
  const f = failures({ results: { B1: { status: 'done' }, B2: { status: 'failed' } } });
  assert.deepEqual(f, ['B2:failed']);
});

// ---------- force.mjs: armed/liveWindows/pidOf on temp registry ----------
// force.mjs reads WORKSPACE_DIR at import; we set it before import and test helpers.
const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-force-test-'));
process.env.WORKSPACE_DIR = wsDir;
const { armed, liveWindows, pidOf, pidAlive, WINDOWS_REG, TMP, FLAG } = await import(importUrl(path.join(scripts, 'codex-tui-orchestrator-force.mjs')));
test('force.mjs armed/liveWindows/pidOf/pidAlive', () => {
  // fresh workspace -> not armed, no windows
  assert.equal(armed(), false);
  assert.deepEqual(liveWindows(), []);
  // pidOf returns 0 for missing/unreadable pidFile
  assert.equal(pidOf({ pidFile: path.join(wsDir, 'no-such.pid') }), 0);
  // write a valid pidFile pointing to current process -> pidOf returns it
  const pidFile = path.join(wsDir, 'w.pid');
  fs.writeFileSync(pidFile, String(process.pid), 'utf8');
  assert.equal(pidOf({ pidFile }), process.pid);
  // pidAlive: a normal node process (not an orchestrator launcher) is NOT a sanctioned window -> false.
  // (The win32 gate requires the command line to reference orchestrate-sdk.mjs / --run-windows.)
  assert.equal(pidAlive(process.pid), false);
  assert.equal(pidAlive(99999999), false);
  // armed becomes true once the flag file exists with a numeric payload
  fs.mkdirSync(path.join(wsDir, 'temp'), { recursive: true });
  const flag = path.join(wsDir, 'temp', '.orchestrator-enabled');
  fs.writeFileSync(flag, String(Date.now()), 'utf8');
  assert.equal(armed(), true);
  // WINDOWS_REG/TMP point under the temp workspace
  assert.equal(TMP, path.join(wsDir, 'temp'));
  assert.ok(WINDOWS_REG.startsWith(TMP));
});

test('force.mjs CLI --status/--assert read/--assert write', () => {
  const cliDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-force-cli-'));
  try {
    const env = { ...process.env, WORKSPACE_DIR: cliDir };
    // --status on empty workspace: armed=false, 0 windows
    const st = runNode(path.join(scripts, 'codex-tui-orchestrator-force.mjs'), ['--status'], { env });
    assert.equal(st.code, 0);
    assert.match(st.out, /armed|ARMED|enabled/);
    // --assert read on not-armed -> exit 0 (ok)
    const ar = runNode(path.join(scripts, 'codex-tui-orchestrator-force.mjs'), ['--assert', 'read'], { env });
    assert.equal(ar.code, 0);
    // --assert write on not-armed -> "ok: orchestrator not armed" exit 0
    const aw = runNode(path.join(scripts, 'codex-tui-orchestrator-force.mjs'), ['--assert', 'write'], { env });
    assert.equal(aw.code, 0);
    // --verify on not-armed -> exit 0 (verification not applicable)
    const v = runNode(path.join(scripts, 'codex-tui-orchestrator-force.mjs'), ['--verify', path.join(cliDir, 'nope.txt')], { env });
    assert.equal(v.code, 0);
  } finally {
    fs.rmSync(cliDir, { recursive: true, force: true });
  }
});

test('force.mjs CLI --assert real kind refuses outside window; --verify VIOLATION when armed', () => {
  const cliDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-force-cli2-'));
  try {
    const env = { ...process.env, WORKSPACE_DIR: cliDir };
    const tmpDir = path.join(cliDir, 'temp');
    fs.mkdirSync(tmpDir, { recursive: true });
    // arm enforcement
    fs.writeFileSync(path.join(tmpDir, '.orchestrator-enabled'), String(Date.now()), 'utf8');
    // --assert read when armed + no window -> read-only ok (exit 0)
    const ar = runNode(path.join(scripts, 'codex-tui-orchestrator-force.mjs'), ['--assert', 'read'], { env });
    assert.equal(ar.code, 0);
    // --assert exec when armed + no window -> REFUSED (exit 1)
    const ae = runNode(path.join(scripts, 'codex-tui-orchestrator-force.mjs'), ['--assert', 'exec'], { env });
    assert.equal(ae.code, 1);
    assert.match(ae.out, /REFUSED/i);
    // --verify a file when armed + no window -> VIOLATION (exit 1)
    const target = path.join(cliDir, 'file.txt');
    fs.writeFileSync(target, 'x', 'utf8');
    const v = runNode(path.join(scripts, 'codex-tui-orchestrator-force.mjs'), ['--verify', target], { env });
    assert.equal(v.code, 1);
    assert.match(v.out, /VIOLATION/i);
  } finally {
    fs.rmSync(cliDir, { recursive: true, force: true });
  }
});

test('force.mjs CLI --enable arms enforcement', () => {
  const cliDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-force-enable-'));
  try {
    const env = { ...process.env, WORKSPACE_DIR: cliDir };
    const en = runNode(path.join(scripts, 'codex-tui-orchestrator-force.mjs'), ['--enable'], { env });
    assert.equal(en.code, 0);
    const flag = path.join(cliDir, 'temp', '.orchestrator-enabled');
    assert.equal(fs.existsSync(flag), true);
  } finally {
    fs.rmSync(cliDir, { recursive: true, force: true });
  }
});

// ---------- orchestrate-sdk: pure decompose/conflict helpers ----------
const { classifyBlockComplexity, conflictByKeys, trySingleBlock, genericProjectSplit, loadCachedDecompose } = await import(importUrl(path.join(scripts, 'orchestrate-sdk.mjs')));
test('orchestrate-sdk classifyBlockComplexity', () => {
  // "修复" 命中分析/决策正则 -> 复杂（可能走 LLM 原型）
  assert.equal(classifyBlockComplexity('修复A'), true);
  assert.equal(classifyBlockComplexity('修复A并重启B且安装C并测试D'), true);
  // 无动作词的简短指令 -> 简单
  assert.equal(classifyBlockComplexity('新建文件 readme.txt'), false);
  assert.equal(classifyBlockComplexity(''), false);
});
test('orchestrate-sdk conflictByKeys', () => {
  // 无活窗 -> 返回 null（无冲突）
  assert.equal(conflictByKeys(['file:C:/workspace/build/81', 'port:8081']), null);
});
test('orchestrate-sdk trySingleBlock returns null for multi-project request', () => {
  const r = trySingleBlock('修复 C:\\workspace\\build\\81 登录页、优化 C:\\workspace\\build\\82 UI');
  assert.equal(r, null);
});
test('orchestrate-sdk trySingleBlock single project + single action -> block', () => {
  const r = trySingleBlock('修复 C:\\workspace\\build\\81 登录页');
  assert.ok(r && r.blocks.length === 1);
  assert.equal(r.blocks[0].title, 'proj-81');
  assert.deepEqual(r.blocks[0].conflictKeys, ['dir:proj-81']);
});
test('orchestrate-sdk trySingleBlock no action -> null', () => {
  assert.equal(trySingleBlock('看看目录结构'), null);
  assert.equal(trySingleBlock(''), null);
});
test('orchestrate-sdk genericProjectSplit splits multi-project sentences', () => {
  const r = genericProjectSplit('修复 C:\\workspace\\build\\81 登录页；优化 C:\\workspace\\build\\82 UI');
  assert.ok(r && r.blocks.length >= 2);
  const titles = r.blocks.map((b) => b.title);
  assert.ok(titles.includes('proj-81'));
  assert.ok(titles.includes('proj-82'));
});
test('orchestrate-sdk genericProjectSplit returns null for single project', () => {
  assert.equal(genericProjectSplit('修复 C:\\workspace\\build\\81 登录页'), null);
});
test('orchestrate-sdk loadCachedDecompose returns null for empty cache', () => {
  assert.equal(loadCachedDecompose('修复 81 登录页'), null);
});

fs.rmSync(wsDir, { recursive: true, force: true });
console.log('orchestrator tests passed.');
