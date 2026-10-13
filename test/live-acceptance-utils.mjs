import path from 'node:path';
import crypto from 'node:crypto';
import {validAbortToken} from '../scripts/core/isolated-acceptance.mjs';

export function capacityRequest({ids,root,workspace,nonce}) {
  return ids.map(id=>`项目${id}：执行 node "${root.replaceAll('\\','/')}/project-${id}/probe${id}.mjs" 创建 result${id}.json，执行工具的工作目录必须为 "${workspace}"，等待命令完成后读回结果，核验 id="${id}"、cwd="${workspace}"、sum=50005000、nonce="${nonce}"，pid/started/finished 为运行证据。本次回执没有 answer 字段，严格按本次 schema 核验。按主持提供的命令逐项记录 started 和 completed 检查点，禁止另开窗口、提交、读写记忆`).join('；');
}

export function validateCapacitySample(summary,expected,observed=0) {
  if(!Number.isInteger(expected)||expected<2)throw new Error('Capacity acceptance requires at least two windows');
  // These fixtures are independent. Memory may queue them, never merge them.
  if(summary&&(summary.capacity!==expected||summary.blocks?.length!==expected||
      new Set(summary.blocks.map(b=>b.key)).size!==expected||
      summary.blocks.some(b=>b.taskIds?.length!==1)||
      new Set(summary.blocks.flatMap(b=>b.taskIds)).size!==expected||
      summary.blocks.flatMap(b=>b.taskIds).some(id=>!/^T\d{3,}$/.test(id)||Number(id.slice(1))<1||Number(id.slice(1))>expected)))
    throw new Error(`Independent block inventory changed: tasks=${expected}, runner=${summary.capacity}`);
  if(observed>expected)throw new Error(`Capacity exceeded: observed=${observed}, limit=${expected}`);
}

export function liveConcurrencyOptions(env=process.env) {
  const taskCount=Number(env.ORCH_LIVE_TASKS||2);
  const minimumConcurrency=Number(env.ORCH_LIVE_MIN_CONCURRENCY||taskCount);
  if(!Number.isSafeInteger(taskCount)||taskCount<2)throw new Error('ORCH_LIVE_TASKS must be an integer >= 2');
  if(!Number.isSafeInteger(minimumConcurrency)||minimumConcurrency<2||minimumConcurrency>taskCount)
    throw new Error('ORCH_LIVE_MIN_CONCURRENCY must be an integer from 2 to ORCH_LIVE_TASKS');
  return {taskCount,minimumConcurrency};
}

// The live harness must inherit the initiating desktop context verbatim.  It
// only replaces controller-owned locations with per-run paths, so the engine
// and its observer cannot see another conversation's controller state.
export function isolatedLiveEnvironment({parentEnv=process.env,runId,controllerRoot,stateDir,abortToken}={}) {
  const workspace=String(parentEnv.WORKSPACE_DIR||'').trim();
  const threadId=String(parentEnv.CODEX_THREAD_ID||parentEnv.CODEX_SESSION_ID||'').trim();
  if(!workspace)throw new Error('Live acceptance requires the host WORKSPACE_DIR binding');
  if(!threadId)throw new Error('Live acceptance requires a Codex thread binding');
  if(String(parentEnv.ORCH_COORDINATOR_DIR||'').trim())throw new Error('Live acceptance refuses inherited ORCH_COORDINATOR_DIR');
  for(const [label,value] of Object.entries({runId,controllerRoot,stateDir}))if(!String(value||'').trim())throw new Error('Live acceptance requires '+label);
  if(!validAbortToken(abortToken))throw new Error('Live acceptance requires a fresh 32-byte base64url isolated abort token');
  return {...parentEnv,WORKSPACE_DIR:workspace,ORCH_AGENT:'codex',ORCH_RUN_ID:String(runId),ORCH_CONTROLLER_ROOT:String(controllerRoot),
    ORCH_STATE_DIR:String(stateDir),ORCH_ISOLATED_ACCEPTANCE:'1',ORCH_ISOLATED_ABORT_TOKEN:String(abortToken)};
}

