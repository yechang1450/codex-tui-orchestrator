import fs from 'node:fs';
import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {levelWaves,verifyChecks,requestTasks,buildTodoList} from './contracts.mjs';
import {checkpointMatches} from './checkpoint.mjs';
import {assertNoReparsePoints} from './runtime-context.mjs';
import {controllerWindowsDir,controllerHeadlessBase} from './controller-state.mjs';
import {isProcessIdentityBinding,readUtf8Bounded} from './leases.mjs';

const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const pathInside=(root,value)=>{
 const candidate=path.isAbsolute(value)?path.resolve(value):path.resolve(root,value);
 const relative=path.relative(path.resolve(root),candidate);
 if(relative==='..'||relative.startsWith(`..${path.sep}`)||path.isAbsolute(relative))return null;
 return candidate;
};
export function runRoot(sum){return path.resolve(String(sum.workspace),'temp','orchestrator','runs',String(sum.runId));}
export function resolveAttemptFile(sum,value,label='attempt file'){
 if(typeof value!=='string'||!value||value.includes('\0'))throw new Error('Invalid recovery ledger: '+label+' must be a safe path');
 const resolved=pathInside(runRoot(sum),value);
 if(!resolved)throw new Error('Invalid recovery ledger: '+label+' escapes the run directory');
 assertNoReparsePoints(resolved,label);
 return resolved;
}
function resolveWindowFile(sum,value,label){
 if(typeof value!=='string'||!value||value.includes('\0'))throw new Error('Invalid recovery ledger: '+label+' must be a safe path');
 const resolved=pathInside(controllerWindowsDir(String(sum.workspace)),value);
 if(!resolved)throw new Error('Invalid recovery ledger: '+label+' escapes controller windows');
 assertNoReparsePoints(resolved,label);
 return resolved;
}
function resolveHeadlessFile(sum,attemptFile,key,value,label){
 if(typeof value!=='string'||!value||value.includes('\0'))throw new Error('Invalid recovery ledger: '+label+' must be a safe path');
 const base=controllerHeadlessBase(String(sum.workspace),attemptFile,key);
 const resolved=pathInside(path.dirname(base),value);
 if(!resolved)throw new Error('Invalid recovery ledger: '+label+' escapes controller headless files');
 assertNoReparsePoints(resolved,label);
 return resolved;
}
function samePath(a,b){return path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();}
function safeStem(value){return String(value).replace(/[^A-Za-z0-9_-]/g,'_');}
export function validateSavedLauncherFiles(sum,block,entry,attempt,{requireLiveFiles=false}={}){
  if(String(sum?.agent||'codex')!=='codex')throw new Error('LEGACY_AGENT_UNSUPPORTED: recovery only accepts Codex ledgers');
 const files=entry?.launcherFiles;
 if(files===undefined)return;
 if(!object(files)||!attempt||attempt.runId!==sum.runId||entry.token!==attempt.token)throw new Error('Invalid recovery ledger: launcher identity is not bound to the latest attempt');
 const attemptFile=resolveAttemptFile(sum,attempt.file,'attempt file');
 const headless=files.mode==='headless'||Object.hasOwn(files,'stdout')||Object.hasOwn(files,'stderr');
 const required=headless?['lp','pf','pidf','rf','stdout','stderr']:['lp','pf','pidf','rf'];
 for(const key of required)if(typeof files[key]!=='string'||!files[key])throw new Error('Invalid recovery ledger: launcherFiles.'+key+' is missing');
 for(const [key,value] of Object.entries(files)){
  // The visible startup receipt is an opaque, durable binding for the
  // executor.  It is deliberately not a launcher artifact path: the runner
  // first authenticates the launcher process, then the visible executor
  // reconstructs and verifies this descriptor.  Treating it as a path here
  // would either reject every valid receipt or turn a mismatch into a generic
  // recovery-ledger failure before the runner can retain the lease for
  // reconciliation.
  if(key==='mode'||key==='startupReceipt')continue;
  if(typeof value!=='string'||!value)throw new Error('Invalid recovery ledger: launcherFiles.'+key+' must be a path');
  if(headless)resolveHeadlessFile(sum,attemptFile,block.key,value,'launcherFiles.'+key);
  else resolveWindowFile(sum,value,'launcherFiles.'+key);
 }
  const key=safeStem(block.key);
  if(headless){
  const base=controllerHeadlessBase(String(sum.workspace),attemptFile,key);
  const expected={lp:base+'.json',pf:base+'.prompt.txt',pidf:base+'.pid',rf:base+'.result.json',stdout:base+'.stdout.jsonl',stderr:base+'.stderr.log'};
  if(Object.hasOwn(files,'privatePrompt'))expected.privatePrompt=base+'.prompt.dpapi';
  for(const [name,value] of Object.entries(expected))if(!samePath(files[name],value))throw new Error('Invalid recovery ledger: headless launcherFiles.'+name+' is not derived from the attempt path');
  if(requireLiveFiles){
   let config;
   try{config=JSON.parse(fs.readFileSync(files.lp,'utf8'));}
   catch(error){if(error?.code==='ENOENT')throw new Error('Invalid recovery ledger: headless launcher configuration is missing');throw new Error('Invalid recovery ledger: headless launcher configuration is unreadable');}
   if(!object(config)||config.version!==1||config.runId!==sum.runId||config.token!==attempt.token||path.resolve(String(config.workspace||''))!==path.resolve(String(sum.workspace))||!Array.isArray(config.args)||!object(config.files))throw new Error('Invalid recovery ledger: headless launcher configuration identity mismatch');
   for(const [name,value] of Object.entries(expected))if(!samePath(config.files[name],value))throw new Error('Invalid recovery ledger: headless launcher configuration path mismatch');
   for(const name of ['ready','cancel','runtime']){
    if(typeof config[name]!=='string'||!samePath(config[name],base+'.'+({ready:'go',cancel:'cancel',runtime:'runtime.json'}[name])))throw new Error('Invalid recovery ledger: headless launcher control path mismatch');
    resolveHeadlessFile(sum,attemptFile,block.key,config[name],'headless control path');
   }
   const sealed=config.privatePrompt===true;
   if(config.privatePrompt!==undefined&&!sealed)throw new Error('Invalid recovery ledger: headless private prompt binding is malformed');
   if(sealed!==Object.hasOwn(files,'privatePrompt')||sealed!==Object.hasOwn(config.files,'privatePrompt'))throw new Error('Invalid recovery ledger: headless private prompt binding is missing');
   if(sealed&&!samePath(config.files.privatePrompt,base+'.prompt.dpapi'))throw new Error('Invalid recovery ledger: headless private prompt path mismatch');
  }
 }else{
  const temp=controllerWindowsDir(String(sum.workspace));
  const lp=path.basename(files.lp),match=/^win-launch-(.+)\.ps1$/i.exec(lp);
  const suffix=match?.[1];
   const launchKey=safeStem(block.key)||'codex-task';
  const expectedSuffix=launchKey+'-'+String(sum.runId)+'-a'+String(attempt.number);
  if(suffix!==expectedSuffix)throw new Error('Invalid recovery ledger: visible launcher is not bound to this run attempt');
  const expected={pf:'agent-win-'+suffix+'.md',pidf:'window-'+suffix+'.pid',rf:'win-'+suffix+'.result.json'};
  if(!samePath(files.lp,path.join(temp,lp))||Object.entries(expected).some(([name,value])=>!samePath(files[name],path.join(temp,value))))throw new Error('Invalid recovery ledger: visible launcher file set is inconsistent');
  if(requireLiveFiles){
   for(const name of ['lp','pf','pidf'])if(!fs.existsSync(files[name]))throw new Error('Invalid recovery ledger: visible launcher file is missing');
   let script,prompt;
   try{script=fs.readFileSync(files.lp,'utf8');prompt=fs.readFileSync(files.pf,'utf8');}
   catch{throw new Error('Invalid recovery ledger: visible launcher files are unreadable');}
   const token=String(attempt.token).replaceAll("'","''");
    const tokenAssignment=`$token = '${token}'`;
   if(!script.includes(tokenAssignment)||!prompt.includes('__ORCH_DONE__ '+attempt.token))throw new Error('Invalid recovery ledger: visible launcher ownership token mismatch');
  }
 }
}

