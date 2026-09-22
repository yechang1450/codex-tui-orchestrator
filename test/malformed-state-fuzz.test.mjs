import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {transaction, atomicJson, reserve, release, claimRun, releaseRun} from '../scripts/core/leases.mjs';
import {readRunStatus, readEvents, createStatusPublisher} from '../scripts/core/status-events.mjs';
import {keysOverlap} from '../scripts/core/contracts.mjs';

// 审计线 C 的畸形输入判据（状态文件 / 路径 fuzz）。
// 基线：绝不把裸 Node 栈帧/内部措辞抛给调用方；绝不静默成功；绝不留下锁死的租约、孤儿进程或一次性残留。
// 每个用例都把实测值打进日志（[fuzz] 前缀），便于 report.md 逐条引用三联证据。
const family = fileURLToPath(new URL('../temp/', import.meta.url));
fs.mkdirSync(family, {recursive: true});
const newDir = (label) => fs.mkdtempSync(path.join(family, `fuzz-${label}-`));
const seen = (name, value) => console.log(`[fuzz] ${name} :: ${value}`);
const quote = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const runDirOf = (workspace, runId) => path.join(workspace, 'temp', 'orchestrator', 'runs', runId);
// 每个"真事务"都会拉起一个 PowerShell 互斥子进程（内部按 100ms 轮询 WMI 确认持有者还活着）；
// 几十次就能把整机的 CIM/WMI 拖到超时。只关心状态文件语义的用例显式注入固定进程表，
// 需要覆盖真实互斥握手（长路径/短名/UNC/只读/被独占）的用例仍走真路径。
const liveSelf = () => new Map([[process.pid, {ProcessId: process.pid, ParentProcessId: 0, Name: 'node.exe', CommandLine: 'fuzz-runner', Started: 'fuzz'}]]);
// 机器繁忙时真握手可能被 WMI 拖垮（"Cannot verify process identities"）：有界重试一次，
// 并把两次实测都记进日志；真缺陷（握手本身坏）会确定性失败，重试救不回来。
async function attempt(label, times, fn) {
  let last = null;
  for (let i = 1; i <= times; i++) {
    try {
      return {ok: true, value: fn()};
    } catch (error) {
      last = error;
      seen(`${label}.attempt${i}`, String(error && error.message).slice(0, 160));
      await pause(400);
    }
  }
  return {ok: false, error: last};
}

