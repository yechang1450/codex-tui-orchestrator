import {testTempFamily} from './test-temp-root.mjs';
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {verifyChecks, buildTodoList, canonicalDigest, CORE_VERSION} from '../scripts/core/contracts.mjs';
import {verifyRun as coreVerifyRun} from '../scripts/core/runner.mjs';
import {DECOMPOSE_CACHE_SCHEMA, decomposeHash, resolveHints} from '../scripts/core/orchestrate-sdk.mjs';

// 审计线 C：计划文件 / 验收契约 / 单元命令三块契约面的畸形输入判据。
// 基线同 malformed-state-fuzz.test.mjs：不抛裸 Node 栈帧、不静默成功、失败必须给出可读真因。
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(repo, 'scripts', 'orchestrate-sdk.mjs');
const family = testTempFamily('malformed-contract-fuzz');
fs.mkdirSync(family, {recursive: true});
const controllerRoot=fs.mkdtempSync(path.join(family,'fuzz-controller-'));
after(()=>fs.rmSync(controllerRoot,{recursive:true,force:true}));
const newDir = (label) => fs.mkdtempSync(path.join(family, `fuzz-${label}-`));
// These fixtures intentionally use their own coordinator; pass that trusted
// fixture path explicitly rather than asking recovery to trust the ledger.
const verifyRun=(workspace,runId,contract,options={})=>coreVerifyRun(workspace,runId,contract,
  {coordinator:path.join(controllerRoot,'codex-coordinator'),...options});
const seen = (name, value) => console.log(`[fuzz] ${name} :: ${value}`);
const firstLine = (text) => String(text || '').trim().split('\n')[0].slice(0, 220);
// 只允许"点名了文件/字段/命令"的可读真因；裸 Node 措辞（整句就是 Node 内部错误）才算越界。
// 注意：JSON 解析细节可以附在可读前缀后面（如 "…contract.json：JSON 解析失败：Unexpected token …"），
// 那是有用的定位信息，不是裸抛。
const BARE_NODE = /^(Cannot read properties|Cannot use 'in' operator|Unexpected token|Unexpected end of JSON input|The "[^"]+" argument must be of type|Received type)|is not a function/;