function absoluteWorkspacePath(value) {
  return typeof value==='string'&&value.trim().length>0&&
    (path.isAbsolute(value)||path.win32.isAbsolute(value)||path.posix.isAbsolute(value));
}

// Raw Windows spellings are not workspace identity. The real resolver performs
// reparse-point checks before returning the physical identity; dependency-free
// tests can inject a narrow identity resolver instead.
export function workspaceHasIdentity(value, expectedIdentity, identityOf) {
  if(!absoluteWorkspacePath(value)||typeof expectedIdentity!=='string'||!expectedIdentity||typeof identityOf!=='function')return false;
  try{return identityOf(value)===expectedIdentity;}catch{return false;}
}

// A Codex process may legitimately be wrapped by another Codex process. Walk
// only the probe's parent chain and return the nearest Codex below the owned
// launcher; a process above the launcher never qualifies.
export function nearestOwnedCodexAncestor(snapshot, probePid, launcherPid) {
  if(!snapshot||typeof snapshot.get!=='function')return null;
  const probe=Number(probePid),launcher=Number(launcherPid);
  if(!Number.isSafeInteger(probe)||probe<=0||!Number.isSafeInteger(launcher)||launcher<=0)return null;
  const seen=new Set([probe]);let current=snapshot.get(probe),candidate=null;
  while(current){
    const parent=Number(current.ParentProcessId);
    if(!Number.isSafeInteger(parent)||parent<=0||seen.has(parent))return null;
    seen.add(parent);
    if(parent===launcher)return candidate;
    current=snapshot.get(parent);
    if(!current)return null;
    if(!candidate&&/^codex(?:\.exe)?$/i.test(String(current.Name||'')))candidate=current;
  }
  return null;
}

export function capacityBarrierDecision({summary,readyTaskIds,liveBlockKeys,minimumConcurrency}) {
  const ready=new Set(readyTaskIds),live=new Set(liveBlockKeys);
  const active=(summary?.blocks||[]).filter(b=>live.has(b.key));
  const readyActive=active.filter(b=>b.taskIds.some(id=>ready.has(id))).length;
  if(readyActive>=minimumConcurrency)return {release:true,reason:'concurrency-proven',concurrencyProven:true};
  // A deferred block cannot start until an admitted worker exits. Release the
  // admitted probes, but keep the requested concurrency proof unsatisfied.
  const queued=Object.values(summary?.results||{}).some(r=>r.status==='deferred');
  const admitted=(summary?.blocks||[]).filter(b=>['launching','running'].includes(summary.results?.[b.key]?.status));
  if(queued&&admitted.length>0&&admitted.every(b=>live.has(b.key)&&b.taskIds.some(id=>ready.has(id))))
    return {release:true,reason:'memory-queue',concurrencyProven:false};
  return {release:false,reason:'waiting-for-probes',concurrencyProven:false};
}

// Decode native Windows argument quoting; never search the prompt for flags.
export function settingsFromCommandLine(commandLine) {
  const args=[];let value='',quoted=false,started=false;
  const line=String(commandLine||'');
  for(let i=0;i<line.length;i++){
    if(line[i]==='\\'){
      let end=i;while(line[end]==='\\')end++;
      const count=end-i;
      if(line[end]==='"'){
        value+='\\'.repeat(Math.floor(count/2));
        if(count%2)value+='"';else quoted=!quoted;
        i=end;started=true;continue;
      }
      value+='\\'.repeat(count);i=end-1;started=true;continue;
    }
    if(line[i]==='"'){quoted=!quoted;started=true;continue;}
    if(/\s/.test(line[i])&&!quoted){if(started){args.push(value);value='';started=false;}continue;}
    value+=line[i];started=true;
  }
  if(started)args.push(value);
  const settings={};
  for(let i=1;i<args.length;i++){
    const arg=args[i];if(arg==='--')break;
    if(arg==='-m'||arg==='--model'){settings.model=args[++i];continue;}
    if(arg.startsWith('--model=')){settings.model=arg.slice(8);continue;}
    if(arg==='-c'||arg==='--config'){
      const pair=args[++i]||'',at=pair.indexOf('='),key=pair.slice(0,at);
      let setting=pair.slice(at+1);try{setting=JSON.parse(setting);}catch{}
      if(key==='model_reasoning_effort')settings.effort=setting;
      if(key==='service_tier')settings.serviceTier=setting;
    }
  }
  return settings;
}

