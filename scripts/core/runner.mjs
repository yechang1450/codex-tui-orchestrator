import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {CORE_VERSION,ledgerPlan,levelWaves,verifyChecks,summaryComplete,TERMINAL,canonicalKey,requestTasks,acceptanceKeyDiff,buildTodoList,todoListText,canonicalDigest,jsonProblem,describeShape} from './contracts.mjs';
import {coordinatorDir,reserve,bind,release,releaseMatchingLease,prepare,atomicJson,isProcessIdentityBinding,launcherIdentity,processIdentityBinding,processSnapshot,tryBackgroundProcessSnapshot,sameProcess,claimRun,releaseRun,readUtf8Bounded,publicLeaseKeys,assertDeadlineAvailable,reservationAcknowledgement} from './leases.mjs';
import {scheduleReady,recoveryTasks,taskPolicy,validateRecoverySummary,validatePersistedCleanupJournals,hasAuthenticatedExitProof,hasBoundLeaseInstance,hasNoProcessProof,hasReconciledCheckpoint,hasParentInspection,resolveAttemptFile,validateSavedLauncherFiles} from './recovery.mjs';
import {readCheckpoints,checkpointMatches} from './checkpoint.mjs';
import {capacityRetryPolicy} from './retry-policy.mjs';
import {availableMB, admissionOk, unconsumedReservationMB, blockCostMB as budgetBlockCostMB, DEFAULT_WINDOW_COST_MB, observedCostMB, loadBudgetState, saveBudgetState, updateRollingCost} from './memory-budget.mjs';
import {createRunMemorySampler} from './memory-sampler.mjs';
import {createVerificationQueue} from './verification-queue.mjs';
import {assertNoReparsePoints,physicallySameOrChild,physicalPathIdentity} from './runtime-context.mjs';
import {controllerStateDir,assertPrivateControllerRoot} from './controller-state.mjs';
import {beginCleanupTransactionMarkerPhase,cleanupTransactionStatusDigests,createCleanupTransactionMarker,deleteCleanupTransactionMarker,readCleanupTransactionMarkerForRecovery,updateCleanupTransactionMarker,updateCleanupTransactionStatusAuthority,writeCleanupTransactionMarker} from './cleanup-transaction.mjs';
import {redactDeep,redactedProjection,isSensitiveObjectKey,isPublicRunnerAuthorization,isCredentialShapedText} from './redaction.mjs';
import {writePrivateRunState,readPrivateRunState} from './private-run-state.mjs';
import {readWorkspaceText,WORKSPACE_READ_LIMITS} from './safe-workspace-read.mjs';

function blockCostFor(sum, key, budget) {
  const block = (sum.blocks || []).find(item => item.key === key);
  return budgetBlockCostMB(block, budget.windowCostMB, budget.taskCosts || {});
}

/**
 * Order only the launch queue; the durable plan remains in planner order.
 * Higher predicted memory enters the reservation/launcher path first so a
 * long-running heavy block does not become the last tail of an otherwise
 * finished wave. Dependencies are still enforced by scheduleReady.
 */
export function orderLaunchPlan(sum, plan, budget) {
  if (!Array.isArray(plan) || budget?.mode !== 'dynamic') return plan;
  const rawWindowCost = Number(budget.windowCostMB);
  const windowCostMB = Number.isFinite(rawWindowCost) && rawWindowCost > 0
    ? rawWindowCost
    : DEFAULT_WINDOW_COST_MB;
  const rawHeadroom = Number(budget.headroom);
  const headroom = Number.isFinite(rawHeadroom) && rawHeadroom >= 1 ? rawHeadroom : 1;
  const ranked = plan.map((record, index) => ({
    record,
    index,
    cost: Math.ceil(blockCostFor(sum, record.key, {...budget, windowCostMB}) * headroom),
  }));
  ranked.sort((left, right) => right.cost - left.cost || left.index - right.index);
  return ranked.map(item => item.record);
}

// A boolean false from a launcher is ambiguous unless the launcher adapter
// independently proved that no owned process exists. Keep that distinction
// explicit so a delayed PID/result cannot be mistaken for a clean spawn miss.
export function classifySpawnResult(result,observed=false){
  const spawned=result===true||result?.ok===true;
  const noProcess=!spawned&&result?.noProcess===true&&!observed;
  return {spawned,noProcess,unknown:!spawned&&!noProcess};
}

// Always union explicit planner hints with deterministic inference. Empty or
// partial conflictKeys from raw, custom, or fallback plans must not bypass the
// safety check; command-input inference itself excludes only proven read-only
// interpreter operands.
export function admissionKeys(block, workspace, infer, scopeDir) {
  const explicit = Array.isArray(block?.conflictKeys) ? block.conflictKeys : [];
  const inferred = (block?.tasks || []).flatMap(task => infer(task.prompt || ''));
  return publicLeaseKeys([...explicit, ...inferred].map(key => canonicalKey(key, workspace)),{scopeDir,cwd:workspace});
}
import {createStatusPublisher,buildExecutionStatus,readRunStatus,authorizeAcceptanceStatusOverride,createCleanupStatusAuthorityBinding,repairStatusAuthorityFromCleanupMarker} from './status-events.mjs';
export {scheduleReady,recoveryTasks};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function validAbsoluteDeadline(value) {
  return typeof value==='number'&&Number.isSafeInteger(value);
}
function validateAbsoluteDeadline(value,label) {
  if(value===undefined||value===null)return undefined;
  if(!validAbsoluteDeadline(value))throw new TypeError(label+' must be an absolute integer timestamp');
  return value;
}
function deadlineExpired(error) {
  return error?.code==='ORCH_DEADLINE_EXHAUSTED';
}
function requireDeadline(deadlineAt,stage,now=Date.now) {
  return assertDeadlineAvailable(deadlineAt,stage,{now});
}
function remainingBeforeDeadline(deadlineAt,stage,now=Date.now) {
  requireDeadline(deadlineAt,stage,now);
  return deadlineAt-now();
}
function deadlineIsAvailable(deadlineAt,stage,now=Date.now) {
  try{requireDeadline(deadlineAt,stage,now);return true;}
  catch(error){if(deadlineExpired(error))return false;throw error;}
}
async function pauseBeforeDeadline(delayMs,deadlineAt,stage,{now=Date.now,pauseMs=pause}={}) {
  const remaining=remainingBeforeDeadline(deadlineAt,stage,now);
  const delay=Math.min(Math.max(0,Number(delayMs)||0),remaining);
  if(delay>0)await pauseMs(delay);
  requireDeadline(deadlineAt,stage,now);
}
function callWithDeadline(callback,args,deadlineAt,receiver) {
  const invoke=values=>receiver===undefined?callback(...values):callback.call(receiver,...values);
  return deadlineAt===undefined||deadlineAt===null
    ?invoke(args)
    :invoke([...args,{deadlineAt}]);
}

// Adapters are objects, not a bag of detached callbacks.  Several supported
// adapters intentionally use sibling methods through `this` (for example,
// headless `close` delegates to its own `waitForExit`).  Bind every accessed
// hook once at the runner boundary so deadline wrappers, retry helpers, and
// the final sweep preserve that receiver consistently.
function receiverBoundHooks(hooks) {
  if(!hooks||typeof hooks!=='object')throw new TypeError('Execution hooks must be an object');
  const cache=new Map();
  // The facade is deliberately a fresh extensible object. Proxying a frozen
  // adapter directly would violate JavaScript's non-configurable property
  // invariant when a function is replaced by its bound form.
  return new Proxy(Object.create(null),{get(_facade,key){
    const value=Reflect.get(hooks,key,hooks);
    if(typeof value!=='function')return value;
    const prior=cache.get(key);
    if(prior?.value===value)return prior.bound;
    const bound=Function.prototype.bind.call(value,hooks);
    cache.set(key,{value,bound});
    return bound;
  }});
}

const EXECUTION_HOOK_DEADLINE_UNCERTAIN='ORCH_EXECUTION_HOOK_DEADLINE_UNCERTAIN';
function executionHookDeadlineError(stage) {
  const error=new Error('Execution hook deadline elapsed during '+stage+'; recovery files and lease retained');
  error.code=EXECUTION_HOOK_DEADLINE_UNCERTAIN;
  error.stage=stage;
  return error;
}
function executionHookDeadlineUncertain(error) {
  return error?.code===EXECUTION_HOOK_DEADLINE_UNCERTAIN;
}

// Spawn, session discovery, and completion waiting each cross an adapter
// boundary.  Passing an absolute deadline alone lets an adapter ignore it and
// hold the controller forever.  A timer gives the controller a bounded return
// path, while AbortSignal lets cooperative adapters stop their own polling.
// The timeout result deliberately means "uncertain", never "not started": a
// late adapter may still create or observe a process after the controller has
// returned, so callers must retain the lease and recovery material.
async function executionHookWithDeadline(callback,args,deadlineAt,stage,{now=Date.now,receiver}={}) {
  validateAbsoluteDeadline(deadlineAt,stage+' deadlineAt');
  requireDeadline(deadlineAt,stage,now);
  const remaining=Math.max(0,deadlineAt-now());
  const timeoutMs=Math.min(remaining,0x7fffffff);
  const controller=new AbortController();
  const context=Object.freeze({deadlineAt,signal:controller.signal,stage});
  const wallDeadline=Date.now()+timeoutMs;
  let timer,timedOut=false;
  const expiration=new Promise((_,reject)=>{
    timer=setTimeout(()=>{
      timedOut=true;
      controller.abort();
      reject(executionHookDeadlineError(stage));
    },timeoutMs);
  });
  const work=Promise.resolve().then(()=>{
    // Promise microtasks run before an expired setTimeout callback.  Recheck
    // immediately before crossing the external adapter boundary so a deadline
    // that crossed after the caller's first check cannot start a new window,
    // worker, or polling operation.
    if(timedOut||controller.signal.aborted||now()>=deadlineAt||Date.now()>=wallDeadline){
      controller.abort();
      throw executionHookDeadlineError(stage);
    }
    return receiver===undefined?callback(...args,context):callback.call(receiver,...args,context);
  });
  // The timer may win before a non-cooperative adapter eventually rejects.
  // Observe that late rejection so it cannot become an unhandled process-level
  // failure after the durable reconciliation decision has been made.
  work.catch(()=>{});
  try{
    const result=await Promise.race([work,expiration]);
    // A synchronous/blocking adapter can prevent the timer callback from
    // running.  Re-check both clocks before accepting its result.
    if(timedOut||controller.signal.aborted||now()>=deadlineAt||Date.now()>=wallDeadline){
      controller.abort();
      throw executionHookDeadlineError(stage);
    }
    return result;
  }catch(error){
    if(timedOut||controller.signal.aborted||now()>=deadlineAt||Date.now()>=wallDeadline){
      controller.abort();
      if(executionHookDeadlineUncertain(error))throw error;
      throw executionHookDeadlineError(stage);
    }
    throw error;
  }finally{
    if(timer!==undefined)clearTimeout(timer);
  }
}

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
export async function identifyWithRetry(identify,pid,pidFile,{attempts=3,pauseMs=ms=>pause(ms),deadlineAt,now=Date.now}={}){
  const limit=Math.max(1,Number(attempts)||1);
  let lastError;
  for(let i=0;i<limit;i++){
    if(deadlineAt!==undefined&&deadlineAt!==null)requireDeadline(deadlineAt,'launcher identity retry',now);
    try{return identify(pid,pidFile);}
    catch(error){
      lastError=error;
      if(i+1<limit){
        if(deadlineAt===undefined||deadlineAt===null)await pauseMs(300*(i+1));
        else await pauseBeforeDeadline(300*(i+1),deadlineAt,'launcher identity retry',{now,pauseMs});
      }
    }
  }
  throw lastError;
}

// Live adapters may return a raw CIM row, while any identity retained in a
// summary, attempt, or controller callback must be the exact durable binding.
// Keep conversion at this boundary so malformed observations cannot leak into
// recovery state or be used to authorize a closer.
function durableLauncherBinding(identity) {
  if(identity==null)return null;
  if(isProcessIdentityBinding(identity))return identity;
  const binding=processIdentityBinding(identity);
  if(!binding)throw new Error('Launcher process identity mismatch');
  return binding;
}

function readPidFromFile(file){
  try{
    const pid=Number((readUtf8Bounded(file,'launcher PID',128)||'').replace(/^\uFEFF/,'').trim());
    return validLauncherPid(pid)?pid:0;
  }catch{return 0;}
}

/** A PID file can be briefly locked while PowerShell closes its writer. */
async function readLauncherPidWithRetry(readPid,pidFile,{attempts=3,pauseMs=ms=>pause(ms),deadlineAt,now=Date.now}={}){
  const limit=Math.max(1,Number(attempts)||1);let lastError,state='startup';
  for(let i=0;i<limit;i++){
    if(deadlineAt!==undefined&&deadlineAt!==null)requireDeadline(deadlineAt,'launcher PID retry',now);
    try{
      const pid=Number(readPid(pidFile));
      if(validLauncherPid(pid))return {pid,error:null,state:'valid'};
      if(pid!==0)return {pid:0,error:new Error('Launcher PID is invalid'),state:'invalid'};
      // Production hooks intentionally collapse unreadable and malformed PID
      // files to zero. Inspect the bounded artifact so a malformed value does
      // not borrow the short startup retry reserved for an actual zero.
      const raw=readUtf8Bounded(pidFile,'launcher PID',128);
      if(raw!==null){
        const text=String(raw).replace(/^\uFEFF/,'').trim();
        if(text&&text!=='0'){
          const filePid=Number(text);
          if(validLauncherPid(filePid))return {pid:filePid,error:null,state:'valid'};
          return {pid:0,error:new Error('Launcher PID is invalid'),state:'invalid'};
        }
      }
      lastError=new Error('Launcher PID is unavailable during startup');
    }catch(error){
      if(!['EBUSY','EPERM','EACCES'].includes(error?.code))return {pid:0,error,state:'unreadable'};
      lastError=error;state='unreadable';
    }
    if(i+1<limit){
      if(deadlineAt===undefined||deadlineAt===null)await pauseMs(100*(i+1));
      else await pauseBeforeDeadline(100*(i+1),deadlineAt,'launcher PID retry',{now,pauseMs});
    }
  }
  return {pid:0,error:lastError,state};
}

function validLauncherPid(value){
  const pid=Number(value);
  return Number.isSafeInteger(pid)&&pid>=1&&pid<=4194304;
}

// An abort authority is intentionally a tiny, controller-owned projection.
// Do not persist arbitrary hook output: callers may hold a raw capability,
// workspace path, or diagnostic text that must not enter the run ledger.
function normalizeAbortProjection(value,runId){
  if(!value||typeof value!=='object'||Array.isArray(value)||value.schema!==1||
    value.kind!=='acceptance-abort'||value.runId!==runId||
    !/^[a-z][a-z0-9-]{0,63}$/.test(String(value.reason||''))||
    !Number.isFinite(value.requestedAt)||value.requestedAt<=0||value.requestedAt>Date.now()+60000)
    throw new Error('Invalid acceptance abort authority');
  return {schema:1,kind:'acceptance-abort',runId,reason:String(value.reason),requestedAt:Number(value.requestedAt),observedAt:Date.now()};
}

// A missing CIM identity is not proof that a launcher exited. Bind the
// controller result to the current attempt and PID before accepting a plain
// process-presence probe as exit evidence.
export function readOwnedLauncherExitEvidence(files,attempt,pid){
  if(!files?.rf||!attempt?.token)return null;
  try{
    const raw=readUtf8Bounded(files.rf,'launcher result',1024*1024);
    const text=String(raw||'').replace(/^\uFEFF/,''),expectedPid=Number(pid);
    // Headless workers persist their controller-owned result as formatted JSON
    // rather than the visible launcher's one-line PowerShell record.  Keep the
    // two protocols separate: only the headless result's full, attempt-bound
    // identity may stand in for a missing live process identity.
    if(files.mode==='headless'){
      const result=JSON.parse(text),resultPid=Number(result?.pid),exitCode=result?.exitCode;
      if(typeof attempt.runId!=='string'||!attempt.runId||result?.runId!==attempt.runId||
         result?.token!==attempt.token||!validLauncherPid(expectedPid)||
         !validLauncherPid(resultPid)||resultPid!==expectedPid||typeof result?.done!=='boolean'||
         !Number.isSafeInteger(exitCode)||(result.done===true&&exitCode!==0))return null;
      return {...result,__DONE__:true,__TOKEN__:result.token,__LAUNCHER_PID__:resultPid,__EXIT__:exitCode};
    }
    const first=text.split(/\r?\n/,1)[0];
    const result=JSON.parse(first);
    const resultPid=Number(result?.__LAUNCHER_PID__);
    const boundAttempt=typeof attempt.runId==='string'&&attempt.runId.length>0&&
      typeof attempt.blockKey==='string'&&attempt.blockKey.length>0&&
      Number.isSafeInteger(attempt.number)&&attempt.number>=1;
    if(result?.__DONE__!==true||result.__TOKEN__!==attempt.token||!Number.isSafeInteger(result?.__EXIT__)||
       !validLauncherPid(expectedPid)||!validLauncherPid(resultPid)||resultPid!==expectedPid||
       (boundAttempt&&(result.__RUN_ID__!==attempt.runId||result.__BLOCK_KEY__!==attempt.blockKey||result.__ATTEMPT__!==attempt.number)))return null;
    return result;
  }catch{return null;}
}

function defaultPidPresence(pid){
  const value=Number(pid);
  if(!Number.isSafeInteger(value)||value<=0)return false;
  try{process.kill(value,0);return true;}
  catch(error){
    if(error?.code==='ESRCH')return false;
    if(error?.code==='EPERM'||error?.code==='EACCES')return null;
    return null;
  }
}