const CLEANUP_PENDING_KEYS=['version','kind','runId','blockKey','attempt','token','lease','phases','recordedAt','updatedAt'];
const CLEANUP_LEASE_KEYS=['id','instanceId'];
const CLEANUP_PHASE_KEYS=['lease','registry','artifacts'];
const NO_PROCESS_PROOF_KEYS=['version','kind','runId','blockKey','attempt','token','lease','recordedAt'];
const RESERVATION_FAULT_KEYS=['version','kind','at','leaseId'];
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const exactKeys=(value,keys)=>object(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));

function sameProcessIdentity(left,right){
 return isProcessIdentityBinding(left)&&isProcessIdentityBinding(right)&&
  left.ProcessId===right.ProcessId&&left.Started===right.Started&&left.Name===right.Name&&
  left.commandLineSha256===right.commandLineSha256;
}

// Protocol 2 records name a lease by both its public id and the controller-
// generated instance id.  The id alone is reusable after release, so an
// unbound or mismatched instance can never authorize a recovery side effect.
export function hasBoundLeaseInstance(entry,attempt){
 return typeof entry?.leaseId==='string'&&entry.leaseId.length>0&&
  typeof attempt?.leaseId==='string'&&attempt.leaseId===entry.leaseId&&
  typeof entry?.leaseInstanceId==='string'&&UUID.test(entry.leaseInstanceId)&&
  typeof attempt?.leaseInstanceId==='string'&&attempt.leaseInstanceId===entry.leaseInstanceId;
}

