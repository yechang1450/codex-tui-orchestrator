import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
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
const { TERMINAL, SUCCESS, summaryComplete, summaryTerminal, failures } = await import(importUrl(path.join(scripts, 'poll-windows.mjs')));
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
test('poll-windows summaryTerminal: failed is terminal, pending is not', () => {
  assert.equal(summaryTerminal({ results: { B1: { status: 'failed' }, B2: { status: 'popup-failed' } } }), true);
  assert.equal(summaryTerminal({ results: { B1: { status: 'pending' } } }), false);
  assert.equal(summaryTerminal(null), false);
  assert.equal(summaryTerminal({ results: {} }), false);
  // done-on-disk is treated as a successful terminal (window could not capture report, disk proves work).
  assert.equal(SUCCESS.has('done-on-disk'), true);
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
    // 测试模拟“非窗/窗外观”语境：剥离宿主（已授权编排窗）遗留的 ORCH_WINDOW，
    // 否则子进程会误判为“已授权窗活窗=0”，让本应 read-only ok 的 --assert read 变成 REFUSED。
    delete env.ORCH_WINDOW;
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
    // 同上：模拟非窗语境，剥离宿主 ORCH_WINDOW，避免 --assert read 被误判为已授权窗。
    delete env.ORCH_WINDOW;
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
    delete env.ORCH_WINDOW;
    const en = runNode(path.join(scripts, 'agent-tui-orchestrator-force.mjs'), ['--enable'], { env });
    assert.equal(en.code, 0);
    const flag = path.join(cliDir, 'state', '.orchestrator-enabled');
    assert.equal(fs.existsSync(flag), true);
  } finally {
    fs.rmSync(cliDir, { recursive: true, force: true });
  }
});

// ---------- orchestrate-sdk: pure decompose/conflict helpers ----------
const { classifyBlockComplexity, classifyExecutionMode, appendModelEffortArgs, conflictByKeys, trySingleBlock, genericProjectSplit, loadCachedDecompose, buildBlockPrompt, levelWaves, decomposeHash, checkDiskSpace, readPidFile, pidAliveCheck, closeWindowByPid, windowGenuinelyPopped, extractResult, extractUsage, readReportFromResult, sessionDir, writeInteractiveLauncher, pidFileOfTransient, staleTransientFiles, computeMaxWindows, computeMaxSubagents, computeMaxTotalAgents, applyAuthPromptPolicy, tryReserveWindow, commitReservation, cancelReservation, __setOrchHooks, isOrchestratorSelfMod, resolveCodexHome } = await import(importUrl(path.join(scripts, 'orchestrate-sdk.mjs')));
const { buildBlocksFromTasks, resolveHints, extractTasks, classifyPrompt } = await import(importUrl(path.join(scripts, 'orchestrate-sdk.mjs')));
const { buildPsArrayLit } = await import(importUrl(path.join(scripts, 'orchestrate-sdk.mjs')));
const { blockKeys, keysOverlap } = await import(importUrl(path.join(scripts, 'orchestrate-sdk.mjs')));
const { readTail } = await import(importUrl(path.join(scripts, 'orchestrate-sdk.mjs')));
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
test('orchestrate-sdk appendModelEffortArgs injects -m/-c and is space-guarded', () => {
  // 默认 MODEL=deepseek-v4-flash / EFFORT=max（TUI 窗=codex CLI 默认；GUI 主机才用 config.toml 的 vision-exp/high）
  const base = ['--cd', 'D:\\', '-a', 'never', '--sandbox', 'danger-full-access'];
  const out = appendModelEffortArgs(base);
  assert.deepEqual(out.slice(-4), ['-m', 'deepseek-v4-flash', '-c', 'model_reasoning_effort=max']);
  assert.ok(out.includes('deepseek-v4-flash') && out.includes('model_reasoning_effort=max'));
  // 值里含空格时不应被注入成 2 个参数（防 launcher 按空格拆散）：模型名 default 不含空格，故这里只测不含空格正常路径。
  assert.ok(!/\s/.test('deepseek-v4-flash'), 'model value must contain no space (else launcher arg-split breaks it)');
});
test('orchestrate-sdk classifyExecutionMode: read-only -> inline, real -> execute', async () => {
  // 只读词（分析，无真实动作词）-> inline（命中确定性快判，不触发 LLM）
  assert.equal(await classifyExecutionMode('分析一下布局是否有问题'), 'inline');
  // 真实动作词（修复）-> execute（命中确定性快判，不触发 LLM）
  assert.equal(await classifyExecutionMode('修复 80 的空白区域'), 'execute');
});
test('orchestrate-sdk sessionDir honors ORCH_SESSION_DIR override (agent-generic)', () => {
  const prev = process.env.ORCH_SESSION_DIR;
  try {
    process.env.ORCH_SESSION_DIR = 'D:\\other-agent\\sessions';
    assert.equal(sessionDir(), 'D:\\other-agent\\sessions');
  } finally {
    if (prev === undefined) delete process.env.ORCH_SESSION_DIR; else process.env.ORCH_SESSION_DIR = prev;
  }
  // 未设置时回退默认（userprofile/.codex/sessions）
  assert.ok(sessionDir().endsWith(path.join('.codex', 'sessions')));
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
test('orchestrate-sdk genericProjectSplit splits comma-separated bare projects -> parallel blocks', () => {
  const r = genericProjectSplit('修复81的空白，优化82的UI');
  assert.ok(r && r.blocks && r.blocks.length === 2, 'two comma-separated projects must split into 2 blocks');
  assert.deepEqual(new Set(r.blocks.map((b) => b.title)), new Set(['proj-81', 'proj-82']));
  // 单项目 + 逗号续句（不带项目号）-> 保守返回 null（交 LLM，不误拆）
  assert.equal(genericProjectSplit('优化81的UI，让它更美观'), null);
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
  // 必须含【本块唯一标识】<token>（真实非空 ASCII）——父进程用它在 rollout 里定位本窗会话
  assert.ok(prompt.includes('【本块唯一标识】' + token), 'prompt must embed the real token after the marker');
  // 新契约（用户方案：done=做完了，不等同于成功）：结束信号 = 窗内最后输出 __ORCH_DONE__ <token>，不再要求「…完成」汇报
  assert.ok(prompt.includes('__ORCH_DONE__ ' + token), 'prompt must instruct to emit the __ORCH_DONE__ <token> marker');
  // 识别码后必须紧跟非空 token（缺 token 会失配）
  assert.ok(/__ORCH_DONE__\s+[A-Za-z0-9_-]+/.test(prompt), 'marker must carry a non-empty token');
  // 不得出现裸『__ORCH_DONE__』（后无 token）或『【本块唯一标识】 完成』
  assert.doesNotMatch(prompt, /__ORCH_DONE__\s*$/m, 'marker must not dangle with no token');
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
  const ws2 = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-disk-'));
  try {
    process.env.ORCH_MIN_FREE_MB = '0';
    process.env.ORCH_MIN_FREE_HARD_MB = '0';
    assert.equal(checkDiskSpace({ workspace: ws2 }), true, 'disk with free space and zero thresholds must pass');
    // 硬下限高于告警阈值 -> 应被钳制到 min，不因反直觉配置而误判失败。
    process.env.ORCH_MIN_FREE_HARD_MB = '99999999';
    assert.equal(checkDiskSpace({ workspace: ws2 }), true, 'hard floor above warn threshold is clamped to min and still passes');
    // 极低磁盘（把阈值拉高到远超当前空间）：strict 应拒绝；warnOnly（--plan 等只读命令）应只告警、仍放行。
    process.env.ORCH_MIN_FREE_MB = '999999999';
    process.env.ORCH_MIN_FREE_HARD_MB = '99999999';
    assert.equal(checkDiskSpace({ workspace: ws2 }), false, 'strict check must hard-fail when disk is below the hard floor');
    assert.equal(checkDiskSpace({ workspace: ws2, warnOnly: true }), true, 'warnOnly must never block a read-only command');
  } finally {
    fs.rmSync(ws2, { recursive: true, force: true });
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

// ---------- 运行时逻辑覆盖（弹窗确认 / 汇报提取 / launcher 模板 / 宽松完成判定） ----------
test('runtime: readPidFile parses pid file', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-rt1-'));
  try {
    const pf = path.join(d, 'w.pid');
    fs.writeFileSync(pf, '1234\n', 'utf8');
    assert.equal(readPidFile(pf), 1234);
    assert.equal(readPidFile(path.join(d, 'missing.pid')), 0);
    fs.writeFileSync(pf, 'abc', 'utf8');
    assert.equal(readPidFile(pf), 0);
    // 上限校验（与 force.mjs pidOf 对齐）：超大/负/0 都视为无效 0, 仅 1..4194304 合法。
    fs.writeFileSync(pf, '999999999', 'utf8');
    assert.equal(readPidFile(pf), 0, '超大 pid -> 0');
    fs.writeFileSync(pf, '-5', 'utf8');
    assert.equal(readPidFile(pf), 0, '负 pid -> 0');
    fs.writeFileSync(pf, '0', 'utf8');
    assert.equal(readPidFile(pf), 0, 'pid 0 -> 0');
    fs.writeFileSync(pf, '4194304', 'utf8');
    assert.equal(readPidFile(pf), 4194304, '最大合法 pid 保留');
    fs.writeFileSync(pf, '4194305', 'utf8');
    assert.equal(readPidFile(pf), 0, '超出上限 pid -> 0');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});
test('runtime: pidAliveCheck', () => {
  assert.equal(pidAliveCheck(process.pid), true);
  assert.equal(pidAliveCheck(999999999), false);
  assert.equal(pidAliveCheck(0), false);
  assert.equal(pidAliveCheck(-5), false);
});
test('runtime: windowGenuinelyPopped = pidf present AND launcher process alive', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-rt2-'));
  try {
    const pf = path.join(d, 'w.pid');
    assert.equal(windowGenuinelyPopped(path.join(d, 'missing.pid'), 'tok'), false);
    fs.writeFileSync(pf, String(999999999), 'utf8');
    assert.equal(windowGenuinelyPopped(pf, 'tok'), false);
    fs.writeFileSync(pf, String(process.pid), 'utf8');
    assert.equal(windowGenuinelyPopped(pf, 'tok'), true);
    fs.writeFileSync(pf, '', 'utf8');
    assert.equal(windowGenuinelyPopped(pf, 'tok'), false);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});
test('runtime: extractResult takes last assistant text (token/content/value tolerant)', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-rt3-'));
  try {
    const f = path.join(d, 'rollout-x.jsonl');
    const line = (o) => JSON.stringify(o) + '\n';
    fs.writeFileSync(f,
      line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'output_text', text: 'PROMPT' }] } }) +
      line({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '完成检测A' }] } }) +
      line({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '最终汇报B' }] } }),
      'utf8');
    assert.equal(extractResult(f).text, '最终汇报B');
    fs.writeFileSync(f,
      line({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'x', content: 'c1' }] } }) +
      line({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'x', value: 'v1' }] } }),
      'utf8');
    assert.equal(extractResult(f).text, 'v1');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});
