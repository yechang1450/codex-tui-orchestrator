import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {buildTodoList,jsonProblem,describeShape,canonicalDigest} from './contracts.mjs';
import {atomicJson,readUtf8Bounded,MAX_CONTROLLER_ARTIFACT_BYTES,isProcessIdentityBinding,processIdentityBinding} from './leases.mjs';
import {assertNoReparsePoints,physicalPathIdentity} from './runtime-context.mjs';
import {controllerStateDir} from './controller-state.mjs';
import {redactDeep,redactSensitiveText} from './redaction.mjs';
import {readCleanupTransactionMarkerForRecovery} from './cleanup-transaction.mjs';

const MAX_STATUS_TEXT_BYTES=Math.min(MAX_CONTROLLER_ARTIFACT_BYTES,4*1024*1024);
const MAX_STATUS_LINE_BYTES=256*1024;
const MAX_RENDERED_FIELD=512;
const CLEANUP_STATUS_AUTHORITY_VERSION=1;
const CLEANUP_STATUS_AUTHORITY_KIND='cleanup-status-authority';
const CLEANUP_STATUS_AUTHORITY_KEYS=['version','kind','runId','workspaceIdentitySha256','source','target'];
const CLEANUP_STATUS_AUTHORITY_DIGEST_KEYS=['summarySha256','acceptanceInvariantSha256'];
function statusDigest(value){return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');}
function acceptanceInvariantDigest(value){
  // Authority is compared to the JSON ledger after it crosses the filesystem
  // boundary. Normalize undefined and other JSON-elided values first; a
  // controller-only in-memory field must not make a legitimate persisted
  // acceptance override look like a wider status mutation.
  const copy=JSON.parse(JSON.stringify(value));
  delete copy.acceptance;
  return canonicalDigest(copy);
}
function isDigest(value){return typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);}
function isRecord(value){return value!==null&&typeof value==='object'&&!Array.isArray(value);}
function exactKeys(value,keys){return isRecord(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));}
function identityDigest(value){return crypto.createHash('sha256').update(String(value),'utf8').digest('hex');}
function sameWorkspaceIdentity(left,right){
  if(typeof left!=='string'||!left.trim()||typeof right!=='string'||!right.trim())return false;
  try{return physicalPathIdentity(left)===physicalPathIdentity(right);}catch{return false;}
}
function statusAuthorityFile(workspace,runId,env=process.env){
  const identity=crypto.createHash('sha256').update(physicalPathIdentity(workspace)).digest('hex');
  return assertNoReparsePoints(path.join(controllerStateDir(workspace,env),'status',identity,runId+'.json'),'status authority');
}
function readStatusAuthority(workspace,runId,env=process.env){
  let authorityText;
  try{authorityText=readUtf8Bounded(statusAuthorityFile(workspace,runId,env),'status authority');}
  catch(error){throw publicStatusError('Status authority unavailable: '+(error?.message||error));}
  if(authorityText===null){
    const error=publicStatusError('Status authority is pending for '+runId+'; refusing unauthenticated summary');
    error.code='STATUS_AUTHORITY_PENDING';
    throw error;
  }
  let authority;
  try{authority=JSON.parse(authorityText);}
  catch(error){throw publicStatusError('Status authority unavailable: '+(error?.message||error));}
  if(!authority||!Number.isSafeInteger(authority.version)||![1,2].includes(authority.version)||authority.runId!==runId||
    !sameWorkspaceIdentity(authority.workspace||'',workspace)||!isDigest(authority.sha256))throw new Error('Status ledger authority mismatch');
  if(authority.version===2&&!isDigest(authority.acceptanceInvariantSha256))throw new Error('Status ledger authority mismatch');
  return authority;
}
// An acceptance override is deliberately narrower than a status override. The
// controller owns this projection, so the workspace mirror may differ only in
// the acceptance binding. A changed plan, task result, run identity or history
// remains fail-closed even when the caller explicitly adopts a new contract.
export function authorizeAcceptanceStatusOverride(workspace,runId,sum,{env=process.env}={}){
  const authority=readStatusAuthority(workspace,runId,env),observedSummarySha256=statusDigest(sum);
  if(authority.version!==2)throw new Error('Status authority does not retain an acceptance recovery binding; refusing override');
  if(authority.sha256===observedSummarySha256)throw new Error('Status authority already matches the workspace summary');
  if(authority.acceptanceInvariantSha256!==acceptanceInvariantDigest(sum))throw new Error('Status ledger authority mismatch outside the acceptance binding; refusing override');
  return {runId,workspace,fromSummarySha256:authority.sha256,observedSummarySha256};
}

