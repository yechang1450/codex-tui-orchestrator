// Opt-in real Codex execution acceptance; ORCH_LIVE_MODE selects headless/visible.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {processSnapshot,sameProcess} from '../scripts/core/leases.mjs';
import {validateCapacitySample,observedTerminal,capacityAcceptancePassed,boundedChildResult,capacityRequest} from './live-acceptance-utils.mjs';
import {requestTasks} from '../scripts/core/contracts.mjs';
import {coreInventory,verifyRelease} from '../scripts/release-integrity.mjs';

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
const freeMemoryMb = os.freemem() / 1024 ** 2;
const capacity = Math.floor(freeMemoryMb / 1000);
if (process.platform !== 'win32' || capacity < 2) throw new Error('This acceptance scenario requires Windows and at least two calculated windows');
fs.mkdirSync(root, { recursive: true });
const env = { ...process.env, ORCH_AGENT: agent, ORCH_MAX_POLL_MS: '900000', ORCH_RUN_ID:runId, ORCH_ACCEPTANCE_FILE:acceptanceFile };
for (const key of ['WORKSPACE_DIR', 'ORCH_STATE_DIR', 'ORCH_TUI', 'ORCH_SANDBOX', 'ORCH_APPROVAL']) delete env[key];
const config = { nonce, workspace, ids: Array.from({ length: capacity + 1 }, (_, i) => String(91 + i)), capacity };
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
while (!fs.existsSync(path.join(root, 'release')) && id !== config.ids.at(-1)) {
  if (Date.now() - started > 600000) throw new Error('parent did not observe the calculated overlapping windows');
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
console.log(JSON.stringify({ root, capacity, tasks: config.ids.length, nonce }));
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
const poll = launch('poll-windows.mjs', ['--require-all-success', '--timeoutMs', '960000', '--intervalMs', '5000'], 'poll');
let engineEnded = false;
engine.done.then(() => {
  engineEnded = true;
  if (!fs.existsSync(summaryFile)) poll.child.kill();
});
const samples = [];
let peak = 0;
let monitorError=null,runnerCapacity=null;
const deadline = Date.now() + 970000;
while (!engineEnded && Date.now() < deadline) {
  try {
    if(fs.existsSync(summaryFile)){
      const current=JSON.parse(fs.readFileSync(summaryFile,'utf8'));
      runnerCapacity=current.capacity;validateCapacitySample(current,capacity);
    }
    const { stdout } = await exec('powershell.exe', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress'], { windowsHide: true, timeout: 15000 });
    const processes = JSON.parse(stdout);
    const byPid = new Map(processes.map(p => [p.ProcessId, p]));
    const registry = path.join(workspace, 'temp', 'orchestrator', 'orchestrator-windows.json');
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
      if (agents.length) live.push({ title: w.title, launcherPid: pid, launcherParentPid: byPid.get(pid).ParentProcessId, agentPids: agents.map(p => p.ProcessId) });
    }
    const ready = config.ids.filter(id => fs.existsSync(path.join(root, 'project-' + id, 'started.json')));
    const sample = { at: Date.now(), live, ready };
    samples.push(sample);
    if (live.length > peak) { peak = live.length; console.log('[measure] peak=' + peak + ' ready=' + ready.length); }
    validateCapacitySample(null,capacity,live.length);
    if (runnerCapacity===capacity&&live.length === capacity && config.ids.slice(0, capacity).every(id => ready.includes(id)) && !fs.existsSync(path.join(root, 'release'))) {
      fs.writeFileSync(path.join(root, 'release'), String(Date.now()));
      console.log('[measure] verified calculated live '+agent+' descendants and running probes; barrier released');
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
        const {closeWindowByPid}=await import('../scripts/core/orchestrate-sdk.mjs');
        await closeWindowByPid(block.launcher.ProcessId,block.launcher);
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
const ordered = receiptsValid && results[capacity].started >= results[capacity - 1].finished;
const windowLaunches = executionMode==='headless'?Object.values(summary?.results||{}).reduce((n,r)=>n+(r.attempts?.length||0),0):(engine.output().match(new RegExp('spawned visible '+agent+' TUI','g')) || []).length;
const uniqueLaunchers = new Set(samples.flatMap(s => s.live.map(w => w.launcherPid))).size;
const overlap = receiptsValid && Math.max(...results.slice(0, capacity).map(r => r.started)) < Math.min(...results.slice(0, capacity).map(r => r.finished));
const coreHashAtEnd=coreHash();let coreUnchanged=coreHashAtLaunch===coreHashAtEnd;
try{verifyRelease(repo);}catch(error){coreUnchanged=false;monitorError ||= String(error);}
const terminal=observedTerminal(executionMode,engine.output());
let closed=false;
try{const snapshot=processSnapshot();closed=!!summary&&Object.values(summary.results).every(r=>!sameProcess(r.launcher,snapshot.get(r.launcher?.ProcessId)));}
catch(error){monitorError ||= String(error);}
const report = { coreHashAtLaunch,coreHashAtEnd,coreUnchanged,coreVersion:summary?.version,executionMode,runId,entry:process.env.ORCH_LIVE_ENTRY||path.join(repo,'scripts','orchestrate-sdk.mjs'),terminal,workspace,root,nonce,capacity,runnerCapacity,peak,windowLaunches,uniqueLaunchers,engineResult,pollResult,receiptsValid,ordered,overlap,results,summary,samples,monitorError,closed };
const passed=capacityAcceptancePassed(report);report.passed=passed;report.equivalentToCurrentCodexPlugin=passed;
fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
fs.writeFileSync(path.join(root, 'engine.log'), engine.output());
fs.writeFileSync(path.join(root, 'poll.log'), poll.output());
console.log('[result] ' + JSON.stringify({ passed, root, peak, receiptsValid, ordered, overlap }));
process.exitCode = passed ? 0 : 1;