/** Prove an identity-null launcher exited; unknown state stays recoverable. */
export async function waitForOwnedLauncherExit(files,attempt,{readPid=readPidFromFile,probePid=defaultPidPresence,timeoutMs=5000,intervalMs=100,deadlineAt,now=Date.now,pauseMs=pause}={}){
  const deadline=deadlineAt===undefined||deadlineAt===null
    ?now()+Math.max(0,Math.min(15000,Number(timeoutMs)||0))
    :Math.min(deadlineAt,now()+Math.max(0,Math.min(15000,Number(timeoutMs)||0)));
  const interval=Math.max(10,Math.min(1000,Number(intervalMs)||100));
  while(true){
    if((deadlineAt!==undefined&&deadlineAt!==null)&&now()>=deadline)return null;
    let pid=0;
    try{pid=Number(await readPid?.(files?.pidf));}catch{pid=0;}
    if((deadlineAt!==undefined&&deadlineAt!==null)&&now()>=deadline)return null;
    if(!validLauncherPid(pid)){
      const remaining=deadline-now();
      if(remaining<=0)return null;
      await pauseMs(Math.min(interval,remaining));
      continue;
    }
    const evidence=readOwnedLauncherExitEvidence(files,attempt,pid);
    let absent=false;
    try{absent=probePid(pid)===false;}catch{absent=false;}
    if(evidence&&absent)return evidence;
    const remaining=deadline-now();
    if(remaining<=0)return null;
    await pauseMs(Math.min(interval,remaining));
  }
}
export async function waitForProcessExit(expected,{timeoutMs=5000,intervalMs=100,snapshot=processSnapshot,probePid,deadlineAt,now=Date.now,pauseMs=pause}={}) {
  if(!expected)return true;
  let binding;
  try{binding=durableLauncherBinding(expected);}catch{return false;}
  if(!binding||!Number.isFinite(Number(binding.ProcessId)))return false;
  const absoluteDeadline=validateAbsoluteDeadline(deadlineAt,'deadlineAt');
  const timeout=Math.max(0,Math.min(15000,Number(timeoutMs)||0)),interval=Math.max(10,Math.min(1000,Number(intervalMs)||100));
  const deadline=absoluteDeadline===undefined?now()+timeout:Math.min(absoluteDeadline,now()+timeout);
  while(true){
    if(now()>=deadline)return false;
    // A full CIM snapshot can be temporarily unavailable under Windows load.
    // ESRCH is direct evidence that this PID is gone; permission/other errors
    // remain unknown and must never be treated as an exit proof.
    const presenceProbe=probePid||(snapshot===processSnapshot?probeProcessPresence:null);
    try{if(presenceProbe&&presenceProbe(binding.ProcessId)===false)return true;}catch{/* fall through to identity-bound snapshot */}
    let current;
    const remaining=deadline-now();
    if(remaining<=0)return false;
    const snapshotTimeout=Math.min(3000,remaining);
    try{current=snapshot(snapshotTimeout);}catch{
      // Process enumeration can briefly fail while a launcher exits. Retry within
      // the same bounded window; an exhausted or continuously unreadable snapshot
      // remains unproven and must retain the lease.
      const retryRemaining=deadline-now();
      if(retryRemaining<=0)return false;
      await pauseMs(Math.min(interval,retryRemaining));continue;
    }
    if(now()>=deadline)return false;
    if(!sameProcess(binding,current?.get(Number(binding.ProcessId))))return true;
    const retryRemaining=deadline-now();
    if(retryRemaining<=0)return false;
    await pauseMs(Math.min(interval,retryRemaining));
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

function retainUnprovenExit(entry,attempt,reason,now=Date.now) {
  const at=now();
  entry.status='needs-reconciliation';
  entry.exitConfirmed=false;
  entry.reason=reason;
  entry.exitUnprovenAt ||= at;
  entry.endedAt ||= at;
  if(attempt){attempt.exitConfirmed=false;attempt.exitUnprovenAt ||= entry.exitUnprovenAt;}
}
function retainCleanupDeadline(entry,attempt,now=Date.now) {
  retainUnprovenExit(entry,attempt,'Cleanup deadline expired before launcher exit could be proven; recovery files and lease retained',now);
}

/** Final cleanup is scoped to this run's durable attempts, never terminal hosts. */
export async function sweepRunProcesses(sum,{close,waitForExit=waitForProcessExit,identify=launcherIdentity,snapshot=processSnapshot,probePid=defaultPidPresence,abort=()=>false,onClosed=async()=>{},onFailed=()=>{},onRetained=async()=>{},onCleanupPending=async()=>{},consumeExitRetryPermit=()=>false,cleanupDeadlineAt,now=Date.now}={}) {
  validateAbsoluteDeadline(cleanupDeadlineAt,'cleanupDeadlineAt');
  const stats={checked:0,closed:0,failed:0,retained:0};
  for(const block of sum?.blocks||[]){
    const entry=sum.results?.[block.key],attempt=entry?.attempts?.at(-1);
    if(!attempt&&!entry?.launcher&&!entry?.launcherFiles)continue;
    // A journaled post-exit cleanup has already proven ownership and exit. Its
    // recovery path must never close, wait on, or otherwise reinterpret the
    // former launcher as a live process.
    if(entry?.cleanupPending!==undefined){stats.checked++;stats.retained++;continue;}
    // A controller-authenticated abort may cancel an attempt before a process
    // exists. That path marks the reservation as released and exit confirmed;
    // a later sweep must not reinterpret its intentionally absent launcher
    // files as a cleanup failure.
    if(entry?.status==='cancelled'&&(hasAuthenticatedExitProof(entry,attempt)||hasNoProcessProof(sum,block,entry,attempt)))continue;
    // An authenticated worker can prove that its own wrapper exited while its
    // internal CLI child remains live, unbound, or otherwise exit-unproven.
    // This state is deliberately terminal for automatic cleanup: do not let a
    // later sweep overwrite it, close a PID, release capacity, or discard the
    // evidence simply because an older summary lacks the timestamp marker.
    const childState=entry?.headlessChildState;
    // A wrapper's claimed exit cannot settle an unresolved child.  Headless
    // child state is its own reconciliation authority, so do not let a stale
    // or partially persisted `exitConfirmed` boolean bypass it.
    const unresolvedHeadlessChild=entry?.launcherFiles?.mode==='headless'&&childState&&
      (childState.childStillRunning===true||childState.exitUnproven===true||childState.terminationRefused===true);
    if(unresolvedHeadlessChild){
      const hadMarker=Boolean(entry.exitUnprovenAt||attempt?.exitUnprovenAt);
      const at=entry.exitUnprovenAt||attempt?.exitUnprovenAt||Date.now();
      entry.exitUnprovenAt ||= at;
      if(attempt)attempt.exitUnprovenAt ||= entry.exitUnprovenAt;
      if(!hadMarker)await onRetained(block,entry,attempt,{reason:entry.reason||'Headless child exit is unproven; recovery files and lease retained'});
      stats.checked++;stats.retained++;continue;
    }
    const hasUnprovenMarker=Boolean(entry?.exitUnprovenAt||attempt?.exitUnprovenAt);
    if(hasUnprovenMarker&&!resolvedExitUncertainty(entry,attempt)){
      // One retry is permitted only by the current controller after it has
      // durably recorded a failed authenticated close.  A restarted
      // controller has no permit, so it must retain rather than replay or
      // touch an unknown launcher.
      let permitted=false;
      try{permitted=entry?.launcherFiles?.mode!=='headless'&&Boolean(consumeExitRetryPermit(block,entry,attempt));}catch{permitted=false;}
      if(!permitted){stats.checked++;stats.retained++;continue;}
    }
    // Protocol 2 cannot recover a public lease id without its generated
    // instance binding.  Keep the ledger and lease for operator reconciliation
    // rather than treating an old compatibility shape as a safe exit.
    if(!hasBoundLeaseInstance(entry,attempt)){
      stats.checked++;
      retainUnprovenExit(entry,attempt,'Final cleanup lacks a bound protocol 2 lease instance; recovery files and lease retained',now);
      await onRetained(block,entry,attempt,{reason:entry.reason});
      stats.retained++;continue;
    }
    // An explicit no-process receipt is the only non-PID proof accepted here.
    // New PID-backed records need the complete dual authenticated proof; a
    // token-shaped exit marker alone must never suppress final cleanup.
    if(hasNoProcessProof(sum,block,entry,attempt))continue;
    if(entry?.exitConfirmed===true&&hasAuthenticatedExitProof(entry,attempt))continue;
    stats.checked++;
    if(cleanupDeadlineAt!==undefined&&cleanupDeadlineAt!==null&&!deadlineIsAvailable(cleanupDeadlineAt,'final cleanup',now)){
      retainCleanupDeadline(entry,attempt,now);
      await onRetained(block,entry,attempt,{reason:entry.reason});
      stats.retained++;continue;
    }
    let exitProven=false;
    try{
      if(!attempt||attempt.runId!==sum.runId||!attempt.token||entry.token!==attempt.token||
          !attempt.taskIds?.length||attempt.taskIds.some(id=>!block.taskIds.includes(id))||!entry.launcherFiles)
        throw new Error('Final cleanup ownership is not bound to this run attempt');
      validateSavedLauncherFiles(sum,block,entry,attempt);
      const authority=durableLauncherAuthority(entry,attempt);
      if(!authority)throw new Error('Final cleanup lacks a durable bound launcher identity');
      let expected=authority,confirmedExitedByPidFile=false,ownedExitEvidence=null;
      if(fs.existsSync(entry.launcherFiles.pidf)){
        const pid=Number((readUtf8Bounded(entry.launcherFiles.pidf,'launcher PID',128)||'').replace(/^\uFEFF/,''));
        if(!Number.isSafeInteger(pid)||pid<=0||pid>4194304)throw new Error('Final cleanup controller PID file is invalid');
        validateSavedLauncherFiles(sum,block,entry,attempt,{requireLiveFiles:true});
        const current=await identifyWithRetry(identify,pid,entry.launcherFiles.pidf,{deadlineAt:cleanupDeadlineAt,now});
        if(cleanupDeadlineAt!==undefined&&cleanupDeadlineAt!==null)requireDeadline(cleanupDeadlineAt,'final cleanup',now);
        if(current){
          const observed=durableLauncherBinding(current);
          if(!sameProcess(expected,observed))throw new Error('Final cleanup saved launcher identity mismatch');
          // Keep the original canonical authority rather than promoting a
          // PID-file observation into a new ownership proof.
          entry.launcher=expected;
        }else{
          if(expected&&Number(expected.ProcessId)!==pid)throw new Error('Final cleanup saved launcher identity mismatch');
          const present=probePid(pid);
          if(present===true)throw new Error('Final cleanup cannot prove launcher exit from its controller PID file');
          if(present!==false)throw new Error('Final cleanup launcher presence is unavailable; exit remains unproven');
          ownedExitEvidence=readOwnedLauncherExitEvidence(entry.launcherFiles,attempt,pid);
          if(!ownedExitEvidence)throw new Error('Final cleanup cannot prove launcher exit from its controller PID file and attempt result');
          confirmedExitedByPidFile=true;
          exitProven=true;
        }
      }
      if(!expected&&!confirmedExitedByPidFile)throw new Error('Final cleanup cannot prove launcher identity or exit');
      const wasConfirmed=entry.exitConfirmed===true;
      if(!confirmedExitedByPidFile){
        let exited=await callWithDeadline(waitForExit,[expected],cleanupDeadlineAt);
        if(!exited){
          if(cleanupDeadlineAt!==undefined&&cleanupDeadlineAt!==null)requireDeadline(cleanupDeadlineAt,'final cleanup',now);
          const current=await identifyWithRetry(identify,expected.ProcessId,entry.launcherFiles.pidf,{deadlineAt:cleanupDeadlineAt,now});
          if(cleanupDeadlineAt!==undefined&&cleanupDeadlineAt!==null)requireDeadline(cleanupDeadlineAt,'final cleanup',now);
          if(!sameProcess(expected,current))throw new Error('Final cleanup launcher identity is unavailable or changed');
          if(typeof close!=='function')throw new Error('Final cleanup has no owned-process closer');
          await callWithDeadline(close,[expected.ProcessId,expected],cleanupDeadlineAt);
          if(cleanupDeadlineAt!==undefined&&cleanupDeadlineAt!==null)requireDeadline(cleanupDeadlineAt,'final cleanup',now);
          exited=await callWithDeadline(waitForExit,[expected],cleanupDeadlineAt);
          if(!exited)throw new Error('Owned launcher still alive after final cleanup; lease retained');
        }
        exitProven=true;
      }
      if(confirmedExitedByPidFile&&entry.launcherFiles?.mode==='headless'){
        const evidence={token:ownedExitEvidence.__TOKEN__,pid:Number(ownedExitEvidence.__LAUNCHER_PID__),exitCode:ownedExitEvidence.__EXIT__,authenticated:true,at:now()};
        entry.exitEvidence=evidence;attempt.exitEvidence=evidence;
      }
      if(hasUnprovenMarker){
        const evidence=entry.exitEvidence||attempt?.exitEvidence||{
          token:attempt.token,pid:Number(expected?.ProcessId),authenticated:true,at:now(),
        };
        entry.exitEvidence=evidence;attempt.exitEvidence=evidence;
        attempt.exitConfirmed=true;
      }
      if(!entry.exitEvidence){
        const evidence={token:attempt.token,pid:Number(expected?.ProcessId),authenticated:true,at:now()};
        entry.exitEvidence=evidence;attempt.exitEvidence={...evidence};
      }
      entry.exitConfirmed=true;attempt.exitConfirmed=true;
      if(!wasConfirmed)stats.closed++;
      await onClosed(block,entry,attempt,{wasConfirmed,deadlineAt:cleanupDeadlineAt});
    }catch(error){
      // During an authenticated acceptance abort, a cleanup failure cannot be
      // reported as an ordinary task failure: its real meaning is that the
      // controller could not prove ownership/exit. Keep the lease and durable
      // evidence for explicit reconciliation instead of silently treating it
      // as a completed cleanup.
      let aborted=false;
      try{aborted=Boolean(abort?.());}catch{aborted=true;}
      if(entry?.cleanupPending!==undefined&&hasAuthenticatedExitProof(entry,attempt)){
        stats.retained++;await onCleanupPending(block,entry,attempt,error);
      }else if(aborted||deadlineExpired(error)||!exitProven){
        stats.retained++;
        if(deadlineExpired(error))retainCleanupDeadline(entry,attempt,now);
        else if(aborted)retainUnprovenExit(entry,attempt,'Acceptance aborted before launcher cleanup could be proven; recovery files and lease retained',now);
        else retainUnprovenExit(entry,attempt,'Final cleanup could not prove launcher exit; recovery files and lease retained',now);
        await onRetained(block,entry,attempt,{reason:entry.reason});
      }else{
        stats.failed++;entry.status='failed';entry.reason=error?.message||String(error);entry.endedAt=now();
        onFailed(block,entry,error);
      }
      entry.endedAt ||= now();
    }
  }
  return stats;
}
async function coordinate(fn,deadlineAt,{now=Date.now,pauseMs=pause,stage='coordinator transaction'}={}) {
  while(true){
    requireDeadline(deadlineAt,stage,now);
    try{
      const result=fn();
      requireDeadline(deadlineAt,stage,now);
      return result;
    }catch(error){
      if(deadlineExpired(error)||!/busy|initializing|abandoned/.test(error?.message||''))throw error;
      await pauseBeforeDeadline(200,deadlineAt,stage,{now,pauseMs});
    }
  }
}
export function runDirectory(workspace,runId) {
  assertPublicRunIdentity({workspace,runId});
  if(!/^[a-zA-Z0-9_-]{1,100}$/.test(runId||''))throw new Error('A valid --run-id is required');
  return assertNoReparsePoints(path.join(workspace,'temp','orchestrator','runs',runId),'run directory');
}

function assertPublicRunIdentity(fields) {
  for(const [field,value] of Object.entries(fields||{})) {
    if(typeof value==='string'&&isCredentialShapedText(value)) {
      // Do not include the offending value: callers use this before durable
      // controller state exists, and a diagnostic must not itself become a
      // persistence or console leak.
      throw new Error('SENSITIVE_RUN_IDENTITY: credential-shaped '+field+' cannot be used in durable controller state');
    }
  }
}

function publicDurablePath(label,value) {
  const selected=path.resolve(value);
  assertPublicRunIdentity({[label]:selected});
  return assertNoReparsePoints(selected,label);
}

function assertPublicLauncherFiles(files) {
  if(!files||typeof files!=='object'||Array.isArray(files))throw new Error('Invalid launcher file descriptor');
  for(const key of ['lp','pf','pidf','rf','stdout','stderr','privatePrompt']) {
    if(typeof files[key]==='string')assertPublicRunIdentity({['launcher '+key]:files[key]});
  }
  if(typeof files.startupReceipt?.file==='string')assertPublicRunIdentity({'launcher startup receipt':files.startupReceipt.file});
}
// 验收契约是安全闸门：畸形文件**不能**被当成"没有检查"静默放行（那样任务会停在
// awaiting-verification 而调用方看不出真因），也不能只回一句 JSON.parse 的裸措辞。
// 这里逐层点名：哪个文件、哪一层、期望什么、实测什么。
const acceptanceCredentialField=/(?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|authorization|token)$/i;
function hasSensitiveAcceptanceContent(value){
  if(redactedProjection(value).changed)return true;
  const seen=new WeakSet();
  const visit=item=>{
    if(item===null||typeof item!=='object')return false;
    if(seen.has(item))return false;seen.add(item);
    try{
      if(Array.isArray(item))return item.some(visit);
      return Object.entries(item).some(([key,entry])=>
        isSensitiveObjectKey(key,entry)||
        (acceptanceCredentialField.test(key)&&!(key==='authorization'&&isPublicRunnerAuthorization(entry)))||
        visit(entry));
    }finally{seen.delete(item);}
  };
  return visit(value);
}
function loadChecks(file,workspace){
  if(!file)return {};
  let text;
  try{text=readWorkspaceText({root:workspace,target:file,maxBytes:WORKSPACE_READ_LIMITS.acceptanceJson}).text;}
  catch(error){throw new Error('Acceptance contract unreadable: '+file+'：'+(error.message||error));}
  let value;
  try{value=JSON.parse(text.replace(/^\uFEFF/,''));}
  catch(error){throw new Error('Invalid acceptance contract '+file+'：'+jsonProblem(text,error));}
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid acceptance contract '+file+'：顶层必须是「任务 id -> 检查」的 JSON 对象（实测 '+describeShape(value)+'）');
  if(hasSensitiveAcceptanceContent(value))throw new Error('SENSITIVE_ACCEPTANCE_CONTRACT: credential-shaped content is not allowed in a persisted acceptance contract; use a non-secret evidence check');
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
export function rejectWorkspaceCommandChecks(checks) {
  for (const entry of Object.values(checks || {})) {
    const list=Array.isArray(entry)?entry:entry?.checks;
    if (Array.isArray(list)&&list.some(check=>check?.type==='command')) {
      throw new Error('Workspace command acceptance is disabled for controller runs; use declarative file/json/absent checks instead');
    }
  }
}
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
function validateResumeStatusAuthority(workspace,runId,expected){
  const authenticated=readRunStatus(workspace,runId);
  if(authenticated.runId!==expected.runId||authenticated.generation!==expected.generation||
     authenticated.eventSeq!==expected.eventSeq)throw new Error('Resume status authority does not match the saved run ledger');
  return authenticated;
}
function isStatusAuthorityMismatch(error){return error?.message==='Status ledger authority mismatch';}
function revalidateAcceptanceStatusOverride(workspace,runId,summary,transition){
  const current=authorizeAcceptanceStatusOverride(workspace,runId,summary);
  if(current.observedSummarySha256!==transition.observedSummarySha256||current.fromSummarySha256!==transition.fromSummarySha256)
    throw new Error('Status changed while preparing acceptance override; retry with a newly reviewed contract');
  return current;
}
function statusAuthorityReboundRecord(transition,binding){
  return {at:binding.boundAt,runId:transition.runId,workspace:transition.workspace,
    fromSummarySha256:transition.fromSummarySha256,observedSummarySha256:transition.observedSummarySha256,
    acceptanceSha256:binding.sha256};
}
const HEADLESS_RECONCILIATION_MARKER='headless-reconciliation.json';
const isRecord=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const unresolvedChildState=value=>value?.childStillRunning===true||value?.exitUnproven===true||value?.terminationRefused===true;
function reconciliationMarkerFile(sum,block,attempt){
  const attemptFile=resolveAttemptFile(sum,attempt?.file,'attempt file');
  return assertNoReparsePoints(path.join(path.dirname(attemptFile),HEADLESS_RECONCILIATION_MARKER),'headless reconciliation marker');
}
function exactRecord(value,keys){
  return isRecord(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
}
function readHeadlessReconciliationMarker(sum,block,attempt){
  const file=reconciliationMarkerFile(sum,block,attempt),text=readUtf8Bounded(file,'headless reconciliation marker');
  if(text===null)return null;
  let marker;
  try{marker=JSON.parse(String(text).replace(/^\uFEFF/,''));}
  catch{throw new Error('Headless reconciliation marker is unreadable; refusing resume');}
  const keys=['version','kind','runId','blockKey','attempt','token','childStillRunning','exitUnproven','terminationRefused','recordedAt'];
  if(!exactRecord(marker,keys)||marker.version!==1||marker.kind!=='headless-child-reconciliation'||
    marker.runId!==sum.runId||marker.blockKey!==block.key||marker.attempt!==attempt?.number||marker.token!==attempt?.token||
    typeof marker.childStillRunning!=='boolean'||typeof marker.exitUnproven!=='boolean'||typeof marker.terminationRefused!=='boolean'||
    !Number.isFinite(marker.recordedAt)||marker.recordedAt<=0||!unresolvedChildState(marker))
    throw new Error('Headless reconciliation marker is invalid; refusing resume');
  return marker;
}
function writeHeadlessReconciliationMarker(sum,block,attempt,childState,recordedAt){
  const marker={version:1,kind:'headless-child-reconciliation',runId:sum.runId,blockKey:block.key,attempt:attempt.number,token:attempt.token,
    childStillRunning:childState.childStillRunning===true,exitUnproven:childState.exitUnproven===true,
    terminationRefused:childState.terminationRefused===true,recordedAt};
  if(!unresolvedChildState(marker))throw new Error('Headless reconciliation marker requires an unresolved child state');
  // This journal is deliberately separate from both attempt.json and the
  // public summary. A failed publisher must never erase the only durable
  // evidence that a live, unbound CLI may still exist.
  atomicJson(reconciliationMarkerFile(sum,block,attempt),marker);
  return marker;
}
function unresolvedHeadlessResult(sum,block,entry,attempt){
  if(entry?.launcherFiles?.mode!=='headless'||!attempt)return false;
  const marker=readHeadlessReconciliationMarker(sum,block,attempt);
  if(marker)return true;
  const text=readUtf8Bounded(entry.launcherFiles.rf,'headless result');
  if(text===null)return false;
  // `rf` is trusted only after the launcher descriptor is re-derived from the
  // attempt and its control configuration binds this run/token. A malformed
  // result is never treated as an absent result during resume.
  validateSavedLauncherFiles(sum,block,entry,attempt,{requireLiveFiles:true});
  let result;
  try{result=JSON.parse(String(text).replace(/^\uFEFF/,''));}
  catch{throw new Error('Headless result is unreadable; refusing resume');}
  if(!isRecord(result)||result.runId!==sum.runId||result.token!==attempt.token)
    throw new Error('Headless result identity mismatch; refusing resume');
  for(const key of ['childStillRunning','exitUnproven','terminationRefused']){
    if(Object.hasOwn(result,key)&&typeof result[key]!=='boolean')throw new Error('Headless result child state is invalid; refusing resume');
  }
  return unresolvedChildState(result);
}
function resolvedExitUncertainty(entry,attempt){
  return entry?.launcherFiles?.mode!=='headless'&&hasAuthenticatedExitProof(entry,attempt);
}

// A PID file is only a locator.  A close-capable path must additionally prove
// that the currently observed process is the exact durable launcher binding
// saved by this attempt.  Either authority may hold the binding after a
// crash, but they must agree when both are present.
function durableLauncherAuthority(entry,attempt){
  const bindings=[entry?.launcher,attempt?.launcherObserved].filter(value=>value!==undefined);
  if(!bindings.length||!bindings.every(isProcessIdentityBinding))return null;
  return bindings.every(value=>sameProcess(bindings[0],value))?bindings[0]:null;
}
function ownsObservedLauncher(entry,attempt,identity){
  const authority=durableLauncherAuthority(entry,attempt);
  return Boolean(authority&&isProcessIdentityBinding(identity)&&sameProcess(authority,identity));
}

const POST_EXIT_CLEANUP_PHASES=['lease','registry','artifacts'];
function cloneCleanupJournal(value){return JSON.parse(JSON.stringify(value));}
function cleanupProofProjection(value){
  if(!value)return null;
  return {
    token:typeof value.token==='string'?value.token:null,
    pid:Number.isSafeInteger(value.pid)?value.pid:null,
    authenticated:value.authenticated===true,
    at:Number.isSafeInteger(value.at)?value.at:null,
    exitCode:Number.isSafeInteger(value.exitCode)?value.exitCode:null,
  };
}
// This digest binds only fields whose value authorizes cleanup recovery.  A
// marker can outlive normal status transitions such as abort cancellation or
// parent verification; those full public transitions are authenticated by the
// separate status-authority binding and must not make a valid cleanup receipt
// unrecoverable.
function cleanupSemanticProjection(sum,block,entry,attempt){
  const e=entry||{},a=attempt||{};
  return {
    runId:sum.runId,
    blockKey:block.key,
    entry:{
      exitConfirmed:e.exitConfirmed===true,
      exitEvidence:cleanupProofProjection(e.exitEvidence),
      leaseId:typeof e.leaseId==='string'?e.leaseId:null,
      leaseInstanceId:typeof e.leaseInstanceId==='string'?e.leaseInstanceId:null,
      noProcessProof:e.noProcessProof??null,
    },
    attempt:{
      runId:typeof a.runId==='string'?a.runId:null,
      blockKey:typeof a.blockKey==='string'?a.blockKey:null,
      number:Number.isSafeInteger(a.number)?a.number:null,
      token:typeof a.token==='string'?a.token:null,
      leaseId:typeof a.leaseId==='string'?a.leaseId:null,
      leaseInstanceId:typeof a.leaseInstanceId==='string'?a.leaseInstanceId:null,
      exitConfirmed:a.exitConfirmed===true,
      exitEvidence:cleanupProofProjection(a.exitEvidence),
      noProcessProof:a.noProcessProof??null,
    },
  };
}
function cleanupJournalTarget(entry,attempt,journal,at){
  return {
    entry:{...entry,cleanupPending:journal,status:'cleanup-pending',reason:'Post-exit cleanup is pending',endedAt:entry.endedAt||at},
    attempt:{...attempt,cleanupPending:cloneCleanupJournal(journal)},
  };
}
function cleanupMarkerProof(sum,block,entry,attempt){
  if(hasAuthenticatedExitProof(entry,attempt)){
    const launcher=entry.launcher??attempt.launcherObserved;
    return {version:1,kind:'authenticated-exit',runId:sum.runId,blockKey:block.key,attempt:attempt.number,token:attempt.token,
      pid:entry.exitEvidence.pid,authenticated:true,launcher,launcherIdentitySha256:canonicalDigest(launcher),recordedAt:entry.exitEvidence.at};
  }
  if(hasNoProcessProof(sum,block,entry,attempt)){
    return {version:1,kind:'no-process',runId:sum.runId,blockKey:block.key,attempt:attempt.number,token:attempt.token,recordedAt:entry.noProcessProof.recordedAt};
  }
  throw new Error('Post-exit cleanup marker lacks a bound proof');
}
function cleanupMarkerBinding(workspace,coordinator,sum,block,entry,attempt,status){
  return {runId:sum.runId,blockKey:block.key,attempt:attempt.number,token:attempt.token,attemptFile:path.resolve(attempt.file),coordinator:path.resolve(coordinator),
    lease:{id:entry.leaseId,instanceId:entry.leaseInstanceId},status};
}
function cleanupJournalFor(sum,block,entry,attempt,now=Date.now){
  if(!hasAuthenticatedExitProof(entry,attempt)&&!hasNoProcessProof(sum,block,entry,attempt))throw new Error('Post-exit cleanup requires an authenticated launcher exit or no-process proof');
  if(typeof entry?.leaseId!=='string'||!entry.leaseId||typeof entry?.leaseInstanceId!=='string'||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(entry.leaseInstanceId))
    throw new Error('Post-exit cleanup requires a bound lease instance');
  const at=now();
  return {version:1,kind:'post-exit-cleanup',runId:sum.runId,blockKey:block.key,attempt:attempt.number,token:attempt.token,
    lease:{id:entry.leaseId,instanceId:entry.leaseInstanceId},
    phases:{lease:'pending',registry:'pending',artifacts:'pending'},recordedAt:at,updatedAt:at};
}
function installCleanupJournal(sum,block,entry,attempt,now=Date.now,journalOverride){
  const journal=entry.cleanupPending||journalOverride||cleanupJournalFor(sum,block,entry,attempt,now);
  entry.cleanupPending=journal;
  attempt.cleanupPending=cloneCleanupJournal(journal);
  entry.status='cleanup-pending';
  entry.reason='Post-exit cleanup is pending';
  entry.endedAt ||= now();
  return journal;
}
function clearCleanupJournal(entry,attempt){
  delete entry.cleanupPending;delete attempt.cleanupPending;
}
function installNoProcessProof(sum,block,entry,attempt,now=Date.now){
  if(typeof entry?.leaseId!=='string'||!entry.leaseId||typeof entry?.leaseInstanceId!=='string'||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(entry.leaseInstanceId))
    throw new Error('No-process cleanup requires a bound lease instance');
  const proof={version:1,kind:'no-process',runId:sum.runId,blockKey:block.key,attempt:attempt.number,token:attempt.token,
    lease:{id:entry.leaseId,instanceId:entry.leaseInstanceId},recordedAt:now()};
  entry.noProcessProof=proof;attempt.noProcessProof={...proof};
  entry.exitConfirmed=true;attempt.exitConfirmed=true;
  return proof;
}
function pendingCleanupBlocks(sum){
  return (sum?.blocks||[]).filter(block=>{
    const entry=sum.results?.[block.key],attempt=entry?.attempts?.at(-1);
    return entry?.cleanupPending!==undefined||attempt?.cleanupPending!==undefined||entry?.status==='cleanup-pending';
  });
}

function pendingCleanupMarkerMissingBlocks(sum,coordinator,workspace){
 const missing=[];
 for(const block of sum?.blocks||[]){
  const entry=sum.results?.[block.key],attempt=entry?.attempts?.at(-1);
  if(entry?.cleanupPending===undefined&&attempt?.cleanupPending===undefined)continue;
  const binding=cleanupMarkerBindingForRecovery(sum,block,entry,attempt,coordinator);
  if(!binding)throw new Error('Invalid recovery ledger: cleanup transaction binding is unavailable for '+block.key);
  if(readCleanupTransactionMarkerForRecovery({workspace,binding})===null)missing.push(block.key);
 }
 return missing;
}

function assertPendingCleanupMarkerAuthority(sum,coordinator,workspace){
 const missing=pendingCleanupMarkerMissingBlocks(sum,coordinator,workspace);
 if(missing.length)throw new Error('Post-exit cleanup controller marker is missing for '+missing.join(', ')+'; reconcile the retained cleanup before resume');
}

function cleanupInflightReconciliationError(recovery){
 const blocks=recovery.plans.filter(plan=>!plan.terminal&&cleanupJournalHasInflight(plan.marker.journal)).map(plan=>plan.block.key);
 return new Error('Post-exit cleanup phase may have executed for '+blocks.join(', ')+'; reconciliation is required before resume');
}

function cleanupMarkerBindingForRecovery(sum,block,entry,attempt,coordinator){
 if(!isRecord(entry)||!isRecord(attempt)||typeof entry.leaseId!=='string'||!entry.leaseId||
   typeof entry.leaseInstanceId!=='string'||!UUID.test(entry.leaseInstanceId)||
   attempt.leaseId!==entry.leaseId||attempt.leaseInstanceId!==entry.leaseInstanceId||
   typeof attempt.token!=='string'||!attempt.token||entry.token!==attempt.token||
   attempt.runId!==sum.runId||attempt.blockKey!==block.key||!Number.isSafeInteger(attempt.number)||attempt.number<1)
   return null;
 try{return {runId:sum.runId,blockKey:block.key,attempt:attempt.number,token:attempt.token,
  attemptFile:resolveAttemptFile(sum,attempt.file,'attempt file'),coordinator:path.resolve(coordinator),
  lease:{id:entry.leaseId,instanceId:entry.leaseInstanceId}};}
 catch{return null;}
}

function readCleanupMarkerCandidates(sum,coordinator,workspace){
 const candidates=[];
 for(const block of sum?.blocks||[]){
  const entry=sum.results?.[block.key],attempt=entry?.attempts?.at(-1),binding=cleanupMarkerBindingForRecovery(sum,block,entry,attempt,coordinator);
  if(!binding)continue;
  const marker=readCleanupTransactionMarkerForRecovery({workspace,binding});
  if(marker!==null)candidates.push({block,entry,attempt,binding,marker});
 }
 return candidates;
}

function sameDurableJson(left,right){return JSON.stringify(left)===JSON.stringify(right);}
function cleanupMarkerKeyForRecovery(binding){
 return JSON.stringify([binding.runId,binding.blockKey,binding.attempt,binding.token,binding.lease.id,binding.lease.instanceId]);
}
function cleanupPhaseRank(value){return value==='pending'?0:value==='inflight'?1:value==='done'?2:-1;}
function cleanupPhaseStatesArePrefix(phases){
 if(!isRecord(phases)||Object.keys(phases).length!==POST_EXIT_CLEANUP_PHASES.length||POST_EXIT_CLEANUP_PHASES.some(phase=>!Object.hasOwn(phases,phase)))return false;
 let pending=false,inflight=false;
 for(const phase of POST_EXIT_CLEANUP_PHASES){
  const state=phases[phase];
  if(cleanupPhaseRank(state)<0)return false;
  if(state==='pending'){pending=true;continue;}
  if(state==='inflight'){
   if(pending||inflight)return false;
   inflight=true;continue;
  }
  if(pending||inflight)return false;
 }
 return true;
}
function cleanupJournalHasInflight(journal){return POST_EXIT_CLEANUP_PHASES.some(phase=>journal?.phases?.[phase]==='inflight');}
function cleanupPhasePrefix(value,markerJournal){
 if(!isRecord(value))throw new Error('Cleanup transaction mirror is malformed');
 const expected=['version','kind','runId','blockKey','attempt','token','lease','phases','recordedAt','updatedAt'];
 if(Object.keys(value).length!==expected.length||expected.some(key=>!Object.hasOwn(value,key)))throw new Error('Cleanup transaction mirror is malformed');
 for(const key of expected)if(!['phases','updatedAt'].includes(key)&&!sameDurableJson(value[key],markerJournal[key]))throw new Error('Cleanup transaction mirror differs from controller marker');
 if(!Number.isSafeInteger(value.updatedAt)||value.updatedAt<markerJournal.recordedAt||value.updatedAt>markerJournal.updatedAt)throw new Error('Cleanup transaction mirror timestamp is invalid');
 if(!cleanupPhaseStatesArePrefix(value.phases))throw new Error('Cleanup transaction mirror phases are invalid');
 for(const phase of POST_EXIT_CLEANUP_PHASES){
  const phaseState=value.phases[phase],markerState=markerJournal.phases[phase];
  if(cleanupPhaseRank(phaseState)<0||cleanupPhaseRank(markerState)<0)throw new Error('Cleanup transaction mirror phase is invalid');
  if(cleanupPhaseRank(phaseState)>cleanupPhaseRank(markerState))throw new Error('Cleanup transaction mirror is ahead of controller marker');
 }
 return true;
}

function expectedMarkerProof(sum,block,marker){
 if(marker.proof.kind==='authenticated-exit')return {
  entry:{exitConfirmed:true,exitEvidence:{token:marker.token,pid:marker.proof.pid,authenticated:true,at:marker.proof.recordedAt},launcher:marker.proof.launcher},
  attempt:{exitConfirmed:true,exitEvidence:{token:marker.token,pid:marker.proof.pid,authenticated:true,at:marker.proof.recordedAt},launcherObserved:marker.proof.launcher},
 };
 if(marker.proof.kind==='no-process'){
  const proof={version:1,kind:'no-process',runId:sum.runId,blockKey:block.key,attempt:marker.attempt,token:marker.token,
   lease:{id:marker.lease.id,instanceId:marker.lease.instanceId},recordedAt:marker.proof.recordedAt};
  return {entry:{exitConfirmed:true,noProcessProof:proof},attempt:{exitConfirmed:true,noProcessProof:structuredClone(proof)}};
 }
 throw new Error('Cleanup transaction marker proof kind is invalid');
}

function assertMarkerProofPrefix(value,expected,kind,label){
 if(!isRecord(value))throw new Error('Cleanup transaction '+label+' mirror is malformed');
 const absent=current=>current===undefined||current===null;
 if(value.exitConfirmed!==undefined&&typeof value.exitConfirmed!=='boolean')throw new Error('Cleanup transaction '+label+' exit proof is malformed');
 if(kind==='authenticated-exit'){
  if(!absent(value.noProcessProof))throw new Error('Cleanup transaction '+label+' proof kind conflicts with controller marker');
  if(!absent(value.exitEvidence)){
   const current=value.exitEvidence,target=expected.exitEvidence;
   if(!isRecord(current)||current.token!==target.token||current.pid!==target.pid||current.authenticated!==true||current.at!==target.at)
    throw new Error('Cleanup transaction '+label+' exit proof differs from controller marker');
  }
  const field=label==='entry'?'launcher':'launcherObserved';
  if(!absent(value[field])&&!sameDurableJson(value[field],expected[field]))throw new Error('Cleanup transaction '+label+' launcher differs from controller marker');
 }else{
  if(!absent(value.exitEvidence)||!absent(value.launcher)||!absent(value.launcherObserved))throw new Error('Cleanup transaction '+label+' proof kind conflicts with controller marker');
  if(!absent(value.noProcessProof)&&!sameDurableJson(value.noProcessProof,expected.noProcessProof))throw new Error('Cleanup transaction '+label+' no-process proof differs from controller marker');
 }
}

function markerRecoveryEntry(sum,block,entry,attempt,marker){
 const expected=expectedMarkerProof(sum,block,marker),kind=marker.proof.kind;
 assertMarkerProofPrefix(entry,expected.entry,kind,'entry');
 assertMarkerProofPrefix(attempt,expected.attempt,kind,'attempt');
 if(entry.cleanupPending!==undefined)cleanupPhasePrefix(entry.cleanupPending,marker.journal);
 if(attempt.cleanupPending!==undefined)cleanupPhasePrefix(attempt.cleanupPending,marker.journal);
 const endedAt=Number.isSafeInteger(entry.endedAt)&&entry.endedAt>0?entry.endedAt:marker.journal.recordedAt;
 const nextAttempt={...attempt,...expected.attempt,cleanupPending:cloneCleanupJournal(marker.journal)};
 const nextEntry={...entry,...expected.entry,cleanupPending:cloneCleanupJournal(marker.journal),status:'cleanup-pending',reason:'Post-exit cleanup is pending',endedAt};
 return {entry:nextEntry,attempt:nextAttempt};
}

function readCleanupAttemptMirror(sum,attempt){
 const file=resolveAttemptFile(sum,attempt.file,'attempt file'),raw=readUtf8Bounded(file,'cleanup attempt record');
 if(raw===null)throw new Error('Cleanup transaction attempt record is missing');
 let disk;try{disk=JSON.parse(raw);}catch{throw new Error('Cleanup transaction attempt record is unreadable');}
 if(!isRecord(disk)||disk.runId!==attempt.runId||disk.blockKey!==attempt.blockKey||disk.number!==attempt.number||disk.token!==attempt.token||
   disk.leaseId!==attempt.leaseId||disk.leaseInstanceId!==attempt.leaseInstanceId||!Array.isArray(disk.taskIds)||!sameDurableJson(disk.taskIds,attempt.taskIds)||
   typeof disk.file!=='string'||path.resolve(resolveAttemptFile(sum,disk.file,'cleanup persisted attempt file'))!==path.resolve(file))
   throw new Error('Cleanup transaction attempt record identity mismatch');
 return {file,disk};
}

function terminalFinalizingCleanupMarker(candidate){
 return candidate.marker.state==='finalizing'&&candidate.entry.status!=='cleanup-pending'&&
  candidate.entry.cleanupPending===undefined&&candidate.attempt.cleanupPending===undefined;
}

// Build a read-only recovery plan before touching a controller or workspace
// file.  A marker may fill in only its own legal publication prefix.  A
// malformed unrelated block must therefore reject the whole resume without a
// partial repair write.
function prepareCleanupMarkerRecoveryPlan({workspace,sum,coordinator}){
 const candidates=readCleanupMarkerCandidates(sum,coordinator,workspace);
 if(!candidates.length)return {plans:[],needsMirrorRepair:false,requiresReconciliation:false};
 const draft=structuredClone(sum),diskOverrides=new Map(),plans=[];
 for(const candidate of candidates){
  const {block,entry,attempt,binding,marker}=candidate;
  if(terminalFinalizingCleanupMarker(candidate)){
   if(canonicalDigest(marker.proof)!==canonicalDigest(cleanupMarkerProof(sum,block,entry,attempt)))
    throw new Error('Finalizing cleanup marker does not match its workspace proof');
   plans.push({...candidate,terminal:true,summaryChanged:false,diskChanged:false});
   continue;
  }
  const target=markerRecoveryEntry(sum,block,entry,attempt,marker);
  const targetSemantic=cleanupSemanticProjection(sum,block,target.entry,target.attempt);
  if(canonicalDigest(targetSemantic)!==marker.status.targetSemanticSha256)
   throw new Error('Cleanup transaction marker target semantics do not match its workspace recovery target');
  const {file,disk}=readCleanupAttemptMirror(sum,attempt);
  assertMarkerProofPrefix(disk,expectedMarkerProof(sum,block,marker).attempt,marker.proof.kind,'persisted attempt');
  if(disk.cleanupPending!==undefined)cleanupPhasePrefix(disk.cleanupPending,marker.journal);
  const nextDisk={...disk,...target.attempt};
  const summaryChanged=!sameDurableJson(entry,target.entry)||!sameDurableJson(attempt,target.attempt);
  const diskChanged=!sameDurableJson(disk,nextDisk);
  const index=entry.attempts.length-1;
  draft.results[block.key]={...target.entry,attempts:[...entry.attempts.slice(0,index),target.attempt]};
  diskOverrides.set(path.resolve(file),nextDisk);
  plans.push({...candidate,target,file,nextDisk,terminal:false,summaryChanged,diskChanged});
 }
 // Validate the fully repaired *projection* before the first durable write.
 // The overridden attempt records let the strict journal validator distinguish
 // an authorised marker prefix from corruption in another block.
 validateRecoverySummary(draft);
 validatePersistedCleanupJournals(draft,{readAttemptRecord:file=>diskOverrides.get(path.resolve(file))});
 return {
  plans,
  needsMirrorRepair:plans.some(plan=>plan.summaryChanged||plan.diskChanged),
  // The controller marker is deliberately the start fence for each external
  // cleanup hook.  An in-flight phase has no durable completion receipt, so a
  // future controller must retain it for explicit reconciliation rather than
  // guessing whether replay would duplicate an external effect.
  requiresReconciliation:plans.some(plan=>!plan.terminal&&cleanupJournalHasInflight(plan.marker.journal)),
 };
}

// The controller marker is the only authority that can reconcile a crash
// between its own publication steps.  This routine performs no launcher,
// lease, registry, cleanup, planning, or verification hook.  Its caller must
// register every live marker before calling `persist`, so one repaired block
// cannot stale another block's status-authority transition.
function repairCleanupMarkerMirrors({workspace,sum,coordinator,persist}){
 const recovery=prepareCleanupMarkerRecoveryPlan({workspace,sum,coordinator});
 if(!recovery.plans.length)return {repaired:false,markers:0,plans:[]};
 let repaired=false;
 // Attempt journals are validated above and written before an authority can
 // advance.  A missing or damaged attempt file therefore cannot promote a
 // workspace summary to controller authority.
 for(const plan of recovery.plans){
  if(plan.diskChanged){atomicJson(plan.file,plan.nextDisk);repaired=true;}
 }
 // A summary may already be at the marker target while only the controller
 // authority is stale.  Bridge that narrow state only after every candidate
 // and attempt mirror has passed the read-only validation above.
 for(const plan of recovery.plans){
  const authorityResult=repairStatusAuthorityFromCleanupMarker({workspace,runId:sum.runId,binding:plan.binding});
  if(authorityResult.repaired)repaired=true;
 }
 for(const plan of recovery.plans){
  if(!plan.summaryChanged)continue;
  const {block,entry,target}=plan,index=entry.attempts.length-1;
  sum.results[block.key]={...target.entry,attempts:[...entry.attempts.slice(0,index),target.attempt]};
  persist(`block.${block.key}.cleanup-recovered`);
  repaired=true;
 }
 return {repaired,markers:recovery.plans.length,plans:recovery.plans};
}

function cleanupPendingError(){
  const error=new Error('ORCH_POST_EXIT_CLEANUP_PENDING');error.code='ORCH_POST_EXIT_CLEANUP_PENDING';return error;
}
function unresolvedResumeLaunchers(sum){
  return (sum?.blocks||[]).filter(block=>{
    const entry=sum.results?.[block.key],attempt=entry?.attempts?.at(-1);
    // The validator accepts this marker only for an unbound, non-authorizing
    // reservation fault. It is nevertheless a real committed-resource
    // ambiguity, so automatic resume must never turn it into a new launch.
    if(entry?.reservationFault!==undefined)return true;
    if(unresolvedHeadlessResult(sum,block,entry,attempt))return true;
    // The public summary is persisted independently from attempt.json.  A
    // crash or failed attempt-side atomic write must not erase an already
    // published declaration that an external hook may still create or observe
    // a launcher.  Either durable marker blocks automatic resume until a
    // human reconciles the retained work.
    // A durable uncertainty marker remains blocking unless both independent
    // authorities carry the same authenticated exit proof.  A claimed boolean
    // or one-sided write cannot turn an unknown launcher into a safe replay or
    // verification candidate.
    return Boolean(entry?.exitUnprovenAt||attempt?.exitUnprovenAt)&&!resolvedExitUncertainty(entry,attempt);
  }).map(block=>block.key);
}
function loadBoundChecks(file,dir,sum,override){
  const checks=loadChecks(file,sum.workspace),digest=canonicalDigest(checks),recorded=recordedAcceptanceDigest(sum,dir,{allowConflict:override===true});
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
  source=publicDurablePath('acceptance source',source);
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
  const view=redactDeep({
    generation:sum.generation,runId:sum.runId,coordinator:sum.coordinator,tasks:sum.tasks,blocks:sum.blocks,
    results:sum.results,taskResults:sum.taskResults,
  });
  return crypto.createHash('sha256').update(JSON.stringify(view)).digest('hex');
}

// The workspace mirror is intentionally readable by the task it describes.
// When credential-shaped content is present, retain the original immutable
// instruction/plan only in a CurrentUser-DPAPI record outside that workspace.
// The marker is part of the public ledger so resume fails closed if the
// private record was removed or no longer represents this redacted view.
function privateRecoveryPayload(sum){
  return {request:sum.request,tasks:sum.tasks,plan:sum.plan,blocks:sum.blocks};
}
function validPrivateRecoveryMarker(value){
  return !!value&&typeof value==='object'&&!Array.isArray(value)&&
    JSON.stringify(Object.keys(value).sort())===JSON.stringify(['projectionVersion','publicSha256','version'])&&
    value.version===2&&value.projectionVersion===2&&typeof value.publicSha256==='string'&&/^[a-f0-9]{64}$/.test(value.publicSha256);
}
function bindPrivateRecovery(workspace,runId,sum){
  const payload=privateRecoveryPayload(sum),projection=redactedProjection(payload);
  if(!projection.changed){delete sum.privateRecovery;return;}
  sum.privateRecovery=writePrivateRunState({workspace,runId,payload});
}
function hydratePrivateRecovery(workspace,runId,publicSum){
  if(publicSum.privateRecovery===undefined)return publicSum;
  if(publicSum.privateRecovery?.version===1)throw new Error('Private recovery state uses an older privacy format; restart the run with the current plugin version');
  if(!validPrivateRecoveryMarker(publicSum.privateRecovery))throw new Error('Invalid private recovery binding');
  const publicDigest=canonicalDigest(privateRecoveryPayload(publicSum));
  if(publicDigest!==publicSum.privateRecovery.publicSha256)throw new Error('private recovery projection mismatch');
  const payload=readPrivateRunState({workspace,runId,expectedPublicSha256:publicSum.privateRecovery.publicSha256});
  const hydrated={...publicSum,...payload};
  // The public ledger's todo list is redacted with its task prompt. Rebuild it
  // only in memory after the sealed private payload has passed its binding
  // check, so recovery validation sees the restored task inventory without
  // ever writing those prompt values back to a public artifact.
  if(publicSum.todoList!==undefined)hydrated.todoList=buildTodoList(hydrated.tasks,hydrated.blocks,hydrated.taskResults);
  return hydrated;
}
// Read and structurally validate a resume ledger before a caller resolves a
// host CLI.  This is deliberately read-only: runWindows() still re-reads the
// ledger and enforces the controller-owned plan, status authority, and TOCTOU
// checks immediately before it resumes any work.
export function preflightResumeLedger(workspace,runId){
  const resolvedWorkspace=path.resolve(workspace);
  const dir=runDirectory(resolvedWorkspace,runId),file=path.join(dir,'summary.json');
  const publicSummary=readLedgerJson(file);
  // Bind the public ledger to the caller's workspace before hydrating or
  // validating fields whose attempt metadata may contain derived paths.
  if(publicSummary.runId!==runId||!sameWorkspace(publicSummary.workspace,resolvedWorkspace))throw new Error('Run workspace/identity mismatch');
  const summary=hydratePrivateRecovery(resolvedWorkspace,runId,publicSummary);
  if(summary.protocol!==2||!Array.isArray(summary.plan))throw new Error('This run has no recoverable task checkpoints');
  if(summary.runId!==runId||!sameWorkspace(summary.workspace,resolvedWorkspace))throw new Error('Run workspace/identity mismatch');
  // Preflight is read-only and does not receive an explicit coordinator.  It
  // may therefore validate the saved canonical path but must not compare it
  // with the caller's current default locator, which can legitimately differ
  // from a test or host-provided saved coordinator.
  const coordinator=canonicalCoordinator(resolvedWorkspace,summary.coordinator,'saved');
  const markerRecovery=prepareCleanupMarkerRecoveryPlan({workspace:resolvedWorkspace,sum:summary,coordinator});
  const abortedCleanupOnly=summary.abort&&((pendingCleanupBlocks(summary).length>0)||markerRecovery.plans.length>0);
  if(summary.abort&&!abortedCleanupOnly)throw new Error('An aborted run cannot be resumed; reconcile its retained work before starting a new run');
  let cleanupPublicationRecovery=markerRecovery.needsMirrorRepair;
  try{
   validateRecoverySummary(summary);
   validatePersistedCleanupJournals(summary);
  }catch(error){
   if(!cleanupPublicationRecovery)throw error;
  }
  assertPendingCleanupMarkerAuthority(summary,coordinator,resolvedWorkspace);
  if(markerRecovery.requiresReconciliation)throw cleanupInflightReconciliationError(markerRecovery);
  if(!cleanupPublicationRecovery){
   const unresolved=unresolvedResumeLaunchers(summary);
   if(unresolved.length)throw new Error('Launcher exit remains unproven for '+unresolved.join(', ')+'; reconcile the saved run before resume');
  }
  return Object.freeze({executionMode:summary.executionMode||'visible',...(cleanupPublicationRecovery?{cleanupPublicationRecovery:true}:undefined),...(abortedCleanupOnly?{abortedCleanupOnly:true}:undefined)});
}
function canonicalCoordinator(workspace,value,label) {
  if(typeof value!=='string'||!value.trim()||!path.isAbsolute(value))throw new Error('Invalid '+label+' coordinator path');
  const resolved=path.resolve(value);
  assertPublicRunIdentity({coordinator:resolved});
  const selected=assertNoReparsePoints(resolved,label+' coordinator');
  if(physicallySameOrChild(workspace,selected))throw new Error(label+' coordinator cannot be inside the initiating workspace');
  return assertPrivateControllerRoot(selected);
}
function coordinatorEquals(a,b) {
  const key=value=>process.platform==='win32'?value.toLowerCase():value;
  return key(a)===key(b);
}
function trustedSavedCoordinator(workspace,saved,explicit,{required=false}={}) {
  const trusted=explicit===undefined?undefined:canonicalCoordinator(workspace,explicit,'explicit');
  if(saved===undefined){
    if(required)throw new Error('Invalid recovery ledger: saved coordinator missing from recoverable ledger');
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
  atomicJson(path.join(dir,'goal.json'),redactDeep({
    version:2,source:'controller-mirror',runId:sum.runId,workspace:sum.workspace,
    objective:sum.request,status,updatedAt:Date.now(),event,summaryGeneration:sum.generation,
    summaryDigest:goalDigest(sum),eventSeq:sum.eventSeq||0,executionMode:sum.executionMode||'visible',executionStatus:buildExecutionStatus(sum),tasks:todoList.map(item=>({id:item.id,status:item.status,block:item.block})),
    blocks:sum.blocks.map(block=>({key:block.key,title:block.title,status:sum.results[block.key]?.status||'pending',taskIds:block.taskIds})),
  }));
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
function retainVisibleRuleGuardRejection(sum,b,e,reason) {
  const message=e.policyRejectionReason||reason||'Visible rule guard refused execution because active or unsafe Codex rules were found.';
  e.policyRejected=true;e.policyRejectionReason=message;e.status='failed';e.reason=message;
  for(const id of b.taskIds)sum.taskResults[id]={status:'failed',reason:message};
}
export function collectVerification(sum,checks,workspace,{allowStarted=false,allowParentInspection=false,blockKey}={}) {
  const blocks=blockKey?sum.blocks.filter(block=>block.key===blockKey):sum.blocks;
  for(const b of blocks) {
    const e=sum.results[b.key];if(!e?.endedAt)continue;
    if(['blocked','popup-failed','preflight-failed','cancelled'].includes(e.status)&&!e.attempts?.length)continue;
    if(e.policyRejected===true){retainVisibleRuleGuardRejection(sum,b,e,e.reason);continue;}
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

// Verification errors often quote a declarative acceptance expectation.  That
// expectation can contain credential-shaped text, so retain only the public
// projection when it crosses the durable report boundary.
export function publicVerificationReport(report){
  return redactDeep(report);
}
export function verifyRun(workspace,runId,acceptanceFile,options={}) {
  const explicitAcceptanceFile=acceptanceFile?publicDurablePath('acceptance source',acceptanceFile):undefined;
  const dir=runDirectory(workspace,runId),file=path.join(dir,'summary.json'),publicSum=readLedgerJson(file),sum=hydratePrivateRecovery(workspace,runId,publicSum);
  if(sum.runId!==runId||!sum.finishedAt)throw new Error('Run is not finalized');
  if(sum.abort)throw new Error('An aborted run cannot be verified; reconcile retained work before starting a new run');
  if(!sameWorkspace(sum.workspace||'',workspace))throw new Error('Run workspace/identity mismatch');
  let statusTransition;
  if(sum.protocol===2){
    validateRecoverySummary(sum);validateBoundRunPlan(sum);
    validatePersistedCleanupJournals(sum);
    // `--verify-run` can reconcile task output, but it cannot prove that an
    // external launcher has exited.  Check this before status-authority or
    // acceptance work so neither ordinary verification nor an explicit
    // acceptance override can rewrite a retained execution.
    const unresolved=unresolvedResumeLaunchers(sum);
    if(unresolved.length)throw new Error('Launcher exit remains unproven for '+unresolved.join(', ')+'; reconcile the saved run before verification');
    const cleanupPending=pendingCleanupBlocks(sum);
    if(cleanupPending.length)throw new Error('Post-exit cleanup remains pending for '+cleanupPending.map(block=>block.key).join(', ')+'; resume the saved run before verification');
    if(Number.isSafeInteger(sum.eventSeq)){
      try{validateResumeStatusAuthority(workspace,runId,publicSum);}
      catch(error){
        if(options.override!==true||!isStatusAuthorityMismatch(error))throw error;
        statusTransition=authorizeAcceptanceStatusOverride(workspace,runId,publicSum);
      }
    }
  }
  const coordinator=trustedSavedCoordinator(workspace,sum.coordinator,options.coordinator,{required:sum.protocol===2});
  assertPublicRunIdentity({coordinator});
  const claim=claimRun(coordinator,'run:'+physicalPathIdentity(dir));
  try{
    if(statusTransition)revalidateAcceptanceStatusOverride(workspace,runId,readLedgerJson(file),statusTransition);
    const contractFile=explicitAcceptanceFile||path.join(dir,'acceptance.json');
    const acceptance=loadBoundChecks(contractFile,dir,sum,options.override===true);
    const checks=acceptance.checks;
    rejectWorkspaceCommandChecks(checks);
    if(sum.tasks?.length){
      const keyDiff=acceptanceKeyDiff(checks,sum.tasks);
      if(keyDiff?.unknown.length)throw new Error('Acceptance keys do not match any task id: '+keyDiff.unknown.join(', ')+'（task ids: '+sum.tasks.map(t=>t.id).join(', ')+'）');
      if(keyDiff?.missing.length)console.warn('[orchestrator] acceptance has no checks for task(s): '+keyDiff.missing.join(', ')+'；这些任务将停在 awaiting-verification');
    }
    // 先校验再用新契约覆盖账本：无效的 override 契约不能把原来能用的绑定改坏。
    if(acceptance.rebound||statusTransition){
      const binding=bindAcceptance(workspace,runId,dir,checks,path.resolve(contractFile));
      sum.acceptance=binding;
      const history={generation:sum.generation};
      if(acceptance.rebound)history.acceptanceRebound=acceptanceReboundRecord(acceptance,binding);
      if(statusTransition)history.statusAuthorityRebound=statusAuthorityReboundRecord(statusTransition,binding);
      sum.history.push(history);
    }
    collectVerification(sum,checks,workspace,{allowStarted:true});sum.success=summaryComplete(sum,true);
    createStatusPublisher(dir).publish(sum,sum.success?'verify.completed':'verify.failed',statusTransition?{authorityTransition:statusTransition}:undefined);
    writeGoalMirror(dir,sum,sum.success?'verify.completed':'verify.failed',sum.success?'completed':'failed');return sum.success;
  }
  finally{releaseRun(coordinator,'run:'+physicalPathIdentity(dir),claim);}
}

export async function runWindows(request,hooks,options={}) {
  hooks=receiverBoundHooks(hooks);
  const workspace=path.resolve(options.workspace),capacity=options.capacity;
  const now=typeof options.now==='function'?options.now:Date.now;
  const pauseMs=typeof options.pauseMs==='function'?options.pauseMs:pause;
  const suppliedExecutionDeadline=validateAbsoluteDeadline(options.executionDeadlineAt,'executionDeadlineAt');
  // All execution-admission activity shares this one immutable absolute budget.
  // Deriving it once preserves the historical timeout path while an explicit
  // caller deadline can never be prolonged by a retry or helper default.
  const executionDeadlineAt=suppliedExecutionDeadline??(now()+(options.timeoutMs||21600000));
  requireDeadline(executionDeadlineAt,'run execution',now);
  let cleanupDeadlineAt=validateAbsoluteDeadline(options.cleanupDeadlineAt,'cleanupDeadlineAt');
  const ensureCleanupDeadline=()=>{
    if(cleanupDeadlineAt!==undefined)return cleanupDeadlineAt;
    const configured=Number(options.cleanupTimeoutMs??30000);
    const duration=Number.isFinite(configured)?Math.max(0,Math.trunc(configured)):30000;
    cleanupDeadlineAt=now()+duration;
    return cleanupDeadlineAt;
  };
  const authorization=options.authorization;
  if(authorization!==undefined&&(!authorization||!['read-only','workspace-write','danger-full-access'].includes(authorization.sandbox)||!['never','on-request'].includes(authorization.approval)))throw new Error('Invalid initiating authorization policy');
  if(options.abort!==undefined&&typeof options.abort!=='function')throw new TypeError('abort must be a function when provided');
  if(options.finalizeAcceptance!==undefined&&typeof options.finalizeAcceptance!=='function')throw new TypeError('finalizeAcceptance must be a function when provided');
  // Capacity is a safety boundary shared by planning, admission and recovery.
  // Reject malformed direct API calls before creating any run state; otherwise
  // an undefined/zero value can leave a partially initialized ledger behind.
  if(!Number.isInteger(capacity)||capacity<1)throw new RangeError('capacity must be a positive integer');
  const runId=options.runId||crypto.randomUUID();
  assertPublicRunIdentity({workspace,runId});
  const explicitAcceptanceFile=options.acceptanceFile?publicDurablePath('acceptance source',options.acceptanceFile):undefined;
  const dir=runDirectory(workspace,runId),summaryFile=path.join(dir,'summary.json');
  // Validate a new acceptance contract before claiming coordinator state.  A
  // rejected credential-shaped contract must not create a run owner, plan, or
  // workspace artifact that could preserve its values.
  const newRunChecks=!options.resume&&!fs.existsSync(dir)?loadChecks(explicitAcceptanceFile,workspace):undefined;
  // A resumed run must stay attached to the coordinator recorded in its
  // validated ledger. New runs use the Codex-specific default locator.
  let savedResume=null,savedResumePublic=null,savedResumeRaw,resumeStatusTransition,resumeCleanupPublicationRepair=false;
  if(options.resume){
      savedResumeRaw=readUtf8Bounded(summaryFile,'run summary');savedResumePublic=parseLedger(summaryFile,savedResumeRaw);savedResume=hydratePrivateRecovery(workspace,runId,savedResumePublic);
    if(savedResume.protocol!==2||!Array.isArray(savedResume.plan))throw new Error('This run has no recoverable task checkpoints');
    if((savedResume.agent||'codex')!==(options.agent||'codex'))throw new Error('Resume agent must match the saved run');
    if(options.executionMode&&(savedResume.executionMode||'visible')!==options.executionMode)throw new Error('Resume execution mode must match the saved run');
    if(!sameWorkspace(savedResume.workspace,workspace)||savedResume.runId!==runId)throw new Error('Run workspace/identity mismatch');
    if(JSON.stringify(savedResume.authorization??null)!==JSON.stringify(authorization??null))throw new Error('Run authorization policy mismatch; refusing to widen or change a resumed run');
    const savedCoordinator=trustedSavedCoordinator(workspace,savedResume.coordinator,options.coordinator,{required:true});
    const markerRecovery=prepareCleanupMarkerRecoveryPlan({workspace,sum:savedResume,coordinator:savedCoordinator});
    const cleanupMarkers=markerRecovery.plans;
    const abortedCleanupOnly=Boolean(savedResume.abort)&&((pendingCleanupBlocks(savedResume).length>0)||cleanupMarkers.length>0);
    if(savedResume.abort&&!abortedCleanupOnly)throw new Error('An aborted run cannot be resumed; reconcile its retained work before starting a new run');
    resumeCleanupPublicationRepair=markerRecovery.needsMirrorRepair;
    try{
      validateRecoverySummary(savedResume);
      validatePersistedCleanupJournals(savedResume);
    }catch(error){
      if(!resumeCleanupPublicationRepair)throw error;
    }
    assertPendingCleanupMarkerAuthority(savedResume,savedCoordinator,workspace);
    if(markerRecovery.requiresReconciliation)throw cleanupInflightReconciliationError(markerRecovery);
    const savedGoalFile=path.join(dir,'goal.json');
    if(fs.existsSync(savedGoalFile)){
      const savedGoal=JSON.parse(readUtf8Bounded(savedGoalFile,'run goal')||'');
      if(savedGoal.runId!==runId||!sameWorkspace(savedGoal.workspace||'',workspace))throw new Error('Run goal mirror identity mismatch');
      // The goal is only a mirror; a crash may interrupt its last replacement.
      if(savedGoal.version===2&&savedGoal.summaryDigest!==goalDigest(savedResume))console.warn('[resume] rebuilding stale goal mirror from the validated ledger');
    }
    if(savedResume.blocks.length>capacity)throw new Error('Current memory capacity is below the saved block count');
    validateBoundRunPlan(savedResume,{required:true});
    try{validateResumeStatusAuthority(workspace,runId,savedResumePublic);}
    catch(error){
      if(cleanupMarkers.length){resumeCleanupPublicationRepair=true;}
      else {
        if(options.acceptanceOverride!==true||!isStatusAuthorityMismatch(error))throw error;
        resumeStatusTransition=authorizeAcceptanceStatusOverride(workspace,runId,savedResumePublic);
      }
    }
    if(!resumeCleanupPublicationRepair){
      const unresolved=unresolvedResumeLaunchers(savedResume);
      if(unresolved.length)throw new Error('Launcher exit remains unproven for '+unresolved.join(', ')+ '; reconcile the saved run before resume');
    }
  }
  const coordinator=options.resume
    ?trustedSavedCoordinator(workspace,savedResume.coordinator,options.coordinator,{required:true})
    :(options.coordinator===undefined?coordinatorDir(workspace):canonicalCoordinator(workspace,options.coordinator,'explicit'));
  assertPublicRunIdentity({coordinator});
  const runKey='run:'+physicalPathIdentity(dir),claim=await coordinate(
    ()=>claimRun(coordinator,runKey,undefined,{deadlineAt:executionDeadlineAt}),
    executionDeadlineAt,{now,pauseMs,stage:'run ownership claim'});
  let memorySamplingAbort=null,memorySampler=null;
  let sum,progressTimer,progressError;
  try {
    // Dynamic-memory telemetry is optional. Keep every potentially-throwing
    // hook read within this ownership scope so the finally below always
    // releases a run claim if sampler setup is malformed.
    if(options.memoryBudget?.mode==='dynamic'){
      memorySamplingAbort=new AbortController();
      const backgroundSnapshot=hooks.sampleProcessSnapshot??tryBackgroundProcessSnapshot;
      memorySampler=createRunMemorySampler({
        sampleProcessSnapshot:()=>backgroundSnapshot({signal:memorySamplingAbort.signal}),
        availableMemoryMB:availableMB,
      });
    }
    let checks,acceptance={checks:null,rebound:false};
    if(options.resume) {
      if(readUtf8Bounded(summaryFile,'run summary')!==savedResumeRaw)throw new Error('Run changed while acquiring recovery ownership; retry resume');
      const freshPublic=parseLedger(summaryFile,savedResumeRaw),fresh=hydratePrivateRecovery(workspace,runId,freshPublic);
      const freshRecovery=prepareCleanupMarkerRecoveryPlan({workspace,sum:fresh,coordinator});
      assertPendingCleanupMarkerAuthority(fresh,coordinator,workspace);
      if(freshRecovery.requiresReconciliation)throw cleanupInflightReconciliationError(freshRecovery);
      if(freshRecovery.needsMirrorRepair)resumeCleanupPublicationRepair=true;
      if(resumeCleanupPublicationRepair){
        const recoveryPublisher=createStatusPublisher(dir);
        const recoveryBindings=new Map();
        for(const plan of freshRecovery.plans)if(!plan.terminal){
          const binding={...plan.binding,status:plan.marker.status};
          recoveryBindings.set(cleanupMarkerKeyForRecovery(binding),binding);
        }
        const persistRecovery=event=>recoveryPublisher.publish(fresh,event,{beforeSummaryWrite:({statusAuthority})=>{
          for(const binding of recoveryBindings.values())updateCleanupTransactionStatusAuthority({workspace,binding,statusAuthority});
        }});
        repairCleanupMarkerMirrors({workspace,sum:fresh,coordinator,persist:persistRecovery});
        savedResumeRaw=readUtf8Bounded(summaryFile,'run summary');
        savedResumePublic=parseLedger(summaryFile,savedResumeRaw);savedResume=hydratePrivateRecovery(workspace,runId,savedResumePublic);
      }
      validateRecoverySummary(savedResume);
      validatePersistedCleanupJournals(savedResume);
      if(resumeStatusTransition)revalidateAcceptanceStatusOverride(workspace,runId,savedResumePublic,resumeStatusTransition);
      else validateResumeStatusAuthority(workspace,runId,savedResumePublic);
      const unresolved=unresolvedResumeLaunchers(savedResume);
      if(unresolved.length)throw new Error('Launcher exit remains unproven for '+unresolved.join(', ')+'; reconcile the saved run before resume');
      sum=savedResume;
      // 恢复同样要复用被绑定的契约：执行窗改掉 acceptance.json 就能让未完成的任务被当成已验收。
      acceptance=loadBoundChecks(explicitAcceptanceFile||path.join(dir,'acceptance.json'),dir,savedResume,options.acceptanceOverride===true);
      checks=acceptance.checks;
      rejectWorkspaceCommandChecks(checks);
      sum.history.push({generation:sum.generation,finishedAt:sum.finishedAt,success:sum.success});
      sum.generation++;delete sum.finishedAt;sum.success=false;
    }else {
      if(fs.existsSync(dir))throw new Error('Run ID already exists; use --resume-run or --verify-run');
      checks=newRunChecks??loadChecks(explicitAcceptanceFile,workspace);
      rejectWorkspaceCommandChecks(checks);
      fs.mkdirSync(dir,{recursive:true});
      const inventory=requestTasks(request);
      const manifest={runId,workspace,request,executionMode:options.executionMode||'visible',tasks:inventory,todoList:buildTodoList(inventory),startedAt:Date.now()};
      const publicManifest=redactDeep(manifest);
      atomicJson(path.join(dir,'manifest.json'),publicManifest);
      options.onEvent?.({...publicManifest,type:'plan.started',executionStatus:[]});
      requireDeadline(executionDeadlineAt,'run planning',now);
      const candidate=await callWithDeadline(hooks.plan,[request,capacity],executionDeadlineAt,hooks);
      requireDeadline(executionDeadlineAt,'run planning',now);
      const memoryBudget=options.memoryBudget;
      // Memory affects launch admission only. The dependency/conflict plan is
      // immutable so waiting never changes which work is serial or parallel.
      const {plan,tasks}=ledgerPlan(request,candidate,capacity,hooks.compact);
      const recs=plan.map((b,i)=>({key:`B${i+1}`,title:b.title,b,dependsOn:b.dependsOn||[],keys:admissionKeys(b,workspace,hooks.infer,coordinator)}));
      levelWaves(recs);
      sum={protocol:2,version:CORE_VERSION,agent:options.agent||'codex',executionMode:options.executionMode||'visible',authorization,runId,workspace,request,capacity,coordinator,generation:1,history:[],startedAt:Date.now(),tasks,plan:recs,
        memoryBudget:memoryBudget?{mode:memoryBudget.mode,reserveMB:memoryBudget.floorMB,windowCostMB:memoryBudget.windowCostMB,headroom:memoryBudget.headroom||1}:undefined,
        blocks:recs.map(r=>({key:r.key,title:r.title,taskIds:r.b.tasks.flatMap(t=>t.sourceIds)})),results:{},taskResults:{},todoList:[]};
      // dynamic 模式下 capacity 只是安全边界；账本记录真实块数，便于宿主与验收读取。
      if(memoryBudget?.mode==='dynamic')sum.capacity=sum.blocks.length;
      for(const r of recs){sum.results[r.key]={status:'pending',attempts:[]};for(const id of sum.blocks.find(b=>b.key===r.key).taskIds)sum.taskResults[id]={status:'pending'};}
      bindPrivateRecovery(workspace,runId,sum);
    }
    if(options.memoryBudget)options.memoryBudget.taskCosts=Object.fromEntries(Object.entries(checks||{}).map(([id,value])=>[id,{memoryMB:Number(value?.memoryMB||0)}]));
    sum.owner=claim.owner;sum.coordinator=coordinator;
    const refreshTodoList=()=>{sum.todoList=buildTodoList(sum.tasks,sum.blocks,sum.taskResults);};
    const verificationQueue=createVerificationQueue();
    // A retry permit is intentionally controller-local.  It permits one
    // final, identity-bound cleanup retry after this exact controller has
    // durably retained a failed close; a restarted controller never inherits
    // permission to touch an exit-unproven launcher.
    const finalSweepRetryPermits=new WeakSet();
    refreshTodoList();
    {
      const keyDiff=acceptanceKeyDiff(checks,sum.tasks);
      if(keyDiff?.unknown.length)throw new Error('Acceptance keys do not match any task id: '+keyDiff.unknown.join(', ')+'（task ids: '+sum.tasks.map(t=>t.id).join(', ')+'）');
      if(keyDiff?.missing.length)console.warn('[orchestrator] acceptance has no checks for task(s): '+keyDiff.missing.join(', ')+'；这些任务将停在 awaiting-verification');
    }
    {
      const binding=bindAcceptance(workspace,runId,dir,checks,explicitAcceptanceFile||path.join(dir,'acceptance.json'));
      sum.acceptance=binding;
      if(acceptance.rebound||resumeStatusTransition){
        const history={generation:sum.generation};
        if(acceptance.rebound)history.acceptanceRebound=acceptanceReboundRecord(acceptance,binding);
        if(resumeStatusTransition)history.statusAuthorityRebound=statusAuthorityReboundRecord(resumeStatusTransition,binding);
        sum.history.push(history);
      }
    }
    if(!options.resume)bindRunPlan(sum);
    const publisher=createStatusPublisher(dir,{onEvent:options.onEvent});
    let pendingAuthorityTransition=resumeStatusTransition;
    // A cleanup marker is also an authority for every later public summary
    // while it remains live.  A concurrent block, finalization, or progress
    // publication must therefore bind its own summary boundary into *each*
    // active marker before replacing summary.json; otherwise a harmless later
    // status event would make an earlier cleanup marker unrecoverable.
    const cleanupStatusMarkers=new Map();
    const registerCleanupStatusMarker=binding=>cleanupStatusMarkers.set(cleanupMarkerKeyForRecovery(binding),binding);
    const unregisterCleanupStatusMarker=binding=>cleanupStatusMarkers.delete(cleanupMarkerKeyForRecovery(binding));
    // A resumed run can contain several independent cleanup transactions.
    // Register all live controller markers before the first new status write,
    // so repairing or completing A cannot stale B's authority transition.
    if(options.resume){
      for(const candidate of readCleanupMarkerCandidates(sum,coordinator,workspace)){
        if(!terminalFinalizingCleanupMarker(candidate))registerCleanupStatusMarker({...candidate.binding,status:candidate.marker.status});
      }
    }
    const persist=(event='run.updated',{beforeSummaryWrite}={})=>{
      const markerBindings=[...cleanupStatusMarkers.values()];
      const bindCleanupStatus=markerBindings.length||beforeSummaryWrite
        ?({statusAuthority})=>{
          beforeSummaryWrite?.({statusAuthority});
          for(const binding of markerBindings)updateCleanupTransactionStatusAuthority({workspace,binding,statusAuthority});
        }
        :undefined;
      publisher.publish(sum,event,{...(pendingAuthorityTransition?{authorityTransition:pendingAuthorityTransition}:undefined),...(bindCleanupStatus?{beforeSummaryWrite:bindCleanupStatus}:undefined)});
      pendingAuthorityTransition=undefined;
      writeGoalMirror(dir,sum,event,sum.finishedAt?(sum.success?'completed':'failed'):'active');
    };
    const mark=(r,status,reason)=>{
      sum.results[r.key]={...sum.results[r.key],status,reason};
      if(!['waiting','launching','running','reserved','retrying','deferred'].includes(status))for(const id of sum.blocks.find(b=>b.key===r.key).taskIds)if(!['verified','needs-reconciliation','awaiting-verification'].includes(sum.taskResults[id]?.status))sum.taskResults[id]={...sum.taskResults[id],status,reason};
      persist(`block.${r.key}.${status}`);
    };
    // The abort callback may read a controller-bound record. Persist only a
    // fixed, non-secret projection and fail closed when that authority is
    // missing, malformed, or temporarily unreadable.
    const recordAbort=value=>{
      if(sum.abort)return sum.abort;
      let projection;
      try{
        if(value==null)return null;
        projection=normalizeAbortProjection(value,runId);
      }catch{
        projection={schema:1,kind:'acceptance-abort',runId,reason:'abort-authority-failed',requestedAt:Date.now(),observedAt:Date.now()};
      }
      sum.abort=projection;
      persist('run.abort-requested');
      return projection;
    };
    const readAbort=()=>{
      if(sum.abort)return sum.abort;
      if(typeof options.abort!=='function')return null;
      try{return recordAbort(options.abort());}
      catch{return recordAbort({});}
    };
    const finalizeAcceptance=async()=>{
      if(sum.abort)return sum.abort;
      if(typeof options.finalizeAcceptance!=='function')return readAbort();
      try{return recordAbort(await options.finalizeAcceptance());}
      catch{return recordAbort({});}
    };
    const abortReason=abort=>'Acceptance aborted: '+abort.reason;
    const markAbortReconciliation=(r,e,b,active,reason)=>{
      const at=Date.now();
      e.status='needs-reconciliation';e.reason=reason;e.endedAt=at;e.exitUnprovenAt ||= at;
      if(active)active.exitUnprovenAt ||= e.exitUnprovenAt;
      for(const id of b.taskIds)if(sum.taskResults[id]?.status!=='verified')sum.taskResults[id]={...sum.taskResults[id],status:'needs-reconciliation',reason};
      persist(`block.${r.key}.needs-reconciliation`);
    };
    const markDeadlineReconciliation=(r,e,b,active,reason='Deadline expired before launcher cleanup could be proven; recovery files and lease retained')=>{
      const at=now();
      e.status='needs-reconciliation';e.reason=reason;e.endedAt=at;e.exitConfirmed=false;e.exitUnprovenAt ||= at;
      if(active){
        active.exitUnprovenAt ||= e.exitUnprovenAt;
        // The attempt record is the restart authority.  If a hook might still
        // be operating after this controller returns, persist retention before
        // any outer sweep can inspect the public summary.
        try{if(active.file)atomicJson(active.file,active);}catch{}
      }
      for(const id of b.taskIds)if(sum.taskResults[id]?.status!=='verified')sum.taskResults[id]={...sum.taskResults[id],status:'needs-reconciliation',reason};
      persist(`block.${r.key}.needs-reconciliation`);
    };
    const deadlineHook=async(callback,args,deadlineAt,stage,receiver)=>{
      requireDeadline(deadlineAt,stage,now);
      const result=await callWithDeadline(callback,args,deadlineAt,receiver);
      requireDeadline(deadlineAt,stage,now);
      return result;
    };
    const cleanupHook=(callback,args,stage)=>deadlineHook(callback,args,ensureCleanupDeadline(),stage,hooks);
    // A post-exit cleanup journal is deliberately written before any lease,
    // registry, or artifact mutation.  Its attempt-side copy survives a crash
    // between the controller's two durable writes; recovery validates that
    // copy before it can run another window or accept task output.
    const persistCleanupJournal=(b,e,attempt,event)=>{
      if(!attempt?.file)throw new Error('Post-exit cleanup has no durable attempt record');
      atomicJson(attempt.file,attempt);
      persist(event||`block.${b.key}.cleanup-pending`);
    };
    const completePostExitCleanup=async(b,e,attempt,{deadlineAt,reservationProofRef}={})=>{
      const cleanupAt=deadlineAt??ensureCleanupDeadline();
      if(!attempt?.file)throw new Error('Post-exit cleanup has no durable attempt record');
      const baseBinding=()=>({runId:sum.runId,blockKey:b.key,attempt:attempt.number,token:attempt.token,attemptFile:path.resolve(attempt.file),coordinator:path.resolve(coordinator),lease:{id:e.leaseId,instanceId:e.leaseInstanceId}});
      const provisionalStatusAuthority=()=>{
        const source=readRunStatus(workspace,sum.runId);
        return createCleanupStatusAuthorityBinding({workspace,runId:sum.runId,source,target:source});
      };
      let markerBinding,marker,journal=e.cleanupPending;
      marker=readCleanupTransactionMarkerForRecovery({workspace,binding:baseBinding()});
      if(journal===undefined&&marker?.state==='finalizing'){
        markerBinding={...baseBinding(),status:marker.status};
        if(canonicalDigest(marker.proof)!==canonicalDigest(cleanupMarkerProof(sum,b,e,attempt)))
          throw new Error('Finalizing cleanup marker does not match its workspace proof');
        registerCleanupStatusMarker(markerBinding);
        return {finalizing:true,markerBinding};
      }
      if(journal!==undefined){
        if(marker===null){
          throw new Error('Post-exit cleanup controller marker is missing; reconcile the retained cleanup before resume');
        }else{
          markerBinding={...baseBinding(),status:marker.status};
          if(cleanupJournalHasInflight(marker.journal))throw new Error('Post-exit cleanup phase may have executed; reconciliation is required before resume');
          if(canonicalDigest(marker.journal)!==canonicalDigest(journal)||canonicalDigest(marker.proof)!==canonicalDigest(cleanupMarkerProof(sum,b,e,attempt)))
            throw new Error('Post-exit cleanup marker does not match its workspace journal');
        }
      }else{
        if(marker!==null)throw new Error('Active cleanup marker is missing its workspace journal');
        const at=now(),created=cleanupJournalFor(sum,b,e,attempt,()=>at);
        const base=cleanupSemanticProjection(sum,b,e,attempt);
        const target=cleanupJournalTarget(e,attempt,created,at);
        markerBinding=cleanupMarkerBinding(workspace,coordinator,sum,b,e,attempt,cleanupTransactionStatusDigests({base,target:cleanupSemanticProjection(sum,b,target.entry,target.attempt)}));
        marker=createCleanupTransactionMarker({workspace,binding:markerBinding,proof:cleanupMarkerProof(sum,b,e,attempt),journal:created,statusAuthority:provisionalStatusAuthority(),createdAt:at,updatedAt:at});
        writeCleanupTransactionMarker({workspace,binding:markerBinding,marker});
        installCleanupJournal(sum,b,e,attempt,()=>at,created);
        journal=e.cleanupPending;
      }
      registerCleanupStatusMarker(markerBinding);
      // No cleanup side effect is permitted until both public and attempt
      // authorities contain the same pending journal.
      persistCleanupJournal(b,e,attempt,`block.${b.key}.cleanup-pending`);
      journal=e.cleanupPending;
      // Fence every external cleanup effect in controller state before calling
      // it.  If the process dies after this point, the marker stays inflight
      // and a future controller refuses to guess whether the effect happened.
      const beginCleanupPhase=phase=>{
        marker=beginCleanupTransactionMarkerPhase({workspace,binding:markerBinding,phase,updatedAt:now()});
        return marker;
      };
      if(journal.phases.lease==='pending'){
        requireDeadline(cleanupAt,'post-exit lease cleanup',now);
        beginCleanupPhase('lease');
        if(reservationProofRef?.value){
          await coordinate(()=>release(coordinator,journal.lease.id,undefined,{deadlineAt:cleanupAt,reservationProof:reservationProofRef.value}),cleanupAt,{now,pauseMs,stage:'post-exit lease cleanup'});
          reservationProofRef.value=null;
        }else await coordinate(()=>releaseMatchingLease(coordinator,{id:journal.lease.id,runId:sum.runId,leaseInstanceId:journal.lease.instanceId},undefined,{deadlineAt:cleanupAt}),cleanupAt,{now,pauseMs,stage:'post-exit lease cleanup'});
        marker=updateCleanupTransactionMarker({workspace,binding:markerBinding,phase:'lease',updatedAt:now()});
        e.cleanupPending=cloneCleanupJournal(marker.journal);attempt.cleanupPending=cloneCleanupJournal(marker.journal);persistCleanupJournal(b,e,attempt,`block.${b.key}.cleanup.lease`);journal=e.cleanupPending;
      }
      if(journal.phases.registry==='pending'){
        requireDeadline(cleanupAt,'post-exit registry cleanup',now);
        beginCleanupPhase('registry');
        const outcome=await deadlineHook(hooks.unregister,[journal.lease.id,coordinator,{deadlineAt:cleanupAt,runId:sum.runId,leaseInstanceId:journal.lease.instanceId}],cleanupAt,'post-exit registry cleanup',hooks);
        if(outcome===false)throw cleanupPendingError();
        marker=updateCleanupTransactionMarker({workspace,binding:markerBinding,phase:'registry',updatedAt:now()});
        e.cleanupPending=cloneCleanupJournal(marker.journal);attempt.cleanupPending=cloneCleanupJournal(marker.journal);persistCleanupJournal(b,e,attempt,`block.${b.key}.cleanup.registry`);journal=e.cleanupPending;
      }
      if(journal.phases.artifacts==='pending'){
        requireDeadline(cleanupAt,'post-exit artifact cleanup',now);
        beginCleanupPhase('artifacts');
        const outcome=e.launcherFiles===undefined?undefined:await deadlineHook(hooks.cleanup,[e.launcherFiles],cleanupAt,'post-exit artifact cleanup',hooks);
        if(outcome===false)throw cleanupPendingError();
        marker=updateCleanupTransactionMarker({workspace,binding:markerBinding,phase:'artifacts',updatedAt:now()});
        e.cleanupPending=cloneCleanupJournal(marker.journal);attempt.cleanupPending=cloneCleanupJournal(marker.journal);persistCleanupJournal(b,e,attempt,`block.${b.key}.cleanup.artifacts`);
      }
      clearCleanupJournal(e,attempt);
      persistCleanupJournal(b,e,attempt,`block.${b.key}.cleanup.completed`);
      // Retain the finalizing controller marker until a later terminal block
      // status is durably published.  A crash after the journal mirrors are
      // cleared must never make a restart repeat already-completed cleanup.
      return {finalizing:true,markerBinding};
    };
    const settleFinalizedCleanupMarker=(b,e,attempt)=>{
      if(e?.status==='cleanup-pending'||e?.cleanupPending!==undefined||attempt?.cleanupPending!==undefined||!attempt?.file)return false;
      const base={runId:sum.runId,blockKey:b.key,attempt:attempt.number,token:attempt.token,attemptFile:path.resolve(attempt.file),coordinator:path.resolve(coordinator),lease:{id:e.leaseId,instanceId:e.leaseInstanceId}};
      const marker=readCleanupTransactionMarkerForRecovery({workspace,binding:base});
      if(marker===null)return false;
      if(marker.state!=='finalizing')throw new Error('Active cleanup marker remains before all phases completed');
      if(canonicalDigest(marker.proof)!==canonicalDigest(cleanupMarkerProof(sum,b,e,attempt)))throw new Error('Finalizing cleanup marker does not match its workspace proof');
      const binding={...base,status:marker.status};
      deleteCleanupTransactionMarker({workspace,binding});
      unregisterCleanupStatusMarker(binding);
      return true;
    };
    const terminalizePolicyRejection=(b,e,attempt)=>{
      if(e?.policyRejected!==true)return false;
      // Cleanup journals temporarily replace `reason`; retain the original
      // policy cause as durable terminal evidence on both normal completion
      // and a cleanup-only resume.
      retainVisibleRuleGuardRejection(sum,b,e,e.policyRejectionReason||e.reason);
      if(attempt?.file)atomicJson(attempt.file,attempt);
      refreshTodoList();
      persist(`block.${b.key}.failed`);
      settleFinalizedCleanupMarker(b,e,attempt);
      return true;
    };
    const isStartupReceiptFailure=error=>/^ISOLATED_ACCEPTANCE_STARTUP_RECEIPT:/.test(String(error?.message||error||''));
    const retainStartupReceiptFailure=async(r,e,b,active,la,identity,error)=>{
      const at=Date.now(),detail=String(error?.message||error||'startup receipt validation failed');
      const reason='Startup receipt validation failed before execution; recovery files and lease retained: '+detail;
      e.status='needs-reconciliation';e.reason=reason;e.launchFailed=true;e.endedAt=at;e.exitConfirmed=false;e.exitUnprovenAt ||= at;
      if(active){
        active.exitUnprovenAt ||= e.exitUnprovenAt;
        try{atomicJson(active.file,active);}catch{}
      }
      for(const id of b.taskIds)if(sum.taskResults[id]?.status!=='verified')sum.taskResults[id]={...sum.taskResults[id],status:'needs-reconciliation',reason};
      // The launcher identity was authenticated, so it is safe to tell this
      // blocked worker to stop. The lease remains retained regardless of that
      // cleanup result: a missing/mismatched startup receipt is never a run
      // that may be retried or finalized automatically.
      // The verifier is an external boundary and may invalidate or replace
      // its transient PID observation before it throws.  Only the durable
      // attempt binding may authorize this best-effort close.
      try{if(identity&&ownsObservedLauncher(e,active,identity))await cleanupHook(hooks.close,[identity.ProcessId,identity],'startup receipt cleanup close');}catch{}
      persist(`block.${r.key}.needs-reconciliation`);
    };
    const inspectBlock=(b,e)=>verificationQueue.enqueue(b.key,async()=>{
      let inspectionError=null;
      try{collectVerification(sum,checks,workspace,{blockKey:b.key,allowParentInspection:true});}
      catch(error){
        inspectionError=error;e.status='failed';e.reason='Parent verification failed: '+(error?.message||String(error));
        for(const id of b.taskIds)sum.taskResults[id]={status:'needs-reconciliation',reason:e.reason};
      }
      const report=publicVerificationReport({at:Date.now(),block:b.key,status:e.status,error:inspectionError?.message||null,tasks:b.taskIds.map(id=>({id,result:sum.taskResults[id]}))});
      try{
        fs.appendFileSync(path.join(dir,'verification-report.jsonl'),JSON.stringify(report)+'\n','utf8');
        e.inspectedToken=e.attempts?.at(-1)?.token;
      }catch(error){
        e.status='failed';e.reason='Parent verification report could not be appended: '+(error?.message||String(error));
        for(const id of b.taskIds)sum.taskResults[id]={status:'needs-reconciliation',reason:e.reason};
        console.error('[orchestrator] '+e.reason);
      }
      persist(`block.${b.key}.${e.status}`);
      settleFinalizedCleanupMarker(b,e,e.attempts?.at(-1));
    });
    // A resumed post-exit journal is a cleanup-only transaction.  It runs
    // after this controller owns the run but before scheduling, planning, or
    // any launcher hook.  A failed phase ends this resume attempt without
    // turning unrelated successors into blocked work or replaying the former
    // block.  Successfully reconciled blocks are inspected once and excluded
    // from this controller's launch queue.
    if(options.resume){
      // A predecessor may have published its terminal block status and then
      // died before deleting the now-useless controller marker.  Collect only
      // that fully completed state while the run claim is held; an active or
      // incomplete marker remains for the cleanup-only branch below.
      for(const candidate of readCleanupMarkerCandidates(sum,coordinator,workspace)){
        if(candidate.marker.state==='finalizing'&&candidate.entry.status!=='cleanup-pending'&&candidate.entry.cleanupPending===undefined&&candidate.attempt.cleanupPending===undefined)
          settleFinalizedCleanupMarker(candidate.block,candidate.entry,candidate.attempt);
      }
    }
    const cleanupReconciled=new Set();
    const resumedPendingCleanup=options.resume&&pendingCleanupBlocks(sum).length>0;
    if(resumedPendingCleanup){
      let cleanupComplete=true;
      for(const block of pendingCleanupBlocks(sum)){
        const entry=sum.results[block.key],attempt=entry?.attempts?.at(-1);
        try{await completePostExitCleanup(block,entry,attempt,{deadlineAt:ensureCleanupDeadline()});cleanupReconciled.add(block.key);}
        catch{cleanupComplete=false;break;}
      }
      if(!cleanupComplete){
        refreshTodoList();sum.finishedAt=Date.now();sum.success=false;
        persist('run.cleanup-pending');
        return sum;
      }
      if(sum.abort){
        // An aborted controller may recover only the retained cleanup
        // transaction.  It must not inspect outputs, launch successors, or
        // turn an abort into an implicit acceptance decision.
        for(const key of cleanupReconciled){
          const block=sum.blocks.find(candidate=>candidate.key===key),entry=block&&sum.results[key],attempt=entry?.attempts?.at(-1);
          if(!block||!entry)continue;
          const unsafe=Object.values(blockCheckpoints(entry,block,sum)).some(checkpoint=>checkpoint?.state==='started'||checkpoint?.state==='completed');
          const reason=unsafe?'Acceptance aborted after a task checkpoint; reconcile before retrying':abortReason(sum.abort);
          entry.status=unsafe?'needs-reconciliation':'cancelled';entry.reason=reason;entry.endedAt ||= Date.now();
          for(const id of block.taskIds)if(sum.taskResults[id]?.status!=='verified')sum.taskResults[id]={...sum.taskResults[id],status:unsafe?'needs-reconciliation':'cancelled',reason};
        }
        refreshTodoList();sum.finishedAt=Date.now();sum.success=false;
        persist('run.abort-cleanup-completed');
        for(const key of cleanupReconciled){
          const block=sum.blocks.find(candidate=>candidate.key===key),entry=block&&sum.results[key];
          if(block&&entry)settleFinalizedCleanupMarker(block,entry,entry.attempts?.at(-1));
        }
        return sum;
      }
      for(const key of cleanupReconciled){
        const block=sum.blocks.find(candidate=>candidate.key===key);
        if(block&&!terminalizePolicyRejection(block,sum.results[key],sum.results[key]?.attempts?.at(-1)))await inspectBlock(block,sum.results[key]);
      }
    }
    if(options.resume&&sum.abort&&!resumedPendingCleanup){
      // This covers a crash after the final cleanup journals were cleared but
      // before their finalizing marker could be garbage-collected.  No worker
      // operation is allowed on an aborted resume.
      refreshTodoList();sum.finishedAt=Date.now();sum.success=false;
      persist('run.abort-cleanup-completed');
      for(const candidate of readCleanupMarkerCandidates(sum,coordinator,workspace)){
        settleFinalizedCleanupMarker(candidate.block,candidate.entry,candidate.attempt);
      }
      return sum;
    }
    persist(options.resume?'run.resumed':'plan.created');
    progressTimer=setInterval(()=>{try{if(refreshTaskProgress(sum))persist('task.progress');}catch(error){progressError=error;clearInterval(progressTimer);}},250);
    console.log(`[run] runId=${runId} mode=${sum.executionMode||'visible'} blocks=${sum.blocks.length} capacity=${capacity} generation=${sum.generation} summary=${displaySummaryPath(summaryFile)}`);
    async function execute(r) {
      const b=sum.blocks.find(b=>b.key===r.key),tasks=b.taskIds.map(id=>sum.tasks.find(t=>t.id===id));
      const identify=(pid,pidFile)=>hooks.identity?hooks.identity(pid,pidFile):launcherIdentity(pid,pidFile);
      const leaseId=crypto.createHash('sha256').update(runKey).digest('hex').slice(0,16)+'-'+r.key;
      let attemptsThisController=0;
      const limit=Math.max(1,Math.min(3,Number(options.maxAttempts||2)));
      let capacityRetries=0;
      let memStats=null;
      let reservationProof=null;
      let leaseInstanceId=null;
      let headlessChildUnresolved=false;
      let spawnConfirmed=false;
      let spawnNoProcess=false;
      let spawnAttempted=false;
      let locallyPrepared=false;
      let executionHookUncertain=false;
      const retainExecutionHookUncertainty=(e,active,error)=>{
        // The adapter may finish after this controller returns.  Set the
        // in-memory retention flag before publication so a status sink failure
        // cannot downgrade the block into ordinary failure or let cleanup run.
        executionHookUncertain=true;
        try{markDeadlineReconciliation(r,e,b,active,error?.message);}
        catch{/* The attempt-side marker was written before status publication. */}
      };
      const retainUnresolvedHeadlessChild=(e,active,reason='Headless child exit is unproven; recovery files and lease retained')=>{
        const recorded=e?.headlessChildState||active?.headlessChildState;
        const childState={childStillRunning:recorded?.childStillRunning===true,exitUnproven:recorded?.exitUnproven===true,
          terminationRefused:recorded?.terminationRefused===true};
        if(!(childState.childStillRunning||childState.exitUnproven||childState.terminationRefused))return false;
        const at=e.exitUnprovenAt||active?.exitUnprovenAt||Date.now();
        e.headlessChildState=childState;
        if(active)active.headlessChildState={...childState};
        e.exitConfirmed=false;
        e.exitUnprovenAt ||= at;
        if(active)active.exitUnprovenAt ||= e.exitUnprovenAt;
        e.status='needs-reconciliation';
        e.reason=reason;
        e.endedAt ||= at;
        for(const id of b.taskIds)if(sum.taskResults[id]?.status!=='verified')sum.taskResults[id]={...sum.taskResults[id],status:'needs-reconciliation',reason};
        return true;
      };
      const stopForAbort=async({e,la,active,identity,reservationHeld=false}={})=>{
        const abort=readAbort();
        if(!abort)return false;
        const cleanupAt=ensureCleanupDeadline();
        if(!deadlineIsAvailable(cleanupAt,'abort cleanup',now)){
          markAbortReconciliation(r,e,b,active,'Acceptance aborted after cleanup deadline; recovery files and lease retained');
          return true;
        }
        const reason=abortReason(abort);
        refreshTaskProgress(sum);
        const checkpoints=blockCheckpoints(e,b,sum);
        const unsafe=Object.values(checkpoints).some(checkpoint=>checkpoint?.state==='started'||checkpoint?.state==='completed');
        const heldLease=e?.leaseId||(reservationHeld?leaseId:null);
        const persistActive=()=>{try{if(active?.file)atomicJson(active.file,active);}catch{}};
        if(identity&&!ownsObservedLauncher(e,active,identity)){
          markAbortReconciliation(r,e,b,active,'Acceptance aborted; observed launcher identity is not bound to this run attempt; recovery files and lease retained');
          return true;
        }
        if(identity){
          let exited=false;
          try{
            requireDeadline(cleanupAt,'abort cleanup close',now);
            await callWithDeadline(hooks.close,[identity.ProcessId,identity],cleanupAt,hooks);
            requireDeadline(cleanupAt,'abort cleanup close',now);
            exited=hooks.waitForExit
              ?await callWithDeadline(hooks.waitForExit,[identity],cleanupAt,hooks)
              :await waitForProcessExit(identity,{deadlineAt:cleanupAt,now,pauseMs});
          }catch{exited=false;}
          if(!exited){
            markAbortReconciliation(r,e,b,active,'Acceptance aborted; authenticated launcher exit is unproven; recovery files and lease retained');
            return true;
          }
          if(active&&!active.exitEvidence){
            active.exitEvidence={token:active.token,pid:Number(identity.ProcessId),authenticated:true,at:Date.now()};
          }
          if(active?.exitEvidence)e.exitEvidence={...active.exitEvidence};
          if(active)active.exitConfirmed=true;
          e.exitConfirmed=true;
          persistActive();
          const durable=hasBoundLeaseInstance(e,active);
          try{
            if(durable&&hasAuthenticatedExitProof(e,active)){
              const proofRef={value:heldLease===leaseId?(reservationProof??undefined):undefined};
              await completePostExitCleanup(b,e,active,{deadlineAt:cleanupAt,reservationProofRef:proofRef});
              if(heldLease===leaseId)reservationProof=proofRef.value;
            }else throw cleanupPendingError();
          }catch{
            markAbortReconciliation(r,e,b,active,'Acceptance aborted after launcher exit; cleanup ownership is unproven; recovery files and lease retained');
            return true;
          }
          e.endedAt=Date.now();if(active){active.endedAt=e.endedAt;active.exitCode=e.exitCode;persistActive();}
          if(unsafe){
            const unsafeReason='Acceptance aborted after a task checkpoint; reconcile before retrying';
            e.status='needs-reconciliation';e.reason=unsafeReason;
            for(const id of b.taskIds)if(sum.taskResults[id]?.status!=='verified')sum.taskResults[id]={...sum.taskResults[id],status:'needs-reconciliation',reason:unsafeReason};
            persist(`block.${r.key}.needs-reconciliation`);
          }else mark(r,'cancelled',reason);
          settleFinalizedCleanupMarker(b,e,active);
          return true;
        }
        // A fresh launcher file alone is not evidence of a process. Once a
        // spawn was attempted (or this is a recovered launcher), however, an
        // absent identity is not enough to close or release it safely.
        // An abort can also arrive before this block has reserved anything or
        // constructed any launcher artifact.  That is an ordinary cancelled
        // task, not a cleanup/reconciliation case; there is no external side
        // effect to fence or retain.
        if(!heldLease&&!la&&!active?.leaseId&&!e?.leaseId&&!spawnAttempted&&!spawnConfirmed){
          mark(r,'cancelled',reason);
          return true;
        }
        const maybeSpawned=spawnAttempted||spawnConfirmed||(!locallyPrepared&&Boolean(la||e?.launcherFiles||e?.launcher));
        if(maybeSpawned&&!spawnNoProcess){
          markAbortReconciliation(r,e,b,active,'Acceptance aborted before launcher identity could be proven; recovery files and lease retained');
          return true;
        }
        const durableNoProcess=spawnNoProcess&&hasBoundLeaseInstance(e,active);
        try{
          if(durableNoProcess){
            installNoProcessProof(sum,b,e,active,now);persistActive();
            const proofRef={value:heldLease===leaseId?(reservationProof??undefined):undefined};
            await completePostExitCleanup(b,e,active,{deadlineAt:cleanupAt,reservationProofRef:proofRef});
            if(heldLease===leaseId)reservationProof=proofRef.value;
          }else throw cleanupPendingError();
        }catch{
          markAbortReconciliation(r,e,b,active,'Acceptance aborted before launch; reservation cleanup is unproven; recovery files and lease retained');
          return true;
        }
        e.exitConfirmed=true;e.endedAt=Date.now();if(active){active.endedAt=e.endedAt;persistActive();}
        mark(r,'cancelled',reason);
        settleFinalizedCleanupMarker(b,e,active);
        return true;
      };
      while(now()<executionDeadlineAt) {
        if(progressError)throw progressError;
        let e=sum.results[r.key],la=e.launcherFiles,identity;
        let active=e.attempts?.at(-1);
        const persistAttempt=()=>{
          try{if(active?.file){atomicJson(active.file,active);return true;}}catch{}
          return false;
        };
        const retainLauncherExitUnproven=(reason,{permitFinalSweep=false}={})=>{
          const at=now();
          e.status='needs-reconciliation';e.exitConfirmed=false;e.reason=reason;e.endedAt ||= at;e.exitUnprovenAt ||= at;
          if(active){active.exitConfirmed=false;active.exitUnprovenAt ||= e.exitUnprovenAt;}
          for(const id of b.taskIds)if(sum.taskResults[id]?.status!=='verified')sum.taskResults[id]={...sum.taskResults[id],status:'needs-reconciliation',reason};
          const attemptPersisted=persistAttempt();
          let summaryPersisted=true;
          try{persist(`block.${r.key}.needs-reconciliation`);}catch{summaryPersisted=false;}
          // A permit never crosses a process boundary and is issued only once
          // both durable authorities recorded the retained state.
          if(permitFinalSweep&&active&&attemptPersisted&&summaryPersisted)finalSweepRetryPermits.add(active);
          return attemptPersisted&&summaryPersisted;
        };
        try{
          if(la)validateSavedLauncherFiles(sum,b,e,active,{requireLiveFiles:['launching','running','awaiting-verification'].includes(e.status)});
        }catch(error){
          retainLauncherExitUnproven('Launcher recovery descriptor is unavailable; recovery files and lease retained');
          return;
        }
        // 没有 pid 文件就没有可认领的启动器；这里不查进程表，省掉一次昂贵的 CIM 枚举。
        if(la&&fs.existsSync(la.pidf)){
          try{
            const pidRead=await readLauncherPidWithRetry(hooks.readPid,la.pidf,{deadlineAt:executionDeadlineAt,now,pauseMs});
            if(pidRead.error){
              retainLauncherExitUnproven('Launcher PID is unavailable; recovery files and lease retained');
              return;
            }
            const observedIdentity=await identifyWithRetry(identify,pidRead.pid,la.pidf,{deadlineAt:executionDeadlineAt,now,pauseMs});
            identity=durableLauncherBinding(observedIdentity);
          }catch(error){
            retainLauncherExitUnproven('Launcher identity is unavailable; recovery files and lease retained');
            return;
          }
        }
        if(identity&&!ownsObservedLauncher(e,e.attempts?.at(-1),identity)){
          retainLauncherExitUnproven('Observed launcher identity does not match the durable attempt binding; recovery files and lease retained');
          return;
        }
        const adopted=Boolean(identity);
        if(await stopForAbort({e,la,active:e.attempts?.at(-1),identity}))return;
        if(adopted) {
          active=e.attempts.at(-1);console.log(`[resume] adopting live ${r.key}; no duplicate window`);
          if(await stopForAbort({e,la,active,identity}))return;
          try{
            requireDeadline(executionDeadlineAt,'execution startup verification',now);
            if(hooks.verifyStartup)await callWithDeadline(hooks.verifyStartup,[la,identity],executionDeadlineAt,hooks);
            requireDeadline(executionDeadlineAt,'execution startup verification',now);
          }
          catch(error){
            if(isStartupReceiptFailure(error)){await retainStartupReceiptFailure(r,e,b,active,la,identity,error);return;}
            retainLauncherExitUnproven('Adopted launcher startup verification failed; recovery files and lease retained');
            return;
          }
          try{
            requireDeadline(executionDeadlineAt,'execution startup ready',now);
            if(hooks.ready)callWithDeadline(hooks.ready,[la],executionDeadlineAt,hooks);
          }catch(error){
            retainLauncherExitUnproven('Adopted launcher readiness could not be proven; recovery files and lease retained');
            return;
          }
        }else {
          if(await stopForAbort({e,la,active,identity}))return;
          const cps=blockCheckpoints(e,b,sum);
          const recovery=recoveryTasks(tasks,cps,checks,workspace,sum.taskResults);
          Object.assign(sum.taskResults,recovery.results);
          if(recovery.verified.length===tasks.length){e.status='verified';e.endedAt=Date.now();persist(`block.${r.key}.verified`);return;}
          if(recovery.uncertain.length){e.status='needs-reconciliation';e.reason='Uncertain tasks: '+recovery.uncertain.join(', ');e.endedAt=Date.now();persist(`block.${r.key}.needs-reconciliation`);return;}
          if(attemptsThisController>=limit){mark(r,'failed','Safe recovery attempt budget exhausted');return;}
          if(attemptsThisController){
            try{await pauseBeforeDeadline(2000*attemptsThisController,executionDeadlineAt,'execution retry',{now,pauseMs});}
            catch(error){if(deadlineExpired(error)){mark(r,'timeout','Run deadline exhausted');return;}throw error;}
          }
          if(await stopForAbort({e,la,active,identity}))return;
          const memoryBudget=options.memoryBudget;
          let cost=memoryBudget&&memoryBudget.mode==='dynamic'
            ?Math.ceil(blockCostFor(sum,r.key,memoryBudget)*(memoryBudget.headroom||1)):0;
          const memoryAdmission=memoryBudget&&memoryBudget.mode==='dynamic'
            ?(leases,rec,snapshot)=>admissionOk({availableMB:availableMB(),runningCostMB:unconsumedReservationMB(leases,snapshot),blockCostMB:rec.memoryCostMB,floorMB:memoryBudget.floorMB})
            :undefined;
          let reserved=false;
          while(now()<executionDeadlineAt) {
            if(await stopForAbort({e,la,active,identity,reservationHeld:reserved}))return;
            if(memoryBudget?.mode==='dynamic')cost=Math.ceil(blockCostFor(sum,r.key,memoryBudget)*(memoryBudget.headroom||1));
            const result=await coordinate(
              ()=>reserve(coordinator,{id:leaseId,runId,keys:r.keys,memoryCostMB:cost},capacity,undefined,memoryAdmission,{keyCwd:workspace,deadlineAt:executionDeadlineAt}),
              executionDeadlineAt,{now,pauseMs,stage:'execution reservation'});
            // A failed private receipt lookup is itself a malformed positive
            // acknowledgement. Keep the sentinel distinct from `undefined`:
            // the latter would pass the old non-null check below and turn the
            // recovery branch into a second TypeError before it can preserve
            // the committed lease for reconciliation.
            let acknowledgement=null,acknowledgementError;
            try{acknowledgement=reservationAcknowledgement(coordinator,leaseId,result);}
            catch(error){acknowledgementError=error;}
            let returnedOk,returnedReason,returnedProof,returnedInstance,projectionError;
            try{
              returnedOk=result?.ok;
              returnedReason=result?.reason;
              returnedProof=result?.reservationProof;
              returnedInstance=result?.leaseInstanceId;
            }catch(error){projectionError=error;}
            const receiptProof=acknowledgement?.reservationProof??returnedProof;
            const receiptInstance=acknowledgement?.leaseInstanceId??returnedInstance;
            // A normal negative answer is the only response that may wait and
            // retry.  `reserve()` registers every positive acknowledgement in
            // a private WeakMap before it projects the proof and UUID onto the
            // public result object.  Therefore a missing `ok`, proof, or UUID
            // after a committed transaction is still attributable to the
            // in-process acknowledgement and cannot be mistaken for capacity.
            const ordinaryNegative=returnedOk===false&&acknowledgement===null&&!projectionError&&
              returnedProof===undefined&&returnedInstance===undefined&&typeof returnedReason==='string'&&returnedReason.length>0;
            const publicProjectionMatches=returnedOk===true&&acknowledgement!==null&&
              returnedProof===acknowledgement.reservationProof&&returnedInstance===acknowledgement.leaseInstanceId;
            const normalAcknowledgement=publicProjectionMatches&&typeof receiptInstance==='string'&&UUID.test(receiptInstance)&&!acknowledgementError&&!projectionError;
            // `reserve()` has already committed a coordinator row before it
            // returns its acknowledgement.  Treat any non-standard answer as
            // a failed acknowledgement, rather than retrying the same public
            // id until timeout.  A stale same-process proof is never grounds
            // for an ID-only release: preserve a matching protocol-2 record
            // so the next controller blocks for explicit reconciliation.
            const malformedAcknowledgement=!ordinaryNegative&&!normalAcknowledgement;
            if(malformedAcknowledgement){
              let rollbackError;
              if(receiptProof){
                try{
                  await coordinate(
                    ()=>release(coordinator,leaseId,undefined,{deadlineAt:executionDeadlineAt,reservationProof:receiptProof}),
                    executionDeadlineAt,{now,pauseMs,stage:'invalid reservation rollback'});
                }catch(error){rollbackError=error;}
              }else rollbackError=new Error('Coordinator acknowledgement has no private reservation proof');
              if(!rollbackError){
                throw new Error('Coordinator reservation acknowledgement is malformed; its unlaunched reservation was rolled back');
              }
              // Prefer the private capability's original instance id. It
              // remains readable after the durable row was replaced, while a
              // later proof-authorized operation correctly rejects that stale
              // row. A syntactically valid public id is retained only when
              // the private acknowledgement itself cannot be read, and still
              // blocks automatic resume rather than authorizing cleanup.
              const retainedInstance=typeof acknowledgement?.leaseInstanceId==='string'&&UUID.test(acknowledgement.leaseInstanceId)
                ?acknowledgement.leaseInstanceId
                :(typeof returnedInstance==='string'&&UUID.test(returnedInstance)?returnedInstance:null);
              const observedAt=Number(now());
              const at=Number.isSafeInteger(observedAt)&&observedAt>0?observedAt:Date.now();
              const reason='Coordinator reservation acknowledgement is malformed and its private rollback is unproven; recovery files and lease retained';
              if(retainedInstance){
                const number=e.attempts.length+1,token=runId+'-'+r.key+'-a'+number+'-'+crypto.randomBytes(6).toString('hex');
                const attemptFile=path.join(dir,'attempts',r.key,String(number),'attempt.json');
                active={file:attemptFile,runId,blockKey:r.key,token,number,taskIds:recovery.pending,leaseId,leaseInstanceId:retainedInstance,
                  createdAt:at,exitConfirmed:false,exitUnprovenAt:at,
                  reservationAcknowledgementError:projectionError?.message||acknowledgementError?.message||rollbackError?.message||'malformed acknowledgement'};
                atomicJson(attemptFile,active);
                const retained={...e,status:'needs-reconciliation',attempts:[...e.attempts,active],leaseId,leaseInstanceId:retainedInstance,token,
                  launcher:undefined,launcherFiles:undefined,exitConfirmed:false,exitUnprovenAt:at,exitEvidence:undefined,noProcessProof:undefined,
                  cleanupPending:undefined,headlessChildState:undefined,endedAt:at,reason};
                sum.results[r.key]=e=retained;
                for(const id of b.taskIds)if(sum.taskResults[id]?.status!=='verified')sum.taskResults[id]={...sum.taskResults[id],status:'needs-reconciliation',reason};
                persist(`block.${r.key}.needs-reconciliation`);
                return;
              }
              // This is a defensive fallback for a coordinator replacement
              // that withholds both usable identity sources.  It cannot carry
              // a protocol-2 attempt without inventing a UUID, so persist a
              // non-authorizing forensic marker and block automatic resume.
              const fault={version:1,kind:'reservation-acknowledgement',at,leaseId};
              const retained={...e,status:'needs-reconciliation',exitConfirmed:false,exitUnprovenAt:at,endedAt:at,reason,reservationFault:fault};
              delete retained.leaseId;delete retained.leaseInstanceId;delete retained.token;
              delete retained.launcher;delete retained.launcherFiles;delete retained.exitEvidence;delete retained.noProcessProof;
              delete retained.cleanupPending;delete retained.headlessChildState;
              sum.results[r.key]=e=retained;
              for(const id of b.taskIds)if(sum.taskResults[id]?.status!=='verified')sum.taskResults[id]={...sum.taskResults[id],status:'needs-reconciliation',reason};
              persist(`block.${r.key}.needs-reconciliation`);
              return;
            }
            if(normalAcknowledgement){
              reserved=true;reservationProof=receiptProof;leaseInstanceId=receiptInstance;break;
            }
            const reason=returnedReason==='memory'?`Waiting for memory: available ${availableMB()}MB, predicted peak ${cost}MB, reserve ${memoryBudget.floorMB}MB`:'Waiting for '+returnedReason;
            mark(r,returnedReason==='memory'?'deferred':'waiting',reason);
            try{await pauseBeforeDeadline(1000,executionDeadlineAt,'execution reservation retry',{now,pauseMs});}
            catch(error){if(deadlineExpired(error))break;throw error;}
          }
          if(!reserved){mark(r,'timeout','Window capacity/resource wait timed out');return;}
          attemptsThisController++;
          const number=e.attempts.length+1,token=runId+'-'+r.key+'-a'+number+'-'+crypto.randomBytes(6).toString('hex');
          const attemptFile=path.join(dir,'attempts',r.key,String(number),'attempt.json');
          active={file:attemptFile,runId,blockKey:r.key,token,number,taskIds:recovery.pending,leaseId,leaseInstanceId,createdAt:Date.now()};
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
          try{
            requireDeadline(executionDeadlineAt,'execution launcher preparation',now);
            la=callWithDeadline(hooks.launcher,[r.key,hooks.prompt(body,token),runId+'-a'+number,{attemptFile,runId,token,taskIds:recovery.pending,blockKey:r.key,attemptNumber:number}],executionDeadlineAt,hooks);
            assertPublicLauncherFiles(la);locallyPrepared=true;
            requireDeadline(executionDeadlineAt,'execution launcher preparation',now);
          }
          catch(error){
            try{
              await coordinate(()=>release(coordinator,leaseId,undefined,{deadlineAt:executionDeadlineAt,reservationProof}),executionDeadlineAt,{now,pauseMs,stage:'execution launcher release'});
              reservationProof=null;
            }catch(releaseError){
              // The attempt record was intentionally published before the
              // launcher callback.  If its same-controller rollback cannot
              // be proven, publish the matching protocol-2 lease binding and
              // retain it for reconciliation instead of leaving an invalid
              // summary whose latest attempt cannot be authenticated.
              const at=now();
              active.launcherPreparationError=error?.message||String(error);
              active.exitConfirmed=false;
              active.exitUnprovenAt=at;
              try{atomicJson(active.file,active);}catch{}
              e={...e,status:'needs-reconciliation',leaseId,leaseInstanceId,token,launcherFiles:undefined,launcher:undefined,
                exitConfirmed:false,exitUnprovenAt:at,exitEvidence:null,endedAt:at,
                reason:'Launcher preparation failed and reservation rollback is unproven; recovery files and lease retained'};
              delete e.noProcessProof;
              sum.results[r.key]=e;
              persist(`block.${r.key}.needs-reconciliation`);
              return;
            }
            // No launcher descriptor or process was published on this path.
            // The lease rollback succeeded under the in-memory proof, so the
            // private attempt record must not outlive its matching summary
            // binding and poison a later protocol-2 recovery.
            e.attempts=e.attempts.filter(candidate=>candidate!==active);
            try{fs.rmSync(active.file,{force:true});}catch{}
            active=undefined;
            throw error;
          }
          // Omit an as-yet unbound launcher from durable state. `null` is not
          // an identity binding and would make a clean pre-identity failure
          // look like a legacy recovery record on the next controller start.
          e={...e,status:'launching',launchFailed:false,leaseId,leaseInstanceId,token,launcherFiles:la,launcher:undefined,endedAt:null,exitConfirmed:false,exitUnprovenAt:null,exitEvidence:null,startedAt:Date.now(),reason:'',retryAt:null};delete e.noProcessProof;sum.results[r.key]=e;persist(`block.${r.key}.launching`);
          spawnNoProcess=false;
          spawnConfirmed=false;
          spawnAttempted=false;
          if(await stopForAbort({e,la,active,identity,reservationHeld:true}))return;
          try {
            requireDeadline(executionDeadlineAt,'execution launcher register',now);
            callWithDeadline(hooks.register,[{id:leaseId,runId,leaseInstanceId,title:r.title,keys:r.keys,pidFile:la.pidf,pid:0,pending:true,reservedAt:Date.now()},coordinator],executionDeadlineAt,hooks);
            requireDeadline(executionDeadlineAt,'execution launcher register',now);
            await coordinate(()=>prepare(coordinator,leaseId,la.pidf,undefined,{deadlineAt:executionDeadlineAt,reservationProof}),executionDeadlineAt,{now,pauseMs,stage:'execution launcher prepare'});
            // Keep the launcher retry budget owned by the runner's caller. A
            // hard-coded one-shot spawn made transient WT/provider startup
            // failures collapse an otherwise full-capacity wave into a single
            // live window, then produced incomplete receipts.
             const spawnRetries=Math.max(1,Math.min(5,Number(options.windowMaxRetry??3)||3));
             if(await stopForAbort({e,la,active,identity,reservationHeld:true}))return;
              requireDeadline(executionDeadlineAt,'execution spawn',now);
             spawnAttempted=true;
              const spawnResult=await executionHookWithDeadline(hooks.spawn,[la.lp,r.title,la.pidf,spawnRetries,token],executionDeadlineAt,'execution spawn',{now,receiver:hooks});
              requireDeadline(executionDeadlineAt,'execution spawn',now);
              const observedPid=await readLauncherPidWithRetry(hooks.readPid,la.pidf,{deadlineAt:executionDeadlineAt,now,pauseMs});
             if(observedPid.error&&observedPid.state!=='startup'){
               // A launcher adapter cannot prove a clean miss while its own
               // controller PID file is unreadable or malformed. Preserve the
               // lease and artifacts for reconciliation instead of trusting a
               // concurrent `noProcess` result.
               spawnConfirmed=true;
               active.pidReadUnavailableAt=Date.now();
               persistAttempt();
               throw observedPid.error;
             }
             const observed=validLauncherPid(observedPid.pid)||fs.existsSync(la.rf)||fs.existsSync(la.rf+'.self-closed');
             const spawnState=classifySpawnResult(spawnResult,observed);
             const spawned=spawnState.spawned;
             spawnConfirmed=observed;
             spawnNoProcess=spawnState.noProcess;
             if(await stopForAbort({e,la,active,identity,reservationHeld:true}))return;
             if(!spawned){
               if(!spawnNoProcess)active.spawnOutcomeUnknownAt=Date.now();
               persistAttempt();
               throw new Error('Execution process did not start');
             }
             spawnConfirmed=true;
             active.popupConfirmedAt=Date.now();
              const identityPid=await readLauncherPidWithRetry(hooks.readPid,la.pidf,{deadlineAt:executionDeadlineAt,now,pauseMs});
             if(identityPid.error)throw identityPid.error;
             active.launcherPid=identityPid.pid||null;
             persist(`block.${r.key}.popup-confirmed`);
             persistAttempt();
               const observedIdentity=await identifyWithRetry(identify,identityPid.pid,la.pidf,{deadlineAt:executionDeadlineAt,now,pauseMs});
              identity=durableLauncherBinding(observedIdentity);
              persistAttempt();
              if(!identity)throw new Error('Launcher process identity mismatch');
              // Adapters may hand us a live raw CIM row. Keep that row only in
              // this stack frame long enough to establish identity, then retain
              // the public-safe binding for attempts, summaries and recovery.
              // `launcherObserved` crosses the durable attempt boundary, so
              // it must remain the exact four-field process binding.  Keep
              // observation timing as separate metadata; appending `at` here
              // turns a safe binding back into an unsupported ledger shape.
              active.launcherObserved=identity;
             active.identityObservedAt=Date.now();
             persistAttempt();
            if(await stopForAbort({e,la,active,identity,reservationHeld:true}))return;
             await coordinate(()=>bind(coordinator,leaseId,identity,undefined,{deadlineAt:executionDeadlineAt,reservationProof}),executionDeadlineAt,{now,pauseMs,stage:'execution launcher bind'});
             requireDeadline(executionDeadlineAt,'execution launcher commit',now);
              if(hooks.commit)callWithDeadline(hooks.commit,[leaseId,identity.ProcessId,coordinator,{runId,leaseInstanceId}],executionDeadlineAt,hooks);
            if(await stopForAbort({e,la,active,identity,reservationHeld:true}))return;
             requireDeadline(executionDeadlineAt,'execution startup verification',now);
             if(hooks.verifyStartup)await callWithDeadline(hooks.verifyStartup,[la,identity],executionDeadlineAt,hooks);
             requireDeadline(executionDeadlineAt,'execution startup verification',now);
             requireDeadline(executionDeadlineAt,'execution startup ready',now);
             if(hooks.ready)callWithDeadline(hooks.ready,[la],executionDeadlineAt,hooks);
          }catch(error){
            if(executionHookDeadlineUncertain(error)){
              retainExecutionHookUncertainty(e,active,error);
              return;
            }
            if(spawnAttempted&&!identity&&!spawnNoProcess){
              const invalidPid=String(error?.message||'')==='Launcher PID is invalid';
              retainLauncherExitUnproven(invalidPid
                ?'Launcher PID is invalid; launcher exit is unproven; recovery files and lease retained'
                :'Launcher identity unavailable; launcher exit is unproven; recovery files and lease retained');
              return;
            }
            if(isStartupReceiptFailure(error)){
              await retainStartupReceiptFailure(r,e,b,active,la,identity,error);
              return;
            }
            e.status='popup-failed';e.reason=error.message;e.launchFailed=true;
            // The unified cleanup below owns the single close-and-exit-proof
            // sequence.  Calling the adapter here as well would require every
            // closer to be idempotent and could target a reused process twice.
          }
        }
        e=sum.results[r.key];
        if(identity&&!isProcessIdentityBinding(identity))throw new Error('Launcher process identity mismatch');
        e.launcher=identity||e.launcher;
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
            // One run-level, low-priority sampler distributes each successful
            // process observation to every active dynamic-memory window.
            if(options.memoryBudget?.mode==='dynamic')memStats=memorySampler.start(r.key,identity);
            // Session rollouts can be created well after the visible window is
            // confirmed (provider/model cold start). Bound discovery by the
            // run deadline, not an arbitrary 90-second cutoff that closes a
            // healthy task before its first rollout event exists.
            requireDeadline(executionDeadlineAt,'execution session discovery',now);
            const session=await executionHookWithDeadline(hooks.session,[
              '【本块唯一标识】'+active.token,
              remainingBeforeDeadline(executionDeadlineAt,'execution session discovery',now),la.rf,readAbort,
            ],executionDeadlineAt,'execution session discovery',{now,receiver:hooks});
            requireDeadline(executionDeadlineAt,'execution session discovery',now);
            // The visible watchdog can close before session discovery returns.
            // Its exit marker proves execution ended; task success still requires
            // the independent checkpoint and receipt checks below.
            let result=session
              ?await executionHookWithDeadline(hooks.wait,[
                session,remainingBeforeDeadline(executionDeadlineAt,'execution session wait',now),la.rf,
                '【本块唯一标识】'+active.token,la.pidf,readAbort,
              ],executionDeadlineAt,'execution session wait',{now,receiver:hooks})
              :{done:fs.existsSync(la.rf)||fs.existsSync(la.rf+'.self-closed'),exitCode:hooks.exitCode(la.rf)};
            requireDeadline(executionDeadlineAt,'execution session wait',now);
            const ruleRejection=typeof hooks.policyRejection==='function'
              ?hooks.policyRejection(la.rf,'【本块唯一标识】'+active.token)
              :null;
            if(ruleRejection)result={...result,done:false,verified:false,policyRejected:true,
              text:'Visible rule guard refused execution because active or unsafe Codex rules were found.',
              exitCode:Number.isInteger(ruleRejection.__EXIT__)?ruleRejection.__EXIT__:3};
            e.exitCode=result.exitCode??hooks.exitCode(la.rf);
            const unresolvedHeadlessChild=la?.mode==='headless'&&(
              result?.childStillRunning===true||result?.exitUnproven===true||result?.terminationRefused===true);
            if(unresolvedHeadlessChild){
              // The worker can prove its own exit while an internal CLI child
              // remains unbound or its exit cannot be proven.  Do not release
              // capacity, erase controller artifacts, or inspect task outputs:
              // those actions would turn an unresolved child into a completed
              // execution.  Persist a safe projection and require explicit
              // reconciliation instead.
              const childState={childStillRunning:result.childStillRunning===true,exitUnproven:result.exitUnproven===true,
                terminationRefused:result.terminationRefused===true};
              const at=Date.now();
              e.headlessChildState=childState;active.headlessChildState={...childState};
              e.exitUnprovenAt ||= at;active.exitUnprovenAt ||= e.exitUnprovenAt;
              headlessChildUnresolved=true;
              retainUnresolvedHeadlessChild(e,active);
              // Commit the independent journal before either best-effort
              // attempt persistence or status publication. Both later writes
              // can fail after the child result is durable.
              writeHeadlessReconciliationMarker(sum,b,active,childState,e.exitUnprovenAt);
              persistAttempt();persist(`block.${r.key}.needs-reconciliation`);
              return;
            }
            if(result.policyRejected===true){
              retainVisibleRuleGuardRejection(sum,b,e,result.text);
              active.diagnostic={sessionFound:Boolean(session),launcherFinished:false,reportCaptured:false,
                launcherExitCode:e.exitCode??null,selfCloseMarkerPresent:fs.existsSync(la.rf+'.self-closed'),policyRejected:true};
            }else{
              e.status=result.done?'awaiting-verification':e.exitCode!=null?'failed':'timeout';
              if(!session||!result.done||result.verified===false||(e.exitCode!=null&&e.exitCode!==0)){
                active.diagnostic={sessionFound:Boolean(session),launcherFinished:Boolean(result.done),reportCaptured:result.verified===true,
                  launcherExitCode:e.exitCode??null,selfCloseMarkerPresent:fs.existsSync(la.rf+'.self-closed')};
              }
              if(result.threadId)active.threadId=result.threadId;
              if(!result.done&&result.text)e.reason=result.text;
            }
            // The worker may have flushed its final completed checkpoint just
            // before the durable result became visible. Refresh before
            // publishing the awaiting-verification transition so host readers
            // never miss that live task state.
            refreshTaskProgress(sum);
            persist(`block.${r.key}.${e.status}`);
            if (!result.policyRejected&&result.retryable === 'capacity') {
              e.retryable = 'capacity';
              e.capacityError = result.capacityError || result.text || 'provider capacity';
              capacityRetry = capacityRetryPolicy(e.capacityError, capacityRetries + 1);
            }
            if (!result.policyRejected&&result.retryable === 'quota') {
              e.retryable = 'quota';
              e.quotaError = result.quotaError || result.text || 'provider usage limit';
            }
          }
        }catch(error){
          // Once an authenticated worker has reported an unresolved internal
          // child, persistence failure is not authority to downgrade it to a
          // normal failed block. Keep the in-memory state monotonic so this
          // `finally` path, the outer sweep, and final status all retain the
          // lease and evidence for explicit reconciliation.
          const retainedUnresolved=retainUnresolvedHeadlessChild(e,active,'Headless child exit is unproven; recovery files and lease retained; status persistence failed');
          if(headlessChildUnresolved||retainedUnresolved)headlessChildUnresolved=true;
           else if(executionHookDeadlineUncertain(error)){
             retainExecutionHookUncertainty(e,active,error);
           }
          else if(deadlineExpired(error)){e.status='timeout';e.reason='Run deadline exhausted';}
          else if(!readAbort()){e.status='failed';e.reason=error.message;}
        }
        finally {
          if(memStats)memStats=memorySampler.stop(r.key)||memStats;
           if(headlessChildUnresolved||executionHookUncertain)return;
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
          if(await stopForAbort({e,la,active,identity,reservationHeld:Boolean(e.leaseId)}))return;
          const cleanupAt=executionDeadlineAt;
          if(!deadlineIsAvailable(cleanupAt,'block cleanup',now)){
            retainLauncherExitUnproven('Run deadline expired before launcher cleanup could be proven; recovery files and lease retained');
            return;
          }
          let cleanupExitProven=false;
          try{
            if(!identity&&la&&fs.existsSync(la.pidf)){
              // A transient/foreign identity result is not an exit proof. Keep
              // the attempt recoverable and only continue when its own result
              // record proves an exited launcher.
              try{
                const pidRead=await readLauncherPidWithRetry(hooks.readPid,la.pidf,{deadlineAt:cleanupAt,now,pauseMs});
                if(pidRead.error)throw pidRead.error;
                const observedIdentity=await identifyWithRetry(identify,pidRead.pid,la.pidf,{deadlineAt:cleanupAt,now,pauseMs});
                identity=durableLauncherBinding(observedIdentity);
                requireDeadline(cleanupAt,'block cleanup identity',now);
              }catch(error){
                if(deadlineExpired(error))return;
                identity=null;e.identityError=error&&error.message?error.message:String(error);
              }
            }
            if(identity){
              if(!ownsObservedLauncher(e,active,identity)){
                retainLauncherExitUnproven('Observed launcher identity does not match the durable attempt binding; recovery files and lease retained');
                return;
              }
              await deadlineHook(hooks.close,[identity.ProcessId,identity],cleanupAt,'block cleanup close',hooks);
              const exited=hooks.waitForExit
                ?await callWithDeadline(hooks.waitForExit,[identity],cleanupAt,hooks)
                :await waitForProcessExit(identity,{deadlineAt:cleanupAt,now,pauseMs});
              requireDeadline(cleanupAt,'block cleanup close',now);
              if(!exited){
                refreshTaskProgress(sum);
                const uncertain=blockCheckpoints(e,b,sum);
                for(const id of b.taskIds)if(uncertain[id]?.state==='started')sum.taskResults[id]={status:'needs-reconciliation',reason:'Launcher exit is unproven; reconcile before retrying',checkpoint:uncertain[id]};
                retainLauncherExitUnproven('Launcher still alive; lease retained',{permitFinalSweep:true});
                return;
              }
              cleanupExitProven=true;
            }
            let exitProven=Boolean(identity||spawnNoProcess);
            cleanupExitProven=cleanupExitProven||exitProven;
            if(!identity&&spawnConfirmed){
              const evidence=await waitForOwnedLauncherExit(la,active,{
                readPid:async pidFile=>(await readLauncherPidWithRetry(hooks.readPid||readPidFromFile,pidFile,{deadlineAt:cleanupAt,now,pauseMs})).pid,
                probePid:hooks.probePid||defaultPidPresence,
                timeoutMs:Math.min(10000,remainingBeforeDeadline(cleanupAt,'block cleanup evidence',now)),
                deadlineAt:cleanupAt,now,pauseMs,
              });
              if(!evidence){
                active.launcherIdentityUnavailableAt=now();
                active.exitUnprovenAt=active.launcherIdentityUnavailableAt;
                e.exitUnprovenAt=active.exitUnprovenAt;
                e.status='needs-reconciliation';
                e.reason='Launcher identity unavailable after popup confirmation; owned exit is unproven; recovery files and lease retained'+(e.identityError?': '+e.identityError:'');
                for(const id of b.taskIds)if(sum.taskResults[id]?.status==='pending'||sum.taskResults[id]?.status==='running')sum.taskResults[id]={status:'needs-reconciliation',reason:e.reason};
                persistAttempt();
                e.endedAt=now();persist(`block.${r.key}.needs-reconciliation`);return;
              }
              active.exitEvidence={token:evidence.__TOKEN__,pid:Number(evidence.__LAUNCHER_PID__),exitCode:evidence.__EXIT__,authenticated:true,at:now()};
              active.selfCloseAt=now();
              persistAttempt();
              exitProven=true;
              cleanupExitProven=true;
            }
            if(!exitProven){
              active.exitUnprovenAt ||= now();
              e.exitUnprovenAt ||= active.exitUnprovenAt;
              persistAttempt();
              e.status='needs-reconciliation';e.reason='Launcher exit is unproven; recovery files and lease retained';e.endedAt=now();persist(`block.${r.key}.needs-reconciliation`);return;
            }
            if(identity&&!active.exitEvidence){
              active.exitEvidence={token:active.token,pid:Number(identity.ProcessId),authenticated:true,at:now()};
              persistAttempt();
            }
            if(active.exitEvidence){
              e.exitEvidence={...active.exitEvidence};
              // Persist the same authenticated proof in both authorities before
              // the cleanup journal can authorize any destructive phase.
              active.exitConfirmed=true;e.exitConfirmed=true;
            }
            const durableLeaseInstance=hasBoundLeaseInstance(e,active);
            if(!durableLeaseInstance){
              retainLauncherExitUnproven('Post-exit cleanup lacks a bound protocol 2 lease instance; recovery files and lease retained');
              return;
            }
            if(spawnNoProcess){
              installNoProcessProof(sum,b,e,active,now);
              const proofRef={value:reservationProof};
              await completePostExitCleanup(b,e,active,{deadlineAt:cleanupAt,reservationProofRef:proofRef});
              reservationProof=proofRef.value;
            }else if(hasAuthenticatedExitProof(e,active)){
              const proofRef={value:reservationProof};
              await completePostExitCleanup(b,e,active,{deadlineAt:cleanupAt,reservationProofRef:proofRef});
              reservationProof=proofRef.value;
            }else{
              retainLauncherExitUnproven('Post-exit cleanup lacks a complete bound launcher proof; recovery files and lease retained');
              return;
            }
            e.endedAt=now();active.endedAt=e.endedAt;active.exitCode=e.exitCode;
            // Cleanup journals temporarily expose `cleanup-pending`. A rule
            // guard refusal has no parent-inspection phase to replace that
            // transient state, so restore its terminal failure explicitly.
            if(e.policyRejected)terminalizePolicyRejection(b,e,active);
            else persistAttempt();
          }catch(error){
            if(e.cleanupPending&&(hasAuthenticatedExitProof(e,active)||hasNoProcessProof(sum,b,e,active)))return;
            if(deadlineExpired(error)||!cleanupExitProven){
              retainLauncherExitUnproven('Launcher cleanup could not prove exit; recovery files and lease retained');
              return;
            }
            throw error;
          }
          // A provider-capacity failure is retryable only before any task has a
          // durable side-effect checkpoint. Do not publish the reconciliation
          // status before the safe retry branch below; status events are
          // monotonic and would make the retry transition invalid.
          const finalCheckpoints=blockCheckpoints(e,b,sum);
          const finalRetryUnsafe=Object.values(finalCheckpoints).some(cp=>cp?.state==='started'||cp?.state==='completed');
          if(!e.policyRejected&&!(capacityRetry?.retry&&!finalRetryUnsafe))await inspectBlock(b,e);
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
          try{await pauseBeforeDeadline(capacityRetry.delayMs,executionDeadlineAt,'capacity retry',{now,pauseMs});}
          catch(error){
            if(deadlineExpired(error)){mark(r,'timeout','Run deadline exhausted');return;}
            throw error;
          }
          continue;
        }
        if(e.status==='verified'||e.policyRejected)return;
        if(e.retryable==='quota') { mark(r,'failed',e.quotaError||'Provider usage limit; retry after quota reset');return; }
        if(e.retryable==='capacity') { mark(r,'failed',retryUnsafe?'Provider capacity after a task checkpoint; reconcile before retrying':'Provider capacity retry budget exhausted');return; }
        // Popup/launcher interruptions have no task checkpoint, so the bounded controller
        // attempt budget retries the block automatically. Only started or completed checkpoints
        // can move a task into needs-reconciliation and stop blind replay.
      }
      mark(r,'timeout','Run deadline exhausted');
    }
    const launchPlan=orderLaunchPlan(sum,sum.plan,options.memoryBudget).filter(record=>!cleanupReconciled.has(record.key));
    await scheduleReady(launchPlan,async r=>{
      try{await execute(r);}
      catch(error){
        const aborted=readAbort();
        const entry=sum.results[r.key];
        if(aborted){
          if(entry?.launcher||entry?.launcherFiles||entry?.leaseId){
            markAbortReconciliation(r,entry,sum.blocks.find(b=>b.key===r.key),entry?.attempts?.at(-1),'Acceptance aborted while controller cleanup failed; recovery files and lease retained');
          }else mark(r,'cancelled',abortReason(aborted));
        }else mark(r,'failed',error.message);
      }
    },key=>sum.results[key]?.status,
      (r,failed)=>{
        const aborted=readAbort();
        if(aborted)mark(r,'cancelled',abortReason(aborted));
        else mark(r,'blocked','Predecessors not verified: '+failed.join(', '));
      });
    const finalCleanupDeadlineAt=ensureCleanupDeadline();
    sum.finalSweep=await sweepRunProcesses(sum,{
      close:typeof hooks.close==='function'?hooks.close.bind(hooks):hooks.close,identify:hooks.identity||launcherIdentity,
      waitForExit:typeof hooks.waitForExit==='function'?hooks.waitForExit.bind(hooks):((identity,context={})=>waitForProcessExit(identity,{...context,now,pauseMs})),
      snapshot:hooks.snapshot||processSnapshot,probePid:hooks.probePid||defaultPidPresence,
      abort:readAbort,cleanupDeadlineAt:finalCleanupDeadlineAt,now,
      onClosed:async(b,e,attempt,{wasConfirmed,deadlineAt:closedDeadline})=>{
        const cleanupAt=closedDeadline??finalCleanupDeadlineAt;
        e.endedAt ||= now();attempt.endedAt ||= e.endedAt;
        try{
          // A one-shot final retry resolves a retained marker only when both
          // restart authorities carry the same authenticated exit proof.  The
          // attempt write comes first; a crash after either side writes still
          // leaves at least one unresolved marker/proof mismatch and blocks
          // a new controller from replaying the block.
          if(resolvedExitUncertainty(e,attempt)){
            if(!attempt?.file)throw new Error('Resolved launcher exit has no durable attempt record');
            atomicJson(attempt.file,attempt);
            persist(`block.${b.key}.exit-proven`);
          }
          requireDeadline(cleanupAt,'final cleanup callback',now);
          if(!wasConfirmed){
            if(!hasBoundLeaseInstance(e,attempt)){
              throw new Error('Final cleanup lacks a bound protocol 2 lease instance');
            }else if(hasAuthenticatedExitProof(e,attempt)){
              await completePostExitCleanup(b,e,attempt,{deadlineAt:cleanupAt});
            }else{
              throw new Error('Final cleanup lacks a complete bound launcher proof');
            }
          }
          requireDeadline(cleanupAt,'final cleanup callback',now);
        }catch(error){
          if(deadlineExpired(error)){
            markDeadlineReconciliation(b,e,b,attempt,'Cleanup deadline expired after launcher exit proof; lease and recovery files retained');
            return;
          }
          throw error;
        }
        if(e.policyRejected){
          terminalizePolicyRejection(b,e,attempt);
          return;
        }
        if(sum.abort){
          if(e.status==='verified'){settleFinalizedCleanupMarker(b,e,attempt);return;}
          const checkpoints=blockCheckpoints(e,b,sum);
          const unsafe=Object.values(checkpoints).some(checkpoint=>checkpoint?.state==='started'||checkpoint?.state==='completed');
          if(unsafe){
            const reason='Acceptance aborted after a task checkpoint; reconcile before retrying';
            e.status='needs-reconciliation';e.reason=reason;
            for(const id of b.taskIds)if(sum.taskResults[id]?.status!=='verified')sum.taskResults[id]={...sum.taskResults[id],status:'needs-reconciliation',reason};
            persist(`block.${b.key}.needs-reconciliation`);
          }else mark(b,'cancelled',abortReason(sum.abort));
          settleFinalizedCleanupMarker(b,e,attempt);
          return;
        }
        if(!e.policyRejected&&e.inspectedToken!==attempt.token)await inspectBlock(b,e);
      },
      onFailed:(_b,e)=>persist('run.cleanup-failed'),
      onCleanupPending:async(b,_e,attempt)=>{
        // The phase driver persists every successful step itself.  This
        // callback only makes a pending terminal status observable if its own
        // final status publication was interrupted.
        if(attempt?.file)atomicJson(attempt.file,attempt);
        persist(`block.${b.key}.cleanup-pending`);
      },
      onRetained:async(b,_e,attempt)=>{
        // Persist both recovery authorities before the sweep returns.  Either
        // one can survive an interruption between writes, and resume checks
        // both.  If both cannot be written, propagate the failure rather than
        // letting this controller claim a clean finalization.
        let attemptError;
        if(attempt?.file)try{atomicJson(attempt.file,attempt);}catch(error){attemptError=error;}
        let summaryError;
        try{persist(`block.${b.key}.needs-reconciliation`);}catch(error){summaryError=error;}
        if(summaryError)throw summaryError;
        if(attemptError)throw attemptError;
      },
      consumeExitRetryPermit:(_block,_entry,attempt)=>Boolean(attempt&&typeof attempt==='object'&&finalSweepRetryPermits.delete(attempt)),
    });
    for(const r of sum.plan)if(!TERMINAL.has(sum.results[r.key]?.status)){
      const aborted=readAbort();
      if(aborted)mark(r,'cancelled',abortReason(aborted));
      else mark(r,'failed','No terminal result');
    }
    await verificationQueue.drain();
    sum.verification=verificationQueue.stats();
    if(progressError)throw progressError;
    // An isolated controller commits either its abort record or its success
    // marker under one short-lived terminal lock. The marker must be acquired
    // after all parent verification has drained and before this public summary
    // can claim success. Ordinary callers still receive a final abort read.
    if(!sum.abort&&summaryComplete(sum,true))await finalizeAcceptance();
    else readAbort();
    // Keep the normal callback path conservative as well: a monitor may have
    // published an authenticated abort while the terminal callback was absent
    // or while an ordinary run crossed its final asynchronous boundary.
    readAbort();
    clearInterval(progressTimer);
    sum.finishedAt=Date.now();sum.success=!sum.abort&&summaryComplete(sum,true);persist(sum.success?'run.completed':'run.failed');
    if(sum.success&&hooks.cleanupCompleted){
      const cleanupAt=ensureCleanupDeadline();
      if(!deadlineIsAvailable(cleanupAt,'completed-run cleanup',now)){
        sum.cleanupWarnings=['Cleanup deadline expired; completed-run cleanup was retained for reconciliation'];
        persist('run.cleanup-warning');
      }else{
        try{
          const warnings=await cleanupHook(hooks.cleanupCompleted,[sum],'completed-run cleanup');
          if(warnings?.length){sum.cleanupWarnings=warnings;persist('run.cleanup-warning');}
        }catch(error){
          if(!deadlineExpired(error))throw error;
          sum.cleanupWarnings=['Cleanup deadline expired; completed-run cleanup was retained for reconciliation'];
          persist('run.cleanup-warning');
        }
      }
    }
    console.log(`[run] finalized runId=${runId} success=${sum.success} summary=${displaySummaryPath(summaryFile)}`);return sum;
  }finally{
    clearInterval(progressTimer);
    memorySamplingAbort?.abort();
    memorySampler?.dispose();
    const cleanupAt=ensureCleanupDeadline();
    try{
      if(deadlineIsAvailable(cleanupAt,'run-owner cleanup',now)){
        await coordinate(()=>releaseRun(coordinator,runKey,claim,undefined,{deadlineAt:cleanupAt}),cleanupAt,{now,pauseMs,stage:'run-owner cleanup'});
      }
    }catch(error){
      // An exhausted cleanup budget intentionally leaves the owner ledger in
      // place for reconciliation. Retrying with a new window could release a
      // later controller, so preserve the original error-free run result.
      if(!deadlineExpired(error))throw error;
    }
  }
}