function requireCleanupAuthoritySummary(value,workspace,runId,label){
  if(!isRecord(value)||value.runId!==runId||!sameWorkspaceIdentity(value.workspace||'',workspace))
    throw new Error('Cleanup status authority '+label+' summary identity mismatch');
  const publicSummary=publicStatusValue(value);
  if(publicSummary.runId!==runId||!sameWorkspaceIdentity(publicSummary.workspace||'',workspace))
    throw new Error('Cleanup status authority '+label+' public summary identity mismatch');
  return {
    summarySha256:statusDigest(publicSummary),
    acceptanceInvariantSha256:acceptanceInvariantDigest(publicSummary),
  };
}

function normaliseCleanupAuthorityDigest(value,label){
  if(!exactKeys(value,CLEANUP_STATUS_AUTHORITY_DIGEST_KEYS)||!isDigest(value.summarySha256)||!isDigest(value.acceptanceInvariantSha256))
    throw new Error('Invalid cleanup status authority '+label+' digest');
  return {summarySha256:value.summarySha256,acceptanceInvariantSha256:value.acceptanceInvariantSha256};
}

function normaliseCleanupStatusAuthorityMarker(workspace,runId,marker,env){
  // `marker` must be the validated controller-owned value returned by
  // readCleanupTransactionMarkerForRecovery.  This module deliberately does
  // not read a workspace journal or accept an arbitrary digest transition as
  // an authority override.
  if(!isRecord(marker)||marker.version!==1||marker.kind!=='cleanup-transaction'||marker.runId!==runId||
    marker.workspaceIdentity!==physicalPathIdentity(workspace)||!isDigest(marker.controllerRootSha256)||
    marker.controllerRootSha256!==identityDigest(physicalPathIdentity(controllerStateDir(workspace,env)))||
    typeof marker.blockKey!=='string'||!marker.blockKey||!Number.isSafeInteger(marker.attempt)||marker.attempt<1||
    typeof marker.token!=='string'||!marker.token||!isRecord(marker.proof)||!isRecord(marker.journal)||
    marker.proof.runId!==runId||marker.proof.blockKey!==marker.blockKey||marker.proof.attempt!==marker.attempt||marker.proof.token!==marker.token||
    marker.journal.runId!==runId||marker.journal.blockKey!==marker.blockKey||marker.journal.attempt!==marker.attempt||marker.journal.token!==marker.token)
    throw new Error('Cleanup status authority marker is not a bound controller transaction');
  const value=marker.statusAuthority;
  if(!exactKeys(value,CLEANUP_STATUS_AUTHORITY_KEYS)||value.version!==CLEANUP_STATUS_AUTHORITY_VERSION||
    value.kind!==CLEANUP_STATUS_AUTHORITY_KIND||value.runId!==runId||
    value.workspaceIdentitySha256!==identityDigest(physicalPathIdentity(workspace)))
    throw new Error('Cleanup status authority marker binding is invalid');
  return {
    version:CLEANUP_STATUS_AUTHORITY_VERSION,
    kind:CLEANUP_STATUS_AUTHORITY_KIND,
    runId,
    workspaceIdentitySha256:value.workspaceIdentitySha256,
    source:normaliseCleanupAuthorityDigest(value.source,'source'),
    target:normaliseCleanupAuthorityDigest(value.target,'target'),
  };
}

function authorityMatchesCleanupDigest(authority,digest){
  return authority?.version===2&&authority.sha256===digest.summarySha256&&
    authority.acceptanceInvariantSha256===digest.acceptanceInvariantSha256;
}

/**
 * Create the opaque status-authority binding that a controller must store
 * verbatim in a cleanup transaction marker before it publishes a cleanup
 * state.  It binds the complete public source and target snapshots, including
 * the acceptance invariant.  The function performs no I/O.
 */