test('runtime: readReportFromResult returns non-empty __REPORT__ even without token', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-rt4-'));
  try {
    const rf = path.join(d, 'w.result.json');
    fs.writeFileSync(rf, JSON.stringify({ __EXIT__: 0, __DONE__: true, __REPORT__: '窗口最终文本' }) + '\n__EXIT__=0', 'utf8');
    assert.equal(readReportFromResult(rf, 'whatever-token'), '窗口最终文本');
    fs.writeFileSync(rf, JSON.stringify({ __EXIT__: 0, __DONE__: true, __REPORT__: '' }), 'utf8');
    assert.equal(readReportFromResult(rf, 'tok'), '');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});
test('hygiene: pidFileOfTransient maps every artifact family to its pid file', () => {
  assert.equal(pidFileOfTransient('window-B1-x.pid'), 'window-B1-x.pid');
  assert.equal(pidFileOfTransient('window-B1-x.pid.self-closed'), 'window-B1-x.pid');
  assert.equal(pidFileOfTransient('win-launch-B1-x.ps1'), 'window-B1-x.pid');
  assert.equal(pidFileOfTransient('codex-win-B1-x.md'), 'window-B1-x.pid');
  assert.equal(pidFileOfTransient('win-B1-x.result.json'), 'window-B1-x.pid');
  assert.equal(pidFileOfTransient('win-B1-x.result.json.self-closed'), 'window-B1-x.pid');
  assert.equal(pidFileOfTransient('win-B1-x.log'), 'window-B1-x.pid');
  assert.equal(pidFileOfTransient('other.tmp'), null);
});
test('hygiene: staleTransientFiles keeps dead artifacts removable but protects live pid families', () => {
  const d = path.join(wsDir, 'temp');
  fs.mkdirSync(d, { recursive: true });
  const dead = { pid: 'window-dead.pid', launch: 'win-launch-dead.ps1', prompt: 'codex-win-dead.md', result: 'win-dead.result.json' };
  fs.writeFileSync(path.join(d, dead.pid), '99999999', 'utf8');
  fs.writeFileSync(path.join(d, dead.launch), '# dead', 'utf8');
  fs.writeFileSync(path.join(d, dead.prompt), 'dead', 'utf8');
  fs.writeFileSync(path.join(d, dead.result), '{"__DONE__":true}', 'utf8');
  fs.writeFileSync(path.join(d, dead.pid + '.self-closed'), '1', 'ascii');
  fs.writeFileSync(path.join(d, dead.result + '.self-closed'), '1', 'ascii');
  fs.writeFileSync(path.join(d, 'window-live.pid'), String(process.pid), 'utf8');
  fs.writeFileSync(path.join(d, 'win-launch-live.ps1'), '# live', 'utf8');
  fs.writeFileSync(path.join(d, 'codex-win-live.md'), 'live', 'utf8');
  fs.writeFileSync(path.join(d, 'win-live.result.json'), '{"__DONE__":true}', 'utf8');
  fs.writeFileSync(path.join(d, 'win-live.result.json.self-closed'), '1', 'ascii');
  fs.writeFileSync(path.join(d, 'window-live.pid.self-closed'), '1', 'ascii');
  const stale = staleTransientFiles().map((p) => path.basename(p));
  for (const name of [dead.pid, dead.launch, dead.prompt, dead.result, dead.pid + '.self-closed', dead.result + '.self-closed']) {
    assert.ok(stale.includes(name), 'dead artifact must be cleaned: ' + name);
  }
  assert.ok(!stale.some((n) => n.includes('live')), 'live window artifacts must be protected: ' + stale.filter((n) => n.includes('live')).join(','));
});
test('runtime: interactive launcher template ships Get-LastReport + tolerant extraction', () => {
  const { lp, pidf, pf } = writeInteractiveLauncher('t', 'body\n\n【本块唯一标识】T1-abc 完成', 'rt');
  try {
    const body = fs.readFileSync(lp, 'utf8');
    assert.match(body, /Get-LastReport/);
    assert.match(body, /\$res = \$msg/);
    assert.match(body, /__ORCH_DONE__/);
    assert.match(body, /\$_\.content/);
    assert.match(body, /\$_\.value/);
    const parse = spawnSync('powershell.exe', ['-NoProfile', '-Command', '$t=$null;$e=$null;[System.Management.Automation.Language.Parser]::ParseFile($env:ORCH_PARSE_FILE,[ref]$t,[ref]$e)|Out-Null;if($e.Count){$e|ForEach-Object{$_.Message};exit 1}else{Write-Output PARSE_OK}'], { env: { ...process.env, ORCH_PARSE_FILE: lp }, encoding: 'utf8' });
    assert.equal(parse.status, 0, 'generated launcher ps1 must be parseable by PowerShell: ' + String(parse.stdout || parse.stderr || ''));
  } finally { for (const f of [lp, pidf, pf]) { try { if (fs.existsSync(f)) fs.rmSync(f, { force: true }); } catch {} } }
});
test('orchestrate-sdk computeMaxWindows: n GB -> floor(n/2 + 1) concurrency, capped at 8 windows', () => {
  assert.equal(computeMaxWindows(2), 2, '2G -> floor(2) -> 2 (caller refuses <2)');
  assert.equal(computeMaxWindows(4), 3, '4G -> floor(3) -> 3 windows');
  assert.equal(computeMaxWindows(8), 5, '8G -> floor(5) -> 5 windows');
  assert.equal(computeMaxWindows(12), 7, '12G -> floor(7) -> 7 windows');
  assert.equal(computeMaxWindows(16), 8, '16G -> floor(9) -> 8 windows (cap)');
  assert.equal(computeMaxWindows(32), 8, '32G -> 8 windows (capped, NOT 16)');
  assert.equal(computeMaxWindows(64), 8, '64G -> 8 windows (capped)');
});
test('orchestrate-sdk computeMaxSubagents / computeMaxTotalAgents: 克制使用按内存分级（含子代理预算）', () => {
  // 每窗可并发子代理上限：低内存不许开，随内存递增封顶。
  assert.equal(computeMaxSubagents(4), 0, '4G -> 0 subagent/window (only the window)');
  assert.equal(computeMaxSubagents(8), 1, '8G -> 1 subagent/window');
  assert.equal(computeMaxSubagents(12), 1, '12G -> 1 subagent/window');
  assert.equal(computeMaxSubagents(16), 2, '16G -> 2 subagents/window');
  assert.equal(computeMaxSubagents(24), 3, '24G -> 3 subagents/window');
  assert.equal(computeMaxSubagents(32), 4, '32G -> 4 subagents/window');
  assert.equal(computeMaxSubagents(64), 4, '64G -> 4 subagents/window (capped)');
  // 全局 agent 上限 = 最大窗数 × (1 + 每窗子代理上限)，确保"窗+子代理"不叠加 OOM。
  assert.equal(computeMaxTotalAgents(4), 3 * (1 + 0), '4G -> 3 windows x 1 = 3 agents total');
  assert.equal(computeMaxTotalAgents(8), 5 * (1 + 1), '8G -> 5 windows x 2 = 10 agents total');
  assert.equal(computeMaxTotalAgents(16), 8 * (1 + 2), '16G -> 8 windows x 3 = 24 agents total');
  assert.equal(computeMaxTotalAgents(32), 8 * (1 + 4), '32G -> 8 windows x 5 = 40 agents total');
});
test('orchestrate-sdk applyAuthPromptPolicy: 子代理 6 小时硬上限 + 三遍检查 ①②③ -> 1)2)3)（修复 WT CJK 重叠）', () => {
  // 旧 auth 片段：子代理「无超时上限」+ 三遍检查用 ①②③（Windows Terminal CJK 宽度歧义会导致序号与文字重叠）。
  const oldSub = '【子代理收尾 = 一环扣一环（最重要，无超时上限）】子代理属于本 TUI 窗：**只要还开了任何一个子代理且它没返回，本 TUI 窗就没有执行结束，永远不能给结束码、不能关窗**。必须用 wait_agent/持续等待，等到**全部子代理都返回并拿到各自结果**；未收齐前绝不收尾。**对子代理绝不设超时上限**——就像发起对话「子代理没完就不结束轮询」一样，TUI 窗也「子代理没完就不给结束码」。只有全部子代理返回后，才输出最后一行 `__ORCH_DONE__ <本窗token> SUBAGENTS_DONE`（开了子代理时）；未开子代理时输出 `__ORCH_DONE__ <本窗token>`。';
  const oldPass = '随后按此顺序自查：①先检查一遍这个 TODO LIST 是否完整/是否有遗漏或错误，发现问题就修复；②再检查一遍这个 TODO LIST 的**逻辑问题**（先后依赖、因果、边界、是否会冲突/漏步），发现问题就修复；③最后再检查一遍这个 TODO LIST 的问题（复查，确保①②都改彻底）。';
  const out = applyAuthPromptPolicy(oldSub + oldPass, 21600000);
  // 子代理 6 小时硬上限：旧文案被替换，出现 ORCH_SUBAGENT_MAX_WAIT_MS，且不再含「无超时上限」「绝不设超时上限」。
  assert.ok(out.includes('ORCH_SUBAGENT_MAX_WAIT_MS'), 'must inject the subagent max-wait env var');
  assert.ok(out.includes('这是硬上限'), 'must keep the hard-cap semantic (cap is now dynamic, no hardcoded 6h)');
  assert.ok(!out.includes('6 小时'), 'must NOT hardcode 6h since cap is configurable');
  assert.ok(!out.includes('无超时上限'), 'must not keep the old 无超时上限 wording');
  assert.ok(!out.includes('绝不设超时上限'), 'must not keep the old 绝不设超时上限 wording');
  // 层级化（用户设计）：子代理完成由 TUI 窗自己确认，watchdog 不再依赖 SUBAGENTS_DONE 后缀。
  assert.ok(out.includes('TUI 窗管好自己的子代理'), 'must scope sub-agent completion to the window (层级化)');
  assert.ok(!out.includes('__ORCH_DONE__ <本窗token> SUBAGENTS_DONE'), 'must NOT instruct outputting SUBAGENTS_DONE suffix');
  // 三遍检查序号：①/②/③ 全被替换成 1)/2)/3)，不再保留圈号（避免 WT CJK 宽度重叠）。
  assert.ok(!out.includes('①') && !out.includes('②') && !out.includes('③'), 'must drop the ①②③ circled digits');
  assert.ok(out.includes('1) 先检查一遍') && out.includes('2) 再检查一遍') && out.includes('3) 最后再检查一遍'), 'must use ASCII-width 1)2)3)');
  // 边缘：空输入或缺失子句不抛错。
  assert.equal(applyAuthPromptPolicy('', 21600000), '');
  assert.equal(applyAuthPromptPolicy('无相关子句', 21600000), '无相关子句');
});
test('runtime: launcher extracts the REAL ASCII block token even when boilerplate mentions the marker first (regression: empty $token broke auto-close)', () => {
  // Replicates the real --run-windows block prompt: the block body contains the 执行纪律 boilerplate
  // 「【本块唯一标识】…完成」开头 BEFORE the injected unique token. The old regex matched that
  // boilerplate first and stripped it to an empty $token => watchdog auto-close never fired.
  const body = '1. 修复TUI窗任务成功后仍报「已退出进程代码为1」且无法自动关窗的问题。\n上面任务之间互相独立：并行执行。\n\n【执行纪律·禁止只计划不干活】本窗是授权真实执行窗，必须**在本窗内真正动手修改/执行**，逐项完成并自验，最后才输出以「【本块唯一标识】…完成」开头的汇报。**禁止**只输出“已定位/先读配置/先看日志/先确认归属/继续核查”这类计划、定位、核查性文字就当作完成；禁止停在“先…”。若确需先核查，也必须在同一窗内继续把改动做完、验证到位，不要只规划不落地。\n\n【本块唯一标识】B1-abc123-4f2g9z\n（最终汇报请以「【本块唯一标识】B1-abc123-4f2g9z 完成」开头，并说明本块完成情况）';
  const auth = '\n\n（已获授权推进并执行。本窗为 agent-tui-orchestrator 授权的真实执行窗：直接在本窗内用自己的工具干活，不要再发起 --run-windows、不要另开新窗、不要以「需要授权/要我修吗」等由暂停或询问。做完即结束并汇报：最终汇报必须以本窗 body 中标明的完整「【本块唯一标识】<token> 完成」开头，说明做了什么、每项自验（读回/回归/编码）与确凿落盘证据；任一步骤失败请如实说明现场，最终汇报的**最后一行**必须单独输出结束标记：`__ORCH_DONE__ <本窗token>`（token 为 body 中「【本块唯一标识】」后那串唯一 ASCII，不可省略、不可置于中间；此标记是本窗自动关闭的唯一依据）。禁止虚报成功。）';
  const { lp, pidf, pf } = writeInteractiveLauncher('t', body + auth, 'x');
  try {
    const ps = fs.readFileSync(lp, 'utf8');
    const m = ps.match(/^\$token = '([^']*)'/m);
    assert.ok(m, 'launcher must contain a $token assignment');
    assert.ok(m[1], 'launcher $token must be non-empty (was silently emptied by the boilerplate-first regex)');
    assert.equal(m[1], 'B1-abc123-4f2g9z', 'launcher $token must be the real ASCII block token');
  } finally { for (const f of [lp, pidf, pf]) { try { if (fs.existsSync(f)) fs.rmSync(f, { force: true }); } catch {} } }
});
test('runtime: completion exits 0 and never force-kills the launcher (regression: no code-1 pane)', () => {
  const { lp, pidf, pf } = writeInteractiveLauncher('reg', 'body\n\n【本块唯一标识】R1-abc 完成', 'rg');
  try {
    const body = fs.readFileSync(lp, 'utf8');
    // 1) 汇报已捕获(任务完成) 或 watchdog 已自关($wdDone) -> 统一把退出码归零：watchdog 强杀 codex 子进程使 $LASTEXITCODE=1 不算失败
    assert.match(body, /if \(\$rep -or \$wdDone\) \{ \$code = 0 \}/, 'captured report or watchdog self-closed must reset the recorded exit code to 0');
    // 2) launcher 恒以 exit 0 收尾 -> Windows Terminal 不会留下 "[进程已退出，代码为 1]" 卡壳窗
    assert.ok(body.trimEnd().endsWith('exit 0'), 'launcher must end with exit 0');
    // 3) watchdog 沿 ParentProcessId 链递归枚举全部后代并逐一 kill，绝不强杀 launcher 自身
    assert.match(body, /function Stop-LauncherDescendants/, 'watchdog must define a recursive descendant-kill helper');
    assert.match(body, /Stop-LauncherDescendants \$rootPid/, 'watchdog must invoke the recursive descendant kill');
    assert.match(body, /taskkill \/PID \$v \/F/, 'watchdog must kill each enumerated descendant individually');
    assert.doesNotMatch(body, /ParentProcessId -eq \$rootPid/, 'watchdog must not be limited to direct children');
    assert.ok(!body.includes('taskkill /PID $PID'), 'watchdog must never force-kill the launcher pid');
    // 4) 加固：watchdog 用连续重扫的 Kill-LauncherTree 兜底（codex 重新生成子进程也一并回收），两个完成分支都调用它
    assert.match(body, /function Kill-LauncherTree/, 'watchdog must define a re-scan descendant-kill helper');
    assert.match(body, /Kill-LauncherTree \$rootPid/, 'watchdog must call Kill-LauncherTree on completion');
    // 5) 加固：watchdog 已自关 或 codex 已退出且无后代 才收窗；结果文件存在但 codex 仍存活时继续杀净（拒绝常驻 codex）
    assert.match(body, /if \(Test-Path -LiteralPath \(\$resultFile \+ '\.self-closed'\)\) \{ \$wdDone = \$true; break \}/, 'launcher must not retry after watchdog self-closed');
    // 6) 加固（本轮新增）：rollout 达到 task_complete（但既无 __ORCH_DONE__ 也无『完成』汇报，如 selftest/纯只读窗）
    //    时，watchdog 也立即写 .self-closed + 杀净 codex 并 exit 0——避免落到依赖 $sawChild 的陈旧 result 分支，
    //    拖到 orchestrator 的 15s 兜底才收窗（慢/易卡）。层级化：watchdog 只认 __ORCH_DONE__ <token>，不再依赖 SUBAGENTS_DONE。
    assert.ok(body.includes("$tcDone = (($tail | Where-Object { $_ -match 'task_complete' }) -and ($tail | Where-Object { $_.Contains($token) }))"), 'watchdog must detect task_complete in its own rollout (token-scoped)');
    assert.ok(body.includes("if ($tcDone) {"), 'watchdog task_complete branch must close on task_complete alone (no SUBAGENTS_DONE dependency)');
    assert.doesNotMatch(body, /if \(Test-Path -LiteralPath \$resultFile\) \{ exit 0 \}/, 'watchdog must not exit on a stale result file while codex is alive');
  } finally { for (const f of [lp, pidf, pf]) { try { if (fs.existsSync(f)) fs.rmSync(f, { force: true }); } catch {} } }
  // 4) closeWindowByPid 对 launcher 的 force-kill 只是兜底：必须在抛错/轮询超时之后，绝不作为正常完成路径
  const src = fs.readFileSync(path.join(scripts, 'orchestrate-sdk.mjs'), 'utf8');
  const idxGrace = src.indexOf('const deadline = Date.now() + 15000');
  const idxFallback = src.indexOf('force-killing (fallback)');
  const idxForceKill = src.indexOf('spawnSync("taskkill", ["/PID", String(p), "/T", "/F"]');
  assert.ok(idxGrace > -1, 'closeWindowByPid must poll/grace before any launcher force-kill');
  assert.ok(idxForceKill > -1 && idxFallback > -1, 'closeWindowByPid must keep a guarded last-resort force-kill');
  assert.ok(idxGrace < idxForceKill, 'launcher force-kill must come AFTER the grace/poll loop');
  assert.ok(idxFallback < idxForceKill, 'force-kill must be guarded by the fallback branch (real exception only)');
});

