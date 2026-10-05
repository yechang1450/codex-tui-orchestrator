import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {CORE_VERSION,ledgerPlan,levelWaves,verifyChecks,summaryComplete,TERMINAL,canonicalKey,requestTasks,acceptanceKeyDiff,buildTodoList,todoListText,canonicalDigest,jsonProblem,describeShape} from './contracts.mjs';
import {coordinatorDir,reserve,bind,release,prepare,atomicJson,launcherIdentity,processSnapshot,sameProcess,claimRun,releaseRun,readUtf8Bounded} from './leases.mjs';
import {scheduleReady,recoveryTasks,taskPolicy,validateRecoverySummary,hasReconciledCheckpoint,hasParentInspection,resolveAttemptFile,validateSavedLauncherFiles} from './recovery.mjs';
import {readCheckpoints,checkpointMatches} from './checkpoint.mjs';
import {capacityRetryPolicy} from './retry-policy.mjs';
import {availableMB, admissionOk, unconsumedReservationMB, blockCostMB as budgetBlockCostMB, observedCostMB, loadBudgetState, saveBudgetState, updateRollingCost} from './memory-budget.mjs';
import {createVerificationQueue} from './verification-queue.mjs';
import {assertNoReparsePoints,physicallySameOrChild,physicalPathIdentity} from './runtime-context.mjs';
import {controllerStateDir} from './controller-state.mjs';

function blockCostFor(sum, key, budget) {
  const block = (sum.blocks || []).find(item => item.key === key);
  return budgetBlockCostMB(block, budget.windowCostMB, budget.taskCosts || {});
}

// Always union explicit planner hints with deterministic inference. Empty or
// partial conflictKeys from raw, custom, or fallback plans must not bypass the
// safety check; command-input inference itself excludes only proven read-only
// interpreter operands.
export function admissionKeys(block, workspace, infer) {
  const explicit = Array.isArray(block?.conflictKeys) ? block.conflictKeys : [];
  const inferred = (block?.tasks || []).flatMap(task => infer(task.prompt || ''));
  return [...new Set([...explicit, ...inferred].map(key => canonicalKey(key, workspace)))];
}
/** 启动器进程树的当前工作集合计（MB），用于滚动修正每窗成本。 */
function treeWorkingSetMB(snapshot, rootPid) {
  const root = Number(rootPid);
  if (!root || !snapshot?.get?.(root)) return 0;
  const children = new Map();
  for (const proc of snapshot.values()) {
    const parent = Number(proc.ParentProcessId) || 0;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(proc);
  }
  let total = 0;
  const seen = new Set();
  const queue = [root];
  while (queue.length) {
    const pid = queue.shift();
    if (seen.has(pid)) continue;
    seen.add(pid);
    const proc = snapshot.get(pid);
    if (proc) total += Number(proc.WorkingSet64) || 0;
    for (const child of children.get(pid) || []) queue.push(Number(child.ProcessId));
  }
  return Math.round(total / 1024 ** 2);
}
import {createStatusPublisher,buildExecutionStatus} from './status-events.mjs';
export {scheduleReady,recoveryTasks};
const pause=ms=>new Promise(r=>setTimeout(r,ms));

// Human-facing run diagnostics must not disclose the initiating workspace or
// controller layout.  Keep the basename useful for locating the artifact while
// binding it to this run with a short, non-reversible digest.  The full path is
// already persisted in the controller-owned ledger for trusted readers.
function displaySummaryPath(file) {
  const resolved=path.resolve(String(file));
  const digest=crypto.createHash('sha256').update(resolved).digest('hex').slice(0,12);
  return path.basename(resolved)+'#'+digest;
}

// Checkpoint commands are pasted into a Windows PowerShell worker prompt.
// Use the already-verified Node executable and single-quoted PowerShell
// literals so paths containing spaces, $, %, !, backticks, or apostrophes stay
// data instead of being expanded by the shell. Control characters cannot be
// valid Windows paths or task fields and would make the prompt ambiguous.
function powershellLiteral(value) {
  const text = String(value);
  if (/[\u0000-\u001f\u007f]/u.test(text)) throw new Error('Checkpoint command argument contains a control character');
  return "'" + text.replaceAll("'", "''") + "'";
}

export function checkpointCommand(helper, attemptFile, id, state, nodePath = process.execPath) {
  return '& ' + [nodePath, helper, attemptFile, id, state].map(powershellLiteral).join(' ');
}

/**
 * 进程身份枚举是瞬时故障源（Windows CIM 查询/互斥锁在机器繁忙时会超时）。
 * 身份不一致仍然立即判失败，但"枚举本身取不到"要有限重试：
 * 一次枚举超时不该让整块任务失败，否则一轮执行完不了（用户硬性要求）。
 */
export async function identifyWithRetry(identify,pid,pidFile,{attempts=3,pauseMs=ms=>pause(ms)}={}){
  const limit=Math.max(1,Number(attempts)||1);
  let lastError;
  for(let i=0;i<limit;i++){
    try{return identify(pid,pidFile);}
    catch(error){lastError=error;if(i+1<limit)await pauseMs(300*(i+1));}
  }
  throw lastError;
}
export async function waitForProcessExit(expected,{timeoutMs=5000,intervalMs=100,snapshot=processSnapshot,probePid}={}) {
  if(!expected||!Number.isFinite(Number(expected.ProcessId)))return true;
  const timeout=Math.max(0,Math.min(15000,Number(timeoutMs)||0)),interval=Math.max(10,Math.min(1000,Number(intervalMs)||100));
  const deadline=Date.now()+timeout;
  while(true){
    // A full CIM snapshot can be temporarily unavailable under Windows load.
    // ESRCH is direct evidence that this PID is gone; permission/other errors
    // remain unknown and must never be treated as an exit proof.
    const presenceProbe=probePid||(snapshot===processSnapshot?probeProcessPresence:null);
    try{if(presenceProbe&&presenceProbe(expected.ProcessId)===false)return true;}catch{/* fall through to identity-bound snapshot */}
    let current;
    try{current=snapshot(Math.min(3000,Math.max(1,deadline-Date.now())));}catch{
      // Process enumeration can briefly fail while a launcher exits. Retry within
      // the same bounded window; an exhausted or continuously unreadable snapshot
      // remains unproven and must retain the lease.
      if(Date.now()>=deadline)return false;
      await pause(Math.min(interval,Math.max(1,deadline-Date.now())));continue;
    }
    if(!sameProcess(expected,current?.get(Number(expected.ProcessId))))return true;
    if(Date.now()>=deadline)return false;
    await pause(Math.min(interval,Math.max(1,deadline-Date.now())));
  }
}

function probeProcessPresence(pid){
  try{process.kill(Number(pid),0);return true;}
  catch(error){
    if(error?.code==='ESRCH')return false;
    if(error?.code==='EPERM'||error?.code==='EACCES')return null;
    throw error;
  }
}

