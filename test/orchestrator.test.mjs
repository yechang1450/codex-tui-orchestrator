import { test, after } from 'node:test';
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
const stDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-force-state-"));
process.env.ORCH_STATE_DIR = stDir;
const { armed, liveWindows, pidOf, pidAlive, WINDOWS_REG, TMP, FLAG, STATE_DIR } = await import(importUrl(path.join(scripts, 'agent-tui-orchestrator-force.mjs')));
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
  fs.mkdirSync(stDir, { recursive: true });
  const flag = path.join(stDir, '.orchestrator-enabled');
  fs.writeFileSync(flag, String(Date.now()), 'utf8');
  assert.equal(armed(), true);
  // WINDOWS_REG/TMP point under the temp workspace
  assert.equal(TMP, path.join(wsDir, 'temp'));
  assert.ok(WINDOWS_REG.startsWith(STATE_DIR));
  assert.equal(FLAG, path.join(STATE_DIR, '.orchestrator-enabled'));
});

test('force.mjs CLI --status/--assert read/--assert write', () => {
  const cliDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-force-cli-'));
  try {
    const env = { ...process.env, WORKSPACE_DIR: cliDir, ORCH_STATE_DIR: path.join(cliDir, 'state') };
    // 测试模拟“非窗/窗外观”语境：剥离宿主（已授权编排窗）遗留的 CODEX_ORCH_WINDOW，
    // 否则子进程会误判为“已授权窗活窗=0”，让本应 read-only ok 的 --assert read 变成 REFUSED。
    delete env.CODEX_ORCH_WINDOW;
    // --status on empty workspace: armed=false, 0 windows
    const st = runNode(path.join(scripts, 'agent-tui-orchestrator-force.mjs'), ['--status'], { env });
    assert.equal(st.code, 0);
    assert.match(st.out, /armed|ARMED|enabled/);
    // --assert read on not-armed -> exit 0 (ok)
    const ar = runNode(path.join(scripts, 'agent-tui-orchestrator-force.mjs'), ['--assert', 'read'], { env });
    assert.equal(ar.code, 0);
    // --assert write on not-armed -> "ok: orchestrator not armed" exit 0
    const aw = runNode(path.join(scripts, 'agent-tui-orchestrator-force.mjs'), ['--assert', 'write'], { env });
    assert.equal(aw.code, 0);
    // --verify on not-armed -> exit 0 (verification not applicable)
    const v = runNode(path.join(scripts, 'agent-tui-orchestrator-force.mjs'), ['--verify', path.join(cliDir, 'nope.txt')], { env });
    assert.equal(v.code, 0);
  } finally {
    fs.rmSync(cliDir, { recursive: true, force: true });
  }
});

test('force.mjs CLI --assert real kind refuses outside window; --verify VIOLATION when armed', () => {
  const cliDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-force-cli2-'));
  try {
    const env = { ...process.env, WORKSPACE_DIR: cliDir, ORCH_STATE_DIR: path.join(cliDir, 'state') };
    // 同上：模拟非窗语境，剥离宿主 CODEX_ORCH_WINDOW，避免 --assert read 被误判为已授权窗。
    delete env.CODEX_ORCH_WINDOW;
    const tmpDir = path.join(cliDir, 'state');
    fs.mkdirSync(tmpDir, { recursive: true });
    // arm enforcement
    fs.writeFileSync(path.join(tmpDir, '.orchestrator-enabled'), String(Date.now()), 'utf8');
    // --assert read when armed + no window -> read-only ok (exit 0)
    const ar = runNode(path.join(scripts, 'agent-tui-orchestrator-force.mjs'), ['--assert', 'read'], { env });
    assert.equal(ar.code, 0);
    // --assert exec when armed + no window -> REFUSED (exit 1)
    const ae = runNode(path.join(scripts, 'agent-tui-orchestrator-force.mjs'), ['--assert', 'exec'], { env });
    assert.equal(ae.code, 1);
    assert.match(ae.out, /REFUSED/i);
    // --verify a file when armed + no window -> VIOLATION (exit 1)
    const target = path.join(cliDir, 'file.txt');
    fs.writeFileSync(target, 'x', 'utf8');
    const v = runNode(path.join(scripts, 'agent-tui-orchestrator-force.mjs'), ['--verify', target], { env });
    assert.equal(v.code, 1);
    assert.match(v.out, /VIOLATION/i);
  } finally {
    fs.rmSync(cliDir, { recursive: true, force: true });
  }
});

test('force.mjs CLI --enable arms enforcement', () => {
  const cliDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-force-enable-'));
  try {
    const env = { ...process.env, WORKSPACE_DIR: cliDir, ORCH_STATE_DIR: path.join(cliDir, 'state') };
    delete env.CODEX_ORCH_WINDOW;
    const en = runNode(path.join(scripts, 'agent-tui-orchestrator-force.mjs'), ['--enable'], { env });
    assert.equal(en.code, 0);
    const flag = path.join(cliDir, 'state', '.orchestrator-enabled');
    assert.equal(fs.existsSync(flag), true);
  } finally {
    fs.rmSync(cliDir, { recursive: true, force: true });
  }
});