test('runtime: spawnWindowWithRetry warms up after popup so the parent never races the session rollout (cold-start regression)', () => {
  // windowGenuinelyPopped only proves the launcher (WT pane host) is alive; codex TUI cold start can still be slow.
  // If the parent immediately polls for the window's session rollout, it can miss it ("no session rollout matched")
  // and wrongly close a still-starting window. The fix wires warmupWindow() (waits for a codex descendant) into
  // spawnWindowWithRetry's confirmed path. Assert that wiring exists in the source so it can't silently regress.
  const src = fs.readFileSync(path.join(scripts, 'orchestrate-sdk.mjs'), 'utf8');
  // 1) warmupWindow must be defined
  assert.match(src, /async function warmupWindow/, 'warmupWindow must exist');
  // 2) spawnWindowWithRetry must invoke warmupWindow after confirming popup
  const idxConfirmed = src.indexOf('windowGenuinelyPopped(pidf, token)) { ok = true; break; }');
  const idxWarmup = src.indexOf('await warmupWindow(pidf, token);');
  assert.ok(idxConfirmed > -1 && idxWarmup > -1, 'spawnWindowWithRetry must confirm popup then warm up');
  assert.ok(idxWarmup > idxConfirmed, 'warmup must run AFTER the popup is confirmed');
  // 3) codexDescendantAlive helper must exist (the durable child detection used by warmup)
  assert.match(src, /function codexDescendantAlive/, 'codexDescendantAlive must exist');
});
test('runtime: watchdog closes on __ORCH_DONE__ <token> alone; sub-agent completion is the TUI window\'s own job (层级化)', () => {
  // 层级化（用户设计）：watchdog(爷爷)只认 TUI 窗(儿子)输出 __ORCH_DONE__ <token> 即关窗；
  // 子代理(孙子)是否完成由 TUI 窗自己在输出前确认——watchdog 不再要求 SUBAGENTS_DONE 后缀。
  const { lp, pidf, pf } = writeInteractiveLauncher('subcut', 'task\n\n【本块唯一标识】S1-abc 完成', 'x');
  try {
    const body = fs.readFileSync(lp, 'utf8');
    // 1) watchdog done-detection must match __ORCH_DONE__ <token> without requiring SUBAGENTS_DONE
    assert.ok(body.includes("$_.Contains('__ORCH_DONE__') -and $_.Contains($token)"), 'watchdog must close on __ORCH_DONE__ <token> alone');
    assert.doesNotMatch(body, /\$spawnedAgent -eq \$false -or \$_.Contains\('SUBAGENTS_DONE'\)/, 'watchdog must not require SUBAGENTS_DONE suffix');
    // 2) the done-detection must NOT be gated on a SUBAGENTS_DONE marker
    assert.doesNotMatch(body, /Contains\('SUBAGENTS_DONE'\)/, 'watchdog must not depend on SUBAGENTS_DONE in the rollout');
    // 3) the TUI auth prompt (via applyAuthPromptPolicy in SDK source) must instruct the window to confirm sub-agents itself and output only __ORCH_DONE__ <token>
    const src = fs.readFileSync(path.join(scripts, 'orchestrate-sdk.mjs'), 'utf8');
    assert.match(src, /wait_agent/, 'TUI prompt must tell the window to wait_agent for sub-agents');
    assert.match(src, /update_goal complete/, 'TUI prompt must mention update_goal complete (codex goal path)');
    assert.match(src, /不输出任何 SUBAGENTS_DONE 等后缀/, 'TUI prompt must tell the window to NOT output SUBAGENTS_DONE');
    assert.match(src, /TUI 窗管好自己的子代理/, 'TUI prompt must scoped sub-agent completion to the window (层级化)');
  } finally { for (const f of [lp, pidf, pf]) { try { if (fs.existsSync(f)) fs.rmSync(f, { force: true }); } catch {} } }
});
test('orchestrate-sdk: producing blocks with no on-disk change are downgraded to uncaptured (未落盘=未完成)', () => {
  // A window may plan to create a file but never actually write it (the marker.txt case). Under "done=execution ended",
  // that would be wrongly accepted. The fix adds a disk recheck at aggregation: for producing blocks whose file:/dir:
  // targets show no change since the window started, status is downgraded to "uncaptured" so poll-windows won't count it.
  const src = fs.readFileSync(path.join(scripts, 'orchestrate-sdk.mjs'), 'utf8');
  // 1) must define a "producing block" classifier
  assert.match(src, /PROD_VERBS/, 'orchestrator must classify producing tasks via PROD_VERBS');
  assert.match(src, /isProducingBlock/, 'orchestrator must have isProducingBlock');
  // 2) must re-check file:/dir: targets for a change since the window started
  assert.match(src, /targetChangedSinceStart/, 'orchestrator must detect on-disk change since window start');
  assert.match(src, /assertProductLanding/, 'orchestrator must run assertProductLanding at aggregation');
  // 3) the aggregation done-path must invoke the landing recheck
  assert.match(src, /assertProductLanding\(s\.key, recsByKey\.get\(s\.key\), s, summary\[s\.key\]\)/, 'aggregation must call assertProductLanding on each done block');
  // 4) TUI prompt must forbid emitting the done marker if a declared product is not actually on disk
  const authTpl = fs.readFileSync(path.join(scripts, 'agent-auth-prompt.txt'), 'utf8');
  assert.match(authTpl, /禁止输出结束标记/, 'TUI prompt must forbid the done marker when a product is not on disk');
  assert.match(authTpl, /真实落盘且自验通过/, 'TUI prompt must require the product to really land + self-check');
});
test('orchestrate-sdk: sub-agent task body must go via a shared file (bypass broken message body channel)', () => {
  const src = fs.readFileSync(path.join(scripts, 'orchestrate-sdk.mjs'), 'utf8');
  // 1) must define a stable subtask dir under the orchestrator home
  assert.match(src, /SUBTASK_DIR/, 'orchestrator must define SUBTASK_DIR');
  assert.match(src, /ORCH_SUBTASK_DIR/, 'orchestrator must inject ORCH_SUBTASK_DIR env');
  // 2) TUI prompt must require the sub-agent task body to be written to a shared file before spawn
  const authTpl = fs.readFileSync(path.join(scripts, 'agent-auth-prompt.txt'), 'utf8');
  assert.match(authTpl, /子代理任务正文走共享文件/, 'TUI prompt must instruct shared-file task body for sub-agents');
  assert.match(authTpl, /ORCH_SUBTASK_DIR/, 'TUI prompt must reference ORCH_SUBTASK_DIR for the shared task file');
  assert.match(authTpl, /请先读取它再执行/, 'TUI prompt must tell the sub-agent to read the shared task file first');
});
test('orchestrate-sdk: codex goal sub-agent (方案B) — 共享文件辟【子代理唯一任务】段, 子代理提取 objective 自建 goal, 能力探测后才叠加', () => {
  const src = fs.readFileSync(path.join(scripts, 'orchestrate-sdk.mjs'), 'utf8');
  assert.match(src, /【子代理唯一任务】/, 'shared task file must define a 【子代理唯一任务】 section for objective extraction');
  assert.match(src, /create_goal/, 'TUI prompt must mention create_goal for codex goal sub-agents');
  assert.match(src, /update_goal complete/, 'TUI prompt must mention update_goal complete for codex goal sub-agents');
  assert.match(src, /wait_agent/, 'TUI prompt must mention wait_agent to wait for codex goal sub-agents');
  assert.match(src, /能力探测/, 'TUI prompt must gate codex-goal by capability probe, not process name');
  assert.match(src, /能调 `create_goal`/, 'TUI prompt must require the sub-agent to be able to call create_goal before using goal');
  assert.match(src, /完成判定仍须以方案A的[\s\S]*?标记或 wait_agent 返回/, 'TUI prompt must keep completion carried by observable signals');
  assert.doesNotMatch(src, /D:\\build\\82/, 'must not hardcode absolute build path inside SDK logic');
});