function cli(args, {workspace, env = {}, timeout = 60000} = {}) {
  // Cache and recovery-ledger validation are offline operations.  Force host
  // resolution to fail deterministically if an accidental eager startup reaches
  // it, instead of making these contract tests depend on the machine's CLI.
  const clean = {...process.env, ORCH_CONTROLLER_ROOT: controllerRoot, ORCH_CLI: path.join(controllerRoot, 'missing-codex.exe'), ORCH_AUTO_INSTALL_CLI: '0', ORCH_AUTO_INSTALL_DEPS: '0', ...env};
  for (const key of ['CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'ORCH_TASK_HINTS', 'ORCH_TASK_FOLD', 'ORCH_TASK_TAIL', 'ORCH_RUN_ID', 'ORCH_STATE_DIR']) delete clean[key];
  clean.ORCH_AGENT = 'codex';
  if (workspace) clean.WORKSPACE_DIR = workspace;
  // maxBuffer 必须够大：--plan 会把整份计划（含超长 prompt）打到 stdout。
  const result = spawnSync(process.execPath, [entry, ...args], {cwd: repo, env: clean, encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 32 * 1024 * 1024});
  return {status: result.status, stdout: result.stdout || '', stderr: result.stderr || '', result};
}

function seedPlanCache(workspace, request, blocks, version, {entry} = {}) {
  const workspaceId=crypto.createHash('sha256').update(fs.realpathSync(workspace).toLowerCase()).digest('hex');
  const stateDir = path.join(controllerRoot, 'decompose', workspaceId);
  fs.mkdirSync(stateDir, {recursive: true});
  const cacheFile = path.join(stateDir, 'orchestrator-decompose-cache.json');
  const hash = decomposeHash(request, resolveHints());
  const cachedEntry = entry === undefined ? {createdAt: Date.now(), blocks} : entry;
  fs.writeFileSync(cacheFile, JSON.stringify({schema:DECOMPOSE_CACHE_SCHEMA, version, entries: {[hash]: cachedEntry}}), 'utf8');
  return {cacheFile, hash};
}

// ---------------------------------------------------- 计划文件（拆块缓存 = 磁盘上的计划）
test('P1-P4 拆块缓存里的畸形计划必须被隔离掉，不得以裸 Node 措辞崩掉 --plan', () => {
  const cases = [
    ['missing-tasks', [{title: 'x'}]],
    ['non-object-block', [42]],
    ['tasks-not-array', [{title: 'x', tasks: 'nope'}]],
    ['null-block', [null]],
    ['null-blocks', null],
    ['empty-blocks', []],
    ['non-array-blocks', {title: 'x'}],
    ['empty-task-list', [{title: 'x', tasks: []}]],
    ['null-entry', null, null],
  ];
  for (const [label, blocks, entry] of cases) {
    const workspace = newDir(`plan-${label}`);
    const request = '修复 README 排版';
    const {cacheFile, hash} = seedPlanCache(workspace, request, blocks, CORE_VERSION, {entry});
    const {status, stdout, stderr} = cli(['--plan', request], {workspace});
    const after = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    const entryAfter = after.entries[hash];
    seen(`plan.${label}`, `status=${status} stderr=${JSON.stringify(firstLine(stderr))} stdout=${JSON.stringify(firstLine(stdout))} entryAfter=${JSON.stringify(entryAfter?.blocks?.map?.((b) => (b && Array.isArray(b.tasks) ? 'ok' : 'bad')))}`);
    assert.doesNotMatch(stderr, /TypeError|Cannot read properties|is not a function/, '坏缓存不得让 CLI 用裸 Node 措辞结尾');
    assert.equal(status, 0, `坏缓存必须当成"没有缓存"走正常规划路径（stderr=${firstLine(stderr)}）`);
    assert.match(stdout, /"blocks"/, '必须给出可用计划');
    assert.match(stderr, /cache/i, '隔离动作必须在 stderr 上可见（不许静默吞掉）');
    assert.ok(!entryAfter || (Array.isArray(entryAfter.blocks) && entryAfter.blocks.every((b) => b && Array.isArray(b.tasks))), '清掉之后重写的缓存条目必须结构合法（同一请求不许被永久毒住）');
    fs.rmSync(workspace, {recursive: true, force: true});
  }
});

test('P5 拆块缓存里的超长 prompt 与带 ; | & 换行 引号的 prompt 必须原样透传，且绝不触发任何 shell 执行', () => {
  const workspace = newDir('plan-nasty');
  const marker = path.join(workspace, 'pwned.marker');
  const nasty = [
    '第一行; 第二行 | 管道 & 连接 && 再来; 引号 "double" \'single\' `反引号` $(子命令) %PATH%',
    `& echo PWNED > ${marker}`,
    '| tee /tmp/x',
    '换行之后的第二段',
  ].join('\n');
  const long = 'A'.repeat(2 * 1024 * 1024);
  const request = '修复 README 排版';
  const {hash} = seedPlanCache(workspace, request, [
    {title: 'nasty', type: 'independent', dependsOn: [], conflictKeys: [], tasks: [{id: '1', title: 'nasty', prompt: nasty}]},
    {title: 'long', type: 'independent', dependsOn: [], conflictKeys: [], tasks: [{id: '2', title: 'long', prompt: long}]},
  ], CORE_VERSION);
  const {status, stdout, stderr} = cli(['--plan', request], {workspace});
  // --plan 的 stdout = 若干 [orchestrator] 诊断行 + 缩进 JSON；只取最后那个独立成行的 '{' 之后的内容。
  const payload = stdout.slice(stdout.lastIndexOf('\n{\n') + 1);
  const plan = JSON.parse(payload);
  const prompts = plan.blocks.flatMap((b) => (b.tasks || []).map((t) => t.prompt));
  seen('plan.nasty', `status=${status} hash=${hash.slice(0, 8)} prompts=${prompts.length} nastyIntact=${prompts.includes(nasty)} longLen=${prompts.find((p) => p.startsWith('AAA'))?.length} marker=${fs.existsSync(marker)} stderr=${JSON.stringify(firstLine(stderr))} stdoutHead=${JSON.stringify(stdout.slice(0, 80))} stdoutTail=${JSON.stringify(stdout.slice(-60))}`);
  assert.equal(status, 0, firstLine(stderr));
  assert.deepEqual(prompts, [nasty, long], 'prompt 必须逐字节原样透传（不得被 shell 转义、截断或改写）');
  assert.equal(fs.existsSync(marker), false, '计划/拆块链路不得执行 prompt 里嵌入的命令');
  fs.rmSync(workspace, {recursive: true, force: true});
});

test('P5a 无缓存且需要模型分类的 --plan 仍必须在调用模型前检查宿主 CLI，再安全回退', () => {
  const workspace = newDir('plan-needs-host');
  try {
    const {status, stdout, stderr} = cli(['--plan', '比较模块甲与模块乙的依赖并给出执行顺序'], {workspace});
    seen('plan.needs-host', `status=${status} stderr=${JSON.stringify(firstLine(stderr))}`);
    assert.equal(status, 0);
    assert.match(stderr, /CLI_MISSING/);
    assert.match(stdout, /"blocks"/);
  } finally {
    fs.rmSync(workspace, {recursive: true, force: true});
  }
});

test('P6-P9 拆块缓存里的依赖错误（未知依赖/自依赖/环/重复块身份）必须 fail-closed 且真因可读（不给计划、不给栈帧）', () => {
  const cases = [
    ['unknown-dependency', [{title: 'a', tasks: [{prompt: 'p'}]}, {title: 'b', dependsOn: ['nope'], tasks: [{prompt: 'q'}]}], /Unknown dependency/],
    ['self-dependency', [{title: 'a', dependsOn: ['a'], tasks: [{prompt: 'p'}]}], /Self dependency/],
    ['cycle', [{title: 'a', dependsOn: ['b'], tasks: [{prompt: 'p'}]}, {title: 'b', dependsOn: ['a'], tasks: [{prompt: 'q'}]}], /Cyclic dependencies/],
    ['duplicate-identity', [{title: 'same', tasks: [{prompt: 'p'}]}, {title: 'same', tasks: [{prompt: 'q'}]}], /Ambiguous block identity/],
  ];
  for (const [label, blocks, expected] of cases) {
    const workspace = newDir(`plan-${label}`);
    const request = '修复 README 排版';
    const {cacheFile, hash} = seedPlanCache(workspace, request, blocks, CORE_VERSION);
    const {status, stdout, stderr} = cli(['--plan', request], {workspace});
    const after = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    seen(`plan.${label}`, `status=${status} stderr=${JSON.stringify(firstLine(stderr))} poisonLeft=${Object.hasOwn(after.entries, hash)}`);
    assert.equal(status, 1, `坏计划必须 fail-closed（stderr=${firstLine(stderr)}）`);
    assert.match(stderr, expected, '真因必须点名是哪类依赖错误');
    // 隔离毒条目会先打一行告警，失败本身必须仍然"只回一行 FATAL"。
    const fatalLines = String(stderr).split('\n').filter((line) => line.startsWith('[orchestrator] FATAL: '));
    assert.equal(fatalLines.length, 1, `失败只允许回一行 FATAL（实测 ${JSON.stringify(fatalLines)}）`);
    assert.doesNotMatch(stderr, /\n\s+at /, '默认不得打 Node 栈帧（ORCH_DEBUG 才允许）');
    assert.equal(stdout.includes('"blocks"'), false, '失败时不得输出计划');
    assert.equal(Object.hasOwn(after.entries, hash), false, '被判定为非法的缓存条目必须清掉，否则同一请求每次都被同一条毒记录拦住');
    fs.rmSync(workspace, {recursive: true, force: true});
  }
});

// ------------------------------------------- 计划文件（账本里的 plan：--resume-run 入口）
function ledgerFixture(workspace, runId, mutate = () => {}) {
  const request = '写证据；再写证据';
  const tasks = [{id: 'T001', prompt: '写证据'}, {id: 'T002', prompt: '再写证据'}];
  const blocks = [{key: 'B1', title: 'b1', taskIds: ['T001']}, {key: 'B2', title: 'b2', taskIds: ['T002']}];
  const plan = [
    {key: 'B1', title: 'b1', keys: ['dir:a'], dependsOn: [], b: {type: 'independent', title: 'b1', dependsOn: [], conflictKeys: [], tasks: [{id: '1', title: 'b1', sourceIds: ['T001'], prompt: '写证据'}]}},
    {key: 'B2', title: 'b2', keys: ['dir:b'], dependsOn: [], b: {type: 'independent', title: 'b2', dependsOn: [], conflictKeys: [], tasks: [{id: '2', title: 'b2', sourceIds: ['T002'], prompt: '再写证据'}]}},
  ];
  const results = {B1: {status: 'pending', attempts: []}, B2: {status: 'pending', attempts: []}};
  const taskResults = {T001: {status: 'pending'}, T002: {status: 'pending'}};
  const sum = {
    protocol: 2, version: CORE_VERSION, agent: 'codex', executionMode: 'headless', runId, workspace,
    coordinator:path.join(controllerRoot,'codex-coordinator'),
    request, capacity: 2, generation: 1, history: [], startedAt: Date.now(),
    tasks, plan, blocks, results, taskResults, todoList: buildTodoList(tasks, blocks, taskResults),
  };
  mutate(sum);
  const dir = path.join(workspace, 'temp', 'orchestrator', 'runs', runId);
  fs.mkdirSync(dir, {recursive: true});
  const file = path.join(dir, 'summary.json');
  fs.writeFileSync(file, JSON.stringify(sum, null, 2), 'utf8');
  return {sum, dir, file, request};
}

test('Q1-Q6 账本里的畸形计划（缺 key/未知依赖/自依赖/环/重复 taskId/清单不符）必须 fail-closed 且不碰任何状态', () => {
  const cases = [
    ['missing-keys', /invalid block or plan/, (sum) => { delete sum.plan[0].keys; }],
    ['unknown-dependency', /Unknown dependency/, (sum) => { sum.plan[1].dependsOn = ['B9']; }],
    ['self-dependency', /Self dependency/, (sum) => { sum.plan[0].dependsOn = ['B1']; }],
    ['cycle', /Cyclic dependencies/, (sum) => { sum.plan[0].dependsOn = ['B2']; sum.plan[1].dependsOn = ['B1']; }],
    ['duplicate-task-id', /duplicate task coverage/, (sum) => { sum.blocks[0].taskIds = ['T001', 'T001']; sum.plan[0].b.tasks[0].sourceIds = ['T001', 'T001']; sum.results.B2 = {status: 'pending', attempts: []}; }],
    ['plan-block-mismatch', /block inventory mismatch/, (sum) => { sum.plan = [sum.plan[0]]; }],
  ];
  for (const [label, expected, mutate] of cases) {
    const workspace = newDir(`resume-${label}`);
    const {file} = ledgerFixture(workspace, 'r1', mutate);
    const before = fs.readFileSync(file, 'utf8');
    const {status, stdout, stderr} = cli(['--resume-run', 'r1'], {workspace, timeout: 25000});
    const dirFiles = fs.readdirSync(path.dirname(file)).sort();
    seen(`plan.ledger.${label}`, `status=${status} stderr=${JSON.stringify(firstLine(stderr))} dirFiles=${JSON.stringify(dirFiles)} unchanged=${fs.readFileSync(file, 'utf8') === before}`);
    assert.equal(status, 1, `坏账本必须 fail-closed（stderr=${firstLine(stderr)}）`);
    assert.match(stderr, /Invalid recovery ledger/);
    assert.match(stderr, expected, '真因必须说明是哪一类账本问题');
    assert.doesNotMatch(stderr, BARE_NODE, '不得回裸 Node 措辞/栈帧');
    assert.equal(stdout.includes('"blocks"'), false);
    assert.equal(fs.readFileSync(file, 'utf8'), before, '校验失败不得改写账本');
    assert.deepEqual(dirFiles, ['summary.json'], '校验失败不得新建任何运行状态/窗口记录');
    fs.rmSync(workspace, {recursive: true, force: true});
  }
});

test('Q7 summary.json 被截断时 --resume-run 必须点名文件，而不是抛裸 SyntaxError', () => {
  const workspace = newDir('resume-truncated');
  const dir = path.join(workspace, 'temp', 'orchestrator', 'runs', 'r1');
  fs.mkdirSync(dir, {recursive: true});
  for (const [label, text] of [['truncated', '{"protocol":2,"runId":"r1"'], ['null', 'null']]) {
    fs.writeFileSync(path.join(dir, 'summary.json'), text, 'utf8');
    const {status, stderr} = cli(['--resume-run', 'r1'], {workspace, timeout: 25000});
    seen(`plan.ledger.${label}`, `status=${status} stderr=${JSON.stringify(firstLine(stderr))}`);
    assert.equal(status, 1);
    assert.match(stderr, /summary\.json/, '真因必须点出被截断/被改坏的账本文件');
    assert.doesNotMatch(stderr, BARE_NODE, '不得把裸 JSON.parse/裸 TypeError 措辞抛给调用方');
  }
  fs.rmSync(workspace, {recursive: true, force: true});
});

// ------------------------------------------------------------ 验收契约文件
function acceptanceFixture(workspace, runId, checks, {binding = true} = {}) {
  const dir = path.join(workspace, 'temp', 'orchestrator', 'runs', runId);
  fs.mkdirSync(dir, {recursive: true});
  const coordinator = path.join(controllerRoot, 'codex-coordinator');
  const contract = path.join(workspace, 'contract.json');
  const tasks = [{id: 'T001', prompt: '写证据'}];
  let digest = 'a'.repeat(64);
  if (typeof checks === 'string') {
    try {
      const parsed = JSON.parse(checks.replace(/^\uFEFF/, ''));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) digest = canonicalDigest(parsed);
    } catch { /* 畸形契约保持假摘要：解析阶段会先失败 */ }
  } else if (checks) {
    digest = canonicalDigest(checks);
  }
  const sum = {
    runId, workspace, coordinator, generation: 1, history: [], finishedAt: Date.now(), success: false,
    tasks, blocks: [{key: 'B1', title: 'b1', taskIds: ['T001']}],
    results: {B1: {status: 'pending', attempts: []}}, taskResults: {T001: {status: 'pending'}},
    ...(binding ? {acceptance: {algorithm: 'sha256', sha256: digest, source: contract, boundAt: Date.now()}} : {}),
  };
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(sum, null, 2), 'utf8');
  if (checks !== undefined) fs.writeFileSync(contract, typeof checks === 'string' ? checks : JSON.stringify(checks), 'utf8');
  return {dir, contract, sum};
}