/** Final cleanup is scoped to this run's durable attempts, never terminal hosts. */
export async function sweepRunProcesses(sum,{close,waitForExit=waitForProcessExit,identify=launcherIdentity,snapshot=processSnapshot,onClosed=async()=>{},onFailed=()=>{}}={}) {
  const stats={checked:0,closed:0,failed:0};
  for(const block of sum?.blocks||[]){
    const entry=sum.results?.[block.key],attempt=entry?.attempts?.at(-1);
    if(!attempt&&!entry?.launcher&&!entry?.launcherFiles)continue;
    stats.checked++;
    try{
      if(!attempt||attempt.runId!==sum.runId||!attempt.token||entry.token!==attempt.token||
          !attempt.taskIds?.length||attempt.taskIds.some(id=>!block.taskIds.includes(id))||!entry.launcherFiles)
        throw new Error('Final cleanup ownership is not bound to this run attempt');
      validateSavedLauncherFiles(sum,block,entry,attempt);
      let expected=entry.launcher,confirmedExitedByPidFile=false;
      if(fs.existsSync(entry.launcherFiles.pidf)){
        const pid=Number((readUtf8Bounded(entry.launcherFiles.pidf,'launcher PID',128)||'').replace(/^\uFEFF/,''));
        if(!Number.isSafeInteger(pid)||pid<=0||pid>4194304)throw new Error('Final cleanup controller PID file is invalid');
        validateSavedLauncherFiles(sum,block,entry,attempt,{requireLiveFiles:true});
        const current=await identifyWithRetry(identify,pid,entry.launcherFiles.pidf);
        if(current){
          if(expected&&!sameProcess(expected,current))throw new Error('Final cleanup saved launcher identity mismatch');
          expected=current;entry.launcher=current;
        }else{
          if(expected&&Number(expected.ProcessId)!==pid)throw new Error('Final cleanup saved launcher identity mismatch');
          if(snapshot().has(pid))throw new Error('Final cleanup cannot prove launcher exit from its controller PID file');
          confirmedExitedByPidFile=true;
        }
      }
      if(!expected&&!confirmedExitedByPidFile)throw new Error('Final cleanup cannot prove launcher identity or exit');
      const wasConfirmed=entry.exitConfirmed===true;
      if(!confirmedExitedByPidFile&&!(await waitForExit(expected))){
        const current=await identifyWithRetry(identify,expected.ProcessId,entry.launcherFiles.pidf);
        if(!sameProcess(expected,current))throw new Error('Final cleanup launcher identity is unavailable or changed');
        if(typeof close!=='function')throw new Error('Final cleanup has no owned-process closer');
        await close(expected.ProcessId,expected);
        if(!(await waitForExit(expected)))throw new Error('Owned launcher still alive after final cleanup; lease retained');
      }
      entry.exitConfirmed=true;
      if(!wasConfirmed)stats.closed++;
      await onClosed(block,entry,attempt,{wasConfirmed});
    }catch(error){
      stats.failed++;entry.status='failed';entry.reason=error?.message||String(error);entry.endedAt=Date.now();
      onFailed(block,entry,error);
    }
  }
  return stats;
}
async function coordinate(fn,deadline) {
  while(Date.now()<deadline){try{return fn();}catch(e){if(!/busy|initializing|abandoned/.test(e.message))throw e;await pause(200);}}
  throw new Error('Coordinator transaction timeout');
}
export function runDirectory(workspace,runId) {
  if(!/^[a-zA-Z0-9_-]{1,100}$/.test(runId||''))throw new Error('A valid --run-id is required');
  return assertNoReparsePoints(path.join(workspace,'temp','orchestrator','runs',runId),'run directory');
}
// 验收契约是安全闸门：畸形文件**不能**被当成"没有检查"静默放行（那样任务会停在
// awaiting-verification 而调用方看不出真因），也不能只回一句 JSON.parse 的裸措辞。
// 这里逐层点名：哪个文件、哪一层、期望什么、实测什么。
function loadChecks(file){
  if(!file)return {};
  let text;
  try{text=readUtf8Bounded(file,'acceptance contract');}
  catch(error){throw new Error('Acceptance contract unreadable ('+error.code+'): '+file+'：'+(error.message||error));}
  let value;
  try{value=JSON.parse(text.replace(/^\uFEFF/,''));}
  catch(error){throw new Error('Invalid acceptance contract '+file+'：'+jsonProblem(text,error));}
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid acceptance contract '+file+'：顶层必须是「任务 id -> 检查」的 JSON 对象（实测 '+describeShape(value)+'）');
  for(const [id,entry] of Object.entries(value)){
    const checks=Array.isArray(entry)?entry:entry?.checks;
    if(!Array.isArray(checks))throw new Error('Invalid acceptance contract '+file+'：任务 "'+id+'" 的检查必须是数组或 {checks:[…]}（实测 '+describeShape(entry)+'，缺 checks 字段等同契约写错，不能静默降级成"无检查"）');
  }
  return value;
}
// 账本读取：ENOENT 保持原样（调用方按 code 判定）；解析/形状问题必须点名文件，
// 不能把裸 SyntaxError 丢给调用方。
function parseLedger(file,text){
  let value;
  try{value=JSON.parse(String(text).replace(/^\uFEFF/,''));}
  catch(error){throw new Error('Invalid run ledger '+file+'：'+jsonProblem(text,error));}
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid run ledger '+file+'：顶层必须是 JSON 对象（实测 '+describeShape(value)+'）');
  return value;
}
export function readLedgerJson(file){
  const text=readUtf8Bounded(file,'run ledger');
  if(text===null)throw Object.assign(new Error('Run ledger not found: '+file),{code:'ENOENT'});
  return parseLedger(file,text);
}
// 验收契约绑定：运行开始时把契约摘要写进账本（summary.json + manifest.json），
// verify/resume 必须重读到同一份契约。执行窗对工作区有写权限，能把
// <runDir>/acceptance.json 换成对自己有利的版本；没有绑定就无法判断它是否被改过。
function acceptanceBinding(checks,source){return {algorithm:'sha256',sha256:canonicalDigest(checks),source,boundAt:Date.now()};}
function readJsonIfPresent(file){
  let text;
  try{text=readUtf8Bounded(file,'controller ledger');}
  catch(error){throw error;}
  if(text===null)return undefined;
  try{return JSON.parse(text.replace(/^\uFEFF/,''));}
  catch(error){throw new Error('Invalid ledger '+file+'：'+jsonProblem(text,error));}
}
function recordedAcceptanceDigest(sum,dir,{allowConflict=false}={}){
  const manifest=readJsonIfPresent(path.join(dir,'manifest.json'));
  const records=[sum?.acceptance,manifest?.acceptance].filter(binding=>typeof binding?.sha256==='string'&&binding.sha256.length>0);
  if(!records.length)return {digest:null,conflict:false,records:[]};
  if(records.length===2&&records[0].sha256===records[1].sha256)return {digest:records[0].sha256,conflict:false,records};
  const details='summary '+String(sum?.acceptance?.sha256).slice(0,12)+', manifest '+String(manifest?.acceptance?.sha256).slice(0,12);
  if(!allowConflict)throw new Error('Acceptance binding records disagree or are incomplete ('+details+'); refusing to select a binding. Use an explicit acceptance override to rebind both records.');
  // 两份账本不一致时不能按时间戳猜测哪一份可信。显式 override 只负责
  // 把当前契约重新绑定到两份账本，且必须在调用方留痕。
  console.warn('[orchestrator] acceptance override: binding records disagree ('+details+'); rebinding both records');
  return {digest:null,conflict:true,records};
}
function trustedAcceptanceFile(workspace,runId){
  const identity=crypto.createHash('sha256').update(physicalPathIdentity(workspace)).digest('hex');
  return assertNoReparsePoints(path.join(controllerStateDir(workspace),'acceptance',identity,runId+'.json'),'trusted acceptance');
}
function trustedPlanFile(workspace,runId){
  const identity=crypto.createHash('sha256').update(physicalPathIdentity(workspace)).digest('hex');
  return assertNoReparsePoints(path.join(controllerStateDir(workspace),'plans',identity,runId+'.json'),'trusted run plan');
}
function sameWorkspace(left,right){
  if(typeof left!=='string'||typeof right!=='string'||!left.trim()||!right.trim())return false;
  try{return physicalPathIdentity(left)===physicalPathIdentity(right);}catch{return false;}
}
function immutableRunPlan(sum){
  return {workspace:sum.workspace,runId:sum.runId,request:sum.request,agent:sum.agent||'codex',
    executionMode:sum.executionMode||'visible',authorization:sum.authorization??null,
    tasks:sum.tasks,blocks:sum.blocks,plan:sum.plan};
}
function bindRunPlan(sum){
  const file=trustedPlanFile(sum.workspace,sum.runId);
  if(fs.existsSync(file))throw new Error('Trusted run plan binding already exists for this run ID');
  atomicJson(file,{version:1,workspace:sum.workspace,runId:sum.runId,sha256:canonicalDigest(immutableRunPlan(sum))});
}
function validateBoundRunPlan(sum,{required=false}={}){
  const binding=readJsonIfPresent(trustedPlanFile(sum.workspace,sum.runId));
  if(!binding){if(required)throw new Error('Trusted run plan binding is missing; cannot resume this run');return false;}
  if(binding.version!==1||binding.runId!==sum.runId||!sameWorkspace(binding.workspace||'',sum.workspace)||
    typeof binding.sha256!=='string'||!/^[a-f0-9]{64}$/.test(binding.sha256))throw new Error('Trusted run plan binding is invalid');
  if(binding.sha256!==canonicalDigest(immutableRunPlan(sum)))throw new Error('Trusted run plan binding differs from the workspace ledger');
  return true;
}
function loadBoundChecks(file,dir,sum,override){
  const checks=loadChecks(file),digest=canonicalDigest(checks),recorded=recordedAcceptanceDigest(sum,dir,{allowConflict:override===true});
  const authority=readJsonIfPresent(trustedAcceptanceFile(sum.workspace,sum.runId));
  if(authority&&(
    authority.version!==1||authority.runId!==sum.runId||!sameWorkspace(authority.workspace||'',sum.workspace)||
    typeof authority.sha256!=='string'||!/^[a-f0-9]{64}$/.test(authority.sha256)
  ))throw new Error('Trusted acceptance binding is invalid');
  if(!authority&&!override)throw new Error('Trusted acceptance binding is missing; use an explicit acceptance override to adopt a historical run');
  if(authority&&authority.sha256!==digest&&!override)throw new Error('Acceptance contract changed since the controller-owned binding was recorded (recorded '+authority.sha256.slice(0,12)+', current '+digest.slice(0,12)+')');
  if(recorded.conflict)return {checks,digest,rebound:true,conflict:true,previousRecords:recorded.records};
  if(!recorded.digest){
    if(!override)throw new Error('Acceptance binding records are missing; use an explicit acceptance override to adopt a historical run');
    return {checks,digest,rebound:true,previous:authority?.sha256};
  }
  if(!authority)return {checks,digest,rebound:true,previous:recorded.digest};
  if(authority.sha256!==digest){
    console.warn('[orchestrator] acceptance override: controller binding changed ('+authority.sha256.slice(0,12)+' -> '+digest.slice(0,12)+'); rebinding '+file);
    return {checks,digest,rebound:true,previous:authority.sha256};
  }
  if(recorded.digest===digest)return {checks,digest,rebound:false};
  if(!override)throw new Error('Acceptance contract changed since the run was recorded (recorded '+recorded.digest.slice(0,12)+', current '+digest.slice(0,12)+'): '+file+'。确认契约没有被削弱后才可以用 --allow-acceptance-change（或 ORCH_ACCEPTANCE_OVERRIDE=1）显式接管。');
  console.warn('[orchestrator] acceptance override: contract digest changed ('+recorded.digest.slice(0,12)+' -> '+digest.slice(0,12)+'); rebinding '+file);
  return {checks,digest,rebound:true,previous:recorded.digest};
}
function bindAcceptance(workspace,runId,dir,checks,source){
  const binding=acceptanceBinding(checks,source);
  atomicJson(trustedAcceptanceFile(workspace,runId),{version:1,workspace,runId,sha256:binding.sha256});
  // 磁盘副本、摘要和账本必须始终是一份契约，否则下一次恢复会拿旧副本对不上新摘要。
  atomicJson(path.join(dir,'acceptance.json'),checks);
  const manifestFile=path.join(dir,'manifest.json'),manifest=readJsonIfPresent(manifestFile);
  if(manifest)atomicJson(manifestFile,{...manifest,acceptance:binding});
  return binding;
}
function acceptanceReboundRecord(acceptance,binding){
  return {at:binding.boundAt,from:acceptance.conflict
    ? acceptance.previousRecords.map(record=>record.sha256)
    : acceptance.previous,to:binding.sha256,...(acceptance.conflict?{conflict:true}:{})};
}
function goalDigest(sum) {
  return crypto.createHash('sha256').update(JSON.stringify({
    generation:sum.generation,runId:sum.runId,coordinator:sum.coordinator,tasks:sum.tasks,blocks:sum.blocks,
    results:sum.results,taskResults:sum.taskResults,
  })).digest('hex');
}
function canonicalCoordinator(workspace,value,label) {
  if(typeof value!=='string'||!value.trim()||!path.isAbsolute(value))throw new Error('Invalid '+label+' coordinator path');
  const selected=assertNoReparsePoints(path.resolve(value),label+' coordinator');
  if(physicallySameOrChild(workspace,selected))throw new Error(label+' coordinator cannot be inside the initiating workspace');
  return selected;
}
function coordinatorEquals(a,b) {
  const key=value=>process.platform==='win32'?value.toLowerCase():value;
  return key(a)===key(b);
}
function trustedSavedCoordinator(workspace,saved,explicit,{required=false}={}) {
  const trusted=explicit===undefined?undefined:canonicalCoordinator(workspace,explicit,'explicit');
  if(saved===undefined){
    if(required)throw new Error('Saved coordinator missing from recoverable ledger');
    return trusted||coordinatorDir(workspace);
  }
  const selected=canonicalCoordinator(workspace,saved,'saved');
  if(trusted){
    if(!coordinatorEquals(selected,trusted))throw new Error('Saved coordinator mismatch with explicitly trusted coordinator');
    return trusted;
  }
  const current=coordinatorDir(workspace);
  if(!coordinatorEquals(selected,current))throw new Error('Untrusted coordinator mismatch with current locator');
  return current;
}
function writeGoalMirror(dir,sum,event,status='active') {
  const todoList=buildTodoList(sum.tasks,sum.blocks,sum.taskResults);
  sum.todoList=todoList;
  atomicJson(path.join(dir,'goal.json'),{
    version:2,source:'controller-mirror',runId:sum.runId,workspace:sum.workspace,
    objective:sum.request,status,updatedAt:Date.now(),event,summaryGeneration:sum.generation,
    summaryDigest:goalDigest(sum),eventSeq:sum.eventSeq||0,executionMode:sum.executionMode||'visible',executionStatus:buildExecutionStatus(sum),tasks:todoList.map(item=>({id:item.id,status:item.status,block:item.block})),
    blocks:sum.blocks.map(block=>({key:block.key,title:block.title,status:sum.results[block.key]?.status||'pending',taskIds:block.taskIds})),
  });
}
export function refreshTaskProgress(sum){
  let changed=false;
  for(const block of sum.blocks){
    const entry=sum.results[block.key],attempt=entry?.attempts?.at(-1);
    if(!attempt||!['running','launching','awaiting-verification'].includes(entry.status))continue;
    let checkpoints;try{checkpoints=readCheckpoints(sum.workspace?resolveAttemptFile(sum,attempt.file):attempt.file,{...attempt,runId:sum.runId});}catch{continue;}
    for(const id of attempt.taskIds){
      const checkpoint=checkpoints[id];
      if(!checkpoint||checkpoint.state==='invalid'||sum.taskResults[id]?.status==='verified')continue;
      const status=checkpoint.state==='started'?'running':'awaiting-verification';
      if(sum.taskResults[id]?.status!==status||sum.taskResults[id]?.checkpoint?.updatedAt!==checkpoint.updatedAt){
        sum.taskResults[id]={status,checkpoint};changed=true;
      }
    }
  }
  return changed;
}
function resetUnverifiedTasks(sum,block) {
  for(const id of block.taskIds) {
    if(sum.taskResults[id]?.status!=='verified')sum.taskResults[id]={status:'pending'};
  }
}
function blockCheckpoints(entry,block,sum) {
  const out={};
  for(const a of entry?.attempts||[]) {
    try{Object.assign(out,readCheckpoints(sum.workspace?resolveAttemptFile(sum,a.file):a.file,{...a,runId:sum.runId}));}
    catch(error){if(error?.code!=='ENOENT')for(const id of a.taskIds)out[id]={state:'invalid'};}
  }
  // Preserve read-only verification of historical protocol-1 runs.
  if(!entry?.attempts&&entry?.receiptFile) {
    try{for(const r of JSON.parse(readUtf8Bounded(entry.receiptFile,'task receipt')||'').tasks||[]){if(block.taskIds.includes(r.id))out[r.id]=r.runId===sum.runId&&r.token===entry.token&&r.status==='completed'?{state:'completed'}:{state:'invalid'};}}catch{}
  }
  for(const id of block.taskIds) {
    if(!out[id]&&sum.taskResults[id]?.checkpoint){
      const saved=sum.taskResults[id].checkpoint;
      // Protocol 2 snapshots retain the same identity as their durable attempt.
      // Identity-free checkpoints are only compatible with historical ledgers.
      const valid=sum.protocol===2?(entry?.attempts||[]).some(a=>a.taskIds.includes(id)&&checkpointMatches(saved,{...a,runId:sum.runId},id)):
        ['started','completed'].includes(saved.state)&&(['id','runId','token'].every(key=>!Object.hasOwn(saved,key))||checkpointMatches(saved,{runId:sum.runId,token:entry?.token},id));
      out[id]=valid?saved:{state:'invalid'};
    }
    const inspected=hasParentInspection(sum.taskResults[id],id)&&(entry?.attempts||[]).some(a=>a.runId===sum.taskResults[id].inspection.runId&&a.token===sum.taskResults[id].inspection.token&&a.taskIds.includes(id));
    if(!out[id]&&sum.taskResults[id]?.status==='verified'&&!inspected)out[id]={state:'invalid'};
  }
  return out;
}
function blockStatus(ids,results) {
  const statuses=ids.map(id=>results[id]?.status);
  if(statuses.every(s=>s==='verified'))return 'verified';
  if(statuses.includes('needs-reconciliation'))return 'needs-reconciliation';
  if(statuses.includes('awaiting-verification'))return 'awaiting-verification';
  return 'failed';
}
export function collectVerification(sum,checks,workspace,{allowStarted=false,allowParentInspection=false,blockKey}={}) {
  const blocks=blockKey?sum.blocks.filter(block=>block.key===blockKey):sum.blocks;
  for(const b of blocks) {
    const e=sum.results[b.key];if(!e?.endedAt)continue;
    if(['blocked','popup-failed','preflight-failed','cancelled'].includes(e.status)&&!e.attempts?.length)continue;
    const cps=blockCheckpoints(e,b,sum);
    for(const id of b.taskIds) {
      const cp=cps[id],attempt=e.attempts?.at(-1);
      // A confirmed exit only authorizes a parent inspection when the parent
      // supplied an actual acceptance contract for this task. Without checks
      // there is no independent evidence to inspect, so a missing checkpoint
      // remains a normal failed result. This also keeps provider capacity and
      // startup failures from being relabeled as awaiting-verification.
      const parentChecks=taskPolicy(checks[id]).checks;
      const parentInspection=allowParentInspection===true&&Array.isArray(parentChecks)&&parentChecks.length>0&&e.exitConfirmed===true&&attempt?.runId===sum.runId&&attempt.taskIds.includes(id);
      if(!cp&&!parentInspection){sum.taskResults[id]={status:'failed',reason:'No durable task checkpoint or confirmed exit inspection'};continue;}
      if(cp?.state==='invalid'){sum.taskResults[id]={status:'needs-reconciliation',reason:'Invalid checkpoint',checkpoint:cp};continue;}
      if(parentInspection){
        const check=verifyChecks(taskPolicy(checks[id]).checks,workspace);
        const inspection={id,runId:sum.runId,token:attempt.token,at:Date.now()};
        sum.taskResults[id]=cp?.state==='started'&&!allowStarted
          ? {status:'needs-reconciliation',reason:'Task has a started checkpoint but no completed checkpoint; use --verify-run for explicit reconciliation',verification:check,checkpoint:cp,inspection}
          : {...check,...(cp?{checkpoint:cp}:{}),inspection,...(cp?.state==='started'?{reconciled:true}:{})};
        if(check.status==='failed')sum.taskResults[id].status='needs-reconciliation';
        continue;
      }
      const reconciled=cp.state==='started'&&(allowStarted||hasReconciledCheckpoint(sum.taskResults[id],cp,id));
      const check=verifyChecks(taskPolicy(checks[id]).checks,workspace);
      sum.taskResults[id]=check.status==='verified'&&(cp.state==='completed'||reconciled)?{...check,checkpoint:cp,...(reconciled?{reconciled:true}:{})}:
        cp.state==='started'?{status:'needs-reconciliation',reason:check.status==='verified'?'Task has no completed checkpoint; use --verify-run for explicit reconciliation':'Task started but result is unproven',verification:check,checkpoint:cp}:{...check,checkpoint:cp};
    }
    e.status=blockStatus(b.taskIds,sum.taskResults);
  }
  return sum;
}
export function verifyRun(workspace,runId,acceptanceFile,options={}) {
  const dir=runDirectory(workspace,runId),file=path.join(dir,'summary.json'),sum=readLedgerJson(file);
  if(sum.runId!==runId||!sum.finishedAt)throw new Error('Run is not finalized');
  if(!sameWorkspace(sum.workspace||'',workspace))throw new Error('Run workspace/identity mismatch');
  if(sum.protocol===2){validateRecoverySummary(sum);validateBoundRunPlan(sum);}
  const coordinator=trustedSavedCoordinator(workspace,sum.coordinator,options.coordinator,{required:sum.protocol===2});
  const claim=claimRun(coordinator,'run:'+physicalPathIdentity(dir));
  try{
    const contractFile=acceptanceFile||path.join(dir,'acceptance.json');
    const acceptance=loadBoundChecks(contractFile,dir,sum,options.override===true);
    const checks=acceptance.checks;
    if(sum.tasks?.length){
      const keyDiff=acceptanceKeyDiff(checks,sum.tasks);
      if(keyDiff?.unknown.length)throw new Error('Acceptance keys do not match any task id: '+keyDiff.unknown.join(', ')+'（task ids: '+sum.tasks.map(t=>t.id).join(', ')+'）');
      if(keyDiff?.missing.length)console.warn('[orchestrator] acceptance has no checks for task(s): '+keyDiff.missing.join(', ')+'；这些任务将停在 awaiting-verification');
    }
    // 先校验再用新契约覆盖账本：无效的 override 契约不能把原来能用的绑定改坏。
    if(acceptance.rebound){
      const binding=bindAcceptance(workspace,runId,dir,checks,path.resolve(contractFile));
      sum.acceptance=binding;
      sum.history.push({generation:sum.generation,acceptanceRebound:acceptanceReboundRecord(acceptance,binding)});
    }
    collectVerification(sum,checks,workspace,{allowStarted:true});sum.success=summaryComplete(sum,true);
    createStatusPublisher(dir).publish(sum,sum.success?'verify.completed':'verify.failed');
    writeGoalMirror(dir,sum,sum.success?'verify.completed':'verify.failed',sum.success?'completed':'failed');return sum.success;
  }
  finally{releaseRun(coordinator,'run:'+physicalPathIdentity(dir),claim);}
}