export function settingsMatch(expected,actual) {
  return !!expected?.model&&!!expected?.effort&&
    ['model','effort','serviceTier'].every(key=>(expected[key]??null)===(actual?.[key]??null));
}

export function receiptConcurrencyPeak(results) {
  const events=[];
  for(const receipt of results){
    if(!Number.isFinite(receipt.started)||!Number.isFinite(receipt.finished)||receipt.finished<=receipt.started)return 0;
    events.push([receipt.started,1],[receipt.finished,-1]);
  }
  events.sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
  let active=0,peak=0;for(const [,delta] of events){active+=delta;peak=Math.max(peak,active);}return peak;
}

export function observedTerminal(mode,output) {
  if(mode==='headless')return null;
  const wt=/spawned visible .* TUI \(Windows Terminal\)/.test(output);
  const conhost=/spawned visible .* TUI \(inactive console\)/.test(output);
  return wt&&conhost?'mixed':wt?'wt':conhost?'conhost':null;
}

function processIdentity(value){
  return !!value&&typeof value==='object'&&Number.isSafeInteger(value.ProcessId)&&value.ProcessId>0&&
    typeof value.Started==='string'&&typeof value.Name==='string'&&(typeof value.CommandLine==='string'||value.CommandLine===null);
}

function sameIdentity(left,right){
  return processIdentity(left)&&processIdentity(right)&&left.ProcessId===right.ProcessId&&left.Started===right.Started&&
    left.Name===right.Name&&left.CommandLine===right.CommandLine;
}

function sameIds(left,right){
  return Array.isArray(left)&&Array.isArray(right)&&left.length===right.length&&left.every((value,index)=>value===right[index]);
}

function receiptMatches(receipt,started,taskId){
  return !!receipt&&receipt.taskId===taskId&&receipt.id===started.id&&receipt.nonce===started.nonce&&
    receipt.pid===started.pid&&receipt.started===started.started&&receipt.cwd===started.cwd&&absoluteWorkspacePath(receipt.cwd)&&
    Number.isFinite(receipt.finished)&&receipt.finished>receipt.started;
}

function startupReceiptMatches(receipt,{runId,blockKey,attempt,launcher,workspaceIdentity}){
  const keys=['schema','kind','runId','blockKey','attempt','tokenSha256','workspaceKeySha256','launcherPid','workspaceIdentity','createdAt'];
  if(!receipt||typeof receipt!=='object'||Array.isArray(receipt)||JSON.stringify(Object.keys(receipt).sort())!==JSON.stringify([...keys].sort()))return false;
  const token=String(attempt?.token||''),number=Number(attempt?.number);
  return receipt.schema===1&&receipt.kind==='launcher-start'&&receipt.runId===runId&&receipt.blockKey===blockKey&&
    Number.isSafeInteger(number)&&number>0&&receipt.attempt===number&&
    typeof receipt.tokenSha256==='string'&&receipt.tokenSha256===crypto.createHash('sha256').update(token,'utf8').digest('hex')&&
    typeof receipt.workspaceKeySha256==='string'&&receipt.workspaceKeySha256===crypto.createHash('sha256').update(workspaceIdentity,'utf8').digest('hex')&&
    receipt.launcherPid===launcher?.ProcessId&&receipt.workspaceIdentity===workspaceIdentity&&Number.isFinite(receipt.createdAt)&&receipt.createdAt>0;
}