export function createCleanupStatusAuthorityBinding({workspace,runId,source,target}={}){
  if(typeof workspace!=='string'||!workspace.trim()||typeof runId!=='string'||!runId.trim())
    throw new Error('Cleanup status authority requires workspace and run identity');
  const workspaceIdentity=physicalPathIdentity(workspace);
  return {
    version:CLEANUP_STATUS_AUTHORITY_VERSION,
    kind:CLEANUP_STATUS_AUTHORITY_KIND,
    runId,
    workspaceIdentitySha256:identityDigest(workspaceIdentity),
    source:requireCleanupAuthoritySummary(source,workspace,runId,'source'),
    target:requireCleanupAuthoritySummary(target,workspace,runId,'target'),
  };
}

/**
 * Repair only the controller-owned status digest after a validated cleanup
 * transaction was interrupted between workspace-summary and authority writes.
 *
 * The caller must pass the validated marker returned by the cleanup-transaction
 * reader, never a workspace-side journal.  This accepts one forward crash
 * boundary only: target summary with source authority.  It never writes the
 * summary or events ledger, never accepts an arbitrary status digest, and
 * refuses backward or mixed transitions.
 */
export function repairStatusAuthorityFromCleanupMarker({workspace,runId,binding,env=process.env}={}){
  if(typeof workspace!=='string'||!workspace.trim()||typeof runId!=='string'||!runId.trim())
    throw new Error('Cleanup status authority recovery requires workspace and run identity');
  if(!isRecord(binding))throw new Error('Cleanup status authority recovery requires a controller marker binding');
  // Do not accept a caller-provided marker object as authority.  Re-read the
  // only controller-owned marker location and validate every immutable attempt
  // identity before it can advance a status authority digest.
  const marker=readCleanupTransactionMarkerForRecovery({workspace,binding,env});
  if(marker===null)throw new Error('Cleanup status authority recovery marker is missing from controller state');
  const authorityBinding=normaliseCleanupStatusAuthorityMarker(workspace,runId,marker,env);
  const dir=directory(workspace,runId),summaryFile=assertNoReparsePoints(path.join(dir,'summary.json'),'status summary file');
  const summary=readLedger(summaryFile);
  if(summary===null)throw new Error('Cleanup status authority recovery requires a workspace summary');
  if(!isRecord(summary)||summary.runId!==runId||!sameWorkspaceIdentity(summary.workspace||'',workspace))
    throw new Error('Cleanup status authority recovery summary identity mismatch');
  const observed={summarySha256:statusDigest(summary),acceptanceInvariantSha256:acceptanceInvariantDigest(summary)};
  const observedSide=observed.summarySha256===authorityBinding.source.summarySha256&&observed.acceptanceInvariantSha256===authorityBinding.source.acceptanceInvariantSha256?'source':
    observed.summarySha256===authorityBinding.target.summarySha256&&observed.acceptanceInvariantSha256===authorityBinding.target.acceptanceInvariantSha256?'target':null;
  if(observedSide===null)throw new Error('Cleanup status authority recovery summary is outside the marker transition');
  const authority=readStatusAuthority(workspace,runId,env);
  const authoritySide=authorityMatchesCleanupDigest(authority,authorityBinding.source)?'source':
    authorityMatchesCleanupDigest(authority,authorityBinding.target)?'target':null;
  if(authoritySide===null)throw new Error('Cleanup status authority recovery controller authority is outside the marker transition');
  if(observedSide==='target'&&authoritySide==='source'){
    const repaired={version:2,runId,workspace:summary.workspace,sha256:authorityBinding.target.summarySha256,
      acceptanceInvariantSha256:authorityBinding.target.acceptanceInvariantSha256};
    // Preserve the only existing audited transition kind.  It remains bound to
    // the controller-owned authority and is unrelated to this cleanup bridge.
    if(authority.transition?.version===1&&authority.transition.kind==='acceptance-override'&&authority.transition.runId===runId&&
      sameWorkspaceIdentity(authority.transition.workspace||'',workspace)&&isDigest(authority.transition.fromSummarySha256)&&
      isDigest(authority.transition.observedSummarySha256)&&isDigest(authority.transition.toSummarySha256)&&Number.isFinite(authority.transition.at))
      repaired.transition=authority.transition;
    atomicJson(statusAuthorityFile(workspace,runId,env),repaired);
    return {repaired:true,runId,fromSummarySha256:authorityBinding.source.summarySha256,toSummarySha256:authorityBinding.target.summarySha256};
  }
  if(observedSide===authoritySide)return {repaired:false,runId,state:observedSide};
  throw new Error('Cleanup status authority recovery refuses a backward or mixed transition');
}