function hasValidLeaseInstance(record){
 return typeof record?.leaseId==='string'&&record.leaseId.length>0&&
  typeof record?.leaseInstanceId==='string'&&UUID.test(record.leaseInstanceId);
}

function hasProtocol2LeaseLifecycle(entry){
 return Boolean(entry?.attempts?.length)||entry?.leaseId!==undefined||entry?.leaseInstanceId!==undefined||
  entry?.launcher!==undefined||entry?.launcherFiles!==undefined||entry?.exitConfirmed===true||
  entry?.exitEvidence!==undefined||entry?.noProcessProof!==undefined||entry?.cleanupPending!==undefined||
  ['launching','running','awaiting-verification','cleanup-pending'].includes(entry?.status);
}

// A coordinator response can be malformed after reserve has committed. When
// no private acknowledgement identity is available, the runner records only
// this non-authorizing forensic marker. It deliberately cannot masquerade as
// a protocol-2 attempt, lease, launcher, or exit receipt.
function validateReservationFault(entry,fail){
 const record=entry?.reservationFault;
 if(record===undefined)return;
 if(!exactKeys(record,RESERVATION_FAULT_KEYS)||record.version!==1||record.kind!=='reservation-acknowledgement'||
    !Number.isSafeInteger(record.at)||record.at<=0||typeof record.leaseId!=='string'||!record.leaseId)
   fail('reservation acknowledgement fault is invalid');
 if(entry.status!=='needs-reconciliation'||entry.exitConfirmed!==false||!Number.isSafeInteger(entry.exitUnprovenAt)||entry.exitUnprovenAt<=0||
    !Array.isArray(entry.attempts)||entry.attempts.length!==0||entry.leaseId!==undefined||entry.leaseInstanceId!==undefined||entry.token!==undefined||
    entry.launcher!==undefined||entry.launcherFiles!==undefined||entry.exitEvidence!==undefined||entry.noProcessProof!==undefined||
    entry.cleanupPending!==undefined||entry.headlessChildState!==undefined)
   fail('reservation acknowledgement fault is not non-authorizing');
}