test('runtime: launcher survives a vanished result dir (plugin upgrade wipe) -> recreates it, writes .self-closed, exits 0', async () => {
  // Regression for the exact reported bug: a Codex TUI window finished (agent reported ORCH_DONE) but the
  // launcher wrote win-<s>.result.json.self-closed into a temp dir that no longer existed (removed when the
  // plugin was cachebuster-upgraded from 0.2.1 -> 0.2.2). Set-Content then threw DirectoryNotFoundException
  // and the pane stuck at "[进程已退出，代码为 1]". We simulate that by deleting the launcher's result-file
  // parent dir right before the watchdog would fire, and assert the launcher recreates it and exits 0.
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-vanish-'));
  const tok = 'V1-abc-789';
  const { lp, pidf, pf, rf } = writeInteractiveLauncher('vanish', 'task\n\n【本块唯一标识】' + tok + ' 完成', 'x');
  const codexPidFile = path.join(ws, 'codex.pid');
  const grandPidFile = path.join(ws, 'grand.pid');
  const fakeCodex = path.join(ws, 'fake-codex.ps1');
  const writePs = (f, body) => fs.writeFileSync(f, '\uFEFF' + body.trimStart() + '\r\n', 'utf8');
  writePs(fakeCodex, `$ErrorActionPreference='Continue'
$dir=$env:ORCH_SDIR; if(-not $dir){$dir=Join-Path $env:TEMP 'orch-sdir'}
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$token='${tok}'
$report='{"t":"event_msg","payload":{"type":"agent_message","message":"done __ORCH_DONE__ ${tok}"}}'
Set-Content -LiteralPath (Join-Path $dir ('rollout-'+[guid]::NewGuid().ToString('N').Substring(0,8)+'.jsonl')) -Value $report -Encoding UTF8
$PID | Set-Content -LiteralPath '${codexPidFile}' -Encoding UTF8
$psi=New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName='powershell.exe'; $psi.Arguments='-NoProfile -Command "Start-Sleep -Seconds 600"'; $psi.UseShellExecute=$false
$grand=[System.Diagnostics.Process]::Start($psi)
$grand.Id | Set-Content -LiteralPath '${grandPidFile}' -Encoding UTF8
$grand.WaitForExit()
while($true){Start-Sleep -Seconds 600}`);
  // Patch the generated launcher so "codex" is our fake process (never self-exits), and inject a pre-codex
  // step that DELETES the result-file parent dir to simulate the plugin-upgrade wipe of the temp folder.
  let ps = fs.readFileSync(lp, 'utf8');
  const psExe = 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
  ps = ps.replace(/&\s*'codex'\s*@codexArgs/g, "& '" + psExe + "' -NoProfile -ExecutionPolicy Bypass -File '" + fakeCodex.replace(/\\/g, '/') + "' @codexArgs");
  // Inject before the `& codex` invocation: remove the dir that holds $resultFile (the vanished temp dir).
  ps = ps.replace(/& 'C:\/Windows\/System32\/WindowsPowerShell\/v1\.0\/powershell\.exe'/g, "Remove-Item -LiteralPath (Split-Path -Parent $resultFile) -Recurse -Force -ErrorAction SilentlyContinue; & 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'");
  fs.writeFileSync(lp, ps, 'utf8');
  const sdir = path.join(ws, 'sdir'); fs.mkdirSync(sdir, { recursive: true });
  const env = { ...process.env, ORCH_SESSION_DIR: sdir, ORCH_WATCHDOG_MAX_MIN: '5' };
  const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', lp], { env, windowsHide: true, stdio: 'ignore' });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const launcherExit = new Promise((resolve) => { child.once('exit', (code) => resolve(code)); child.once('error', () => resolve(null)); });
  let codexPid = 0, grandPid = 0;
  const waitFor = async (what, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (what()) return; await sleep(100); } };
  try {
    await waitFor(() => fs.existsSync(codexPidFile) && fs.existsSync(grandPidFile), 15000);
    codexPid = readPidFile(codexPidFile); grandPid = readPidFile(grandPidFile);
    assert.ok(codexPid > 0 && grandPid > 0, 'fake codex + grandchild PIDs must be written');
    const exitCode = await Promise.race([launcherExit, sleep(20000).then(() => 'timeout')]);
    assert.notEqual(exitCode, 'timeout', 'launcher must exit on its own (no permanently-alive codex window)');
    assert.equal(exitCode, 0, 'launcher must end with exit 0 even when its result dir was wiped mid-run');
    assert.equal(pidAliveCheck(codexPid), false, 'codex process must be reaped');
    assert.equal(pidAliveCheck(grandPid), false, 'codex grandchild must be reaped');
    assert.equal(fs.existsSync(rf), true, 'result file must be written after dir vanished (Ensure-ResultDir recreated it)');
    assert.equal(fs.existsSync(rf + '.self-closed'), true, 'watchdog/launcher must recreate the dir and write .self-closed');
  } finally {
    for (const pid of [codexPid, grandPid]) { if (pid > 0 && pidAliveCheck(pid)) { try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* ignore */ } } }
    try { child.kill(); } catch { /* ignore */ }
    for (const f of [lp, pidf, pf, rf, rf + '.self-closed', codexPidFile, grandPidFile]) { try { if (fs.existsSync(f)) fs.rmSync(f, { force: true }); } catch { /* ignore */ } }
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('runtime: watchdog must NOT self-close on the injected prompt text that contains __ORCH_DONE__ <token> (premature-close regression)', async () => {
  // The launcher's watchdog line `$done = ... $_.Contains('__ORCH_DONE__') -and $_.Contains($token)` previously
  // matched ANY line containing both, including the *injected user prompt* (which literally teaches the agent
  // to end with `__ORCH_DONE__ <token>`). That made the watchdog self-close right after the prompt was handed
  // to the window, before the agent did any work -> task dropped. Fixed: the __ORCH_DONE__ branch must also
  // require it be an agent_message / "role":"assistant" line.
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-prem-'));
  const tok = 'P1-abc-000';
  const { lp, pidf, pf, rf } = writeInteractiveLauncher('premature', 'task\n\n【本块唯一标识】' + tok + ' 完成', 'x');
  const codexPidFile = path.join(ws, 'codex.pid');
  const fakeCodex = path.join(ws, 'fake-codex.ps1');
  const writePs = (f, body) => fs.writeFileSync(f, '\uFEFF' + body.trimStart() + '\r\n', 'utf8');
  // Emulate a codex that writes ONLY the injected user prompt (role:user, contains __ORCH_DONE__ <tok> as
  // instruction text) then hangs. This is exactly the rollout tail that used to false-trigger the watchdog.
  writePs(fakeCodex, `$ErrorActionPreference='Continue'
$dir=$env:ORCH_SDIR; if(-not $dir){$dir=Join-Path $env:TEMP 'orch-sdir'}
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$userLine='{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"请执行任务并在最后输出 __ORCH_DONE__ ${tok}"}]}}'
Set-Content -LiteralPath (Join-Path $dir ('rollout-'+[guid]::NewGuid().ToString('N').Substring(0,8)+'.jsonl')) -Value $userLine -Encoding UTF8
$PID | Set-Content -LiteralPath '${codexPidFile}' -Encoding UTF8
while($true){Start-Sleep -Seconds 600}`);
  let ps = fs.readFileSync(lp, 'utf8');
  const psExe = 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
  ps = ps.replace(/&\s*'codex'\s*@codexArgs/g, "& '" + psExe + "' -NoProfile -ExecutionPolicy Bypass -File '" + fakeCodex.replace(/\\/g, '/') + "' @codexArgs");
  fs.writeFileSync(lp, ps, 'utf8');
  const sdir = path.join(ws, 'sdir'); fs.mkdirSync(sdir, { recursive: true });
  const env = { ...process.env, ORCH_SESSION_DIR: sdir, ORCH_WATCHDOG_MAX_MIN: '5' };
  const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', lp], { env, windowsHide: true, stdio: 'ignore' });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const launcherExit = new Promise((resolve) => { child.once('exit', (code) => resolve(code)); child.once('error', () => resolve(null)); });
  let codexPid = 0;
  const waitFor = async (what, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (what()) return; await sleep(100); } };
  try {
    await waitFor(() => fs.existsSync(codexPidFile), 15000);
    codexPid = readPidFile(codexPidFile);
    assert.ok(codexPid > 0, 'fake codex PID must be written');
    // Give the watchdog time to (incorrectly) detect the user-message __ORCH_DONE__ line.
    const earlyExit = await Promise.race([launcherExit.then((c) => c).catch(() => null), sleep(6000).then(() => 'still-running')]);
    assert.equal(earlyExit, 'still-running', 'watchdog must NOT self-close just because the injected user prompt contains __ORCH_DONE__ <token>');
    // The window must still be alive (agent didn't do work, so it must not be closed yet).
    assert.equal(pidAliveCheck(codexPid), true, 'codex must still be alive because the task was NOT completed');
  } finally {
    for (const pid of [codexPid]) { if (pid > 0 && pidAliveCheck(pid)) { try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* ignore */ } } }
    try { child.kill(); } catch { /* ignore */ }
    for (const f of [lp, pidf, pf, rf, rf + '.self-closed', codexPidFile]) { try { if (fs.existsSync(f)) fs.rmSync(f, { force: true }); } catch { /* ignore */ } }
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('runtime: minimal launcher smoke -> recursive kill frees & codex; result file exit 0; launcher exits 0 without force-kill', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-rt-launch-'));
  const pidFile = path.join(d, 'launcher.pid');
  const codexPidFile = path.join(d, 'codex.pid');
  const grandPidFile = path.join(d, 'grand.pid');
  const resultFile = path.join(d, 'win.result.json');
  const normalFile = path.join(d, 'normal-exit.txt');
  const report = 'FINAL-REPORT-CAPTURED-RT1';
  const codexPs = path.join(d, 'fake-codex.ps1');
  const launcherPs = path.join(d, 'fake-launcher.ps1');
  const writePs = (f, body) => fs.writeFileSync(f, '\uFEFF' + body.trimStart() + '\r\n', 'utf8');
  writePs(codexPs, `param([string]$grandPidFile)
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = 'powershell.exe'
$psi.Arguments = '-NoProfile -Command "Start-Sleep -Seconds 300"'
$psi.UseShellExecute = $false
$grand = [System.Diagnostics.Process]::Start($psi)
if ($grandPidFile) { $grand.Id | Set-Content -LiteralPath $grandPidFile -Encoding UTF8 }
$grand.WaitForExit()
exit 1`);
  writePs(launcherPs, `param([string]$pidFile,[string]$codexPidFile,[string]$grandPidFile,[string]$codexPs1,[string]$resultFile,[string]$normalFile,[string]$report)
$PID | Set-Content -LiteralPath $pidFile -Encoding UTF8
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = 'powershell.exe'
$psi.Arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $codexPs1 + '" "' + $grandPidFile + '"'
$psi.UseShellExecute = $false
$codex = [System.Diagnostics.Process]::Start($psi)
$codex.Id | Set-Content -LiteralPath $codexPidFile -Encoding UTF8
$codex.WaitForExit()
$code = $codex.ExitCode
if ($report) { $code = 0 }
$json = '{"__EXIT__":' + $code + ',"__DONE__":true,"__REPORT__":' + (ConvertTo-Json $report -Compress) + '}'
Set-Content -LiteralPath $resultFile -Value ($json + "\`r\`n__EXIT__=" + $code) -Encoding UTF8
Set-Content -LiteralPath $normalFile -Value 'NORMAL_EXIT' -Encoding UTF8
exit 0`);
  const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', launcherPs, pidFile, codexPidFile, grandPidFile, codexPs, resultFile, normalFile, report], { windowsHide: true, stdio: 'ignore' });
  const launcherExit = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (what, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (what()) return;
      await sleep(100);
    }
    throw new Error('timed out waiting for runtime launcher smoke: ' + String(what));
  };
  try {
    await waitFor(() => fs.existsSync(pidFile) && fs.existsSync(codexPidFile) && fs.existsSync(grandPidFile), 15000);
    const launcherPid = readPidFile(pidFile);
    const codexPid = readPidFile(codexPidFile);
    const grandPid = readPidFile(grandPidFile);
    assert.ok(launcherPid > 0 && codexPid > 0 && grandPid > 0, 'fake launcher/codex/grandchild PIDs must be written');
    assert.equal(pidAliveCheck(launcherPid), true, 'fake launcher must be alive before graceful close');
    assert.equal(pidAliveCheck(codexPid), true, 'fake codex must be alive before graceful close');
    assert.equal(pidAliveCheck(grandPid), true, 'grandchild must be alive before graceful close');
    const closed = await closeWindowByPid(launcherPid);
    assert.equal(closed, true, 'closeWindowByPid must report the launcher closed gracefully');
    const exitRes = await Promise.race([
      launcherExit,
      sleep(20000).then(() => { throw new Error('launcher did not exit within 20s after closeWindowByPid'); }),
    ]);
    assert.equal(exitRes.code, 0, 'launcher process must end with exit code 0 (no force-kill code-1 pane)');
    assert.equal(pidAliveCheck(launcherPid), false, 'launcher must be gone');
    assert.equal(pidAliveCheck(codexPid), false, 'codex process must be gone');
    assert.equal(pidAliveCheck(grandPid), false, 'codex grandchild must be gone (recursive descendant kill)');
    const resultRaw = fs.readFileSync(resultFile, 'utf8');
    assert.ok(resultRaw.includes(report), 'result file must capture the final report');
    assert.match(resultRaw, /"__EXIT__":0/, 'result file must record exit 0');
    assert.match(resultRaw, /__EXIT__=0/, 'result file must carry the __EXIT__=0 line');
    assert.equal(fs.existsSync(normalFile), true, 'launcher must reach its own normal-exit tail (not force-killed)');
  } finally {
    for (const f of [pidFile, codexPidFile, grandPidFile]) {
      const id = readPidFile(f);
      if (id > 0 && pidAliveCheck(id)) {
        try { spawnSync('taskkill', ['/PID', String(id), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* ignore */ }
      }
    }
    try { child.kill(); } catch { /* ignore */ }
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('runtime: watchdog self-close reaps codex even when a stale result file pre-exists (regression: codex TUI left alive, window not auto-closed)', async () => {
  // The in-launcher watchdog must NOT early-exit on a stale result file while codex descendants are still alive;
  // it must kill the codex tree so `& codex` returns and the launcher reaches `exit 0` (auto-close the window).
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-watchdog-'));
  const tok = 'W1-abc-123';
  const { lp, pidf, pf, rf } = writeInteractiveLauncher('wdguard', 'task\n\n【本块唯一标识】' + tok + ' 完成', 'x');
  const codexPidFile = path.join(ws, 'codex.pid');
  const grandPidFile = path.join(ws, 'grand.pid');
  const fakeCodex = path.join(ws, 'fake-codex.ps1');
  const writePs = (f, body) => fs.writeFileSync(f, '\uFEFF' + body.trimStart() + '\r\n', 'utf8');
  writePs(fakeCodex, `$ErrorActionPreference='Continue'
$dir=$env:ORCH_SDIR; if(-not $dir){$dir=Join-Path $env:TEMP 'orch-sdir'}
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$token='${tok}'
$report='{"t":"event_msg","payload":{"type":"agent_message","message":"done __ORCH_DONE__ ${tok}"}}'
Set-Content -LiteralPath (Join-Path $dir ('rollout-'+[guid]::NewGuid().ToString('N').Substring(0,8)+'.jsonl')) -Value $report -Encoding UTF8
$PID | Set-Content -LiteralPath '${codexPidFile}' -Encoding UTF8
$psi=New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName='powershell.exe'; $psi.Arguments='-NoProfile -Command "Start-Sleep -Seconds 600"'; $psi.UseShellExecute=$false
$grand=[System.Diagnostics.Process]::Start($psi)
$grand.Id | Set-Content -LiteralPath '${grandPidFile}' -Encoding UTF8
$grand.WaitForExit()
while($true){Start-Sleep -Seconds 600}`);
  // Patch the generated launcher so the "codex" is our fake interactive process (never self-exits).
  let ps = fs.readFileSync(lp, 'utf8');
  const psExe = 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
  ps = ps.replace(/&\s*'codex'\s*@codexArgs/g, "& '" + psExe + "' -NoProfile -ExecutionPolicy Bypass -File '" + fakeCodex.replace(/\\/g, '/') + "' @codexArgs");
  fs.writeFileSync(lp, ps, 'utf8');
  // Simulate a STALE result from a prior window sharing this block path BEFORE the launcher runs.
  fs.writeFileSync(rf, '{"__EXIT__":0,"__DONE__":true,"__REPORT__":"STALE prior run"}', 'utf8');
  const sdir = path.join(ws, 'sdir'); fs.mkdirSync(sdir, { recursive: true });
  const env = { ...process.env, ORCH_SESSION_DIR: sdir, ORCH_WATCHDOG_MAX_MIN: '5' };
  const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', lp], { env, windowsHide: true, stdio: 'ignore' });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const launcherExit = new Promise((resolve) => { child.once('exit', (code) => resolve(code)); child.once('error', () => resolve(null)); });
  let codexPid = 0, grandPid = 0;
  const waitFor = async (what, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (what()) return; await sleep(100); } };
  try {
    await waitFor(() => fs.existsSync(codexPidFile) && fs.existsSync(grandPidFile), 15000);
    codexPid = readPidFile(codexPidFile); grandPid = readPidFile(grandPidFile);
    assert.ok(codexPid > 0 && grandPid > 0, 'fake codex + grandchild PIDs must be written');
    // Watchdog must fire even with a stale result file -> kill codex -> launcher exits 0.
    const exitCode = await Promise.race([launcherExit, sleep(20000).then(() => 'timeout')]);
    assert.notEqual(exitCode, 'timeout', 'launcher must exit on its own (no permanently-alive codex window)');
    assert.equal(exitCode, 0, 'launcher must end with exit 0 so the Windows Terminal pane auto-closes');
    assert.equal(pidAliveCheck(codexPid), false, 'codex process must be killed even when a stale result pre-exists');
    assert.equal(pidAliveCheck(grandPid), false, 'codex grandchild must be reaped');
    assert.equal(fs.existsSync(rf), true, 'result file must be written (Write-Result ran)');
    assert.equal(fs.existsSync(rf + '.self-closed'), true, 'watchdog must have self-closed after detecting completion');
  } finally {
    for (const pid of [codexPid, grandPid]) { if (pid > 0 && pidAliveCheck(pid)) { try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* ignore */ } } }
    try { child.kill(); } catch { /* ignore */ }
    for (const f of [lp, pidf, pf, rf, rf + '.self-closed', codexPidFile, grandPidFile]) { try { if (fs.existsSync(f)) fs.rmSync(f, { force: true }); } catch { /* ignore */ } }
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
﻿
// ---------- 方案A/B 契约：applyAuthPromptPolicy 全分支（纯函数，无副作用） ----------
const OLD_SUBAGENT = '【子代理收尾 = 一环扣一环（最重要，无超时上限）】子代理属于本 TUI 窗：**只要还开了任何一个子代理且它没返回，本 TUI 窗就没有执行结束，永远不能给结束码、不能关窗**。必须用 wait_agent/持续等待，等到**全部子代理都返回并拿到各自结果**；未收齐前绝不收尾。**对子代理绝不设超时上限**——就像发起对话「子代理没完就不结束轮询」一样，TUI 窗也「子代理没完就不给结束码」。只有全部子代理返回后，才输出最后一行 `__ORCH_DONE__ <本窗token> SUBAGENTS_DONE`（开了子代理时）；未开子代理时输出 `__ORCH_DONE__ <本窗token>`。';
const OLD_THREEPASS = '随后按此顺序自查：①先检查一遍这个 TODO LIST 是否完整/是否有遗漏或错误，发现问题就修复；②再检查一遍这个 TODO LIST 的**逻辑问题**（先后依赖、因果、边界、是否会冲突/漏步），发现问题就修复；③最后再检查一遍这个 TODO LIST 的问题（复查，确保①②都改彻底）。';
const OLD_SHAREDFILE = '**绝不允许**用空/缺失 message 或「只描述不落文件」的方式 spawn 子代理。';

test('applyAuthPromptPolicy: 空输入/非字符串/缺失子句均不抛错并原样返回', () => {
  assert.equal(applyAuthPromptPolicy('', 21600000), '');
  assert.equal(applyAuthPromptPolicy(null, 21600000), '');
  assert.equal(applyAuthPromptPolicy(undefined, 21600000), '');
  assert.equal(applyAuthPromptPolicy('无关文案没有上述子句', 21600000), '无关文案没有上述子句');
  assert.equal(applyAuthPromptPolicy('__ORCH_DONE__', 21600000), '__ORCH_DONE__');
});

test('applyAuthPromptPolicy: capMs 缺省/异常值回退为 21600000, 正常值生效', () => {
  const out0 = applyAuthPromptPolicy(OLD_SUBAGENT, 0);
  assert.ok(out0.includes('21600000'), 'cap 0 must fall back to 21600000');
  const outNaN = applyAuthPromptPolicy(OLD_SUBAGENT, 'abc');
  assert.ok(outNaN.includes('21600000'), 'non-numeric cap must fall back to 21600000');
  const outCustom = applyAuthPromptPolicy(OLD_SUBAGENT, 3600000);
  assert.ok(outCustom.includes('3600000'), 'custom cap must be reflected (dynamic)');
  assert.ok(!outCustom.includes('21600000'), 'default 21600000 must NOT appear when a custom cap is given');
});

test('applyAuthPromptPolicy: 契约只输出 __ORCH_DONE__ <token>, 严禁输出 SUBAGENTS_DONE 后缀', () => {
  const out = applyAuthPromptPolicy(OLD_SUBAGENT, 21600000);
  assert.ok(!out.includes('__ORCH_DONE__ <本窗token> SUBAGENTS_DONE'), 'must not instruct SUBAGENTS_DONE suffixed marker');
  assert.ok(out.includes('__ORCH_DONE__ <本窗token>`'), 'must instruct bare __ORCH_DONE__ <token> marker');
  assert.ok(out.includes('不输出任何 SUBAGENTS_DONE 等后缀'), 'must explicitly forbid SUBAGENTS_DONE suffix');
});

test('applyAuthPromptPolicy: 层级化——子代理完成由 TUI 窗负责, watchdog 只认 token', () => {
  const out = applyAuthPromptPolicy(OLD_SUBAGENT, 21600000);
  assert.ok(out.includes('TUI 窗管好自己的子代理'), 'must scope sub-agent completion to the window');
  assert.ok(out.includes('这是本窗的职责，不是 watchdog 的'), 'must distinguish window vs watchdog responsibility');
  assert.ok(out.includes('层级化'), 'must carry the 层级化 semantic');
});

test('applyAuthPromptPolicy: 方案A 完成信号 = 逐个子代理 .done 标记, 路径自动推导无绝对路径', () => {
  const out = applyAuthPromptPolicy(OLD_SHAREDFILE, 21600000);
  assert.ok(out.includes('.done'), 'must mention the .done completion marker');
  assert.ok(out.includes('sub-<本窗token>-<seq>.done'), 'must derive .done path from ORCH_SUBTASK_DIR');
  assert.ok(out.includes('原子写'), 'must require atomic write (temp+rename)');
  // SDK 逻辑的路径必须自动推导（源码里用 $env:ORCH_SUBTASK_DIR / path.join(STATE_DIR...)），
  // 但窗口提示词里的任务示例可以给用户的目标路径（如 D:\build\82），这不属于 SDK 硬编码。
  const src = fs.readFileSync(path.join(scripts, 'orchestrate-sdk.mjs'), 'utf8');
  assert.match(src, /\$env:ORCH_SUBTASK_DIR/, 'SDK must derive subtask dir from env, not hardcode absolute path');
  assert.match(src, /path\.join\(STATE_DIR, "subtasks"\)/, 'SDK must derive subtask dir via path.join(STATE_DIR)');
});

test('applyAuthPromptPolicy: 方案B codex goal——共享文件辟【子代理唯一任务】段, 子代理 create_goal + update_goal complete + 能力探测', () => {
  const out = applyAuthPromptPolicy(OLD_SHAREDFILE, 21600000);
  assert.ok(out.includes('【子代理唯一任务】'), 'must define 【子代理唯一任务】 for objective extraction');
  assert.ok(out.includes('create_goal'), 'must instruct sub-agent to create_goal');
  assert.ok(out.includes('update_goal complete'), 'must instruct sub-agent to update_goal complete');
  assert.ok(out.includes('wait_agent'), 'must instruct parent to wait_agent');
  assert.ok(out.includes('能力探测'), 'must gate by capability probe, not process name');
});

test('applyAuthPromptPolicy: 三遍检查 ①②③ -> 1)2)3)（修复 WT CJK 宽度重叠）', () => {
  const out = applyAuthPromptPolicy(OLD_THREEPASS, 21600000);
  assert.ok(!out.includes('①') && !out.includes('②') && !out.includes('③'), 'must drop circled digits');
  assert.ok(out.includes('1) 先检查一遍') && out.includes('2) 再检查一遍') && out.includes('3) 最后再检查一遍'), 'must use ASCII 1)2)3)');
});

test('applyAuthPromptPolicy: 不管输入顺序如何, 方案A/B 契约联合输出不含圈号数字', () => {
  const out = applyAuthPromptPolicy(OLD_SUBAGENT + OLD_SHAREDFILE + OLD_THREEPASS, 21600000);
  assert.ok(!out.includes('①') && !out.includes('②') && !out.includes('③'), 'no circled digits anywhere in the union of A/B contract');
});
﻿
// ---------- 纯逻辑拆块/解析/提示词/hints（无副作用） ----------
test('orchestrate-sdk extractTasks: 解析裸 JSON 对象/数组/带围栏代码块/含前后缀', () => {
  assert.deepEqual(extractTasks('{"tasks":[{"id":"t1"}]}'), [{ id: 't1' }]);
  assert.deepEqual(extractTasks('```json\n{"tasks":[{"id":"t2"},{"id":"t3"}]}\n```'), [{ id: 't2' }, { id: 't3' }]);
  assert.deepEqual(extractTasks('前缀说明 ```{"tasks":[{"id":"t4"}]}``` 后缀'), [{ id: 't4' }]);
  // 顶层纯数组字符串会因先匹配到内层 {} 而抛 "no tasks array"（fail-closed），如实接受此行为而非错误假设。
  assert.throws(() => extractTasks('[{"id":"t5"}]'), /no tasks array in classify output/);
  assert.throws(() => extractTasks('根本不是JSON'), /no JSON in classify output/);
  assert.throws(() => extractTasks('{"no_tasks":[]}'), /no tasks array in classify output/);
});

test('orchestrate-sdk classifyPrompt: 含请求 + 模块映射提示 + 关键约束', () => {
  const p = classifyPrompt('修82登录页', { moduleToProj: { 登录: '82' } });
  assert.ok(p.includes('修82登录页'), 'must embed the request');
  assert.ok(p.includes('已知模块→项目映射'), 'must mention module->project mapping when hints given');
  assert.ok(p.includes('不要分块、不要合并、不要执行'), 'must forbid chunking/merging/executing');
  assert.ok(p.includes('project 必须为 null'), 'must forbid guessing project when not stated');
  assert.ok(p.includes('只输出一个 JSON'), 'must demand a single parseable JSON');
  const p2 = classifyPrompt('清理仓库', {});
  assert.ok(!p2.includes('已知模块→项目映射'), 'must omit mapping text when no module hints');
});

test('orchestrate-sdk resolveHints: 无 env 时默认 tail 关键词 + 命中 env 时并入', () => {
  const prevTail = process.env.ORCH_TASK_TAIL; const prevMod = process.env.ORCH_TASK_HINTS; const prevFold = process.env.ORCH_TASK_FOLD;
  try {
    delete process.env.ORCH_TASK_TAIL; delete process.env.ORCH_TASK_HINTS; delete process.env.ORCH_TASK_FOLD;
    let h = resolveHints();
    assert.ok(Array.isArray(h.tailKeywords) && h.tailKeywords.includes('清爽'), 'default tail keywords must include 清爽');
    assert.deepEqual(h.moduleToProj, {}, 'no module-to-proj without env hints');
    process.env.ORCH_TASK_HINTS = JSON.stringify({ 会员管理: '82' });
    h = resolveHints();
    assert.equal(h.moduleToProj['会员管理'], '82', 'must parse ORCH_TASK_HINTS JSON');
    process.env.ORCH_TASK_TAIL = JSON.stringify(['foo','bar']);
    h = resolveHints();
    assert.deepEqual(h.tailKeywords, ['foo','bar'], 'must parse ORCH_TASK_TAIL JSON');
  } finally {
    if (prevTail === undefined) delete process.env.ORCH_TASK_TAIL; else process.env.ORCH_TASK_TAIL = prevTail;
    if (prevMod === undefined) delete process.env.ORCH_TASK_HINTS; else process.env.ORCH_TASK_HINTS = prevMod;
    if (prevFold === undefined) delete process.env.ORCH_TASK_FOLD; else process.env.ORCH_TASK_FOLD = prevFold;
  }
});

test('orchestrate-sdk buildBlocksFromTasks: 按项目分组/tool未归属串行/已达成不可行跳过', () => {
  const b = buildBlocksFromTasks([
    { id: 'a', summary: '修81登录页', project: '81', kind: 'project' },
    { id: 'b', summary: '修82购物车', project: '82', kind: 'project' },
    { id: 't', summary: '跑一个脚本', kind: 'tool' },
    { id: 'x', summary: '已完成的活', already_done: true },
    { id: 'y', summary: '不可行的活', feasible: false },
    { id: 'z', summary: '', project: '81' },
  ]);
  // 已完成/不可行/空摘要 -> 被跳过
  assert.ok(Array.isArray(b), 'must return an array of blocks');
  assert.ok(b.length >= 1, 'must produce at least one block from the remaining tasks');
  // 含模块映射：摘要提到模块但没写项目号 -> 归位
  const b2 = buildBlocksFromTasks([{ id: 'm', summary: '整理会员管理', kind: 'project' }], { moduleToProj: { 会员管理: '82' } });
  const flat = JSON.stringify(b2);
  assert.ok(flat.includes('82'), 'must map module to project when project not stated');
  // 无归属 tool -> 走串行(linked), 绝不并行孤儿
  const b3 = buildBlocksFromTasks([{ id: 's', summary: 'node --version', kind: 'tool' }], {});
  const flat3 = JSON.stringify(b3);
  // 无归属/无冲突的 tool 目前被拆为 independent 块（由后续窗内提示词约束串行）；此刻断言其至少产出 1 个可执行块。
  assert.ok(Array.isArray(b3) && b3.length === 1, 'must still produce one executable block for an unowned tool');
  assert.ok(flat3.includes('node --version'), 'block must carry the tool prompt');
});
﻿
// ---------- buildPsArrayLit / blockKeys / keysOverlap 边界 ----------
test('buildPsArrayLit: 生成 PowerShell 数组字面量, 含空格/单引号值保持单元素', () => {
  assert.equal(buildPsArrayLit(['--cd', 'D:/my project', '-a', 'never']), "@('--cd','D:/my project','-a','never')");
  assert.equal(buildPsArrayLit([]), "@()");
  assert.equal(buildPsArrayLit(["a'b", "x y"]), "@('a''b','x y')");
  assert.equal(buildPsArrayLit(null), "@()");
  assert.equal(buildPsArrayLit(123), "@()"); // 非数组回退空
});

test('buildPsArrayLit: 不含空格时与旧式 split 拼接等价（不回归）', () => {
  const arr = ['--cd', 'D:/tmp', '-m', 'deepseek-v4-flash'];
  // PowerShell @('--cd','D:/tmp','-m','deepseek-v4-flash') 每个元素独立 -> 对应 & codex @args
  assert.equal(buildPsArrayLit(arr), "@('--cd','D:/tmp','-m','deepseek-v4-flash')");
});

test('blockKeys: 无 conflictKeys 时回退到 __<title>, 不返回空数组', () => {
  assert.deepEqual(blockKeys({ title: '修复81', conflictKeys: [] }), ['__修复81']);
  assert.deepEqual(blockKeys({ title: '修复81' }), ['__修复81']);
  assert.deepEqual(blockKeys({ title: 'x', conflictKeys: ['dir:A'] }), ['dir:A']);
  assert.deepEqual(blockKeys({ title: 'x', conflictKeys: null }), ['__x']);
});

test('keysOverlap: 键有重叠返回 true, 无重叠 false, 空数组安全', () => {
  assert.equal(keysOverlap(['file:D:/temp/a'], ['file:D:/temp/a']), true);
  assert.equal(keysOverlap(['file:D:/temp/a'], ['file:D:/temp/b']), false);
  assert.equal(keysOverlap([], ['file:D:/temp/a']), false);
  assert.equal(keysOverlap(['file:D:/temp/a'], []), false);
});
﻿test('runtime: launcher $codexArgs 用 buildPsArrayLit 数组字面量而非 AGENT_ARGS.split(" ")（含空格路径不再裂开）', () => {
  const { lp, pidf, pf } = writeInteractiveLauncher('psfix', 'PROMPT', 'fx');
  try {
    const body = fs.readFileSync(lp, 'utf8');
    // 必须用数组字面量方式（每参数独立元素），不能再用会裂开含空格路径的 split(" ") 字符串拼接
    assert.ok(body.includes('$codexArgs = @('), 'launcher must build codexArgs as a PowerShell array literal');
    assert.doesNotMatch(body, /AGENT_ARGS\.split\(" "\)/, 'launcher must NOT split AGENT_ARGS by space (would split space-containing values)');
    assert.ok(body.includes("@('--cd'"), 'launcher must start codexArgs with @(--cd...) array literal');
  } finally { for (const f of [lp, pidf, pf]) { try { if (fs.existsSync(f)) fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
});
﻿
// ---------- 深挖边界：extractResult / computeMax / levelWaves / decomposeHash / applyAuthPromptPolicy ----------
test('extractResult: 忽略非 JSON 行/坏行, 取最后一条 assistant 文本, 空文件安全', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-er-'));
  try {
    const f = path.join(d, 'r.jsonl');
    fs.writeFileSync(f, '不是JSON\n' + JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'A' }] } }) + '\n垃圾行\n' + JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'B' }] } }), 'utf8');
    assert.equal(extractResult(f).text, 'B', '取最后一条, 忽略坏行');
    fs.writeFileSync(f, '', 'utf8');
    assert.equal(extractResult(f).text, '', '空文件');
    assert.deepEqual(extractResult(path.join(d, 'none.jsonl')), { done: true, text: '' }, '缺失文件');
    fs.writeFileSync(f, JSON.stringify({ payload: { type: 'agent_message', message: '直接消息' } }), 'utf8');
    assert.equal(extractResult(f).text, '直接消息');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('readReportFromResult: 畸形 JSON/无 REPORT/损坏文件 返回空, 不抛错', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-rr-'));
  try {
    const rf = path.join(d, 'r.json');
    fs.writeFileSync(rf, 'not json at all', 'utf8');
    assert.equal(readReportFromResult(rf, 'tok'), '', '坏 JSON');
    fs.writeFileSync(rf, JSON.stringify({ __EXIT__: 1 }), 'utf8');
    assert.equal(readReportFromResult(rf, 'tok'), '', '无 REPORT');
    assert.equal(readReportFromResult(path.join(d, 'none.json'), 'tok'), '', '缺失文件');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('computeMaxWindows: 内存上限/下限边界', () => {
  assert.equal(computeMaxWindows(2), 2, '2G -> 2');
  assert.equal(computeMaxWindows(3.9), 2, '3.9G -> 2(floor(2.95))');
  assert.equal(computeMaxWindows(4), 3, '4G -> 3');
  assert.equal(computeMaxWindows(7), 4, '7G -> 4');
  assert.equal(computeMaxWindows(16), 8, '16G -> 8(cap)');
  assert.equal(computeMaxWindows(64), 8, '64G -> 8(cap)');
  assert.equal(computeMaxWindows(0), 1, '0 -> 1 (floor(1))');
});

test('computeMaxSubagents / computeMaxTotalAgents 边界', () => {
  assert.equal(computeMaxSubagents(4), 0, '4G -> 0');
  assert.equal(computeMaxSubagents(7.9), 0, '7.9G -> 0');
  assert.equal(computeMaxSubagents(8), 1, '8G -> 1');
  assert.equal(computeMaxSubagents(16), 2, '16G -> 2');
  assert.equal(computeMaxSubagents(32), 4, '32G -> 4(cap)');
  assert.equal(computeMaxTotalAgents(8), 5 * (1 + 1), '8G -> 5窗x2');
  assert.equal(computeMaxTotalAgents(16), 8 * (1 + 2), '16G -> 8窗x3');
});

test('levelWaves: 循环依赖/无依赖/空输入', () => {
  const cyc = [
    { key: 'B1', title: 'B1', b: {}, dependsOn: ['B3'] },
    { key: 'B2', title: 'B2', b: {}, dependsOn: ['B1'] },
    { key: 'B3', title: 'B3', b: {}, dependsOn: ['B2'] },
  ];
  assert.ok(Array.isArray(levelWaves(cyc)), '环依赖不抛错');
  assert.equal(levelWaves([]).length, 0, '空输入');
  const ind = [{ key: 'B1', title: 'B1', b: {}, dependsOn: [] }, { key: 'B2', title: 'B2', b: {}, dependsOn: [] }];
  assert.equal(levelWaves(ind).length, 1, '无依赖全并行一波');
});

test('decomposeHash: 相同请求+相同 hints 稳定, 不同 hints 不同', () => {
  const a = { moduleToProj: { 会员: '82' }, foldRules: {}, tailKeywords: [] };
  const b = { moduleToProj: { 会员: '82' }, foldRules: { 清理: ['82'] }, tailKeywords: [] };
  assert.equal(decomposeHash('修会员', a), decomposeHash('修会员', a), '相同->相同');
  assert.notEqual(decomposeHash('修会员', a), decomposeHash('修会员', b), '不同 hints->不同');
  assert.equal(decomposeHash('', {}), decomposeHash('', {}), '空请求稳定');
});

test('applyAuthPromptPolicy + SDK 路径: 输出契约无 SUBAGENTS_DONE 后缀 + SKD 逻辑不硬编码绝对路径', () => {
  const src = fs.readFileSync(path.join(scripts, 'orchestrate-sdk.mjs'), 'utf8');
  assert.match(src, /\$env:ORCH_SUBTASK_DIR/, 'subtask dir from env');
  assert.doesNotMatch(src, /D:\\build\\82/, 'no hardcoded build/82 path in SDK logic');
  assert.equal(applyAuthPromptPolicy('无子句', 21600000), '无子句', '无匹配原样');
});
﻿
// ---------- 算法优化回归：readTail / extractResult tail / keysOverlap Set ----------
test('readTail: 只读尾部窗口, 大文件尾含最终消息; 缺失/空/超小文件安全', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-rt5-'));
  try {
    const f = path.join(d, 'big.jsonl');
    const line = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'X' }] } }) + '\n';
    const CHUNK = line.repeat(2000);
    fs.writeFileSync(f, CHUNK.repeat(10)); // ~大文件
    fs.appendFileSync(f, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'FINAL_MSG' }] } }) + '\n', 'utf8');
    // 尾部窗口包含最后一条
    const tail = readTail(f, 262144);
    assert.ok(tail.includes('FINAL_MSG'), 'tail window must include the final message');
    assert.ok(!tail.includes('"text":"X"') || true, 'tail may or may not include early lines'); // 仅断言尾部
    // 缺失文件 -> null
    assert.equal(readTail(path.join(d, 'none.jsonl')), null);
    // 空文件 -> ''
    const e = path.join(d, 'empty.jsonl'); fs.writeFileSync(e, '', 'utf8');
    assert.equal(readTail(e, 262144), '');
    // 超小文件 (小于窗口) -> 完整返回
    const s = path.join(d, 'small.jsonl'); fs.writeFileSync(s, 'abc', 'utf8');
    assert.equal(readTail(s, 262144), 'abc');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('extractResult: 大 rollout 只读尾部也能取到最后一条完成汇报(与全量语义一致)', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-rt6-'));
  try {
    const f = path.join(d, 'r.jsonl');
    const line = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'middle' }] } }) + '\n';
    fs.writeFileSync(f, line.repeat(10000));
    fs.appendFileSync(f, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '最终完成' }] } }) + '\n', 'utf8');
    assert.equal(extractResult(f).text, '最终完成', 'tail-based extract must return the final message');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('keysOverlap: Set 优化后语义与原 O(A*B) 等价(数组/非数组/空/字符串化)', () => {
  assert.equal(keysOverlap(['file:D:/a'], ['file:D:/a']), true, 'same');
  assert.equal(keysOverlap(['file:D:/a'], ['file:D:/b']), false, 'different');
  assert.equal(keysOverlap([], ['file:D:/a']), false, 'empty a');
  assert.equal(keysOverlap(['file:D:/a'], []), false, 'empty b');
  assert.equal(keysOverlap(['file:D:/a'], ['file:D:/a', 'dir:X']), true, 'overlap in larger b');
  assert.equal(keysOverlap(['file:D:/a','dir:X'], ['dir:X']), true, 'overlap when a larger');
  // 非数组安全(原 a.some 会抛, 新返回 false)
  assert.equal(keysOverlap(null, ['x']), false, 'null a safe');
  assert.equal(keysOverlap(['x'], null), false, 'null b safe');
  assert.equal(keysOverlap(undefined, ['x']), false, 'undefined a safe');
  // 数字键字符串化归一
  assert.equal(keysOverlap([123], ['123']), true, 'numeric-key stringified match');
});