function acceptanceLifecycleValid(report){
  const {summary,runId,workspace,workspaceIdentity,lifecycleEvidence,results}=report||{};
  if(!summary||summary.runId!==runId||!absoluteWorkspacePath(workspace)||!absoluteWorkspacePath(summary.workspace)||
    typeof workspaceIdentity!=='string'||!workspaceIdentity||!lifecycleEvidence||typeof lifecycleEvidence!=='object'||!Array.isArray(results))return false;
  const receiptByTask=new Map();
  for(const receipt of results){
    if(!receipt||typeof receipt.taskId!=='string'||receiptByTask.has(receipt.taskId))return false;
    receiptByTask.set(receipt.taskId,receipt);
  }
  const launcherIds=new Set();
  for(const block of summary.blocks||[]){
    const taskId=block?.taskIds?.[0],entry=summary.results?.[block?.key],attempt=entry?.attempts?.[0],evidence=lifecycleEvidence?.[block?.key];
    if(typeof taskId!=='string'||!entry||entry.status!=='verified'||entry.attempts?.length!==1||!attempt||
      attempt.runId!==runId||!sameIds(attempt.taskIds,block.taskIds)||attempt.token!==entry.token||
      !sameIdentity(entry.launcher,attempt.launcherObserved)||attempt.launcherPid!==entry.launcher.ProcessId||
      entry.exitConfirmed!==true)return false;
    const exitEvidence=entry.exitEvidence||attempt.exitEvidence;
    if(!exitEvidence||exitEvidence.token!==attempt.token||exitEvidence.pid!==entry.launcher.ProcessId||
      (report.executionMode==='headless'&&exitEvidence.exitCode!==0))return false;
    if(!evidence||evidence.runId!==runId||!sameIds(evidence.taskIds,block.taskIds)||!sameIdentity(evidence.launcher,entry.launcher)||
      !processIdentity(evidence.agent)||!processIdentity(evidence.probe)||evidence.finalLauncher!==null||
      !Array.isArray(evidence.agentAncestors)||!Array.isArray(evidence.probeAncestors)||
      !evidence.agentAncestors.includes(entry.launcher.ProcessId)||!evidence.probeAncestors.includes(evidence.agent.ProcessId)||
      !evidence.probeAncestors.includes(entry.launcher.ProcessId)||
      !startupReceiptMatches(evidence.startupReceipt,{runId,blockKey:block.key,attempt,launcher:entry.launcher,workspaceIdentity}))return false;
    const started=evidence.started,receipt=evidence.receipt,reportedReceipt=receiptByTask.get(taskId),probeBirth=Date.parse(evidence.probe.Started);
    if(!started||started.taskId!==taskId||started.pid!==evidence.probe.ProcessId||!absoluteWorkspacePath(started.cwd)||
      !Number.isFinite(started.started)||!Number.isFinite(probeBirth)||probeBirth>started.started||started.started-probeBirth>60000||
      !receiptMatches(receipt,started,taskId)||!receiptMatches(reportedReceipt,started,taskId)||
      JSON.stringify(receipt)!==JSON.stringify(reportedReceipt))return false;
    const key=[entry.launcher.ProcessId,entry.launcher.Started,entry.launcher.Name,entry.launcher.CommandLine].join('|');
    if(launcherIds.has(key))return false;
    launcherIds.add(key);
  }
  return launcherIds.size===(summary.blocks||[]).length&&receiptByTask.size===(summary.blocks||[]).length;
}

function acceptanceFinalizationValid(report){
  const finalization=report?.acceptanceFinalization;
  return finalization?.schema===1&&finalization.kind==='acceptance-finalization'&&finalization.runId===report.runId&&
    finalization.workspaceIdentity===report.workspaceIdentity&&
    finalization.workspaceKeySha256===crypto.createHash('sha256').update(report.workspaceIdentity,'utf8').digest('hex')&&
    finalization.abortTokenSha256===report.abortTokenSha256&&Number.isFinite(finalization.finalizedAt)&&finalization.finalizedAt>0;
}