// A public `exitConfirmed` boolean is never enough to authorize destructive
// recovery.  Both independent durable records must bind the same owned
// *process identity*, rather than merely a PID that Windows may later reuse,
// to the latest attempt token and identify that proof as authenticated.
export function hasAuthenticatedExitProof(entry,attempt){
 const left=entry?.exitEvidence,right=attempt?.exitEvidence,pid=left?.pid;
 const bindings=[entry?.launcher,attempt?.launcherObserved].filter(value=>value!==undefined);
 const bindingMatches=bindings.length>0&&
  bindings.every(value=>sameProcessIdentity(bindings[0],value))&&
  bindings[0].ProcessId===pid&&
  (attempt?.launcherPid===undefined||(Number.isSafeInteger(attempt.launcherPid)&&attempt.launcherPid===pid));
 return entry?.exitConfirmed===true&&attempt?.exitConfirmed===true&&
  typeof entry?.token==='string'&&entry.token.length>0&&
  typeof attempt?.token==='string'&&attempt.token.length>0&&entry.token===attempt.token&&
  hasBoundLeaseInstance(entry,attempt)&&
  left?.token===attempt.token&&right?.token===attempt.token&&
  left?.authenticated===true&&right?.authenticated===true&&
  Number.isSafeInteger(pid)&&pid>0&&right?.pid===pid&&
  bindingMatches&&
  Number.isSafeInteger(left?.at)&&left.at>0&&
  Number.isSafeInteger(right?.at)&&right.at>0;
}

// A launcher adapter may explicitly prove that it did not create a process.
// This is deliberately separate from an authenticated PID exit proof: it can
// only suppress a later sweep when both durable authorities carry the same
// token-bound receipt written by the controller's no-process branch.
export function hasNoProcessProof(sum,block,entry,attempt){
 const left=entry?.noProcessProof,right=attempt?.noProcessProof;
 return entry?.exitConfirmed===true&&attempt?.exitConfirmed===true&&
  isDeepStrictEqual(left,right)&&exactKeys(left,NO_PROCESS_PROOF_KEYS)&&
  left.version===1&&left.kind==='no-process'&&
  typeof sum?.runId==='string'&&sum.runId.length>0&&left.runId===sum.runId&&attempt?.runId===sum.runId&&
  typeof block?.key==='string'&&block.key.length>0&&left.blockKey===block.key&&
  Number.isSafeInteger(attempt?.number)&&attempt.number>=1&&left.attempt===attempt.number&&
  typeof attempt?.token==='string'&&attempt.token.length>0&&left.token===attempt.token&&entry?.token===attempt.token&&
  hasBoundLeaseInstance(entry,attempt)&&
  exactKeys(left.lease,CLEANUP_LEASE_KEYS)&&left.lease.id===entry.leaseId&&left.lease.instanceId===entry.leaseInstanceId&&
  typeof left.lease.id==='string'&&left.lease.id.length>0&&typeof left.lease.instanceId==='string'&&UUID.test(left.lease.instanceId)&&
  Number.isSafeInteger(left.recordedAt)&&left.recordedAt>0;
}

