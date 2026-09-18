// Opt-in real power-loss acceptance: run two blocks, hard-kill the controller tree mid-run
// (controller + window + worker), then resume the same run identity with --resume-run.
// Requires: a completed non-repeatable task must NOT run twice, an interrupted task may only
// continue when the acceptance declares retrySafe, and the resumed run must reach verified.
// Usage (Windows shell, from the initiating workspace):
//   node <repo>/test/live-powerloss.mjs
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {verifyRelease} from '../scripts/release-integrity.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspace = process.cwd();
verifyRelease(repo);
const nonce = crypto.randomUUID();
const root = path.join(workspace, 'temp', 'powerloss-' + nonce.slice(0, 12));
fs.rmSync(root, {recursive: true, force: true});
const p1 = path.join(root, 'project-91'), p2 = path.join(root, 'project-92');
fs.mkdirSync(p1, {recursive: true});
fs.mkdirSync(p2, {recursive: true});

// T001: non-repeatable side effect — the counter file may only ever read 1.
fs.writeFileSync(path.join(p1, 'inc.mjs'), `import fs from 'node:fs';import path from 'node:path';
const f = path.join(process.cwd(), 'counter.json');
const n = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')).count : 0;
fs.writeFileSync(f, JSON.stringify({count: n + 1, nonce: ${JSON.stringify(nonce)}}));
console.log('count=' + (n + 1));`);
// T002: long enough to be interrupted after T001 has been verified.
fs.writeFileSync(path.join(p2, 'slow.mjs'), `import fs from 'node:fs';import path from 'node:path';
await new Promise(r => setTimeout(r, 90000));
fs.writeFileSync(path.join(process.cwd(), 'slow.json'), JSON.stringify({done: true, nonce: ${JSON.stringify(nonce)}}));
console.log('slow done');`);

const runId = 'powerloss-' + nonce;
const acceptance = path.join(root, 'acceptance.json');
fs.writeFileSync(acceptance, JSON.stringify({
  T001: {checks: [{type: 'json', path: path.join(p1, 'counter.json'), equals: {count: 1, nonce}}]},
  T002: {retrySafe: true, checks: [{type: 'json', path: path.join(p2, 'slow.json'), equals: {done: true, nonce}}]},
}, null, 2));
const request = [[91, p1, 'inc.mjs', 'counter.json'], [92, p2, 'slow.mjs', 'slow.json']]
  .map(([id, dir, file, out]) => `项目${id}：执行 node "${path.join(dir, file)}" 创建 ${out}，执行工具的工作目录必须为 "${dir}"，等待命令完成后读回结果，核验 nonce="${nonce}"、cwd="${dir}"。按主持提供的命令逐项记录 started 和 completed 检查点，禁止另开窗口、提交、读写记忆`)
  .join('；');

const env = {...process.env, ORCH_AGENT: 'codex', ORCH_RUN_ID: runId, ORCH_ACCEPTANCE_FILE: acceptance, ORCH_MAX_POLL_MS: '600000'};
for (const key of ['WORKSPACE_DIR', 'ORCH_STATE_DIR', 'ORCH_TUI', 'ORCH_SANDBOX', 'ORCH_APPROVAL', 'ORCH_EXEC_MODE']) delete env[key];
const entry = path.join(repo, 'scripts', 'orchestrate-sdk.mjs');
// 运行账本属于发起工作区的 temp/orchestrator，而不是本用例自己的 root 目录。
const summaryFile = path.join(workspace, 'temp', 'orchestrator', 'runs', runId, 'summary.json');
const read = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; } };
const status = id => read(summaryFile)?.taskResults?.[id]?.status;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

const controller = spawn(process.execPath, [entry, '--exec', request], {cwd: workspace, env, windowsHide: true, detached: true, stdio: 'ignore'});
controller.unref();
// 断电时机：T001 的检查点已 completed，且 T002 的检查点为 started（正在那 90 秒任务里）。
// 注意不能等 taskResults 的 verified —— 那是整块独立验收之后的状态，那时运行已经结束。
const taskState = id => read(summaryFile)?.taskResults?.[id];
const checkpoint = id => taskState(id)?.checkpoint?.state;
const startedTask = id => checkpoint(id) === 'started' || taskState(id)?.status === 'running';
const completedTask = id => checkpoint(id) === 'completed' || ['awaiting-verification', 'verified'].includes(taskState(id)?.status);
const phaseOneDeadline = Date.now() + 300000;
while (Date.now() < phaseOneDeadline && !(completedTask('T001') && startedTask('T002'))) await pause(500);
const midFlight = completedTask('T001') && startedTask('T002');
const beforeKill = read(summaryFile);
const kill = spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(controller.pid)], {encoding: 'utf8', windowsHide: true});
await pause(3000);
const afterKill = read(summaryFile);
const resume = spawnSync(process.execPath, [entry, '--resume-run', runId], {cwd: workspace, env, encoding: 'utf8', windowsHide: true, timeout: 600000, maxBuffer: 32 * 1024 * 1024});
const final = read(summaryFile);
const counter = read(path.join(p1, 'counter.json'));
const slow = read(path.join(p2, 'slow.json'));
const beforeT1 = beforeKill?.results?.B1?.attempts?.length ?? null;
const finalT1Attempts = final?.results?.B1?.attempts?.length ?? null;
const report = {
  testedAt: new Date().toISOString(), runId, nonce, root, workspace,
  beforeKill: {t1: beforeKill?.taskResults?.T001?.status, t2: beforeKill?.taskResults?.T002?.status, t1Checkpoint: checkpoint('T001'), t2Checkpoint: checkpoint('T002'), t1Attempts: beforeT1, midFlight},
  kill: {status: kill.status, output: String(kill.stdout || '').trim()},
  afterKill: {t1: afterKill?.taskResults?.T001?.status, t2: afterKill?.taskResults?.T002?.status, success: afterKill?.success},
  resumeExit: resume.status,
  final: {success: final?.success, generation: final?.generation, t1: final?.taskResults?.T001?.status, t2: final?.taskResults?.T002?.status, t1Attempts: finalT1Attempts, counter, slow},
  checks: {
    killedMidFlight: midFlight,
    // 断电前只要求 T001 的检查点已经 completed（整块 verified 要等窗口结束后的独立验收）。
    completedBeforeLoss: beforeKill?.taskResults?.T001?.checkpoint?.state === 'completed',
    controllerHardKilled: kill.status === 0 && String(kill.stdout || '').includes(String(controller.pid)),
    resumeExitedClean: resume.status === 0,
    completedTaskNotRerun: finalT1Attempts === beforeT1 && counter?.count === 1,
    retrySafeTaskContinued: final?.taskResults?.T002?.status === 'verified' && slow?.done === true,
    runVerified: final?.success === true,
  },
};
report.passed = Object.values(report.checks).every(Boolean);
fs.mkdirSync(root, {recursive: true});
fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
console.log('[powerloss] ' + JSON.stringify({passed: report.passed, runId, root, checks: report.checks, counter, t1Attempts: finalT1Attempts}));
process.exitCode = report.passed ? 0 : 1;