test('A1-A5 验收契约文件畸形输入（缺失/截断/BOM/数组/字段缺失/错类型）必须 fail-closed 且点名文件与键', () => {
  const cases = [
    ['array-contract', '[{"type":"file","path":"a"}]', /contract\.json/],
    ['per-task-missing-checks', '{"T001":{}}', /T001/],
    ['per-task-string', '{"T001":"nope"}', /T001/],
    ['per-task-checks-not-array', '{"T001":{"checks":"nope"}}', /T001/],
    ['truncated', '{"T001":', /contract\.json/],
    ['empty-file', '', /contract\.json/],
    ['null-contract', 'null', /contract\.json/],
  ];
  for (const [label, text, expected] of cases) {
    const workspace = newDir(`acceptance-${label}`);
    const {contract} = acceptanceFixture(workspace, 'r1', text);
    let error = null;
    try {
      verifyRun(workspace, 'r1', contract);
    } catch (caught) {
      error = caught;
    }
    seen(`acceptance.${label}`, error ? error.message.slice(0, 220) : '(no error)');
    assert.ok(error, `畸形验收契约不得被当成"没有检查"静默通过（input=${JSON.stringify(text).slice(0, 40)}）`);
    assert.match(error.message, expected, '真因必须点名文件/键');
    assert.doesNotMatch(error.message, BARE_NODE, '不得把裸 Node 措辞抛给调用方');
    fs.rmSync(workspace, {recursive: true, force: true});
  }
  // 缺失文件：点名路径
  const workspace = newDir('acceptance-missing');
  const {contract} = acceptanceFixture(workspace, 'r1', undefined);
  let error = null;
  try {
    verifyRun(workspace, 'r1', contract);
  } catch (caught) {
    error = caught;
  }
  seen('acceptance.missing-file', error && error.message.slice(0, 200));
  assert.ok(error);
  assert.match(error.message, /contract\.json/);
  assert.doesNotMatch(error.message, BARE_NODE);
  fs.rmSync(workspace, {recursive: true, force: true});
  // BOM 契约：必须可读（不得因为 BOM 被判成坏契约）
  const bomWorkspace = newDir('acceptance-bom');
  const bom = acceptanceFixture(bomWorkspace, 'r1', '\uFEFF' + JSON.stringify({T001: [{type: 'file', path: 'evidence.txt'}]}));
  fs.writeFileSync(path.join(bomWorkspace, 'evidence.txt'), 'done', 'utf8');
  let bomError = null;
  let bomResult = null;
  try {
    bomResult = verifyRun(bomWorkspace, 'r1', bom.contract, {override: true});
  } catch (caught) {
    bomError = caught;
  }
  seen('acceptance.bom', bomError ? bomError.message.slice(0, 200) : `verified=${bomResult}`);
  assert.equal(bomError, null, '带 BOM 的验收契约必须能读（BOM 是编码噪声，不是内容错误）');
  assert.equal(bomResult, false, 'T001 没有完成检查点，必须停在未验收而不是判成功');
  fs.rmSync(bomWorkspace, {recursive: true, force: true});
});