function validateCleanupPending(sum,block,entry,attempt,fail){
 const entryRecord=entry?.cleanupPending,attemptRecord=attempt?.cleanupPending;
 if(entryRecord===undefined&&attemptRecord===undefined)return;
 if(entryRecord===undefined||attemptRecord===undefined||!isDeepStrictEqual(entryRecord,attemptRecord))fail('cleanup pending journal is not mirrored');
 const record=entryRecord;
 if(!exactKeys(record,CLEANUP_PENDING_KEYS)||record.version!==1||record.kind!=='post-exit-cleanup'||
   record.runId!==sum.runId||record.blockKey!==block.key||record.attempt!==attempt.number||record.token!==attempt.token||
   !Number.isSafeInteger(record.attempt)||record.attempt<1||!Number.isSafeInteger(record.recordedAt)||record.recordedAt<=0||
   !Number.isSafeInteger(record.updatedAt)||record.updatedAt<record.recordedAt)fail('cleanup pending journal is malformed');
 if(entry?.token!==attempt?.token||attempt?.leaseInstanceId!==entry?.leaseInstanceId)fail('cleanup pending identity is not bound to the latest attempt');
 if(!exactKeys(record.lease,CLEANUP_LEASE_KEYS)||record.lease.id!==entry.leaseId||record.lease.instanceId!==entry.leaseInstanceId||
   typeof record.lease.id!=='string'||!record.lease.id||typeof record.lease.instanceId!=='string'||!UUID.test(record.lease.instanceId))
   fail('cleanup pending lease identity is invalid');
 if(!cleanupPhasePrefix(record.phases))
   fail('cleanup pending phases are invalid');
 if(entry.status!=='cleanup-pending')fail('cleanup pending block status is invalid');
 if(!hasAuthenticatedExitProof(entry,attempt)&&!hasNoProcessProof(sum,block,entry,attempt))
  fail('cleanup pending lacks a bound exit proof');
}

// A phase is fenced in the controller before its external side effect starts.
// At most one phase may be in-flight, after a contiguous done prefix and
// before a pending suffix.  An in-flight state is intentionally recoverable
// only by explicit reconciliation, never ordinary resume.
function cleanupPhasePrefix(phases){
 if(!exactKeys(phases,CLEANUP_PHASE_KEYS))return false;
 let pending=false,inflight=false;
 for(const phase of CLEANUP_PHASE_KEYS){
  const value=phases[phase];
  if(value==='pending'){pending=true;continue;}
  if(value==='inflight'){
   if(pending||inflight)return false;
   inflight=true;continue;
  }
  if(value==='done'&&!pending&&!inflight)continue;
  return false;
 }
 return true;
}

function validateNoProcessProof(sum,block,entry,attempt,fail){
 const entryProof=entry?.noProcessProof,attemptProof=attempt?.noProcessProof;
 if(entryProof===undefined&&attemptProof===undefined)return;
 if(!hasNoProcessProof(sum,block,entry,attempt))fail('no-process receipt is invalid');
}

function persistedAttemptRecord(sum,attempt,fail,readAttemptRecord){
 const file=resolveAttemptFile(sum,attempt.file,'attempt file');
 const override=typeof readAttemptRecord==='function'?readAttemptRecord(file,attempt):undefined;
 const raw=override===undefined?readUtf8Bounded(file,'attempt record'):override;
 if(raw===null)return null;
 let value;
 try{value=typeof raw==='string'?JSON.parse(raw):raw;}catch{fail('persisted attempt record is unreadable');}
 if(!object(value)||value.runId!==attempt.runId||value.token!==attempt.token||value.number!==attempt.number||
   !Array.isArray(value.taskIds)||!isDeepStrictEqual(value.taskIds,attempt.taskIds)||typeof value.file!=='string')
   fail('persisted attempt record identity mismatch');
 if(!hasValidLeaseInstance(value)||value.leaseId!==attempt.leaseId||value.leaseInstanceId!==attempt.leaseInstanceId)
   fail('persisted attempt record lease instance mismatch');
 try{if(path.resolve(resolveAttemptFile(sum,value.file,'persisted attempt file'))!==path.resolve(file))fail('persisted attempt file identity mismatch');}
 catch(error){if(String(error?.message||error).startsWith('Invalid recovery ledger:'))throw error;fail('persisted attempt file identity mismatch');}
 return value;
}