export async function runWindows(request,hooks,options={}) {
  const workspace=path.resolve(options.workspace),capacity=options.capacity;
  const authorization=options.authorization;
  if(authorization!==undefined&&(!authorization||!['read-only','workspace-write','danger-full-access'].includes(authorization.sandbox)||!['never','on-request'].includes(authorization.approval)))throw new Error('Invalid initiating authorization policy');
  // Capacity is a safety boundary shared by planning, admission and recovery.
  // Reject malformed direct API calls before creating any run state; otherwise
  // an undefined/zero value can leave a partially initialized ledger behind.
  if(!Number.isInteger(capacity)||capacity<1)throw new RangeError('capacity must be a positive integer');
  const runId=options.runId||crypto.randomUUID(),dir=runDirectory(workspace,runId),summaryFile=path.join(dir,'summary.json');
  const deadline=Date.now()+(options.timeoutMs||21600000);
  // A resumed run must stay attached to the coordinator recorded in its
  // validated ledger. New runs use the Codex-specific default locator.
  let savedResume=null,savedResumeRaw;
  if(options.resume){
      savedResumeRaw=readUtf8Bounded(summaryFile,'run summary');savedResume=parseLedger(summaryFile,savedResumeRaw);
    if(savedResume.protocol!==2||!Array.isArray(savedResume.plan))throw new Error('This run has no recoverable task checkpoints');
    if((savedResume.agent||'codex')!==(options.agent||'codex'))throw new Error('Resume agent must match the saved run');
    if(options.executionMode&&(savedResume.executionMode||'visible')!==options.executionMode)throw new Error('Resume execution mode must match the saved run');
    if(!sameWorkspace(savedResume.workspace,workspace)||savedResume.runId!==runId)throw new Error('Run workspace/identity mismatch');
    validateRecoverySummary(savedResume);
    if(JSON.stringify(savedResume.authorization??null)!==JSON.stringify(authorization??null))throw new Error('Run authorization policy mismatch; refusing to widen or change a resumed run');
    trustedSavedCoordinator(workspace,savedResume.coordinator,options.coordinator,{required:true});
    const savedGoalFile=path.join(dir,'goal.json');
    if(fs.existsSync(savedGoalFile)){
      const savedGoal=JSON.parse(readUtf8Bounded(savedGoalFile,'run goal')||'');
      if(savedGoal.runId!==runId||!sameWorkspace(savedGoal.workspace||'',workspace))throw new Error('Run goal mirror identity mismatch');
      // The goal is only a mirror; a crash may interrupt its last replacement.
      if(savedGoal.version===2&&savedGoal.summaryDigest!==goalDigest(savedResume))console.warn('[resume] rebuilding stale goal mirror from the validated ledger');
    }
    if(savedResume.blocks.length>capacity)throw new Error('Current memory capacity is below the saved block count');
    validateBoundRunPlan(savedResume,{required:true});
  }
  const coordinator=options.resume
    ?trustedSavedCoordinator(workspace,savedResume.coordinator,options.coordinator,{required:true})
    :(options.coordinator===undefined?coordinatorDir(workspace):canonicalCoordinator(workspace,options.coordinator,'explicit'));
  const runKey='run:'+physicalPathIdentity(dir),claim=await coordinate(()=>claimRun(coordinator,runKey),deadline);
  let sum,progressTimer,progressError;
  try {
    let checks,acceptance={checks:null,rebound:false};
    if(options.resume) {
      if(readUtf8Bounded(summaryFile,'run summary')!==savedResumeRaw)throw new Error('Run changed while acquiring recovery ownership; retry resume');
      sum=savedResume;
      // 恢复同样要复用被绑定的契约：执行窗改掉 acceptance.json 就能让未完成的任务被当成已验收。
      acceptance=loadBoundChecks(options.acceptanceFile||path.join(dir,'acceptance.json'),dir,savedResume,options.acceptanceOverride===true);
      checks=acceptance.checks;
      sum.history.push({generation:sum.generation,finishedAt:sum.finishedAt,success:sum.success});
      sum.generation++;delete sum.finishedAt;sum.success=false;
    }else {
      if(fs.existsSync(dir))throw new Error('Run ID already exists; use --resume-run or --verify-run');
      fs.mkdirSync(dir,{recursive:true});checks=loadChecks(options.acceptanceFile);
      const inventory=requestTasks(request);
      const manifest={runId,workspace,request,executionMode:options.executionMode||'visible',tasks:inventory,todoList:buildTodoList(inventory),startedAt:Date.now()};
      atomicJson(path.join(dir,'manifest.json'),manifest);
      options.onEvent?.({...manifest,type:'plan.started',executionStatus:[]});
      const candidate=await hooks.plan(request,capacity);
      const memoryBudget=options.memoryBudget;
      // Memory affects launch admission only. The dependency/conflict plan is
      // immutable so waiting never changes which work is serial or parallel.
      const {plan,tasks}=ledgerPlan(request,candidate,capacity,hooks.compact);
      const recs=plan.map((b,i)=>({key:`B${i+1}`,title:b.title,b,dependsOn:b.dependsOn||[],keys:admissionKeys(b,workspace,hooks.infer)}));
      levelWaves(recs);
      sum={protocol:2,version:CORE_VERSION,agent:options.agent||'codex',executionMode:options.executionMode||'visible',authorization,runId,workspace,request,capacity,coordinator,generation:1,history:[],startedAt:Date.now(),tasks,plan:recs,
        memoryBudget:memoryBudget?{mode:memoryBudget.mode,reserveMB:memoryBudget.floorMB,windowCostMB:memoryBudget.windowCostMB,headroom:memoryBudget.headroom||1}:undefined,
        blocks:recs.map(r=>({key:r.key,title:r.title,taskIds:r.b.tasks.flatMap(t=>t.sourceIds)})),results:{},taskResults:{},todoList:[]};
      // dynamic 模式下 capacity 只是安全边界；账本记录真实块数，便于宿主与验收读取。
      if(memoryBudget?.mode==='dynamic')sum.capacity=sum.blocks.length;
      for(const r of recs){sum.results[r.key]={status:'pending',attempts:[]};for(const id of sum.blocks.find(b=>b.key===r.key).taskIds)sum.taskResults[id]={status:'pending'};}
    }
    if(options.memoryBudget)options.memoryBudget.taskCosts=Object.fromEntries(Object.entries(checks||{}).map(([id,value])=>[id,{memoryMB:Number(value?.memoryMB||0)}]));
    sum.owner=claim.owner;sum.coordinator=coordinator;
    const refreshTodoList=()=>{sum.todoList=buildTodoList(sum.tasks,sum.blocks,sum.taskResults);};
    const verificationQueue=createVerificationQueue();
    refreshTodoList();
    {
      const keyDiff=acceptanceKeyDiff(checks,sum.tasks);
      if(keyDiff?.unknown.length)throw new Error('Acceptance keys do not match any task id: '+keyDiff.unknown.join(', ')+'（task ids: '+sum.tasks.map(t=>t.id).join(', ')+'）');
      if(keyDiff?.missing.length)console.warn('[orchestrator] acceptance has no checks for task(s): '+keyDiff.missing.join(', ')+'；这些任务将停在 awaiting-verification');
    }
    {
      const binding=bindAcceptance(workspace,runId,dir,checks,options.acceptanceFile?path.resolve(options.acceptanceFile):path.join(dir,'acceptance.json'));
      sum.acceptance=binding;
      if(acceptance.rebound)sum.history.push({generation:sum.generation,acceptanceRebound:acceptanceReboundRecord(acceptance,binding)});
    }
    if(!options.resume)bindRunPlan(sum);
    const publisher=createStatusPublisher(dir,{onEvent:options.onEvent});
    const persist=(event='run.updated')=>{
      publisher.publish(sum,event);
      writeGoalMirror(dir,sum,event,sum.finishedAt?(sum.success?'completed':'failed'):'active');
    };
    const mark=(r,status,reason)=>{
      sum.results[r.key]={...sum.results[r.key],status,reason};
      if(!['waiting','launching','running','reserved','retrying','deferred'].includes(status))for(const id of sum.blocks.find(b=>b.key===r.key).taskIds)if(!['verified','needs-reconciliation','awaiting-verification'].includes(sum.taskResults[id]?.status))sum.taskResults[id]={...sum.taskResults[id],status,reason};
      persist(`block.${r.key}.${status}`);
    };
    const inspectBlock=(b,e)=>verificationQueue.enqueue(b.key,async()=>{
      let inspectionError=null;
      try{collectVerification(sum,checks,workspace,{blockKey:b.key,allowParentInspection:true});}
      catch(error){
        inspectionError=error;e.status='failed';e.reason='Parent verification failed: '+(error?.message||String(error));
        for(const id of b.taskIds)sum.taskResults[id]={status:'needs-reconciliation',reason:e.reason};
      }
      const report={at:Date.now(),block:b.key,status:e.status,error:inspectionError?.message||null,tasks:b.taskIds.map(id=>({id,result:sum.taskResults[id]}))};
      try{
        fs.appendFileSync(path.join(dir,'verification-report.jsonl'),JSON.stringify(report)+'\n','utf8');
        e.inspectedToken=e.attempts?.at(-1)?.token;
      }catch(error){
        e.status='failed';e.reason='Parent verification report could not be appended: '+(error?.message||String(error));
        for(const id of b.taskIds)sum.taskResults[id]={status:'needs-reconciliation',reason:e.reason};
        console.error('[orchestrator] '+e.reason);
      }
      persist(`block.${b.key}.${e.status}`);
    });
    persist(options.resume?'run.resumed':'plan.created');
    progressTimer=setInterval(()=>{try{if(refreshTaskProgress(sum))persist('task.progress');}catch(error){progressError=error;clearInterval(progressTimer);}},250);
    console.log(`[run] runId=${runId} mode=${sum.executionMode||'visible'} blocks=${sum.blocks.length} capacity=${capacity} generation=${sum.generation} summary=${displaySummaryPath(summaryFile)}`);
    async function execute(r) {
      const b=sum.blocks.find(b=>b.key===r.key),tasks=b.taskIds.map(id=>sum.tasks.find(t=>t.id===id));
      const identify=(pid,pidFile)=>hooks.identity?hooks.identity(pid,pidFile):launcherIdentity(pid,pidFile);
      const waitExit=identity=>hooks.waitForExit?hooks.waitForExit(identity):waitForProcessExit(identity);
      const leaseId=crypto.createHash('sha256').update(runKey).digest('hex').slice(0,16)+'-'+r.key;
      let attemptsThisController=0;
      const limit=Math.max(1,Math.min(3,Number(options.maxAttempts||2)));
      let capacityRetries=0;
      let memTimer=null,memStats=null;
      while(Date.now()<deadline) {
        if(progressError)throw progressError;
        let e=sum.results[r.key],la=e.launcherFiles,identity;
        if(la)validateSavedLauncherFiles(sum,b,e,e.attempts?.at(-1),{requireLiveFiles:['launching','running','awaiting-verification'].includes(e.status)});
        // 没有 pid 文件就没有可认领的启动器；这里不查进程表，省掉一次昂贵的 CIM 枚举。
        if(la&&fs.existsSync(la.pidf))identity=await identifyWithRetry(identify,hooks.readPid(la.pidf),la.pidf);
        const adopted=identity&&(!e.launcher||sameProcess(e.launcher,identity));
        let active;
        if(adopted) {
          active=e.attempts.at(-1);console.log(`[resume] adopting live ${r.key}; no duplicate window`);
          hooks.ready?.(la);
        }else {
          const cps=blockCheckpoints(e,b,sum);
          const recovery=recoveryTasks(tasks,cps,checks,workspace,sum.taskResults);
          Object.assign(sum.taskResults,recovery.results);
          if(recovery.verified.length===tasks.length){e.status='verified';e.endedAt=Date.now();persist(`block.${r.key}.verified`);return;}
          if(recovery.uncertain.length){e.status='needs-reconciliation';e.reason='Uncertain tasks: '+recovery.uncertain.join(', ');e.endedAt=Date.now();persist(`block.${r.key}.needs-reconciliation`);return;}
          if(attemptsThisController>=limit){mark(r,'failed','Safe recovery attempt budget exhausted');return;}
          if(attemptsThisController)await pause(Math.min(2000*attemptsThisController,Math.max(0,deadline-Date.now())));
          const memoryBudget=options.memoryBudget;
          let cost=memoryBudget&&memoryBudget.mode==='dynamic'
            ?Math.ceil(blockCostFor(sum,r.key,memoryBudget)*(memoryBudget.headroom||1)):0;
          const memoryAdmission=memoryBudget&&memoryBudget.mode==='dynamic'
            ?(leases,rec,snapshot)=>admissionOk({availableMB:availableMB(),runningCostMB:unconsumedReservationMB(leases,snapshot),blockCostMB:rec.memoryCostMB,floorMB:memoryBudget.floorMB})
            :undefined;
          let reserved=false;
          while(Date.now()<deadline) {
            if(memoryBudget?.mode==='dynamic')cost=Math.ceil(blockCostFor(sum,r.key,memoryBudget)*(memoryBudget.headroom||1));
            const result=await coordinate(()=>reserve(coordinator,{id:leaseId,runId,keys:r.keys,memoryCostMB:cost},capacity,undefined,memoryAdmission),deadline);
            if(result.ok){reserved=true;break;}
            const reason=result.reason==='memory'?`Waiting for memory: available ${availableMB()}MB, predicted peak ${cost}MB, reserve ${memoryBudget.floorMB}MB`:'Waiting for '+result.reason;
            mark(r,result.reason==='memory'?'deferred':'waiting',reason);await pause(1000);
          }
          if(!reserved){mark(r,'timeout','Window capacity/resource wait timed out');return;}
          attemptsThisController++;
          const number=e.attempts.length+1,token=runId+'-'+r.key+'-a'+number+'-'+crypto.randomBytes(6).toString('hex');
          const attemptFile=path.join(dir,'attempts',r.key,String(number),'attempt.json');
          active={file:attemptFile,runId,token,number,taskIds:recovery.pending,createdAt:Date.now()};
          atomicJson(attemptFile,active);e.attempts.push(active);
          const helper=fileURLToPath(new URL('./checkpoint.mjs',import.meta.url));
          const command=(id,state)=>checkpointCommand(helper,attemptFile,id,state);
          const todoList=buildTodoList(sum.tasks,sum.blocks,sum.taskResults);
          const body=options.auth+'\n本执行块目录为 '+workspace+'；所有工具 workdir 保持此目录，除非原始任务明确另指定。\n'+
            'Global TodoList (controller-owned; do not rewrite):\n'+todoListText(todoList)+'\n\nCurrent block TodoList ('+r.key+'):\n'+todoListText(todoList,r.key)+'\n'+
            '严格按下列先后顺序执行本块列出的全部待办任务：不得跳过、不得重排、不得只做其中一部分就收尾。每项开始前必须成功执行 started 命令，失败则停止该项，禁止重复执行。完成并自验后立即执行 completed 命令。每项都立即写检查点，不能等整块完成。若某项的命令需要等待（例如等待外部信号、长任务返回或前置条件出现），必须持续等待该项结束，不得因为等待而跳过它去执行后面的任务。本块列出的每一项都写上 completed 检查点之后，才允许结束本窗；任何项失败则停止后续任务，说明情况并退出本轮，不自行重跑整块。\n'+
            '已独立验收的任务禁止重做：'+recovery.verified.join(', ')+'\n'+
            recovery.pending.map(id=>`任务 ${id}\n开始前：${command(id,'started')}\n原始任务：${tasks.find(t=>t.id===id).prompt}\n完成自验后：${command(id,'completed')}`).join('\n\n')+
            '\n本块列出的全部待办都已分别写入 completed 检查点后，最后仅输出 __ORCH_DONE__ '+token;
          try{la=hooks.launcher(r.key,hooks.prompt(body,token),runId+'-a'+number,{attemptFile,runId,token,taskIds:recovery.pending});}
          catch(error){await coordinate(()=>release(coordinator,leaseId),deadline);throw error;}
          e={...e,status:'launching',launchFailed:false,leaseId,token,launcherFiles:la,launcher:null,endedAt:null,exitConfirmed:false,startedAt:Date.now(),reason:'',retryAt:null};sum.results[r.key]=e;persist(`block.${r.key}.launching`);
          try {
            hooks.register({id:leaseId,runId,title:r.title,keys:r.keys,pidFile:la.pidf,pid:0,pending:true,reservedAt:Date.now()});
            await coordinate(()=>prepare(coordinator,leaseId,la.pidf),deadline);
            // Keep the launcher retry budget owned by the runner's caller. A
            // hard-coded one-shot spawn made transient WT/provider startup
            // failures collapse an otherwise full-capacity wave into a single
            // live window, then produced incomplete receipts.
            const spawnRetries=Math.max(1,Math.min(5,Number(options.windowMaxRetry??3)||3));
            if(!await hooks.spawn(la.lp,r.title,la.pidf,spawnRetries,token))throw new Error('Execution process did not start');
            identity=await identifyWithRetry(identify,hooks.readPid(la.pidf),la.pidf);
            if(!identity)throw new Error('Launcher process identity mismatch');
            await coordinate(()=>bind(coordinator,leaseId,identity),deadline);hooks.commit?.(leaseId,identity.ProcessId);
            hooks.ready?.(la);
          }catch(error){e.status='popup-failed';e.reason=error.message;e.launchFailed=true;
            // Admission failed after a worker was created: signal it before releasing
            // the lease, then wait for the worker's durable result/exit. A blocked go
            // latch must never remain as an orphan or be adopted as a running block.
            try{if(identity)await hooks.close(identity.ProcessId,identity);else if(la)await hooks.close(hooks.readPid(la.pidf));}catch{}
          }
        }
        e=sum.results[r.key];e.launcher=identity||e.launcher;
        let capacityRetry = null;
        try {
          if(identity&&!e.launchFailed) {
            e.status='running';
            // Publish the controller-owned execution state immediately after
            // the launcher is authenticated. A fast worker may write its
            // first checkpoint before the periodic progress sampler runs;
            // the host still needs one durable running view for every pending
            // task. Verification continues to require the durable checkpoint.
            const firstPending=b.taskIds.find(id=>sum.taskResults[id]?.status==='pending');
            if(firstPending)sum.taskResults[firstPending]={status:'running'};
            refreshTaskProgress(sum);persist(`block.${r.key}.running`);
            // 采样本窗进程树的工作集峰值与可用内存最低点，供滚动修正每窗成本。
            memStats={startAvailable:availableMB(),peakProcessMB:0,minAvailable:Infinity};
            memTimer=setInterval(()=>{
              try{
                const snapshot=processSnapshot();
                memStats.peakProcessMB=Math.max(memStats.peakProcessMB,treeWorkingSetMB(snapshot,identity.ProcessId));
                memStats.minAvailable=Math.min(memStats.minAvailable,availableMB());
              }catch{/* 采样失败不影响执行 */}
            },5000);
            // Session rollouts can be created well after the visible window is
            // confirmed (provider/model cold start). Bound discovery by the
            // run deadline, not an arbitrary 90-second cutoff that closes a
            // healthy task before its first rollout event exists.
            const session=await hooks.session('【本块唯一标识】'+active.token,Math.max(0,deadline-Date.now()),la.rf);
            // The visible watchdog can close before session discovery returns.
            // Its exit marker proves execution ended; task success still requires
            // the independent checkpoint and receipt checks below.
            const result=session?await hooks.wait(session,Math.max(0,deadline-Date.now()),la.rf,'【本块唯一标识】'+active.token,la.pidf):{done:fs.existsSync(la.rf)||fs.existsSync(la.rf+'.self-closed'),exitCode:hooks.exitCode(la.rf)};
            e.exitCode=result.exitCode??hooks.exitCode(la.rf);
            e.status=result.done?'awaiting-verification':e.exitCode!=null?'failed':'timeout';
            if(!session||!result.done||result.verified===false||(e.exitCode!=null&&e.exitCode!==0)){
              active.diagnostic={sessionFound:Boolean(session),launcherFinished:Boolean(result.done),reportCaptured:result.verified===true,
                launcherExitCode:e.exitCode??null,selfCloseMarkerPresent:fs.existsSync(la.rf+'.self-closed')};
            }
            if(result.threadId)active.threadId=result.threadId;
            if(!result.done&&result.text)e.reason=result.text;
            // The worker may have flushed its final completed checkpoint just
            // before the durable result became visible. Refresh before
            // publishing the awaiting-verification transition so host readers
            // never miss that live task state.
            refreshTaskProgress(sum);
            persist(`block.${r.key}.${e.status}`);
            if (result.retryable === 'capacity') {
              e.retryable = 'capacity';
              e.capacityError = result.capacityError || result.text || 'provider capacity';
              capacityRetry = capacityRetryPolicy(e.capacityError, capacityRetries + 1);
            }
            if (result.retryable === 'quota') {
              e.retryable = 'quota';
              e.quotaError = result.quotaError || result.text || 'provider usage limit';
            }
          }
        }catch(error){e.status='failed';e.reason=error.message;}
        finally {
          if(memTimer){clearInterval(memTimer);memTimer=null;}
          if(memStats&&options.memoryBudget?.mode==='dynamic'){
            const observed=observedCostMB({processPeakMB:memStats.peakProcessMB,availableDeltaMB:(Number.isFinite(memStats.minAvailable)?memStats.startAvailable-memStats.minAvailable:0)});
            e.peakProcessMB=memStats.peakProcessMB;
            e.peakAvailableDropMB=Number.isFinite(memStats.minAvailable)?memStats.startAvailable-memStats.minAvailable:0;
            if(observed>0&&identity&&!e.launchFailed){
              e.observedCostMB=observed;
              const stateFile=options.memoryBudget.stateFile;
              if(stateFile){const next=updateRollingCost(loadBudgetState(stateFile),{observedMB:observed});saveBudgetState(stateFile,next);options.memoryBudget.windowCostMB=next.windowCostMB;console.log(`[orchestrator] window cost rolling update -> ${next.windowCostMB}MB (observed ${observed}MB, samples ${next.samples})`);}
            }
            memStats=null;
          }
          if(!identity&&la&&fs.existsSync(la.pidf)){
            // 身份枚举是瞬时故障源（Windows CIM / 互斥体在机器繁忙时会超时）。它绝不能
            // 从 finally 里抛出去，把一次枚举抖动变成任务级终态失败：保留租约、给出真因，
            // 交给 --resume-run 接管。
            try{identity=await identifyWithRetry(identify,hooks.readPid(la.pidf),la.pidf);}
            catch(error){
              e.status='failed';e.reason='Process identity enumeration failed: '+(error&&error.message?error.message:error);
              e.endedAt=Date.now();persist();return;
            }
          }
          if(identity)await hooks.close(identity.ProcessId,identity);
          if(identity&&!(await waitExit(identity))){
            // Keep the lease for resume/adoption, but never leave tasks at their
            // initial pending state when a durable checkpoint is already present.
            refreshTaskProgress(sum);
            const uncertain=blockCheckpoints(e,b,sum);
            for(const id of b.taskIds)if(uncertain[id]?.state==='started')sum.taskResults[id]={status:'needs-reconciliation',reason:'Launcher exit is unproven; reconcile before retrying',checkpoint:uncertain[id]};
            e.status='failed';e.reason='Launcher still alive; lease retained';e.endedAt=Date.now();persist();return;
          }
          await coordinate(()=>release(coordinator,e.leaseId||leaseId),Date.now()+30000);
          e.exitConfirmed=!!identity;
          hooks.unregister(e.leaseId||leaseId);if(la)hooks.cleanup(la);
          e.endedAt=Date.now();active.endedAt=e.endedAt;active.exitCode=e.exitCode;
          // A provider-capacity failure is retryable only before any task has a
          // durable side-effect checkpoint. Do not publish the reconciliation
          // status before the safe retry branch below; status events are
          // monotonic and would make the retry transition invalid.
          const finalCheckpoints=blockCheckpoints(e,b,sum);
          const finalRetryUnsafe=Object.values(finalCheckpoints).some(cp=>cp?.state==='started'||cp?.state==='completed');
          if(!(capacityRetry?.retry&&!finalRetryUnsafe))await inspectBlock(b,e);
        }
        // A capacity failure happens before any task checkpoint. Reclaim the window and
        // retry after the provider's suggested/backoff delay without consuming the normal
        // safe-recovery attempt budget. Once a task started, recoveryTasks above prevents
        // this path from retrying an unproven side effect.
        const retryCheckpoints=blockCheckpoints(e,b,sum);
        const retryUnsafe=Object.values(retryCheckpoints).some(cp=>cp?.state==='started'||cp?.state==='completed');
        if (capacityRetry?.retry && !retryUnsafe) {
          capacityRetries++;
          attemptsThisController=Math.max(0,attemptsThisController-1);
          resetUnverifiedTasks(sum,b);refreshTodoList();
          e.status='waiting';e.reason=`Provider capacity; retry ${capacityRetries}/${capacityRetry.maxRetries} in ${capacityRetry.delayMs}ms`;e.retryAt=Date.now()+capacityRetry.delayMs;
          delete e.retryable;delete e.capacityError;
          persist(`block.${r.key}.capacity-retry`);
          await pause(Math.min(capacityRetry.delayMs,Math.max(0,deadline-Date.now())));
          continue;
        }
        if(e.status==='verified')return;
        if(e.retryable==='quota') { mark(r,'failed',e.quotaError||'Provider usage limit; retry after quota reset');return; }
        if(e.retryable==='capacity') { mark(r,'failed',retryUnsafe?'Provider capacity after a task checkpoint; reconcile before retrying':'Provider capacity retry budget exhausted');return; }
        // Popup/launcher interruptions have no task checkpoint, so the bounded controller
        // attempt budget retries the block automatically. Only started or completed checkpoints
        // can move a task into needs-reconciliation and stop blind replay.
      }
      mark(r,'timeout','Run deadline exhausted');
    }
    await scheduleReady(sum.plan,async r=>{try{await execute(r);}catch(e){mark(r,'failed',e.message);}},key=>sum.results[key]?.status,
      (r,failed)=>mark(r,'blocked','Predecessors not verified: '+failed.join(', ')));
    sum.finalSweep=await sweepRunProcesses(sum,{
      close:hooks.close,identify:hooks.identity||launcherIdentity,waitForExit:hooks.waitForExit||waitForProcessExit,
      onClosed:async(b,e,attempt,{wasConfirmed})=>{
        e.endedAt ||= Date.now();attempt.endedAt ||= e.endedAt;
        if(!wasConfirmed){
          await coordinate(()=>release(coordinator,e.leaseId),Date.now()+30000);
          hooks.unregister(e.leaseId);hooks.cleanup(e.launcherFiles);
        }
        if(e.inspectedToken!==attempt.token)await inspectBlock(b,e);
      },
      onFailed:(_b,e)=>persist('run.cleanup-failed'),
    });
    for(const r of sum.plan)if(!TERMINAL.has(sum.results[r.key]?.status))mark(r,'failed','No terminal result');
    await verificationQueue.drain();
    sum.verification=verificationQueue.stats();
    if(progressError)throw progressError;
    clearInterval(progressTimer);
    sum.finishedAt=Date.now();sum.success=summaryComplete(sum,true);persist(sum.success?'run.completed':'run.failed');
    if(sum.success&&hooks.cleanupCompleted){
      const warnings=await hooks.cleanupCompleted(sum);
      if(warnings?.length){sum.cleanupWarnings=warnings;persist('run.cleanup-warning');}
    }
    console.log(`[run] finalized runId=${runId} success=${sum.success} summary=${displaySummaryPath(summaryFile)}`);return sum;
  }finally{clearInterval(progressTimer);await coordinate(()=>releaseRun(coordinator,runKey,claim),Date.now()+30000);}
}