// ---------------------------------------------------------------- leases.json
test('L1-L6 畸形 leases.json（截断/非数组/null/空文件）隔离 + 一次性 fail-closed，BOM 与 CRLF 必须可读', () => {
  for (const [label, text] of [['truncated', '[{"id":"dead"'], ['object', '{"id":"dead"}'], ['null', 'null'], ['empty', '']]) {
    const dir = newDir(`leases-${label}`);
    const file = path.join(dir, 'leases.json');
    fs.writeFileSync(file, text, 'utf8');
    // 第一次事务：必须显式失败（畸形状态不能当空表静默放行，否则容量/冲突闸门被绕过）。
    let error = null;
    try {
      transaction(dir, () => { throw new Error('事务体不得在畸形账本上执行'); }, liveSelf);
    } catch (caught) {
      error = caught;
    }
    const quarantined = fs.readdirSync(dir).filter((name) => /^leases\.json\.corrupt-\d+$/.test(name));
    seen(`leases.${label}.reject`, `input=${JSON.stringify(text)} error=${error && error.message.slice(0, 150)} quarantined=${JSON.stringify(quarantined)}`);
    assert.ok(error, `畸形 leases.json 必须 fail-closed（input=${JSON.stringify(text)}）`);
    assert.match(error.message, /协调器租约表/, '真因必须说明是哪个账本');
    assert.equal(quarantined.length, 1, '坏文件必须被隔离而不是留在原位（否则每次事务都重复失败）');
    assert.equal(fs.readFileSync(path.join(dir, quarantined[0]), 'utf8'), text, '隔离件必须原样保留原始字节，不销毁证据');
    // 第二次事务：坏文件已被摘走，工作区必须自愈，不能被一条毒记录永久锁死。
    let ran = false;
    transaction(dir, (leases) => {
      ran = true;
      leases.push({id: 'probe', owner: {ProcessId: process.pid}, reservedAt: Date.now()});
    }, liveSelf);
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    seen(`leases.${label}.recover`, `ran=${ran} after=${JSON.stringify(after.map((l) => l.id))}`);
    assert.equal(ran, true, '隔离之后任务必须能重新跑起来（自愈，不许永久锁死）');
    assert.deepEqual(after.map((l) => l.id), ['probe'], '事务必须正常落盘');
    fs.rmSync(dir, {recursive: true, force: true});
  }
  // BOM / CRLF：编码噪声不得让整份租约表失效（同仓库其它 JSON 读取处都显式剥 BOM）。
  for (const [label, write] of [
    ['bom', (text) => '\uFEFF' + text],
    ['crlf', (text) => text.replaceAll('\n', '\r\n')],
  ]) {
    const dir = newDir(`leases-${label}`);
    const file = path.join(dir, 'leases.json');
    fs.writeFileSync(file, write(JSON.stringify([{id: 'live', keys: ['dir:a'], owner: {ProcessId: process.pid}, reservedAt: Date.now()}], null, 2)), 'utf8');
    let ids = null;
    transaction(dir, (leases) => { ids = leases.map((l) => l.id); }, liveSelf);
    seen(`leases.${label}`, `kept=${JSON.stringify(ids)} quarantine=${fs.readdirSync(dir).filter((n) => n.includes('corrupt')).length}`);
    assert.deepEqual(ids, ['live'], `合法租约表不得因为 ${label} 而被当成坏文件`);
    assert.equal(fs.readdirSync(dir).some((n) => n.includes('corrupt')), false, '合法租约表不得被隔离');
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('L7 无 owner / reservedAt 为字符串或负数 / 非对象条目：新鲜兜底保留、过期与非对象剪掉', () => {
  const dir = newDir('leases-ownerless');
  const now = Date.now();
  fs.writeFileSync(path.join(dir, 'leases.json'), JSON.stringify([
    null,
    42,
    'not-an-object',
    {id: 'fresh-no-owner', keys: ['dir:a'], reservedAt: now},
    {id: 'stale-no-owner', keys: ['dir:b'], reservedAt: now - 120000},
    {id: 'string-reserved', keys: ['dir:c'], owner: {ProcessId: 1}, reservedAt: 'not-a-number'},
    {id: 'negative-reserved', keys: ['dir:d'], owner: {ProcessId: 1}, reservedAt: -1},
    {id: 'live', keys: ['dir:e'], owner: {ProcessId: process.pid}, reservedAt: now},
  ]), 'utf8');
  let ids = null;
  transaction(dir, (leases) => { ids = leases.map((l) => l && l.id); }, liveSelf);
  seen('leases.ownerless', `kept=${JSON.stringify(ids)}`);
  assert.deepEqual(ids, ['fresh-no-owner', 'live'], '只看"是否还新鲜/进程是否还活着"，绝不在这里解引用 undefined');
  fs.rmSync(dir, {recursive: true, force: true});
});

test('L8 重复 id 的租约条目必须去重：容量不得被重复计数、块不得被永久挡在门外', () => {
  const dir = newDir('leases-dup');
  const now = Date.now();
  fs.writeFileSync(path.join(dir, 'leases.json'), JSON.stringify([
    {id: 'dup', keys: ['dir:a'], owner: {ProcessId: process.pid}, reservedAt: now - 5000, capacity: 2},
    {id: 'dup', keys: ['dir:a'], owner: {ProcessId: process.pid}, reservedAt: now, capacity: 2},
  ]), 'utf8');
  const result = reserve(dir, {id: 'other', keys: ['dir:b']}, 2, liveSelf);
  const after = JSON.parse(fs.readFileSync(path.join(dir, 'leases.json'), 'utf8'));
  seen('leases.dup', `reserve=${JSON.stringify(result)} entries=${JSON.stringify(after.map((l) => [l.id, l.reservedAt]))}`);
  assert.deepEqual(result, {ok: true}, '两条同 id 的重复条目只占一个真实名额，另一个块必须能预约');
  assert.equal(after.filter((l) => l.id === 'dup').length, 1, '重复 id 必须收敛成一条');
  assert.equal(after.find((l) => l.id === 'dup').reservedAt, now, '保留较新的那条（旧记录才是被覆盖的）');
  fs.rmSync(dir, {recursive: true, force: true});
});

test('L9 只读 leases.json：fail-closed 且真因可读、无临时残留、锁不锁死', () => {
  const dir = newDir('leases-readonly');
  const file = path.join(dir, 'leases.json');
  atomicJson(file, []);
  fs.chmodSync(file, 0o444);
  const started = Date.now();
  let error = null;
  try {
    transaction(dir, (leases) => leases.push({id: 'ro'}));
  } catch (caught) {
    error = caught;
  }
  const elapsed = Date.now() - started;
  seen('leases.readonly', `error=${error && error.code + ' ' + error.message.slice(0, 120)} elapsedMs=${elapsed} tmp=${JSON.stringify(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')))}`);
  assert.ok(error, '只读租约表必须显式失败（不得静默成功）');
  assert.match(error.message, /leases\.json/, '真因必须点出是哪个文件');
  assert.ok(elapsed < 30000, `失败必须在有界时间内给出（实测 ${elapsed}ms）`);
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), [], '失败不得留下临时文件');
  fs.chmodSync(file, 0o666);
  let recovered = null;
  transaction(dir, (leases) => { recovered = leases.length; });
  seen('leases.readonly.recovery', `entries=${recovered}`);
  assert.notEqual(recovered, null, '前一次失败不得把协调器互斥锁锁死');
  fs.rmSync(dir, {recursive: true, force: true});
});

test('L10 被另一个进程独占的 leases.json：fail-closed、真因可读、无残留', {skip: process.platform !== 'win32'}, async () => {
  const dir = newDir('leases-locked');
  const file = path.join(dir, 'leases.json');
  const ready = path.join(dir, 'holder.ready');
  fs.writeFileSync(file, '[]', 'utf8');
  const script = `$s=[IO.File]::Open(${quote(file)},[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None);try{[IO.File]::WriteAllText(${quote(ready)},'ready');Start-Sleep -Milliseconds 12000}finally{$s.Dispose()}`;
  const holder = spawn('powershell.exe', ['-NoProfile', '-Command', script], {windowsHide: true, stdio: 'ignore'});
  try {
    const deadline = Date.now() + 15000;
    while (!fs.existsSync(ready) && Date.now() < deadline) await pause(25);
    assert.ok(fs.existsSync(ready), '锁持有者未能就绪');
    let error = null;
    try {
      transaction(dir, (leases) => leases.push({id: 'locked'}));
    } catch (caught) {
      error = caught;
    }
    seen('leases.locked', `error=${error && error.code + ' ' + error.message.slice(0, 140)}`);
    assert.ok(error, '被独占的租约表必须显式失败');
    assert.match(error.message, /leases\.json/, '真因必须点出是哪个文件');
    assert.doesNotMatch(error.message, /Cannot read properties|is not a function/, '不得回裸 Node 内部措辞');
  } finally {
    holder.kill();
    await pause(200);
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

// ---------------------------------------------- run-owners.json（运行占用账本）
test('L11 run-owners.json 中途被删或被写坏：释放必须幂等，占用必须自愈', () => {
  for (const [label, damage] of [
    ['deleted', (file) => fs.rmSync(file, {force: true})],
    ['corrupt', (file) => fs.writeFileSync(file, '{"run:r1":', 'utf8')],
    ['null', (file) => fs.writeFileSync(file, 'null', 'utf8')],
  ]) {
    const dir = newDir(`owners-${label}`);
    const file = path.join(dir, 'run-owners.json');
    const claim = claimRun(dir, 'run:r1');
    damage(file);
    let error = null;
    try {
      releaseRun(dir, 'run:r1', claim);
    } catch (caught) {
      error = caught;
    }
    // 释放必须幂等：runWindows 的 finally 会调它，抛错会把"已经成功的一轮"改判成失败。
    seen(`owners.${label}.release`, error ? `${error.constructor.name}: ${error.message.slice(0, 120)}` : 'ok');
    assert.equal(error, null, `释放占用不得因为账本被${label}而抛错`);
    const again = claimRun(dir, 'run:r1');
    assert.ok(again && again.token, '被破坏的运行占用账本必须自愈，否则这一轮永远起不来');
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    seen(`owners.${label}.reclaim`, `keys=${JSON.stringify(Object.keys(state))} token=${String(again.token).slice(0, 8)}`);
    assert.deepEqual(Object.keys(state), ['run:r1']);
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

// ------------------------------------------------- summary.json / events.jsonl
test('S1/S2 损坏的 summary.json（截断/null/数组/字符串）必须给出点名文件的可读真因', () => {
  const workspace = newDir('summary');
  const dir = runDirOf(workspace, 'r1');
  fs.mkdirSync(dir, {recursive: true});
  for (const [label, text] of [['truncated', '{"runId":"r1"'], ['null', 'null'], ['array', '[]'], ['string', '"r1"'], ['number', '7'], ['bom', '\uFEFF{"runId":"r1"}']]) {
    fs.writeFileSync(path.join(dir, 'summary.json'), text, 'utf8');
    let error = null;
    let state = null;
    try {
      state = readRunStatus(workspace, 'r1');
    } catch (caught) {
      error = caught;
    }
    seen(`summary.${label}`, error ? `${error.constructor.name}: ${error.message}` : `state=${JSON.stringify(state)}`);
    assert.ok(error, `坏账本 ${label} 不得被当成正常状态读出去（否则调用方会拿到半份状态）`);
    assert.match(error.message, /summary\.json/, '真因必须点出是哪个文件');
    assert.doesNotMatch(error.message, /Cannot read properties|is not a function|Unexpected token|Unexpected end of JSON input|Unexpected number/, '不得把裸 Node 内部措辞抛给调用方');
  }
  fs.rmSync(workspace, {recursive: true, force: true});
});

test('S3 summary.json 被删（同目录还有 manifest.json）必须回落到 manifest，而不是崩', () => {
  const workspace = newDir('summary-missing');
  const dir = runDirOf(workspace, 'r1');
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    runId: 'r1', workspace, request: '写证据', executionMode: 'headless',
    tasks: [{id: 'T001', prompt: '写证据'}], todoList: [{id: 'T001', prompt: '写证据', status: 'pending', block: null}],
    startedAt: Date.now(),
  }), 'utf8');
  const state = readRunStatus(workspace, 'r1');
  seen('summary.missing', `runId=${state.runId} todoList=${JSON.stringify(state.todoList)}`);
  assert.equal(state.runId, 'r1');
  assert.deepEqual(state.todoList.map((t) => t.status), ['pending']);
  fs.rmSync(workspace, {recursive: true, force: true});
});

test('S4 summary.json 与 manifest.json 都被删：必须报出 run 目录下的文件路径', () => {
  const workspace = newDir('summary-gone');
  const dir = runDirOf(workspace, 'r1');
  fs.mkdirSync(dir, {recursive: true});
  let error = null;
  try {
    readRunStatus(workspace, 'r1');
  } catch (caught) {
    error = caught;
  }
  seen('summary.gone', error && `${error.code} ${error.message.slice(0, 160)}`);
  assert.ok(error, '两份账本都没有时必须显式失败');
  assert.match(error.message, /summary\.json|manifest\.json/);
  assert.match(error.message, /r1/, '真因必须能定位到具体 run');
  fs.rmSync(workspace, {recursive: true, force: true});
});

test('S5 events.jsonl 的非法行/序号错乱必须点名文件与行号（尾部半行除外）', () => {
  const dir = newDir('events-invalid');
  const file = path.join(dir, 'events.jsonl');
  const good = JSON.stringify({schema: 1, seq: 1, runId: 'r1', type: 'plan.created'});
  const cases = [
    ['invalid-json', `${good}\n{"schema":1,\n`],
    ['bad-sequence', `${good}\n${JSON.stringify({schema: 1, seq: 1, runId: 'r1', type: 'again'})}\n`],
    ['identity-mismatch', `${good}\n${JSON.stringify({schema: 1, seq: 2, runId: 'r2', type: 'x'})}\n`],
  ];
  for (const [label, text] of cases) {
    fs.writeFileSync(file, text, 'utf8');
    let error = null;
    try {
      readEvents(dir);
    } catch (caught) {
      error = caught;
    }
    seen(`events.${label}`, error ? error.message : '(no error)');
    assert.ok(error, `坏事件流 ${label} 不得被静默当成空流`);
    assert.match(error.message, /events\.jsonl/, '真因必须点名事件文件');
    assert.match(error.message, /:\d+/, '真因必须给出行号，便于定位是哪一条');
    assert.doesNotMatch(error.message, /Unexpected|is not a function|Cannot read properties/, '不得回裸 Node 内部措辞');
  }
  // 尾部半行（没有换行收尾）是崩溃残留：读侧只看完整行，发布器随后裁掉它（见 S6-S8）。
  fs.writeFileSync(file, `${good}\n{"schema":1,"seq":2`, 'utf8');
  const partial = readEvents(dir);
  seen('events.partial-tail', `events=${partial.length}`);
  assert.equal(partial.length, 1, '尾部半行必须被忽略，而不是让整份事件流不可读');
  fs.rmSync(dir, {recursive: true, force: true});
});

test('S6-S8 events.jsonl 尾部半行 / 中途被删 / summary 被删：发布器必须自愈且序号不倒退', () => {
  const workspace = newDir('events-selfheal');
  const dir = runDirOf(workspace, 'r1');
  fs.mkdirSync(dir, {recursive: true});
  const file = path.join(dir, 'events.jsonl');
  fs.writeFileSync(file, JSON.stringify({schema: 1, seq: 1, runId: 'r1', type: 'plan.created'}) + '\n{"schema":1,"seq":2', 'utf8');
  const sum = {
    runId: 'r1', workspace, generation: 1, eventSeq: 1, request: '写证据',
    tasks: [{id: 'T001', prompt: '写证据'}],
    blocks: [{key: 'B1', title: 'b1', taskIds: ['T001']}],
    results: {B1: {status: 'running', attempts: []}}, taskResults: {T001: {status: 'running'}},
  };
  const publisher = createStatusPublisher(dir);
  const first = publisher.publish(sum, 'run.updated');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  seen('events.truncated-tail', `published=${first.seq} lines=${JSON.stringify(lines.map((l) => l.seq))}`);
  assert.deepEqual(lines.map((l) => l.seq), [1, 2], '尾部半行必须被裁掉，不能把半截 JSON 留在账本里');
  fs.rmSync(file, {force: true});
  const second = publisher.publish(sum, 'block.B1.verified');
  seen('events.deleted', `published=${second.seq} exists=${fs.existsSync(file)}`);
  assert.equal(second.seq, 3, '事件文件被删后序号必须从账本继续，不得倒退');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8').trim().split('\n').at(-1)).seq, 3);
  fs.rmSync(path.join(dir, 'summary.json'), {force: true});
  const third = publisher.publish(sum, 'run.completed');
  const reread = readRunStatus(workspace, 'r1');
  seen('summary.deleted-midrun', `published=${third.seq} reread.runId=${reread.runId} todo=${JSON.stringify(reread.todoList)}`);
  assert.equal(third.seq, 4);
  assert.equal(reread.runId, 'r1', 'summary 被删后发布必须把它重新落盘');
  fs.rmSync(workspace, {recursive: true, force: true});
});

// -------------------------------------------------------------------- 路径 fuzz
test('F1 状态目录含空格/中文/&/#：预约、释放与运行占用全部可用', () => {
  const dir = newDir('state 中文 & #');
  const reservation = reserve(dir, {id: 'r-1', keys: ['dir:a']}, 2);
  const claim = claimRun(dir, 'run:r1');
  release(dir, 'r-1');
  releaseRun(dir, 'run:r1', claim);
  const left = JSON.parse(fs.readFileSync(path.join(dir, 'leases.json'), 'utf8'));
  seen('paths.special-chars', `reserve=${JSON.stringify(reservation)} left=${left.length} dir=${dir}`);
  assert.deepEqual(reservation, {ok: true});
  assert.deepEqual(left, []);
  fs.rmSync(dir, {recursive: true, force: true});
});

test('F2 状态目录超过 260 字符：协调器事务仍然可用（Windows 长路径）', {skip: process.platform !== 'win32'}, async () => {
  let dir = path.join(family, 'fuzz-longpath');
  while (dir.length < 280) dir = path.join(dir, 'segment-pad-' + 'x'.repeat(24));
  fs.mkdirSync(dir, {recursive: true});
  let error = null;
  let entries = null;
  const outcome = await attempt('paths.long', 2, () => {
    reserve(dir, {id: 'long', keys: ['dir:a']}, 2);
    transaction(dir, (leases) => { entries = leases.length; });
    return true;
  });
  if (!outcome.ok) error = outcome.error;
  seen('paths.long', `len=${dir.length} error=${error && error.message} entries=${entries}`);
  assert.equal(error, null, `长路径状态目录不得让事务失败（实测 ${error && error.message}）`);
  assert.equal(entries, 1);
  fs.rmSync(path.join(family, 'fuzz-longpath'), {recursive: true, force: true});
});

test('F3 状态目录末尾带点：协调器事务仍然可用', async () => {
  const dir = path.join(newDir('dotted'), 'state.');
  fs.mkdirSync(dir, {recursive: true});
  let error = null;
  let entries = null;
  const outcome = await attempt('paths.trailing-dot', 2, () => {
    transaction(dir, (leases) => { leases.push({id: 'dot', owner: {ProcessId: process.pid}, reservedAt: Date.now()}); entries = leases.length; });
    return true;
  });
  if (!outcome.ok) error = outcome.error;
  seen('paths.trailing-dot', `error=${error && error.message} entries=${entries}`);
  assert.equal(error, null, `末尾带点的状态目录不得让事务失败（实测 ${error && error.message}）`);
  assert.equal(entries, 1);
  fs.rmSync(path.dirname(dir), {recursive: true, force: true});
});

test('F4 8.3 短名与长名必须归一到同一个冲突键，且短名状态下事务可用', {skip: process.platform !== 'win32'}, async (t) => {
  const dir = newDir('shortname-directory');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command',
    `$fso=New-Object -ComObject Scripting.FileSystemObject;$fso.GetFolder(${quote(dir)}).ShortPath`], {encoding: 'utf8', windowsHide: true});
  const short = String(result.stdout || '').trim();
  if (!short || short.toLowerCase() === dir.toLowerCase()) {
    t.skip('此卷未启用 8.3 短名');
    fs.rmSync(dir, {recursive: true, force: true});
    return;
  }
  let error = null;
  const outcome = await attempt('paths.8.3', 2, () => {
    transaction(short, (leases) => leases.push({id: 'short', owner: {ProcessId: process.pid}, reservedAt: Date.now()}));
    return true;
  });
  if (!outcome.ok) error = outcome.error;
  const overlap = keysOverlap([`dir:${short}`], [`dir:${dir}`]);
  seen('paths.8.3', `short=${short} overlap=${overlap} error=${error && error.message}`);
  assert.equal(overlap, true, '同一目录的短名/长名必须算同一个冲突键，否则两块会并行写同一目录');
  assert.equal(error, null, '通过 8.3 短名访问状态目录不得让事务失败');
  assert.equal(fs.readFileSync(path.join(dir, 'leases.json'), 'utf8').includes('short'), true, '短名与长名必须落到同一份账本');
  fs.rmSync(dir, {recursive: true, force: true});
});

test('F5 UNC 路径（\\\\localhost\\C$\\…）作为状态目录：事务与原子写都可用', {skip: process.platform !== 'win32'}, async (t) => {
  const dir = newDir('unc-share');
  const unc = '\\\\localhost\\' + dir[0].toLowerCase() + '$' + dir.slice(2);
  try {
    fs.readdirSync(unc);
  } catch {
    t.skip('本机不可通过 UNC 访问该目录');
    fs.rmSync(dir, {recursive: true, force: true});
    return;
  }
  let error = null;
  const outcome = await attempt('paths.unc', 2, () => {
    atomicJson(path.join(unc, 'leases.json'), []);
    transaction(unc, (leases) => leases.push({id: 'unc', owner: {ProcessId: process.pid}, reservedAt: Date.now()}));
    return true;
  });
  if (!outcome.ok) error = outcome.error;
  seen('paths.unc', `unc=${unc} error=${error && error.message}`);
  assert.equal(error, null, 'UNC 状态目录不得让事务失败');
  assert.equal(fs.readFileSync(path.join(dir, 'leases.json'), 'utf8').includes('unc'), true);
  fs.rmSync(dir, {recursive: true, force: true});
});

test('F6 工作区含空格/中文/&/#：run 目录与状态发布器可用', () => {
  const workspace = newDir('workspace 中文 & #');
  const dir = runDirOf(workspace, 'run-1');
  fs.mkdirSync(dir, {recursive: true});
  const sum = {
    runId: 'run-1', workspace, generation: 1, request: '写证据',
    tasks: [{id: 'T001', prompt: '写证据'}],
    blocks: [{key: 'B1', title: 'b1', taskIds: ['T001']}],
    results: {B1: {status: 'pending', attempts: []}}, taskResults: {T001: {status: 'pending'}},
  };
  const publisher = createStatusPublisher(dir);
  const event = publisher.publish(sum, 'plan.created');
  const state = readRunStatus(workspace, 'run-1');
  seen('paths.workspace', `seq=${event.seq} blocks=${state.executionStatus.length} dir=${dir}`);
  assert.equal(event.seq, 1);
  assert.equal(state.executionStatus[0].block, 'B1');
  fs.rmSync(workspace, {recursive: true, force: true});
});