// The attempt file is intentionally read before resume or verification.  The
// summary is a separately published projection, so ignoring a journal that
// survived a crash between the two writes could otherwise replay work or
// accept a result while controller resources remain retained.
export function validatePersistedCleanupJournals(sum,{readAttemptRecord}={}){
 const fail=reason=>{throw new Error('Invalid recovery ledger: '+reason);};
 for(const block of sum.blocks||[]){
  const entry=sum.results?.[block.key],attempts=entry?.attempts||[],latest=attempts.at(-1);
  for(const attempt of attempts){
   const disk=persistedAttemptRecord(sum,attempt,fail,readAttemptRecord);
   const summaryRecord=attempt.cleanupPending;
   if(attempt!==latest&&summaryRecord!==undefined)fail('non-latest attempt has cleanup pending journal');
   if(attempt===latest){
    const entryRecord=entry?.cleanupPending;
    if((entryRecord!==undefined||summaryRecord!==undefined)&&!disk)fail('cleanup pending attempt record is missing');
    if(entryRecord!==undefined||summaryRecord!==undefined){
      if(disk?.cleanupPending===undefined||!isDeepStrictEqual(entryRecord,disk.cleanupPending)||!isDeepStrictEqual(summaryRecord,disk.cleanupPending))
        fail('cleanup pending journal differs from persisted attempt record');
    }else if(disk?.cleanupPending!==undefined)fail('persisted cleanup pending journal has no public mirror');
    const entryNoProcess=entry?.noProcessProof,summaryNoProcess=attempt?.noProcessProof,diskNoProcess=disk?.noProcessProof;
    if(entryNoProcess!==undefined||summaryNoProcess!==undefined||diskNoProcess!==undefined){
      if(entryNoProcess===undefined||summaryNoProcess===undefined||diskNoProcess===undefined||
        !isDeepStrictEqual(entryNoProcess,summaryNoProcess)||!isDeepStrictEqual(entryNoProcess,diskNoProcess))
        fail('no-process receipt differs from persisted attempt record');
    }
   }else if(disk?.cleanupPending!==undefined)fail('non-latest persisted attempt has cleanup pending journal');
  }
 }
 return sum;
}

