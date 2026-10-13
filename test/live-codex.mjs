// A real Codex acceptance run consumes account capacity and may open visible
// windows. It is opt-in only when the caller explicitly selects a mode.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {launcherIdentity,processSnapshot,sameProcess} from '../scripts/core/leases.mjs';
import {validateCapacitySample,observedTerminal,capacityAcceptancePassed,boundedChildResult,capacityRequest,orderedCapacityReceipts,liveConcurrencyOptions,capacityBarrierDecision,settingsFromCommandLine,settingsMatch,receiptConcurrencyPeak,isolatedLiveEnvironment,workspaceHasIdentity,nearestOwnedCodexAncestor} from './live-acceptance-utils.mjs';
import {requestTasks} from '../scripts/core/contracts.mjs';
import {coreInventory,verifyRelease} from '../scripts/release-integrity.mjs';
import {captureInitiatorContext} from '../scripts/core/initiator-context.mjs';
import {resolveInitiatorSettings,resolveInitiatorPolicy,assertInitiatorWorkspace} from '../scripts/core/initiator-settings.mjs';
import {budgetSettings} from '../scripts/core/memory-budget.mjs';
import {controllerWindowsDir} from '../scripts/core/controller-state.mjs';
import {physicalPathIdentity} from '../scripts/core/runtime-context.mjs';
import {readRunStatus} from '../scripts/core/status-events.mjs';
import {startupReceiptSpec,readStartupReceipt,acceptanceAbortSpec,requestAcceptanceAbort,readAcceptanceAbort,readAcceptanceFinalization} from '../scripts/core/isolated-acceptance.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const initiatorContext=captureInitiatorContext();
const processWorkspace=process.cwd();
const workspace=initiatorContext.workspace;
const workspaceIdentity=physicalPathIdentity(workspace);
const requestedAgent=String(process.env.ORCH_LIVE_AGENT||'codex').trim();
if(requestedAgent!=='codex')throw new Error('Live acceptance exercises the Codex plugin only');
const agent='codex';
const executionMode=String(process.env.ORCH_LIVE_MODE||'').trim();
if(!['headless','visible'].includes(executionMode))throw new Error('Live acceptance requires explicit ORCH_LIVE_MODE=headless or visible');
if(String(process.env.ORCH_LIVE_ENTRY||'').trim())throw new Error('Live acceptance refuses ORCH_LIVE_ENTRY overrides');
if (process.platform !== 'win32') throw new Error('This acceptance scenario requires Windows');
if(!initiatorContext.threadId||!initiatorContext.workspace||physicalPathIdentity(processWorkspace)!==workspaceIdentity)
  throw new Error('Live acceptance requires the immutable host workspace binding');