function frozenCleanupStatusAuthorityBinding(binding){
  return Object.freeze({...binding,source:Object.freeze({...binding.source}),target:Object.freeze({...binding.target})});
}

function publishCleanupStatusAuthorityBoundary({workspace,runId,summaryFile,publicTarget,beforeSummaryWrite,env}){
  // A marker needs the exact durable source snapshot, rather than a runner's
  // mutable in-memory approximation.  Read and authenticate that source before
  // handing the controller its pre-write callback.
  const source=readLedger(summaryFile);
  if(source===null)throw new Error('Cleanup status authority pre-write hook requires an existing authenticated summary');
  const sourceDigest=requireCleanupAuthoritySummary(source,workspace,runId,'source');
  const sourceAuthority=readStatusAuthority(workspace,runId,env);
  if(!authorityMatchesCleanupDigest(sourceAuthority,sourceDigest))
    throw new Error('Cleanup status authority pre-write hook refuses an unauthenticated source summary');
  const binding=frozenCleanupStatusAuthorityBinding(createCleanupStatusAuthorityBinding({workspace,runId,source,target:publicTarget}));
  const result=beforeSummaryWrite(Object.freeze({version:1,kind:CLEANUP_STATUS_AUTHORITY_KIND,runId,workspace:publicTarget.workspace,statusAuthority:binding}));
  if(result&&typeof result.then==='function')throw new Error('Cleanup status authority pre-write hook must finish synchronously');
  // The marker was just made durable.  Do not let a changed workspace mirror
  // turn it into a generic override: the old snapshot and authority must still
  // be exactly the bound source when the publisher crosses the write boundary.
  const stableSource=readLedger(summaryFile);
  if(stableSource===null)throw new Error('Cleanup status authority source disappeared before summary publication');
  const stableDigest=requireCleanupAuthoritySummary(stableSource,workspace,runId,'source');
  const stableAuthority=readStatusAuthority(workspace,runId,env);
  if(stableDigest.summarySha256!==binding.source.summarySha256||stableDigest.acceptanceInvariantSha256!==binding.source.acceptanceInvariantSha256||
    !authorityMatchesCleanupDigest(stableAuthority,binding.source))
    throw new Error('Cleanup status authority source changed before summary publication');
}
function safeText(value,max=MAX_RENDERED_FIELD){
  return String(value??'').slice(0,max).replace(/[\u0000-\u001f\u007f-\u009f]/g,ch=>'\\u'+ch.charCodeAt(0).toString(16).padStart(4,'0'));
}
function publicProcessIdentity(value,label){
  if(isProcessIdentityBinding(value))return value;
  const binding=processIdentityBinding(value);
  if(binding)return binding;
  if(value&&typeof value==='object'&&!Array.isArray(value)&&Object.hasOwn(value,'CommandLine'))
    throw publicStatusError('Invalid public process identity: '+label);
  return value;
}
function projectStatusResultIdentities(value){
  if(!value||typeof value!=='object'||Array.isArray(value))return value;
  const result={...value};
  if(Object.hasOwn(value,'launcher'))result.launcher=publicProcessIdentity(value.launcher,'launcher');
  if(Array.isArray(value.attempts))result.attempts=value.attempts.map(attempt=>{
    if(!attempt||typeof attempt!=='object'||Array.isArray(attempt)||!Object.hasOwn(attempt,'launcherObserved'))return attempt;
    return {...attempt,launcherObserved:publicProcessIdentity(attempt.launcherObserved,'launcher observation')};
  });
  return result;
}
function projectStatusIdentities(value){
  if(!value||typeof value!=='object'||Array.isArray(value))return value;
  const result={...value};
  if(Object.hasOwn(value,'owner'))result.owner=publicProcessIdentity(value.owner,'owner');
  if(value.results&&typeof value.results==='object'&&!Array.isArray(value.results))
    result.results=Object.fromEntries(Object.entries(value.results).map(([key,entry])=>[key,projectStatusResultIdentities(entry)]));
  return result;
}
function assertNoRawCommandLine(value,seen=new WeakSet()){
  if(!value||typeof value!=='object')return;
  if(seen.has(value))return;
  seen.add(value);
  try{
    if(Object.hasOwn(value,'CommandLine'))throw publicStatusError('Status public projection refuses raw CommandLine fields');
    for(const child of Object.values(value))assertNoRawCommandLine(child,seen);
  }finally{seen.delete(value);}
}
function publicStatusValue(value){
  const projected=projectStatusIdentities(value);
  assertNoRawCommandLine(projected);
  return redactDeep(projected);
}
function publicStatusError(message){return new Error(redactSensitiveText(String(message??'')));}