test('A6 契约被换成削弱版（摘要不匹配）必须拒绝，且真因给出摘要前缀', () => {
  const workspace = newDir('acceptance-digest');
  const {contract, dir} = acceptanceFixture(workspace, 'r1', {T001: [{type: 'file', path: 'evidence.txt'}]});
  fs.writeFileSync(path.join(workspace, 'evidence.txt'), 'done', 'utf8');
  const summary = JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8'));
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    runId: 'r1', workspace, acceptance: summary.acceptance,
  }), 'utf8');
  verifyRun(workspace, 'r1', contract,{override:true});       // Explicitly adopt a historical ledger without controller authority.
  fs.writeFileSync(contract, JSON.stringify({T001: []}), 'utf8'); // 执行窗把契约换成空检查
  let error = null;
  try {
    verifyRun(workspace, 'r1', contract);
  } catch (caught) {
    error = caught;
  }
  seen('acceptance.weakened', error ? error.message.slice(0, 240) : '(no error)');
  assert.ok(error, '被换过的契约必须拒绝（否则执行窗可以自降验收条件）');
  assert.match(error.message, /Acceptance (contract changed|binding records disagree or are incomplete)/);
  assert.match(error.message, new RegExp(summary.acceptance.sha256.slice(0, 12)));
  fs.rmSync(workspace, {recursive: true, force: true});
});

