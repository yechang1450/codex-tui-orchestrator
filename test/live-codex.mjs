// Opt-in real Codex execution acceptance; ORCH_LIVE_MODE selects headless/visible.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {processSnapshot,sameProcess} from '../scripts/core/leases.mjs';
import {validateCapacitySample,observedTerminal,capacityAcceptancePassed,boundedChildResult,capacityRequest,orderedCapacityReceipts,liveConcurrencyOptions,capacityBarrierDecision,settingsFromCommandLine,settingsMatch,receiptConcurrencyPeak} from './live-acceptance-utils.mjs';
import {requestTasks} from '../scripts/core/contracts.mjs';
import {coreInventory,verifyRelease} from '../scripts/release-integrity.mjs';
import {resolveInitiatorSettings} from '../scripts/core/initiator-settings.mjs';
import {budgetSettings} from '../scripts/core/memory-budget.mjs';
import {controllerWindowsDir} from '../scripts/core/controller-state.mjs';

const exec = promisify(execFile);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspace = process.cwd();
const agent=process.env.ORCH_LIVE_AGENT||'codex';
const executionMode=process.env.ORCH_LIVE_MODE||'visible';
if(!['headless','visible'].includes(executionMode))throw new Error('Invalid ORCH_LIVE_MODE');
verifyRelease(repo);
const coreHash=()=>crypto.createHash('sha256').update(JSON.stringify(coreInventory(repo))).digest('hex');
const coreHashAtLaunch=coreHash();
const parent = path.join(workspace, 'temp');
const name = 'codex-live-'+executionMode+'-' + crypto.randomUUID().replace(/[^a-z]/g, '');
const root = path.join(parent, name);
const nonce = crypto.randomUUID();
const runId='acceptance-'+nonce;
const summaryFile=path.join(workspace,'temp','orchestrator','runs',runId,'summary.json');
const acceptanceFile=path.join(root,'acceptance.json');
const {taskCount,minimumConcurrency}=liveConcurrencyOptions();
// The fixture describes work, not a total-RAM window formula. Runtime admission
// decides which independent blocks fit and queues the remainder unchanged.
const capacity=taskCount;
const memoryAtLaunch={availableMB:Math.floor(os.freemem()/1024**2),reserveMB:budgetSettings().floorMB};
const initiatorSettings=resolveInitiatorSettings();
if (process.platform !== 'win32') throw new Error('This acceptance scenario requires Windows');
if(agent==='codex'&&(!initiatorSettings.model||!initiatorSettings.effort))throw new Error('Live acceptance requires resolved initiating model and reasoning effort');
fs.mkdirSync(root, { recursive: true });
const env = { ...process.env, ORCH_AGENT: agent, ORCH_MAX_POLL_MS: '900000', ORCH_RUN_ID:runId, ORCH_ACCEPTANCE_FILE:acceptanceFile };
for (const key of ['WORKSPACE_DIR', 'ORCH_STATE_DIR', 'ORCH_TUI', 'ORCH_SANDBOX', 'ORCH_APPROVAL']) delete env[key];
// Four tasks default to a four-worker proof. Explicitly setting a lower minimum
// also exercises normal memory queueing without silently weakening the proof.
const config = { nonce, workspace, ids: Array.from({ length: taskCount }, (_, i) => String(91 + i)), taskCount, minimumConcurrency };
fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config));
fs.writeFileSync(acceptanceFile,JSON.stringify(Object.fromEntries(config.ids.map((id,i)=>['T'+String(i+1).padStart(3,'0'),[{type:'json',path:path.join(root,'project-'+id,'result'+id+'.json'),equals:{id,nonce,cwd:workspace,sum:50005000}}]])),null,2));
const probe = `import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
const id = path.basename(fileURLToPath(import.meta.url)).slice(5, -4);
assert.ok(config.ids.includes(id));
const out = path.join(root, 'project-' + id);
fs.mkdirSync(out, { recursive: true });
assert.equal(process.cwd(), config.workspace);
const started = Date.now();
fs.writeFileSync(path.join(out, 'started.json'), JSON.stringify({id, nonce:config.nonce, pid:process.pid, started}));
while (!fs.existsSync(path.join(root, 'release'))) {
  if (Date.now() - started > 600000) throw new Error('parent did not release the live acceptance barrier');
  await new Promise(r => setTimeout(r, 500));
}
await new Promise(r => setTimeout(r, 15000));
assert.equal(process.cwd(), config.workspace);
const value = {id, cwd:process.cwd(), nonce:config.nonce, pid:process.pid, started, finished:Date.now(), sum:Array.from({length:10000},(_,i)=>i+1).reduce((a,b)=>a+b,0)};
assert.equal(value.sum,50005000);
const file = path.join(out,'result' + id + '.json');
fs.writeFileSync(file,JSON.stringify(value));
assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')),value);
console.log(JSON.stringify(value));
`;
for (const id of config.ids) {
  fs.mkdirSync(path.join(root, 'project-' + id));
  fs.writeFileSync(path.join(root, 'project-' + id, 'probe' + id + '.mjs'), probe);
}
// Validate the generated program before spending provider quota on the fixture.
const syntax=spawnSync(process.execPath,['--check',path.join(root,'project-'+config.ids[0],'probe'+config.ids[0]+'.mjs')],{encoding:'utf8',windowsHide:true});
if(syntax.status!==0)throw new Error('Invalid live probe: '+syntax.stderr);
const request = capacityRequest({ids:config.ids,root,workspace,nonce});
if(requestTasks(request).length!==config.ids.length)throw new Error('Generated request changed the acceptance task inventory');
fs.writeFileSync(path.join(root, 'request.txt'), request, 'utf8');
console.log(JSON.stringify({ root, taskCount, minimumConcurrency, memoryAtLaunch, initiatorSettings, nonce }));
const children = [];
function launch(script, args, label) {
  const entry = label === 'engine' ? (process.env.ORCH_LIVE_ENTRY||path.join(repo, 'scripts', 'orchestrate-sdk.mjs')) : path.join(repo, 'scripts', script);
  const forwarded = args;
  const child = spawn(process.execPath, [entry, ...forwarded], { cwd: workspace, env, windowsHide: true });
  children.push(child);
  let output = '';
  for (const pipe of [child.stdout, child.stderr]) pipe.on('data', data => {
    const text = data.toString(); output += text;
    process.stdout.write('[' + label + '] ' + text);
  });
  const done = new Promise(resolve => {
    child.on('error', e => resolve({ code: -1, error: String(e) }));
    child.on('close', code => resolve({ code }));
  });
  return { child, done, output: () => output };
}
const engine = launch('orchestrate-sdk.mjs', [executionMode==='headless'?'--exec':'--run-windows', request], 'engine');
const startupDeadline = Date.now() + 60000;
while (engine.child.exitCode === null && !fs.existsSync(summaryFile) && Date.now() < startupDeadline) await new Promise(r => setTimeout(r, 500));
const poll = launch('poll-windows.mjs', ['--require-all-success', '--timeoutMs', '1860000', '--intervalMs', '5000'], 'poll');
let engineEnded = false;
engine.done.then(() => {
  engineEnded = true;
  if (!fs.existsSync(summaryFile)) poll.child.kill();
});
const samples = [];
let peak = 0;
let monitorError=null,runnerCapacity=null;
let currentSummary=null;
let observedPeakLive=0;
const settingsEvidence=new Map();
let barrierRelease=null;
// Memory pressure may defer independent blocks. Finishing the queue and proving
// the requested overlap are separate acceptance requirements.
const deadline = Date.now() + 1800000;
while (!engineEnded && Date.now() < deadline) {
  try {
    if(fs.existsSync(summaryFile)){
      const current=JSON.parse(fs.readFileSync(summaryFile,'utf8'));
      runnerCapacity=current.capacity;validateCapacitySample(current,capacity);
      currentSummary=current;
    }
    // 进程采样在负载高时会偶发失败：重试后仍失败就跳过本次采样，绝不因此中断整轮验收。
    let processes = null;
    for (let attempt = 0; attempt < 3 && !processes; attempt++) {
      try {
        const { stdout } = await exec('powershell.exe', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress'], { windowsHide: true, timeout: 20000 });
        processes = [].concat(JSON.parse(stdout)||[]);
      } catch (error) {
        if (attempt === 2) { console.log('[measure] process sample skipped: ' + String(error && error.message || error).slice(0, 120)); }
        else await new Promise(r => setTimeout(r, 1500));
      }
    }
    if (!processes) { await new Promise(r => setTimeout(r, 3000)); continue; }
    const byPid = new Map(processes.map(p => [p.ProcessId, p]));
    const registry = path.join(controllerWindowsDir(workspace), 'orchestrator-windows.json');
    const windows = fs.existsSync(registry) ? JSON.parse(fs.readFileSync(registry, 'utf8')) : [];
    const own = windows.filter(w => w.runId===runId);
    const live = [];
    for (const w of own) {
      let pid = Number(w.pid);
      if (fs.existsSync(w.pidFile)) pid = Number(fs.readFileSync(w.pidFile, 'utf8').replace(/^\uFEFF/, '').trim());
      if (!byPid.has(pid)) continue;
      const descendants = processes.filter(p => {
        let q = p; const visited = new Set();
        while (q && !visited.has(q.ProcessId)) {
          visited.add(q.ProcessId);
          if (q.ParentProcessId === pid) return true;
          q = byPid.get(q.ParentProcessId);
        }
        return false;
      });
      const agents = descendants.filter(p => agent==='pi'?(/^pi(?:\.exe)?$/i.test(p.Name)||(/^node(?:\.exe)?$/i.test(p.Name)&&/pi-coding-agent.*cli\.js/i.test(p.CommandLine||''))):/^codex(?:\.exe)?$/i.test(p.Name));
      if (agents.length) {
        const blockKey=/-(B\d+)$/.exec(w.id||'')?.[1];
        const agentSettings=agents.map(p=>({pid:p.ProcessId,settings:settingsFromCommandLine(p.CommandLine)}));
        if(agent==='codex'){
          if(agentSettings.some(p=>!settingsMatch(initiatorSettings,p.settings)))throw new Error('Observed CLI settings differ from the initiating window in '+blockKey);
          settingsEvidence.set(pid,{blockKey,launcherPid:pid,agents:agentSettings});
        }
        live.push({ blockKey,title: w.title, launcherPid: pid, launcherParentPid: byPid.get(pid).ParentProcessId, agentPids: agents.map(p => p.ProcessId) });
      }
    }
    const ready = config.ids.filter(id => {
      const startedFile=path.join(root,'project-'+id,'started.json');
      if(!fs.existsSync(startedFile)||fs.existsSync(path.join(root,'project-'+id,'result'+id+'.json')))return false;
      const receipt=JSON.parse(fs.readFileSync(startedFile,'utf8'));
      return receipt.id===id&&receipt.nonce===nonce&&byPid.has(receipt.pid);
    });
    const sample = { at: Date.now(), live, ready };
    samples.push(sample);
    if (live.length > observedPeakLive) observedPeakLive = live.length;
    if (live.length > peak) { peak = live.length; console.log('[measure] peak=' + peak + ' ready=' + ready.length); }
    validateCapacitySample(null,capacity,live.length);
    const decision=capacityBarrierDecision({summary:currentSummary,
      readyTaskIds:ready.map(id=>'T'+String(config.ids.indexOf(id)+1).padStart(3,'0')),
      liveBlockKeys:live.map(w=>w.blockKey),minimumConcurrency});
    if (decision.release && !fs.existsSync(path.join(root, 'release'))) {
      barrierRelease={...decision,at:Date.now(),live:live.length,ready:ready.length};
      fs.writeFileSync(path.join(root, 'release'), String(Date.now()));
      console.log('[measure] barrier released: '+decision.reason+'; live='+live.length+' probes='+ready.length+' required='+minimumConcurrency);
    }
  } catch (e) { monitorError=String(e);console.log('[measure] ' + monitorError);break; }
  await new Promise(r => setTimeout(r, 3000));
}
if(!engineEnded){
  monitorError ||= 'Acceptance monitor deadline exhausted';
  // End only the controllers owned by this harness, then reconcile their workers.
  for(const child of children)if(child.exitCode===null)child.kill();
  fs.writeFileSync(path.join(root,'release'),'acceptance aborted');
  if(fs.existsSync(summaryFile)){
    const current=JSON.parse(fs.readFileSync(summaryFile,'utf8'));
    for(const block of Object.values(current.results||{})){
      if(executionMode==='headless'){
        const file=block.launcherFiles?.lp;
        if(file&&path.resolve(file).startsWith(path.resolve(path.dirname(summaryFile))+path.sep)){
          const worker=JSON.parse(fs.readFileSync(file,'utf8'));
          if(worker.runId===runId&&worker.token===block.token)fs.writeFileSync(worker.cancel,'cancel');
        }
      }else if(block.launcher){
        // 中止路径尽力而为：模块加载失败（例如本进程 PATH 无原生 CLI）不能把验收进程打崩，
        // 窗口自身的 watchdog 仍会按契约自闭。
        try{const {closeWindowByPid}=await import('../scripts/core/orchestrate-sdk.mjs');await closeWindowByPid(block.launcher.ProcessId,block.launcher);}catch(error){monitorError||=('close fallback unavailable: '+String(error&&error.message||error));}
      }
    }
  }
}
const engineResult = await boundedChildResult(engine,20000);
const pollResult = await boundedChildResult(poll,20000);
const results = config.ids.map(id => {
  const f = path.join(root, 'project-' + id, 'result' + id + '.json');
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : { id, missing: true };
});

const summary = fs.existsSync(summaryFile) ? JSON.parse(fs.readFileSync(summaryFile, 'utf8')) : null;
const receiptsValid = results.every((r, i) => !r.missing && r.id === config.ids[i] && r.nonce === nonce && r.sum === 50005000 && r.cwd === workspace && r.finished > r.started);
const ordered = receiptsValid && orderedCapacityReceipts(results, taskCount, summary?.blocks);
const windowLaunches = executionMode==='headless'?Object.values(summary?.results||{}).reduce((n,r)=>n+(r.attempts?.length||0),0):(engine.output().match(new RegExp('spawned visible '+agent+' TUI','g')) || []).length;
const uniqueLaunchers = new Set(samples.flatMap(s => s.live.map(w => w.launcherPid))).size;
const receiptPeak=receiptConcurrencyPeak(results);
const overlap = receiptsValid && observedPeakLive >= minimumConcurrency&&receiptPeak>=minimumConcurrency;
const settingsInherited=agent!=='codex'||(settingsEvidence.size===taskCount&&[...settingsEvidence.values()].every(item=>item.agents.every(p=>settingsMatch(initiatorSettings,p.settings))));
const coreHashAtEnd=coreHash();let coreUnchanged=coreHashAtLaunch===coreHashAtEnd;
try{verifyRelease(repo);}catch(error){coreUnchanged=false;monitorError ||= String(error);}
const terminal=observedTerminal(executionMode,engine.output());
let closed=false;
try{const snapshot=processSnapshot();closed=!!summary&&Object.values(summary.results).every(r=>!sameProcess(r.launcher,snapshot.get(r.launcher?.ProcessId)));}
catch(error){monitorError ||= String(error);}
const report = { coreHashAtLaunch,coreHashAtEnd,coreUnchanged,coreVersion:summary?.version,executionMode,runId,entry:process.env.ORCH_LIVE_ENTRY||path.join(repo,'scripts','orchestrate-sdk.mjs'),terminal,workspace,root,nonce,capacity,taskCount,minimumConcurrency,memoryAtLaunch,runnerCapacity,peak,receiptPeak,barrierRelease,initiatorSettings,settingsInherited,settingsEvidence:[...settingsEvidence.values()],windowLaunches,uniqueLaunchers,engineResult,pollResult,receiptsValid,ordered,overlap,results,summary,samples,monitorError,closed };
const passed=capacityAcceptancePassed(report);report.passed=passed;report.equivalentToCurrentCodexPlugin=passed;
fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
fs.writeFileSync(path.join(root, 'engine.log'), engine.output());
fs.writeFileSync(path.join(root, 'poll.log'), poll.output());
console.log('[result] ' + JSON.stringify({ passed, root, peak, receiptsValid, ordered, overlap }));
process.exitCode = passed ? 0 : 1;