function runsDirectory(workspace){
  const root=path.join(path.resolve(workspace),'temp','orchestrator','runs');
  return assertNoReparsePoints(root,'status runs directory');
}
function directory(workspace,runId){
  if(!/^[A-Za-z0-9_-]{1,100}$/.test(runId||''))throw new Error('Invalid run ID');
  return assertNoReparsePoints(path.join(runsDirectory(workspace),runId),'status run directory');
}
export function latestRunId(workspace){
  const root=runsDirectory(workspace);
  let entries;
  try{entries=fs.readdirSync(root,{withFileTypes:true});}
  catch(error){if(error.code==='ENOENT')return null;throw error;}
  assertNoReparsePoints(root,'status runs directory');
  const candidates=[];
  for(const entry of entries){
    if(!entry.isDirectory()||!/^[A-Za-z0-9_-]{1,100}$/.test(entry.name))continue;
    for(const name of ['summary.json','manifest.json']){
      const file=path.join(root,entry.name,name);
      let stat;
      try{stat=fs.lstatSync(file);}catch(error){if(error.code==='ENOENT')continue;throw error;}
      if(stat.isFile()){candidates.push({runId:entry.name,mtimeMs:stat.mtimeMs});break;}
    }
  }
  candidates.sort((a,b)=>b.mtimeMs-a.mtimeMs||b.runId.localeCompare(a.runId));
  return candidates[0]?.runId||null;
}
export function buildExecutionStatus(sum){
  return (sum.blocks||[]).map(block=>{
    const entry=sum.results?.[block.key]||{},attempt=entry.attempts?.at(-1);
    return {block:block.key,title:block.title,mode:sum.executionMode||'visible',status:entry.status||'pending',
      attempt:attempt?.number||0,pid:entry.launcher?.ProcessId||null,taskIds:block.taskIds,
      startedAt:entry.startedAt??null,endedAt:entry.endedAt??null,reason:entry.reason||'',
      retryAt:entry.retryAt??null};
  });
}
function readTextWithIdentity(file,label){
  let fd;
  try{fd=fs.openSync(file,'r');}
  catch(error){
    if(error.code==='ENOENT'){
      assertNoReparsePoints(file,label);
      return null;
    }
    throw publicStatusError(error?.message||error);
  }
  try{
    assertNoReparsePoints(file,label);
    const opened=fs.fstatSync(fd,{bigint:true});
    if(opened.size>BigInt(MAX_STATUS_TEXT_BYTES))throw publicStatusError(`${label} exceeds the ${MAX_STATUS_TEXT_BYTES} byte safety limit: ${file}`);
    const text=fs.readFileSync(fd,'utf8');
    const current=fs.statSync(file,{bigint:true});
    if(opened.dev!==current.dev||opened.ino!==current.ino)throw publicStatusError(`${label} changed during read: ${file}`);
    assertNoReparsePoints(file,label);
    return text;
  }finally{fs.closeSync(fd);}
}
// A manifest is written before planning starts and is intentionally readable
// before the controller has produced an authenticated summary.  Keep this
// fallback strictly planning-only: a workspace-controlled manifest must never
// be able to smuggle a completed/successful state past the controller
// authority check below.
function isPlanningManifest(sum){
  return !!sum && typeof sum==='object' && !Array.isArray(sum) &&
    Array.isArray(sum.tasks) && sum.success!==true && sum.finishedAt==null &&
    sum.eventSeq==null && sum.results==null && sum.taskResults==null &&
    sum.executionStatus==null;
}
function eventText(dir){
  const file=assertNoReparsePoints(path.join(dir,'events.jsonl'),'status events file');
  return readTextWithIdentity(file,'status events file')??'';
}
function readEventsRaw(dir,{after=0,runId:expectedRunId=null}={}){
  const safeDir=assertNoReparsePoints(dir,'status directory');
  const file=assertNoReparsePoints(path.join(safeDir,'events.jsonl'),'status events file'),text=eventText(safeDir),lines=text.slice(0,text.lastIndexOf('\n')+1).split('\n'),events=[];
  let previous=0,runId,lineNumber=0;
  for(const line of lines){
    lineNumber++;
    if(!line.trim())continue;
    let event;
    // 事件账本是审计线索：坏行仍然 fail-closed，但真因必须点名文件 + 行号，
    // 否则调用方只知道"有问题"，不知道是哪一条。
    if(Buffer.byteLength(line,'utf8')>MAX_STATUS_LINE_BYTES)throw publicStatusError('Status event line exceeds the '+MAX_STATUS_LINE_BYTES+' byte safety limit: '+file+':'+lineNumber);
    try{event=JSON.parse(line);}
    catch(error){throw publicStatusError('Invalid status event JSON at '+file+':'+lineNumber+'：'+jsonProblem(line,error));}
    if(event.schema!==1||!Number.isSafeInteger(event.seq)||event.seq<=previous||!event.runId||typeof event.type!=='string'||(runId&&runId!==event.runId)||(expectedRunId&&expectedRunId!==event.runId))
      throw publicStatusError('Invalid status event sequence or identity at '+file+':'+lineNumber+'（要求 schema=1、seq 严格递增、整份文件同一个 runId）');
    previous=event.seq;runId=event.runId;if(event.seq>after)events.push(event);
  }
  return events;
}
export function readEvents(dir,options={}){return readEventsRaw(dir,options).map(publicStatusValue);}
export function createStatusPublisher(dir,{onEvent,env=process.env}={}){
  const safeDir=assertNoReparsePoints(dir,'status directory');
  const events=readEventsRaw(safeDir),text=eventText(safeDir),file=assertNoReparsePoints(path.join(safeDir,'events.jsonl'),'status events file');
  let seq=events.at(-1)?.seq||0;
  let boundRunId=events[0]?.runId||null;
  let retainedTransition,loadedTransition=false;
  // Only the controller holding the run claim creates a publisher. A partial
  // final append belongs to its dead predecessor; readers never repair files.
  if(text&&!text.endsWith('\n')){
    const truncateFd=fs.openSync(file,'r+');
    try{
      assertNoReparsePoints(safeDir,'status directory');
      assertNoReparsePoints(file,'status events file');
      fs.ftruncateSync(truncateFd,Buffer.byteLength(text.slice(0,text.lastIndexOf('\n')+1)));
    }finally{fs.closeSync(truncateFd);}
  }
  return {publish(sum,type='run.updated',{authorityTransition,beforeSummaryWrite}={}){
    if(boundRunId&&boundRunId!==sum.runId)throw new Error('Status publisher run identity mismatch');
    if(authorityTransition!==undefined&&(!authorityTransition||authorityTransition.runId!==sum.runId||
      !sameWorkspaceIdentity(authorityTransition.workspace||'',sum.workspace)||!isDigest(authorityTransition.fromSummarySha256)||
      !isDigest(authorityTransition.observedSummarySha256)))throw new Error('Invalid status authority override transition');
    if(beforeSummaryWrite!==undefined&&typeof beforeSummaryWrite!=='function')throw new Error('Invalid cleanup status authority pre-write hook');
    boundRunId=boundRunId||sum.runId;
    seq=Math.max(seq,sum.eventSeq||0)+1;
    sum.todoList=buildTodoList(sum.tasks,sum.blocks,sum.taskResults);
    sum.executionStatus=buildExecutionStatus(sum);sum.eventSeq=seq;sum.updatedAt=Date.now();
    // The live controller retains the exact task plan so it can continue the
    // attempt.  The workspace ledger, authority digest, event stream and host
    // callback receive only the public projection; an interrupted run must
    // never turn a provider credential embedded in task text into durable
    // workspace evidence.
    const publicSum=publicStatusValue(sum);
    const event={schema:1,seq,runId:publicSum.runId,generation:publicSum.generation,type,at:publicSum.updatedAt,
      todoList:publicSum.todoList,executionStatus:publicSum.executionStatus,finishedAt:publicSum.finishedAt??null,success:publicSum.success===true};
    const summaryFile=assertNoReparsePoints(path.join(safeDir,'summary.json'),'status summary file');
    if(beforeSummaryWrite!==undefined)publishCleanupStatusAuthorityBoundary({workspace:publicSum.workspace,runId:publicSum.runId,summaryFile,publicTarget:publicSum,beforeSummaryWrite,env});
    atomicJson(summaryFile,publicSum,()=>assertNoReparsePoints(safeDir,'status directory'));
    // The workspace summary is a derived mirror. Keep its digest in the
    // controller-owned root so readers can reject a worker-written success.
    // Version 2 also binds every field except `acceptance`; that narrow
    // projection is the only state an explicit acceptance override may repair.
    const digest=statusDigest(publicSum),authority={version:2,runId:publicSum.runId,workspace:publicSum.workspace,sha256:digest,
      acceptanceInvariantSha256:acceptanceInvariantDigest(publicSum)};
    if(authorityTransition!==undefined){
      retainedTransition={version:1,kind:'acceptance-override',runId:sum.runId,workspace:sum.workspace,
        fromSummarySha256:authorityTransition.fromSummarySha256,observedSummarySha256:authorityTransition.observedSummarySha256,
        toSummarySha256:digest,at:sum.updatedAt};
    }
    if(!loadedTransition){
      loadedTransition=true;
      if(!retainedTransition)try{
        const prior=readStatusAuthority(sum.workspace,sum.runId,env),transition=prior.transition;
        if(transition?.version===1&&transition.kind==='acceptance-override'&&transition.runId===sum.runId&&
          sameWorkspaceIdentity(transition.workspace||'',sum.workspace)&&isDigest(transition.fromSummarySha256)&&
          isDigest(transition.observedSummarySha256)&&isDigest(transition.toSummarySha256)&&Number.isFinite(transition.at))retainedTransition=transition;
      }catch{/* A fresh run has no authority yet; malformed prior audit cannot authorize anything. */}
    }
    if(retainedTransition)authority.transition=retainedTransition;
    atomicJson(statusAuthorityFile(sum.workspace,sum.runId,env),authority);
    // Recheck after the atomic snapshot and after opening the append handle.
    // If a same-user race swaps the run directory to a junction in either
    // window, fail before appending the event through the redirected handle.
    assertNoReparsePoints(safeDir,'status directory');
    const fd=fs.openSync(file,'a');
    try{
      assertNoReparsePoints(safeDir,'status directory');
      assertNoReparsePoints(file,'status events file');
      fs.writeFileSync(fd,JSON.stringify(event)+'\n');fs.fsyncSync(fd);
    }finally{fs.closeSync(fd);}
    onEvent?.(event);return event;
  }};
}
export function readRunStatus(workspace,runId,{env=process.env}={}){
  const dir=directory(workspace,runId),summaryFile=assertNoReparsePoints(path.join(dir,'summary.json'),'status summary file'),manifestFile=assertNoReparsePoints(path.join(dir,'manifest.json'),'status manifest file');
  let source=summaryFile,sum=readLedger(summaryFile);
  if(!sum){source=manifestFile;sum=readLedger(manifestFile);}
  if(!sum)throw publicStatusError('Run ledger not found: '+summaryFile+'（同目录也没有 manifest.json：'+dir+'）');
  if(typeof sum.runId!=='string'||typeof sum.workspace!=='string')throw publicStatusError('Invalid run ledger '+source+'：缺少 runId/workspace 字段（实测 runId='+describeShape(sum.runId)+'，workspace='+describeShape(sum.workspace)+'）');
  if(sum.runId!==runId||!sameWorkspaceIdentity(sum.workspace,workspace))throw new Error('Status run identity mismatch');
  // Before the first controller publication only the planning manifest exists.
  // It may be displayed as pending inventory, but it is never accepted as an
  // authenticated result.  A manifest that looks like a result is rejected.
  if(source===manifestFile){
    if(!isPlanningManifest(sum))throw new Error('Status manifest is not a planning ledger; refusing unauthenticated execution state');
    return publicStatusValue({...sum,todoList:buildTodoList(sum.tasks,sum.blocks,sum.taskResults),executionStatus:buildExecutionStatus(sum)});
  }
  const authority=readStatusAuthority(workspace,runId,env);
  if(authority.sha256!==statusDigest(sum))throw new Error('Status ledger authority mismatch');
  return publicStatusValue({...sum,todoList:buildTodoList(sum.tasks,sum.blocks,sum.taskResults),executionStatus:buildExecutionStatus(sum)});
}
// 坏账本既不能静默当成正常状态读出去（调用方会拿到半份状态），也不能只回裸 SyntaxError。
// ENOENT 返回 null 交给调用方决定回落（summary 缺失时看 manifest）。
function readLedger(file){
  const text=readTextWithIdentity(file,'status ledger file');
  if(text===null)return null;
  let value;
  try{value=JSON.parse(text.replace(/^\uFEFF/,''));}
  catch(error){throw publicStatusError('Invalid run ledger '+file+'：'+jsonProblem(text,error));}
  if(!value||typeof value!=='object'||Array.isArray(value))throw publicStatusError('Invalid run ledger '+file+'：顶层必须是 JSON 对象（实测 '+describeShape(value)+'）');
  return value;
}
export function renderRunStatus(state){
  state=publicStatusValue(state||{});
  if(!state.runId)return ['No orchestrator runs found in '+safeText(state.workspace),'TodoList','Execution'].join('\n');
  const rows=['Run '+safeText(state.runId)+' | '+(state.finishedAt?(state.success?'verified':'finished with unresolved tasks'):'active'),
    'TodoList',...(state.todoList||[]).map(t=>`${t.status==='verified'?'[x]':'[ ]'} ${safeText(t.id)} ${safeText(t.status)} (${safeText(t.block||'planning')}) ${safeText(t.prompt)}`),
    'Execution',...(state.executionStatus||[]).map(e=>`${safeText(e.block)} ${safeText(e.mode)} ${safeText(e.status)} | attempt ${safeText(e.attempt)} | PID ${safeText(e.pid??'-')} | tasks ${safeText((e.taskIds||[]).join(','))}${e.reason?' | '+safeText(e.reason):''}`)];
  return rows.join('\n');
}
function terminalEventMatchesSummary(workspace,runId,event,env=process.env){
  const sum=readRunStatus(workspace,runId,{env});
  return !!sum.finishedAt&&sum.eventSeq===event.seq&&sum.finishedAt===event.finishedAt&&sum.success===event.success;
}
export async function watchRunStatus({workspace,runId,after=0,intervalMs=250,timeoutMs=21600000,signal,onEvent=console.log,env=process.env}){
  if(!Number.isSafeInteger(after)||after<0||!Number.isFinite(intervalMs)||intervalMs<10||!Number.isFinite(timeoutMs)||timeoutMs<0)throw new Error('Invalid status watch timing or cursor');
  const dir=directory(workspace,runId),deadline=Date.now()+timeoutMs;
  let seq=after,initial=true,lastSize=-1;
  while(!signal?.aborted){
    let sum;
    try{sum=readRunStatus(workspace,runId,{env});}
    catch(error){
      // createStatusPublisher atomically replaces summary.json, then records
      // its controller-owned digest, then appends the event.  If a watcher
      // lands in that tiny interval, wait for the authority instead of
      // surfacing an unauthenticated snapshot.  Any malformed/mismatched
      // authority still fails closed and is not retried.
      if(error?.code!=='STATUS_AUTHORITY_PENDING'||Date.now()>=deadline)throw error;
      try{await sleep(Math.min(intervalMs,deadline-Date.now()),undefined,{signal});}catch(waitError){if(signal?.aborted)return;throw waitError;}
      continue;
    }
    if(initial){onEvent({schema:1,seq:sum.eventSeq||0,type:'snapshot',...sum});seq=Math.max(seq,sum.eventSeq||0);initial=false;if(sum.finishedAt)return;}
    let size=0;try{size=fs.statSync(assertNoReparsePoints(path.join(dir,'events.jsonl'),'status events file')).size;}catch(error){if(error.code!=='ENOENT')throw error;}
    if(size!==lastSize){for(const event of readEventsRaw(dir,{after:seq,runId})){
      seq=event.seq;
      // Events are workspace-readable hints.  A worker can append a forged
      // terminal event, so only a fresh controller-authenticated summary can
      // authorize terminal output and watcher termination.
      if(event.finishedAt){
        if(!terminalEventMatchesSummary(workspace,runId,event,env))continue;
        onEvent(publicStatusValue(event));return;
      }
      onEvent(publicStatusValue(event));
    }lastSize=size;}
    // A controller may die between its atomic snapshot and event append.
    if((sum.eventSeq||0)>seq){onEvent({schema:1,seq:sum.eventSeq,type:'snapshot',...sum});seq=sum.eventSeq;if(sum.finishedAt)return;}
    if(Date.now()>=deadline)throw new Error('Status watch timed out');
    try{await sleep(Math.min(intervalMs,deadline-Date.now()),undefined,{signal});}catch(error){if(signal?.aborted)return;throw error;}
  }
}