// ------------------------------------------------------------------ 单元命令
test('U1-U9 单元命令/验收检查的畸形输入：命令类必须 fail-closed 且真因可读', () => {
  const workspace = newDir('unit-cmd 中文 &');
  const spaced = path.join(workspace, 'dir with spaces');
  const chinese = path.join(workspace, '中文 目录');
  fs.mkdirSync(spaced, {recursive: true});
  fs.mkdirSync(chinese, {recursive: true});
  const tool = (dir, name) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, "console.log('ok');\n", 'utf8');
    return file;
  };
  const spacedTool = tool(spaced, 'tool.mjs');
  const chineseTool = tool(chinese, '工具.mjs');
  const plainTool = tool(workspace, 'plain.mjs');
  const exitTool = path.join(workspace, 'exit-3.mjs');
  const timeoutTool = path.join(workspace, 'timeout.mjs');
  fs.writeFileSync(exitTool, 'process.exit(3);\n', 'utf8');
  fs.writeFileSync(timeoutTool, 'setTimeout(()=>{},60000);\n', 'utf8');
  const uncWorkspace = '\\\\localhost\\' + workspace[0].toLowerCase() + '$' + workspace.slice(2);
  fs.writeFileSync(path.join(workspace, 'shim.cmd'), '@echo off\r\nexit /b 0\r\n', 'utf8');
  const cases = [
    ['workspace-command', [{type: 'command', command: process.execPath, args: [plainTool]}], /Workspace command acceptance is disabled/],
    ['workspace-command-with-loader', [{type: 'command', command: process.execPath, args: ['--loader', plainTool]}], /Workspace command acceptance is disabled/],
    ['non-object-check', [null], /Acceptance check/],
    ['json-equals-not-object', [{type: 'json', path: 'shape.json', equals: 'nope'}], /equals/],
  ];
  fs.writeFileSync(path.join(workspace, 'shape.json'), JSON.stringify({a: 1}), 'utf8');
  const previousCommandPolicy=process.env.ORCH_ALLOW_ACCEPTANCE_COMMANDS;
  process.env.ORCH_ALLOW_ACCEPTANCE_COMMANDS='1';
  try {
    const command=verifyChecks([{type:'command',command:process.execPath,args:[plainTool]}],workspace);
    assert.equal(command.status,'failed');
    assert.match(String(command.reason),/Workspace command acceptance is disabled/i);
  } finally { if(previousCommandPolicy===undefined)delete process.env.ORCH_ALLOW_ACCEPTANCE_COMMANDS;else process.env.ORCH_ALLOW_ACCEPTANCE_COMMANDS=previousCommandPolicy; }
  const negatives = [
    ['hash-mismatch', [{type: 'file', path: 'shape.json', sha256: 'b'.repeat(64)}], /Hash mismatch/],
    ['missing-file', [{type: 'file', path: 'nope.txt'}], /Acceptance file missing/],
    ['bad-json', [{type: 'json', path: 'plain.mjs', equals: {a: 1}}], /Acceptance JSON parse failed/],
    ['unsupported-type', [{type: 'wat', path: 'shape.json'}], /Unsupported acceptance check/],
    ['absent-violated', [{type: 'absent', path: 'shape.json'}], /Acceptance absent check failed: .*still exists/],
    ['path-escape', [{type: 'file', path: path.join(workspace, '..', 'outside.txt')}], /escapes the initiating workspace/],
  ];
  for (const [label, checks, expected] of negatives) {
    const result = verifyChecks(checks, workspace);
    seen(`unit.${label}`, `${result.status} ${String(result.reason || '')}`);
    assert.equal(result.status, 'failed');
    assert.match(String(result.reason), expected);
    assert.doesNotMatch(String(result.reason), BARE_NODE);
  }
  fs.rmSync(workspace, {recursive: true, force: true});
});