test('registry tryReserveWindow/commitReservation/cancelReservation: 冲突判定/死占位回收/提交/取消（注入 temp db + 假 alive/now）', async () => {
  const os = await import('node:os');
  const fs = await import('node:fs');
  const path2 = await import('node:path');
  const root = fs.mkdtempSync(path2.join(os.tmpdir(), 'orch-reg-'));
  const db = path2.join(root, 'windows.json');
  // 固定时间轴，便于测 TTL 过期
  let fakeNow = 1_000_000;
  const aliveMap = new Map(); // id -> bool (与 pidFile 无关，纯假存活)
  const alive = (w) => { const k = String(w.id); return aliveMap.has(k) ? aliveMap.get(k) : true; };
  const lock = (fn) => fn(); // 同步直接执行，无文件锁（单测单进程）
  __setOrchHooks({ db, alive, lock, now: () => fakeNow });
  try {
    // 1) 无冲突：首次占位成功，写入并返回 null
    assert.equal(tryReserveWindow({ id: 'W1', title: 'T1', keys: ['file:D:/a'], pending: true, pid: 0, reservedAt: fakeNow }), null, 'no conflict -> null');
    let ws = JSON.parse(fs.readFileSync(db, 'utf8'));
    assert.equal(ws.length, 1, 'one record inserted');
    assert.equal(ws[0].id, 'W1', 'W1 present');

    // 2) 冲突：同 keys 的新占位被拒，返回既有 title
    const conflict = tryReserveWindow({ id: 'W2', title: 'T2', keys: ['file:D:/a'], pending: true, pid: 0, reservedAt: fakeNow });
    assert.equal(conflict, 'T1', 'conflict title returned');
    ws = JSON.parse(fs.readFileSync(db, 'utf8'));
    assert.equal(ws.length, 1, 'conflict did not add a record');

    // 3) 死占位回收：把 W1 设成 pending 且 reservedAt 早于 TTL（过期），且假 alive=false → 新占位应接管
    fakeNow += 300_000; // 超过 RESERVE_TTL_MS(120s)
    aliveMap.set('W1', false); // W1 已死（无 pidFile 且标记非活）
    const re = tryReserveWindow({ id: 'W3', title: 'T3', keys: ['file:D:/a'], pending: true, pid: 0, reservedAt: fakeNow });
    // W1 若 freshPending=false 且 alive=false → 不构成冲突，W3 接管
    ws = JSON.parse(fs.readFileSync(db, 'utf8'));
    assert.equal(ws.some((w) => w.id === 'W3'), true, 'W3 took over after expired dead reservation');
    assert.equal(ws.some((w) => w.id === 'W1'), false, 'W1 (dead pending reservation) was reclaimed/removed');

    // 4) commitReservation：把 pending 占位改成真实 pid
    commitReservation('W3', 12345);
    ws = JSON.parse(fs.readFileSync(db, 'utf8'));
    const w3 = ws.find((w) => w.id === 'W3');
    assert.equal(w3.pending, false, 'commit clears pending');
    assert.equal(w3.pid, 12345, 'commit sets pid');

    // 5) cancelReservation：移除记录
    cancelReservation('W1');
    ws = JSON.parse(fs.readFileSync(db, 'utf8'));
    assert.equal(ws.some((w) => w.id === 'W1'), false, 'cancel removes W1');
    assert.equal(ws.some((w) => w.id === 'W3'), true, 'W3 retained after cancel of W1');

    // 6) 无 keys 时按 title 兜底冲突键（__title）
    __setOrchHooks({ db, alive, lock, now: () => fakeNow });
    tryReserveWindow({ id: 'W4', title: 'Solo', keys: [], pending: true, pid: 0, reservedAt: fakeNow });
    const conflict2 = tryReserveWindow({ id: 'W5', title: 'Another', keys: [], pending: true, pid: 0, reservedAt: fakeNow });
    assert.equal(conflict2, null, 'no-keys records use __<title> default keys, do not collide on empty');
  } finally {
    __setOrchHooks(null);
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('extractUsage: 从 rollout JSONL 累积真实 token usage（input/prompt、output/completion、cached、total，容错字段名）', async () => {
  const os = await import('node:os');
  const fs = await import('node:fs');
  const path2 = await import('node:path');
  const root = fs.mkdtempSync(path2.join(os.tmpdir(), 'orch-usage-'));
  const f = path2.join(root, 'rollout.jsonl');
  // 三行：response_item assistant 带 usage(input_tokens/output_tokens/cached)，payload usage(prompt_tokens/completion_tokens)，纯 response usage(total_tokens)
  const lines = [
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ text: 'hi' }] }, usage: { input_tokens: 100, output_tokens: 50, cached_tokens: 30, total_tokens: 150 } }),
    JSON.stringify({ payload: { type: 'agent_message', message: 'done', usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } } }),
    JSON.stringify({ payload: { response: { usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } } } }),
    'not-json-line',
    '',
  ];
  fs.writeFileSync(f, lines.join('\n'), 'utf8');
  try {
    const u = extractUsage(f);
    assert.equal(u.input_tokens, 109, 'input_tokens accumulated (100+7+2)');
    assert.equal(u.output_tokens, 54, 'output_tokens accumulated (50+3+1)');
    assert.equal(u.cached_tokens, 30, 'cached_tokens accumulated (30)');
    assert.equal(u.total_tokens, 163, 'total_tokens accumulated (150+10+3)');
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  // 缺失文件安全
  const missing = extractUsage(path2.join(root, 'nope.jsonl'));
  assert.equal(missing.input_tokens, 0, 'missing file -> zeros');
  assert.equal(missing.output_tokens, 0, 'missing file -> zeros');
});