const initiatorPolicy=resolveInitiatorPolicy();
assertInitiatorWorkspace(workspace,initiatorPolicy,process.env,initiatorContext);
if(executionMode==='headless'&&initiatorPolicy.approval!=='never')throw new Error('Headless live acceptance requires an initiating approval policy of never; run visible acceptance instead');
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
const controllerParent=fs.mkdtempSync(path.join(os.tmpdir(),'codex-live-controller-'));
const controllerRoot=path.join(controllerParent,'controller');
const stateDir=path.join(root,'state');
const abortToken=crypto.randomBytes(32).toString('base64url');
const abortTokenSha256=crypto.createHash('sha256').update(abortToken,'utf8').digest('hex');
const {taskCount,minimumConcurrency}=liveConcurrencyOptions();
// The fixture describes work, not a total-RAM window formula. Runtime admission
// decides which independent blocks fit and queues the remainder unchanged.
const capacity=taskCount;
const memoryAtLaunch={availableMB:Math.floor(os.freemem()/1024**2),reserveMB:budgetSettings().floorMB};
const initiatorSettings=resolveInitiatorSettings();
if(!initiatorSettings.model||!initiatorSettings.effort)throw new Error('Live acceptance requires resolved initiating model and reasoning effort');
fs.mkdirSync(root, { recursive: true });
const env={...isolatedLiveEnvironment({parentEnv:process.env,runId,controllerRoot,stateDir,abortToken}),ORCH_MAX_POLL_MS:'900000',ORCH_ACCEPTANCE_FILE:acceptanceFile};
// Four tasks default to a four-worker proof. Explicitly setting a lower minimum
// also exercises normal memory queueing without silently weakening the proof.
const tasks=Array.from({length:taskCount},(_,i)=>({id:String(91+i),taskId:'T'+String(i+1).padStart(3,'0')}));
const config = { nonce, workspace, tasks, taskCount, minimumConcurrency };
fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config));
fs.writeFileSync(acceptanceFile,JSON.stringify(Object.fromEntries(config.tasks.map(task=>[task.taskId,[{type:'json',path:path.join(root,'project-'+task.id,'result'+task.id+'.json'),equals:{taskId:task.taskId,id:task.id,nonce,cwd:workspace,sum:50005000}}]])),null,2));
const probe = `import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
const id = path.basename(fileURLToPath(import.meta.url)).slice(5, -4);
const task = config.tasks.find(item => item.id === id);
assert.ok(task);
const out = path.join(root, 'project-' + id);
fs.mkdirSync(out, { recursive: true });
const started = Date.now();
fs.writeFileSync(path.join(out, 'started.json'), JSON.stringify({taskId:task.taskId,id, nonce:config.nonce, cwd:process.cwd(), pid:process.pid, started}));
while (!fs.existsSync(path.join(root, 'release'))) {
  if (Date.now() - started > 600000) throw new Error('parent did not release the live acceptance barrier');
  await new Promise(r => setTimeout(r, 500));
}
await new Promise(r => setTimeout(r, 15000));
const value = {taskId:task.taskId,id, cwd:process.cwd(), nonce:config.nonce, pid:process.pid, started, finished:Date.now(), sum:Array.from({length:10000},(_,i)=>i+1).reduce((a,b)=>a+b,0)};
assert.equal(value.sum,50005000);
const file = path.join(out,'result' + id + '.json');
fs.writeFileSync(file,JSON.stringify(value));
assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')),value);
console.log(JSON.stringify(value));
`;
for (const task of config.tasks) {
  fs.mkdirSync(path.join(root, 'project-' + task.id));
  fs.writeFileSync(path.join(root, 'project-' + task.id, 'probe' + task.id + '.mjs'), probe);
}
// Validate the generated program before spending provider quota on the fixture.
const syntax=spawnSync(process.execPath,['--check',path.join(root,'project-'+config.tasks[0].id,'probe'+config.tasks[0].id+'.mjs')],{encoding:'utf8',windowsHide:true});
if(syntax.status!==0)throw new Error('Invalid live probe: '+syntax.stderr);
const request = capacityRequest({ids:config.tasks.map(task=>task.id),root,workspace,nonce});
if(requestTasks(request).length!==config.tasks.length)throw new Error('Generated request changed the acceptance task inventory');
fs.writeFileSync(path.join(root, 'request.txt'), request, 'utf8');
console.log(JSON.stringify({ root, taskCount, minimumConcurrency, memoryAtLaunch, initiatorSettings, nonce }));
let abortSpec=null,abortRequested=null,abortObserved=null,abortRequestError=null;
const retainedChildren=[];
let peak=0,monitorError=null,runnerCapacity=null,currentSummary=null,observedPeakLive=0;

// A live acceptance failure must remain a controller-bound event. It never
// releases the probes and it never gives the harness authority to terminate a
// child process by PID alone. If the engine failed before it prepared its
// proof, retain that fact as evidence instead of fabricating an abort record.
function requestAbort(reason='monitor-failed'){
  if(abortRequested)return abortRequested;
  try{
    abortSpec??=acceptanceAbortSpec({workspace,runId,token:abortToken,env});
    abortRequested=requestAcceptanceAbort(abortSpec,{reason});
  }catch(error){abortRequestError??=String(error?.message||error);}
  return abortRequested;
}