// Validate persisted structure before recovery can change state or invoke tools.
export function validateRecoverySummary(sum) {
 const fail=reason=>{throw new Error('Invalid recovery ledger: '+reason);};
 const strings=x=>Array.isArray(x)&&x.every(v=>typeof v==='string'&&v.length>0);
 const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
 const exact=(ids,value)=>object(value)&&new Set(ids).size===ids.length&&Object.keys(value).length===ids.length&&ids.every(id=>Object.hasOwn(value,id)&&object(value[id]));
 if(!object(sum)||sum.protocol!==2||typeof sum.request!=='string'||typeof sum.workspace!=='string'||!path.isAbsolute(sum.workspace)||typeof sum.runId!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(sum.runId)||!Number.isSafeInteger(sum.generation)||sum.generation<1||!Array.isArray(sum.history))fail('invalid header');
 if(sum.executionMode!==undefined&&!['headless','visible'].includes(sum.executionMode))fail('invalid execution mode');
 const tasks=requestTasks(sum.request);
 if(!tasks.length||!Array.isArray(sum.tasks)||!same(sum.tasks.map(t=>({id:t?.id,prompt:t?.prompt})),tasks))fail('original task inventory mismatch');
 if(sum.todoList!==undefined){
  const expected=buildTodoList(sum.tasks,sum.blocks,sum.taskResults);
  if(!Array.isArray(sum.todoList)||!same(sum.todoList,expected))fail('todo list status mismatch');
 }
 // Keep ledger validation deterministic. The caller enforces the current
 // system-free-memory capacity before resume; re-reading a transient OS
 // sample here would make verifyRun/recovery fail based on machine load.
 if(!Array.isArray(sum.blocks)||!sum.blocks.length||!Array.isArray(sum.plan)||sum.plan.length!==sum.blocks.length)fail('block inventory mismatch');
 const ids=tasks.map(t=>t.id),blockIds=sum.blocks.map(b=>b?.key);
 if(!strings(blockIds)||!exact(blockIds,sum.results)||!exact(ids,sum.taskResults))fail('result inventory mismatch');
 const covered=[];
 for(let i=0;i<sum.blocks.length;i++) {
  const block=sum.blocks[i],plan=sum.plan[i],entry=sum.results[block.key];
   if(!strings(block.taskIds)||!block.taskIds.length||!object(plan)||plan.key!==block.key||!strings(plan.keys)||!strings(plan.dependsOn)||!Array.isArray(plan.b?.tasks))fail('invalid block or plan');
  if(!plan.b.tasks.every(t=>strings(t?.sourceIds)&&t.sourceIds.length)||!same(plan.b.tasks.flatMap(t=>t.sourceIds),block.taskIds))fail('plan task coverage mismatch');
  covered.push(...block.taskIds);
   if(!Array.isArray(entry.attempts))fail('missing attempt inventory');
   if(entry.launcher!==undefined&&!isProcessIdentityBinding(entry.launcher))fail('legacy raw launcher identity is unsupported for recovery');
   if(!entry.attempts.length&&(entry.launcherFiles||entry.launcher||entry.token||['launching','running','verified','awaiting-verification'].includes(entry.status)))fail('launched block has no attempt inventory');
   for(const attempt of entry.attempts) {
    if(!object(attempt)||attempt.runId!==sum.runId||typeof attempt.token!=='string'||!attempt.token||typeof attempt.file!=='string'||!attempt.file||!strings(attempt.taskIds)||!attempt.taskIds.length||new Set(attempt.taskIds).size!==attempt.taskIds.length||attempt.taskIds.some(id=>!block.taskIds.includes(id)))fail('invalid attempt identity or task coverage');
    if(attempt.launcherObserved!==undefined&&!isProcessIdentityBinding(attempt.launcherObserved))fail('legacy raw launcher observation is unsupported for recovery');
    // Every durable protocol 2 attempt is created only after reservation, so
    // an absent pair is malformed just as a partial or non-UUID pair is.
    if(!hasValidLeaseInstance(attempt))
      fail('protocol 2 attempt lease instance is invalid');
   try{resolveAttemptFile(sum,attempt.file,'attempt file');}catch(error){fail(error.message.replace(/^Invalid recovery ledger:\s*/,''));}
  }
  const latestAttempt=entry.attempts.at(-1);
  validateReservationFault(entry,fail);
  if(hasProtocol2LeaseLifecycle(entry)&&!hasBoundLeaseInstance(entry,latestAttempt))
    fail('protocol 2 lease instance is not bound to the latest attempt');
  validateCleanupPending(sum,block,entry,latestAttempt,fail);
  validateNoProcessProof(sum,block,entry,latestAttempt,fail);
  if(entry.status==='cleanup-pending'&&entry.cleanupPending===undefined&&latestAttempt?.cleanupPending===undefined){
   if((!hasAuthenticatedExitProof(entry,latestAttempt)&&!hasNoProcessProof(sum,block,entry,latestAttempt))||
      entry.leaseInstanceId!==latestAttempt?.leaseInstanceId)
    fail('cleanup-pending status lacks a bound recovery proof');
  }
  if(entry.launcherFiles){try{validateSavedLauncherFiles(sum,block,entry,latestAttempt,{requireLiveFiles:['launching','running','awaiting-verification'].includes(entry.status)});}catch(error){fail(error.message.replace(/^Invalid recovery ledger:\s*/,''));}}
  for(const id of block.taskIds) {
   const inspection=sum.taskResults[id]?.inspection;
   if(inspection!==undefined&&(!hasParentInspection(sum.taskResults[id],id)||inspection.runId!==sum.runId||!entry.attempts.some(a=>a.runId===inspection.runId&&a.token===inspection.token&&a.taskIds.includes(id))))fail('invalid parent inspection: '+id);
   const checkpoint=sum.taskResults[id]?.checkpoint;
   if(checkpoint!==undefined&&checkpoint?.state!=='invalid'&&!entry.attempts.some(attempt=>attempt.taskIds.includes(id)&&checkpointMatches(checkpoint,attempt,id)))fail('invalid saved task checkpoint: '+id);
  }
 }
 if(covered.length!==ids.length||new Set(covered).size!==ids.length||covered.some(id=>!ids.includes(id)))fail('incomplete or duplicate task coverage');
 try{levelWaves(structuredClone(sum.plan));}catch(error){fail(error.message);}
 return sum;
}