export function capacityAcceptancePassed(r) {
  const blocks=r.taskCount,minimum=r.minimumConcurrency;
  try{validateCapacitySample(r.summary,blocks,r.peak);}catch{return false;}
  const proof=r.isolationProof,initiatorProof=r.initiatorProof;
  const noAbort=r.abortRequested===null&&r.abortObserved===null&&r.abortRequestError===null;
  const noRetainedChildren=Array.isArray(r.retainedChildren)&&r.retainedChildren.length===0;
  return Number.isInteger(minimum)&&minimum>=2&&minimum<=blocks&&!r.monitorError&&r.coreUnchanged===true&&r.closed===true&&r.settingsInherited===true&&
    r.initiatorBound===true&&r.isolationProofValid===true&&r.startupReceiptsValid===true&&r.workspaceConsistent===true&&
    noAbort&&noRetainedChildren&&proof?.schema===1&&proof.runId===r.runId&&proof.threadBound===true&&typeof proof.workspaceIdentity==='string'&&proof.workspaceIdentity===r.workspaceIdentity&&
    typeof r.abortTokenSha256==='string'&&proof.abortTokenSha256===r.abortTokenSha256&&
    initiatorProof?.threadBound===true&&initiatorProof.workspaceIdentity===r.workspaceIdentity&&
    acceptanceFinalizationValid(r)&&acceptanceLifecycleValid(r)&&r.engineResult.code===0&&r.pollResult.code===0
    &&r.runnerCapacity===blocks&&r.peak>=minimum&&r.receiptPeak>=minimum&&r.receiptsValid===true&&r.ordered===true&&r.overlap===true
    &&r.windowLaunches===blocks&&r.uniqueLaunchers===blocks
    &&(r.executionMode==='headless'||['wt','conhost'].includes(r.terminal))
    &&r.summary?.success===true&&Object.keys(r.summary.results).length===blocks
    &&Object.values(r.summary.results).every(result=>result.status==='verified'&&result.attempts?.length===1);
}

// The overflow ordering check only applies when the fixture intentionally
// creates one task beyond the observed block count. A small two-task probe can
// legitimately have exactly as many receipts as blocks.
export function orderedCapacityReceipts(results, expectedLive, blocks) {
  if (!Array.isArray(results) || !Number.isInteger(expectedLive) || expectedLive < 1) return false;
  if (results.length < expectedLive) return false;
  if(blocks){
    const assigned=new Set();
    for(const block of blocks){
      let previous;
      for(const id of block.taskIds||[]){
        const index=Number(String(id).replace(/^T/,''))-1,receipt=results[index];
        if(assigned.has(index)||!Number.isFinite(receipt?.started)||!Number.isFinite(receipt?.finished)||receipt.finished<receipt.started)return false;
        if(previous&&receipt.started<previous.finished)return false;
        assigned.add(index);previous=receipt;
      }
    }
    return assigned.size===results.length;
  }
  if (results.length === expectedLive) return true;
  const lastConcurrent = results[expectedLive - 1];
  const overflow = results[expectedLive];
  return Number.isFinite(lastConcurrent?.finished) && Number.isFinite(overflow?.started)
    && overflow.started >= lastConcurrent.finished;
}

export function liveTimeout(env=process.env){
  const value=Number(env.ORCH_LIVE_TIMEOUT_MS||600000);
  if(!Number.isSafeInteger(value)||value<1000||value>21600000)throw new Error('Invalid ORCH_LIVE_TIMEOUT_MS: expected 1000..21600000');
  return value;
}

export async function boundedChildResult(item,timeoutMs) {
  let timer;
  try {
    return await Promise.race([item.done,new Promise(resolve=>{timer=setTimeout(()=>{
      // The harness owns the observer process, but it must not turn a timeout
      // into an unverified force-kill. The controller-bound abort protocol is
      // responsible for asking the runner to close only authenticated work.
      resolve({code:-1,timedOut:true,error:'Acceptance child did not exit before its deadline'});
    },timeoutMs);})]);
  } finally {clearTimeout(timer);}
}