test('U10 验收检查里的超长路径/不存在目录必须给出可读真因，不得裸崩', () => {
  const workspace = newDir('unit-huge');
  const deep = path.join(workspace, ...Array.from({length: 12}, (_, i) => `segment-${i}-` + 'y'.repeat(24)));
  const checks = [
    {type: 'file', path: path.join(deep, 'missing.txt')},
    {type: 'command', command: process.execPath, args: [path.join(deep, 'missing.mjs')]},
  ];
  for (const check of checks) {
    const result = verifyChecks([check], workspace);
    seen(`unit.deep-path.${check.type}`, `${result.status} ${String(result.reason || '').slice(0, 180)}`);
    assert.equal(result.status, 'failed');
    assert.ok(result.reason && result.reason.length > 10, '真因必须能读懂（点名路径）');
    assert.doesNotMatch(String(result.reason), BARE_NODE);
  }
  fs.rmSync(workspace, {recursive: true, force: true});
});

// -------------------------------------------------------------- 账本读取入口
test('E1 公开入口任何失败只回一行 FATAL（默认零 Node 栈帧），ORCH_DEBUG=1 才附栈', () => {
  const workspace = newDir('entry-fatal');
  try {
    const failure = cli(['--nope'], {workspace, env: {ORCH_DEBUG: '0'}});
    seen('entry.fatal', `status=${failure.status} stderr=${JSON.stringify(failure.stderr)}`);
    assert.equal(failure.status, 1, '失败必须给出非 0 退出码');
    assert.equal(String(failure.stderr).trim(), '[orchestrator] FATAL: Unknown mode: --nope', '默认必须只回一行可读真因');
    assert.doesNotMatch(String(failure.stderr), /\n\s+at /, '默认不得把 Node 栈帧丢给调用方');
    const debug = cli(['--nope'], {workspace, env: {ORCH_DEBUG: '1'}});
    seen('entry.fatal.debug', `status=${debug.status} hasStack=${/\n\s+at /.test(String(debug.stderr))}`);
    assert.equal(debug.status, 1);
    assert.match(String(debug.stderr), /\n\s+at /, 'ORCH_DEBUG=1 时必须附栈，排障才不用改代码');
  } finally {
    fs.rmSync(workspace, {recursive: true, force: true});
  }
});