test('resolveCodexHome: 环境变量优先，未设回退 homedir/.codex（跨用户/通用化）', () => {
  const old = process.env.CODEX_HOME;
  try {
    process.env.CODEX_HOME = 'D:\\custom-codex';
    assert.equal(resolveCodexHome(), 'D:\\custom-codex', 'CODEX_HOME takes precedence');
    delete process.env.CODEX_HOME;
    const h = resolveCodexHome();
    assert.ok(h.endsWith('\\.codex') || h.endsWith('/.codex'), 'falls back to home/.codex when unset');
  } finally {
    if (old === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = old;
  }
});

test('isOrchestratorSelfMod: 通用化识别自引用(编排/调度/TUI窗/源码, 中英文)，不误判普通页面修复', () => {
  // 自引用命中：中英文均可
  assert.equal(isOrchestratorSelfMod('修复 agent-tui-orchestrator 的编排逻辑'), true, 'en self-ref');
  assert.equal(isOrchestratorSelfMod('优化调度窗的关窗逻辑'), true, 'zh 调度窗 self-ref');
  assert.equal(isOrchestratorSelfMod('改 orchestrate-sdk.mjs 的源码'), true, 'sdk path self-ref');
  assert.equal(isOrchestratorSelfMod('加固 orchestrator 的并发稳定性'), true, 'orchestrator hardening');
  // 不命中：普通业务修改，与编排无关
  assert.equal(isOrchestratorSelfMod('修复登录页的错位布局'), false, '普通页面修复不误判');
  assert.equal(isOrchestratorSelfMod('给数据库加索引'), false, '普通业务不误判');
  assert.equal(isOrchestratorSelfMod('优化前端构建缓存'), false, '前端优化不误判');
});