export async function scheduleReady(recs,execute,status,onBlocked=()=>{}) {
  levelWaves(recs); // Validate the whole graph before any work starts.
  const byKey=new Map(recs.map(r=>[r.key,r])),jobs=new Map();
  const start=r=>{
    if(jobs.has(r.key))return jobs.get(r.key);
    const job=Promise.resolve().then(async()=>{
      await Promise.all(r.dependsOn.map(id=>start(byKey.get(id))));
      const failed=r.dependsOn.filter(id=>status(id)!=='verified');
      if(failed.length)return onBlocked(r,failed);
      return execute(r);
    });
    jobs.set(r.key,job);return job;
  };
  await Promise.all(recs.map(start));
}

export const taskPolicy=value=>Array.isArray(value)?{checks:value,retrySafe:false}:{checks:value?.checks||[],retrySafe:value?.retrySafe===true};
export function hasReconciledCheckpoint(result,checkpoint,id) {
  return result?.status==='verified'&&result.reconciled===true&&result.checkpoint?.state==='started'&&checkpoint?.state==='started'&&checkpointMatches(result.checkpoint,checkpoint,id);
}
export function hasParentInspection(result,id) {
  const proof=result?.inspection;
  return proof?.id===id&&typeof proof.runId==='string'&&!!proof.runId&&typeof proof.token==='string'&&!!proof.token&&Number.isFinite(proof.at)&&proof.at>0;
}
export function recoveryTasks(tasks,checkpoints,checks,workspace,previousResults={}) {
  const result={verified:[],pending:[],uncertain:[],results:{}};
  for(const task of tasks) {
    const cp=checkpoints[task.id],policy=taskPolicy(checks[task.id]);
    if(!cp){
      // A persisted inspection is only a receipt from the previous controller
      // process. It is not proof that a worker exited or that the same output
      // still exists. Recompute it only in the live controller after a fresh
      // identity-bound exit confirmation; resume must reconcile or retry.
      result.pending.push(task.id);
      result.results[task.id]={status:'pending'};
      continue;
    }
    if(!['started','completed'].includes(cp.state)){result.uncertain.push(task.id);result.results[task.id]={status:'needs-reconciliation',reason:'Invalid checkpoint',checkpoint:cp};continue;}
    const verification=verifyChecks(policy.checks,workspace);
    const reconciled=hasReconciledCheckpoint(previousResults[task.id],cp,task.id);
    if(verification.status==='verified'&&(cp.state==='completed'||reconciled)){result.verified.push(task.id);result.results[task.id]={...verification,checkpoint:cp,...(reconciled?{reconciled:true}:{})};}
    else if(verification.status==='verified'){
      result.uncertain.push(task.id);result.results[task.id]={status:'needs-reconciliation',reason:'Task has no completed checkpoint; use --verify-run for explicit reconciliation',verification,checkpoint:cp};
    }
    else if(policy.retrySafe){
      // A failed recheck is not a verified receipt. Clear the old status before
      // composing the next prompt, otherwise the TodoList says "verified" while
      // the task is being retried and the new attempt can inherit an invalid
      // receipt identity.
      result.pending.push(task.id);
      result.results[task.id]={status:'pending',reason:'Prior receipt did not satisfy acceptance; safe retry declared',checkpoint:cp};
    }
    else {result.uncertain.push(task.id);result.results[task.id]={status:'needs-reconciliation',reason:'Started task has no proven result and is not declared safe to retry',verification,checkpoint:cp};}
  }
  return result;
}