test('S9 verifyRun 读被改坏的 summary.json 必须点名文件；缺文件仍保持 ENOENT 语义', () => {
  const workspace = newDir('verify-ledger');
  const dir = path.join(workspace, 'temp', 'orchestrator', 'runs', 'r1');
  fs.mkdirSync(dir, {recursive: true});
  const file = path.join(dir, 'summary.json');
  for (const [label, text] of [['truncated', '{"runId":"r1"'], ['null', 'null']]) {
    fs.writeFileSync(file, text, 'utf8');
    let error = null;
    try {
      verifyRun(workspace, 'r1');
    } catch (caught) {
      error = caught;
    }
    seen(`verify.${label}`, error && `${error.constructor.name}: ${error.message.slice(0, 160)}`);
    assert.ok(error, '坏账本不得被当成可验收');
    assert.match(error.message, /summary\.json/, '真因必须点名账本文件');
    assert.doesNotMatch(error.message, BARE_NODE, '不得回裸 Node 措辞');
  }
  fs.rmSync(file, {force: true});
  let missing = null;
  try {
    verifyRun(workspace, 'r1');
  } catch (caught) {
    missing = caught;
  }
  seen('verify.missing', missing && `${missing.code} ${missing.message.slice(0, 120)}`);
  assert.equal(missing?.code, 'ENOENT', '账本不存在时保留原始 ENOENT（既有调用方按 code 判定）');
  fs.rmSync(workspace, {recursive: true, force: true});
});