// These are the two direct children created by this harness. Detaching an
// overdue child lets this process report the unproven state without sending a
// termination signal. The controller abort remains responsible for cleanup.
function detachTimedOutChild(item,label){
  const child=item?.child;
  if(!child||child.exitCode!==null)return null;
  const evidence={label,pid:Number.isSafeInteger(child.pid)&&child.pid>0?child.pid:null,detached:false};
  for(const pipe of [child.stdin,child.stdout,child.stderr])try{pipe?.destroy();}catch{}
  try{child.unref();evidence.detached=true;}catch(error){evidence.detachError=String(error?.message||error);}
  retainedChildren.push(evidence);
  return evidence;
}

function launch(script, args, label) {
  const entry=path.join(repo,'scripts',script);
  const child = spawn(process.execPath, [entry, ...args], { cwd: workspace, env, windowsHide: true });
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
engine.done.then(result => {
  engineEnded = true;
  if(result?.code!==0||!fs.existsSync(summaryFile)){
    monitorError ||= 'Acceptance engine exited before a successful verified summary';
    requestAbort('engine-failed');
  }
});
poll.done.then(result=>{
  if(result?.code!==0){
    monitorError ||= 'Acceptance poller exited before a successful verified summary';
    requestAbort('monitor-failed');
  }
});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function ancestorPids(snapshot,pid){
  const result=[],seen=new Set();let current=snapshot.get(Number(pid));
  while(current&&!seen.has(current.ProcessId)){
    seen.add(current.ProcessId);const parent=Number(current.ParentProcessId);
    if(!Number.isSafeInteger(parent)||parent<=0)break;
    result.push(parent);current=snapshot.get(parent);
  }
  return result;
}
function descendsFrom(snapshot,pid,ancestorPid){return ancestorPids(snapshot,pid).includes(Number(ancestorPid));}
function commandHasPath(command,file){
  const normalized=String(command||'').toLowerCase().replaceAll('/','\\');
  const escaped=String(file).toLowerCase().replaceAll('/','\\').replace(/[-/\\^$*+?.()|[\]{}]/g,'\\$&');
  return new RegExp("(?:^|[\\s\"'])"+escaped+"(?=[\\s\"']|$)").test(normalized);
}
function sameLineage(left,right){return sameProcess(left.launcher,right.launcher)&&sameProcess(left.agent,right.agent)&&sameProcess(left.probe,right.probe)&&JSON.stringify(left.startupReceipt)===JSON.stringify(right.startupReceipt)&&JSON.stringify(left.started)===JSON.stringify(right.started);}
function readJson(file,label){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(error){throw new Error(label+' is invalid: '+(error?.message||error));}}

const samples=[];
const settingsEvidence=new Map(),lineageByBlock=new Map();
let barrierRelease=null;
// Memory pressure may defer independent blocks. Finishing the queue and proving
// the requested overlap are separate acceptance requirements.
const deadline=Date.now()+1800000;
while(!engineEnded&&Date.now()<deadline){
  try{
    try{
      currentSummary=readRunStatus(workspace,runId,{env});
      runnerCapacity=currentSummary.capacity;validateCapacitySample(currentSummary,capacity);
    }catch(error){
      if(error?.code!=='STATUS_AUTHORITY_PENDING'&&!/Run ledger not found/.test(String(error?.message||error)))throw error;
      currentSummary=null;
    }
    if(!currentSummary){await pause(1000);continue;}
    let snapshot,error;
    for(let attempt=0;attempt<3&&!snapshot;attempt++){
      try{snapshot=processSnapshot(30000);}catch(caught){error=caught;if(attempt<2)await pause(1500);}
    }
    if(!snapshot)throw error;
    const registry=path.join(controllerWindowsDir(workspace,env),'orchestrator-windows.json');
    const windows=fs.existsSync(registry)?readJson(registry,'controller window registry'):[];
    if(!Array.isArray(windows))throw new Error('controller window registry must be an array');
    const live=[];
    for(const window of windows.filter(value=>value?.runId===runId)){
      const blockKey=/-(B\d+)$/.exec(String(window.id||''))?.[1],entry=currentSummary.results?.[blockKey];
      if(!blockKey||!entry?.launcher||!window.identity||!window.pidFile)continue;
      let pid=Number(window.pid);
      if(fs.existsSync(window.pidFile))pid=Number(String(fs.readFileSync(window.pidFile,'utf8')).replace(/^\uFEFF/,'').trim());
      const launcher=launcherIdentity(pid,window.pidFile,snapshot);
      if(!launcher)continue;
      if(!sameProcess(window.identity,launcher)||!sameProcess(entry.launcher,launcher))throw new Error('Launcher identity changed for '+blockKey);
      const agents=[...snapshot.values()].filter(process=>/^codex(?:\.exe)?$/i.test(process.Name||'')&&descendsFrom(snapshot,process.ProcessId,launcher.ProcessId));
      if(!agents.length)continue;
      const agentSettings=agents.map(process=>({pid:process.ProcessId,settings:settingsFromCommandLine(process.CommandLine)}));
      live.push({blockKey,title:window.title,launcher,agents});
    }
    const readyTaskIds=[];
    for(const task of config.tasks){
      const startedFile=path.join(root,'project-'+task.id,'started.json'),resultFile=path.join(root,'project-'+task.id,'result'+task.id+'.json');
      if(!fs.existsSync(startedFile)||fs.existsSync(resultFile))continue;
      const started=readJson(startedFile,'probe start receipt');
      if(started.taskId!==task.taskId||started.id!==task.id||started.nonce!==nonce||!workspaceHasIdentity(started.cwd,workspaceIdentity,physicalPathIdentity)||!Number.isInteger(started.pid)||!Number.isFinite(started.started))throw new Error('Probe start receipt does not match its task');
      const block=currentSummary.blocks.find(value=>value.taskIds?.includes(task.taskId)),running=live.find(value=>value.blockKey===block?.key),probe=snapshot.get(started.pid);
      if(!block||!running||!probe)continue;
      if(!/^node(?:\.exe)?$/i.test(probe.Name||'')||!commandHasPath(probe.CommandLine,path.join(root,'project-'+task.id,'probe'+task.id+'.mjs')))throw new Error('Probe process identity does not match its fixture');
      const agent=nearestOwnedCodexAncestor(snapshot,probe.ProcessId,running.launcher.ProcessId);
      if(!agent)throw new Error('Probe process does not have an owned Codex ancestor');
      if(!descendsFrom(snapshot,agent.ProcessId,running.launcher.ProcessId))throw new Error('Codex process does not descend from its launcher');
      const attempt=entry.attempts?.[0];
      const startup=readStartupReceipt(startupReceiptSpec({workspace,runId,blockKey,attempt:attempt?.number,token:attempt?.token,env}),{launcher:running.launcher});
      const agentSettings=settingsFromCommandLine(agent.CommandLine);
      if(!settingsMatch(initiatorSettings,agentSettings))throw new Error('Observed CLI settings differ from the initiating window in '+block.key);
      settingsEvidence.set(block.key,{blockKey:block.key,launcherPid:running.launcher.ProcessId,agents:[{pid:agent.ProcessId,settings:agentSettings}]});
      const evidence={runId,taskIds:[...block.taskIds],launcher:{...running.launcher},agent:{...agent},probe:{...probe},agentAncestors:ancestorPids(snapshot,agent.ProcessId),probeAncestors:ancestorPids(snapshot,probe.ProcessId),startupReceipt:startup,started};
      const previous=lineageByBlock.get(block.key);
      if(previous&&!sameLineage(previous,evidence))throw new Error('Live process lineage changed for '+block.key);
      lineageByBlock.set(block.key,evidence);readyTaskIds.push(task.taskId);
    }
    const sample={at:Date.now(),live:live.map(item=>({blockKey:item.blockKey,launcherPid:item.launcher.ProcessId,agentPids:item.agents.map(agent=>agent.ProcessId)})),readyTaskIds};
    samples.push(sample);observedPeakLive=Math.max(observedPeakLive,live.length);peak=Math.max(peak,live.length);
    validateCapacitySample(null,capacity,live.length);
    const decision=capacityBarrierDecision({summary:currentSummary,readyTaskIds,liveBlockKeys:live.map(item=>item.blockKey),minimumConcurrency});
    if(decision.release&&!fs.existsSync(path.join(root,'release'))){
      barrierRelease={...decision,at:Date.now(),live:live.length,ready:readyTaskIds.length};
      fs.writeFileSync(path.join(root,'release'),String(Date.now()));
      console.log('[measure] barrier released: '+decision.reason+'; live='+live.length+' probes='+readyTaskIds.length+' required='+minimumConcurrency);
    }
  }catch(error){
    monitorError=String(error?.message||error);
    requestAbort('monitor-failed');
    console.log('[measure] '+monitorError);break;
  }
  await pause(3000);
}
let engineGraceResult=null;
if(!engineEnded){
  monitorError ||= 'Acceptance monitor ended before the engine completed';
  requestAbort('monitor-failed');
  engineGraceResult=await boundedChildResult(engine,60000);
}
const engineResult=engineGraceResult||await boundedChildResult(engine,20000);
const pollResult=await boundedChildResult(poll,20000);
if(engineResult.timedOut){
  monitorError ||= engineResult.error;
  requestAbort('engine-timeout');
  detachTimedOutChild(engine,'engine');
}
if(pollResult.timedOut){
  monitorError ||= pollResult.error;
  requestAbort('monitor-timeout');
  detachTimedOutChild(poll,'poll');
}
const results=config.tasks.map(task=>{
  const file=path.join(root,'project-'+task.id,'result'+task.id+'.json');
  return fs.existsSync(file)?readJson(file,'probe result'):{taskId:task.taskId,id:task.id,missing:true};
});
let summary=null;
try{summary=readRunStatus(workspace,runId,{env});}
catch(error){monitorError ||= String(error?.message||error);requestAbort('monitor-failed');}
const receiptsValid=results.every((receipt,index)=>{
  const task=config.tasks[index];
  return !receipt.missing&&receipt.taskId===task.taskId&&receipt.id===task.id&&receipt.nonce===nonce&&receipt.sum===50005000&&
    workspaceHasIdentity(receipt.cwd,workspaceIdentity,physicalPathIdentity)&&receipt.finished>receipt.started;
});
const ordered=receiptsValid&&orderedCapacityReceipts(results,taskCount,summary?.blocks);
const lifecycleEvidence=Object.fromEntries([...lineageByBlock.entries()].map(([key,evidence])=>[key,{...evidence,receipt:results.find(receipt=>receipt.taskId===evidence.started.taskId)||null,finalLauncher:null}]));
let finalSnapshot;
try{
  finalSnapshot=processSnapshot(30000);
  for(const evidence of Object.values(lifecycleEvidence)){
    const current=finalSnapshot.get(evidence.launcher.ProcessId);
    evidence.finalLauncher=sameProcess(evidence.launcher,current)?{...current}:null;
  }
}catch(error){monitorError ||= String(error?.message||error);requestAbort('monitor-failed');}
const workspaceConsistent=!!summary&&workspaceHasIdentity(summary.workspace,workspaceIdentity,physicalPathIdentity)&&
  results.every(receipt=>!receipt.missing&&workspaceHasIdentity(receipt.cwd,workspaceIdentity,physicalPathIdentity))&&
  Object.values(lifecycleEvidence).every(evidence=>workspaceHasIdentity(evidence.started.cwd,workspaceIdentity,physicalPathIdentity)&&evidence.startupReceipt?.workspaceIdentity===workspaceIdentity);
const proofFile=path.join(controllerRoot,'acceptance-proofs',runId+'.json');
let isolationProof=null,isolationProofValid=false;
try{
  isolationProof=readJson(proofFile,'isolated acceptance proof');
  isolationProofValid=isolationProof?.schema===1&&isolationProof.runId===runId&&isolationProof.threadBound===true&&
    isolationProof.workspaceIdentity===workspaceIdentity&&isolationProof.abortTokenSha256===abortTokenSha256;
}catch(error){monitorError ||= String(error?.message||error);requestAbort('monitor-failed');}
let acceptanceFinalization=null;
try{
  const finalizationSpec=acceptanceAbortSpec({workspace,runId,token:abortToken,env});
  acceptanceFinalization=readAcceptanceFinalization(finalizationSpec);
  if(!acceptanceFinalization)throw new Error('isolated acceptance finalization is missing');
}catch(error){monitorError ||= String(error?.message||error);requestAbort('monitor-failed');}
if(abortSpec){
  try{abortObserved=readAcceptanceAbort(abortSpec);}
  catch(error){abortRequestError??=String(error?.message||error);monitorError ||= abortRequestError;}
}
const initiatorBound=initiatorContext.threadId===String(process.env.CODEX_THREAD_ID||process.env.CODEX_SESSION_ID||'').trim()&&
  physicalPathIdentity(initiatorContext.workspace)===workspaceIdentity;
const initiatorProof={threadBound:initiatorBound,workspaceIdentity};
const windowLaunches=Object.values(summary?.results||{}).reduce((count,result)=>count+(result.attempts?.length||0),0);
const uniqueLaunchers=new Set(Object.values(lifecycleEvidence).map(evidence=>[evidence.launcher.ProcessId,evidence.launcher.Started,evidence.launcher.Name,evidence.launcher.CommandLine].join('|'))).size;
const receiptPeak=receiptConcurrencyPeak(results);
const overlap=receiptsValid&&barrierRelease?.concurrencyProven===true&&observedPeakLive>=minimumConcurrency&&receiptPeak>=minimumConcurrency;
const startupReceiptsValid=Object.keys(lifecycleEvidence).length===taskCount&&Object.values(lifecycleEvidence).every(evidence=>
  evidence.startupReceipt?.runId===runId&&evidence.startupReceipt?.workspaceIdentity===workspaceIdentity&&
  evidence.startupReceipt?.launcherPid===evidence.launcher.ProcessId);
const settingsInherited=settingsEvidence.size===taskCount&&[...settingsEvidence.values()].every(item=>item.agents.every(agent=>settingsMatch(initiatorSettings,agent.settings)));
const coreHashAtEnd=coreHash();let coreUnchanged=coreHashAtLaunch===coreHashAtEnd;
try{verifyRelease(repo);}catch(error){coreUnchanged=false;monitorError ||= String(error?.message||error);requestAbort('monitor-failed');}
const terminal=observedTerminal(executionMode,engine.output());
const closed=retainedChildren.length===0&&!!summary&&summary.blocks.every(block=>{
  const result=summary.results?.[block.key],evidence=lifecycleEvidence[block.key];
  return result?.exitConfirmed===true&&evidence?.finalLauncher===null;
});
const report={coreHashAtLaunch,coreHashAtEnd,coreUnchanged,coreVersion:summary?.version,executionMode,runId,entry:path.join(repo,'scripts','orchestrate-sdk.mjs'),terminal,
  workspace,workspaceIdentity,root,controllerRoot,nonce,capacity,taskCount,minimumConcurrency,memoryAtLaunch,runnerCapacity,peak,receiptPeak,barrierRelease,
  initiatorBound,initiatorProof,isolationProof,isolationProofValid,startupReceiptsValid,workspaceConsistent,initiatorSettings,settingsInherited,settingsEvidence:[...settingsEvidence.values()],
  abortTokenSha256,acceptanceFinalization,abortRequested,abortObserved,abortRequestError,retainedChildren,
  windowLaunches,uniqueLaunchers,engineResult,pollResult,receiptsValid,ordered,overlap,results,summary,samples,lifecycleEvidence,monitorError,closed};
const passed=capacityAcceptancePassed(report);report.passed=passed;report.equivalentToCurrentCodexPlugin=passed;
fs.writeFileSync(path.join(root,'report.json'),JSON.stringify(report,null,2));
fs.writeFileSync(path.join(root,'engine.log'),engine.output());
fs.writeFileSync(path.join(root,'poll.log'),poll.output());
console.log('[result] '+JSON.stringify({passed,root,peak,receiptsValid,ordered,overlap,aborted:!!abortRequested,retainedChildren:retainedChildren.length}));
process.exitCode=passed?0:1;