// ---------- orchestrate-sdk: pure decompose/conflict helpers ----------
const { classifyBlockComplexity, conflictByKeys, trySingleBlock, genericProjectSplit, loadCachedDecompose, buildBlockPrompt, levelWaves, decomposeHash, checkDiskSpace } = await import(importUrl(path.join(scripts, 'orchestrate-sdk.mjs')));
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
test('orchestrate-sdk blockPrompt: run-windows block prompt embeds a real ASCII token, no bare 完成', () => {
  // 复刻 --run-windows 生成块 prompt 的精确拼接：buildBlockPrompt(blockBody, tk) + "\n" + auth
  const body = '仅处理项目 proj-81。任务：修复登录页；优化 UI。不要处理其它项目编号。\n上面任务之间互相独立、互不依赖：并行执行，互不等待。全部完成后汇总结果。';
  const token = 'B1-abc123-4f2g9z'; // 真实非空 ASCII（r.key-rid-随机 base36）
  const auth = '\n\n（用户已明确、反复授权「同意推进，允许执行」……）\n执行完即可结束本窗、汇报。';
  const prompt = buildBlockPrompt(body, token) + '\n' + auth;
  // 必须含【本块唯一标识】<token> 完成（token 为真实非空 ASCII）
  assert.ok(prompt.includes('【本块唯一标识】' + token), 'prompt must embed the real token after the marker');
  const m = prompt.match(/【本块唯一标识】([A-Za-z0-9_-]+) 完成/);
  assert.ok(m, 'prompt must contain 【本块唯一标识】<token> 完成');
  assert.equal(m[1], token, 'the token before 完成 must be the real block token');
  // 不得出现裸『【本块唯一标识】 完成』（标识后紧跟空格+完成 = token 缺失，watchdog 会把“完成”当 token 再清洗成空而失配）
  assert.doesNotMatch(prompt, /【本块唯一标识】\s+完成/);
});

test('orchestrate-sdk levelWaves strips self/unknown dependsOn and enforces ordering', () => {
  const recs = [
    { key: 'B1', title: 'B1:task-1', b: { title: 'task-1' }, dependsOn: [] },
    { key: 'B2', title: 'B2:task-2', b: { title: 'task-2' }, dependsOn: ['task-1', 'task-2', 'not-a-block'] },
  ];
  const waves = levelWaves(recs);
  // 自引用 task-2 与未知 not-a-block 应被剔除，仅保留对 task-1(B1) 的依赖 -> 严格两波、B1 在前
  assert.equal(waves.length, 2, 'self/unknown deps removed -> B2 must wait for B1');
  assert.deepEqual(waves[0].map((r) => r.key), ['B1']);
  assert.deepEqual(waves[1].map((r) => r.key), ['B2']);
  // B2 的 dependsOn 归一化后只剩 [B1]
  assert.deepEqual(recs[1].dependsOn, ['B1']);
});

test('orchestrate-sdk decomposeHash: cache key is hints-aware (no cross-project collision)', () => {
  const a = { moduleToProj: { 会员管理: '82' }, foldRules: {}, tailKeywords: [] };
  const b = { moduleToProj: { 会员管理: '81' }, foldRules: {}, tailKeywords: [] };
  const h1 = decomposeHash('修复会员管理', a);
  const h2 = decomposeHash('修复会员管理', b);
  const h3 = decomposeHash('修复会员管理', a);
  assert.notEqual(h1, h2, 'different project hints must not collide on the same request text');
  assert.equal(h1, h3, 'same request + same hints must reuse the cache entry');
});

test('orchestrate-sdk checkDiskSpace: returns true on a disk with space (thresholds zeroed)', () => {
  const prevMin = process.env.ORCH_MIN_FREE_MB;
  const prevHard = process.env.ORCH_MIN_FREE_HARD_MB;
  try {
    process.env.ORCH_MIN_FREE_MB = '0';
    process.env.ORCH_MIN_FREE_HARD_MB = '0';
    assert.equal(checkDiskSpace(), true, 'disk with free space and zero thresholds must pass');
  } finally {
    if (prevMin === undefined) delete process.env.ORCH_MIN_FREE_MB; else process.env.ORCH_MIN_FREE_MB = prevMin;
    if (prevHard === undefined) delete process.env.ORCH_MIN_FREE_HARD_MB; else process.env.ORCH_MIN_FREE_HARD_MB = prevHard;
  }
});

// 全部测试完成后统一清理顶层临时工作区（wsDir 与 stDir 都是测试专用一次性目录），
// 避免像原先那样只清理 wsDir、导致每次运行都在 %TEMP% 遗留 orch-force-state-* 目录。
after(() => {
  fs.rmSync(wsDir, { recursive: true, force: true });
  fs.rmSync(stDir, { recursive: true, force: true });
  console.log('orchestrator tests passed.');
});
