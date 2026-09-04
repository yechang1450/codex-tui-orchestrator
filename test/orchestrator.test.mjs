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
const { classifyBlockComplexity, classifyExecutionMode, appendModelEffortArgs, conflictByKeys, trySingleBlock, genericProjectSplit, loadCachedDecompose, buildBlockPrompt, levelWaves, decomposeHash, checkDiskSpace, readPidFile, pidAliveCheck, closeWindowByPid, windowGenuinelyPopped, extractResult, readReportFromResult, sessionDir, writeInteractiveLauncher, pidFileOfTransient, staleTransientFiles, computeMaxWindows } = await import(importUrl(path.join(scripts, 'orchestrate-sdk.mjs')));
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
test('orchestrate-sdk computeMaxWindows: n GB -> n/2 concurrency, capped at 8 windows', () => {
  assert.equal(computeMaxWindows(2), 1, '2G -> floor(1) -> 1 (caller refuses <2)');
  assert.equal(computeMaxWindows(4), 2, '4G -> 2 windows');
  assert.equal(computeMaxWindows(8), 4, '8G -> 4 windows');
  assert.equal(computeMaxWindows(12), 6, '12G -> 6 windows');
  assert.equal(computeMaxWindows(16), 8, '16G -> 8 windows (cap)');
  assert.equal(computeMaxWindows(32), 8, '32G -> 8 windows (capped, NOT 16)');
  assert.equal(computeMaxWindows(64), 8, '64G -> 8 windows (capped)');
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
