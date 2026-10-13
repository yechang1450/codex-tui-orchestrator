import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {assertControllerPath,controllerStateDir} from './controller-state.mjs';
import {assertNoReparsePoints,physicallySameOrChild,physicalPathIdentity} from './runtime-context.mjs';
import {canonicalDigest} from './contracts.mjs';
import {atomicJson,isProcessIdentityBinding,readUtf8Bounded} from './leases.mjs';

// This module is intentionally independent from the runner and recovery
// engines.  It stores the controller-owned half of a post-exit cleanup
// transaction, so a future recovery driver can distinguish a workspace-side
// partial write from a controller-authorized operation.  Callers must still
// publish their public and attempt ledgers separately; this module never
// changes workspace files or leases.

export const CLEANUP_TRANSACTION_VERSION=1;
export const CLEANUP_TRANSACTION_PHASES=Object.freeze(['lease','registry','artifacts']);

const MARKER_KIND='cleanup-transaction';
const JOURNAL_KIND='post-exit-cleanup';
const ACTIVE_STATE='active';
const FINALIZING_STATE='finalizing';
const PHASE_PENDING='pending';
const PHASE_INFLIGHT='inflight';
const PHASE_DONE='done';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256=/^[a-f0-9]{64}$/;
const RUN_ID=/^[A-Za-z0-9_-]{1,100}$/;
const MAX_MARKER_BYTES=128*1024;
const MARKER_KEYS=['version','kind','workspaceIdentity','controllerRootSha256','coordinatorIdentitySha256','runId','blockKey','attempt','token','attemptPathSha256','lease','proof','journal','status','statusAuthority','state','createdAt','updatedAt'];
const LEASE_KEYS=['id','instanceId'];
const JOURNAL_KEYS=['version','kind','runId','blockKey','attempt','token','lease','phases','recordedAt','updatedAt'];
const EXIT_PROOF_KEYS=['version','kind','runId','blockKey','attempt','token','pid','authenticated','launcher','launcherIdentitySha256','recordedAt'];
const NO_PROCESS_PROOF_KEYS=['version','kind','runId','blockKey','attempt','token','recordedAt'];
const STATUS_KEYS=['baseSemanticSha256','targetSemanticSha256'];
const STATUS_AUTHORITY_KEYS=['version','kind','runId','workspaceIdentitySha256','source','target'];
const STATUS_AUTHORITY_DIGEST_KEYS=['summarySha256','acceptanceInvariantSha256'];
const BINDING_KEYS=['runId','blockKey','attempt','token','attemptFile','coordinator','lease','status'];

const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const digest=value=>crypto.createHash('sha256').update(String(value),'utf8').digest('hex');
const sameKeys=(value,keys)=>object(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const fail=reason=>{throw new Error('Invalid cleanup transaction marker: '+reason);};
const validTime=value=>Number.isSafeInteger(value)&&value>0;
const validString=(value,max=4096)=>typeof value==='string'&&value.length>0&&value.length<=max&&!value.includes('\0');

function clone(value){return JSON.parse(JSON.stringify(value));}

function normaliseLease(value,label='lease'){
 if(!sameKeys(value,LEASE_KEYS)||!validString(value.id,512)||typeof value.instanceId!=='string'||!UUID.test(value.instanceId))fail(label+' identity is invalid');
 return {id:value.id,instanceId:value.instanceId};
}

function normaliseStatusDigests(value){
 if(!sameKeys(value,STATUS_KEYS)||!SHA256.test(value.baseSemanticSha256)||!SHA256.test(value.targetSemanticSha256))fail('status semantic digests are invalid');
 return {baseSemanticSha256:value.baseSemanticSha256,targetSemanticSha256:value.targetSemanticSha256};
}

function normaliseStatusAuthorityDigest(value,label){
 if(!sameKeys(value,STATUS_AUTHORITY_DIGEST_KEYS)||!SHA256.test(value.summarySha256)||!SHA256.test(value.acceptanceInvariantSha256))fail('status authority '+label+' digest is invalid');
 return {summarySha256:value.summarySha256,acceptanceInvariantSha256:value.acceptanceInvariantSha256};
}

// The marker carries full controller-side digests for exactly one status
// publication boundary.  Unlike the semantic cleanup-status digests above,
// these bind the serialized public summary and acceptance invariant so the
// status layer can repair only its own summary-to-authority crash window.
function normaliseStatusAuthority(value,binding){
 if(!sameKeys(value,STATUS_AUTHORITY_KEYS)||value.version!==1||value.kind!=='cleanup-status-authority'||
   value.runId!==binding.runId||value.workspaceIdentitySha256!==digest(binding.workspaceIdentity))
   fail('status authority binding is invalid');
 return {version:1,kind:'cleanup-status-authority',runId:binding.runId,workspaceIdentitySha256:digest(binding.workspaceIdentity),
  source:normaliseStatusAuthorityDigest(value.source,'source'),target:normaliseStatusAuthorityDigest(value.target,'target')};
}

function normaliseSemanticValue(value,stack=new WeakSet()){
 if(value===null||typeof value==='string'||typeof value==='boolean')return value;
 if(typeof value==='number'){
  if(!Number.isFinite(value))fail('status semantic value is not finite');
  return value;
 }
 if(!value||typeof value!=='object')fail('status semantic value is invalid');
 if(stack.has(value))fail('status semantic value is cyclic');
 stack.add(value);
 try{
  if(Array.isArray(value)){
   const keys=Object.keys(value);
   if(keys.length!==value.length||keys.some(key=>!/^\d+$/.test(key)||Number(key)>=value.length))fail('status semantic array is invalid');
   return value.map(entry=>normaliseSemanticValue(entry,stack));
  }
  const prototype=Object.getPrototypeOf(value);
  if((prototype!==Object.prototype&&prototype!==null)||Object.getOwnPropertySymbols(value).length||Object.hasOwn(value,'toJSON'))fail('status semantic object is invalid');
  const output={};
  for(const key of Object.keys(value)){
   const descriptor=Object.getOwnPropertyDescriptor(value,key);
   if(!descriptor||!Object.hasOwn(descriptor,'value'))fail('status semantic object is invalid');
   Object.defineProperty(output,key,{value:normaliseSemanticValue(descriptor.value,stack),enumerable:true,configurable:true,writable:true});
  }
  return output;
 }finally{stack.delete(value);}
}

function normaliseBinding(workspace,binding,env){
 if(!sameKeys(binding,BINDING_KEYS))fail('binding is invalid');
 const {runId,blockKey,attempt,token,attemptFile,coordinator,lease}=binding;
 if(typeof workspace!=='string'||!path.isAbsolute(workspace))fail('workspace must be an absolute path');
 if(typeof runId!=='string'||!RUN_ID.test(runId))fail('run identity is invalid');
 if(!validString(blockKey,256))fail('block identity is invalid');
 if(!Number.isSafeInteger(attempt)||attempt<1)fail('attempt number is invalid');
 if(!validString(token,8192))fail('attempt token is invalid');
 if(typeof attemptFile!=='string'||!path.isAbsolute(attemptFile)||attemptFile.includes('\0'))fail('attempt file is invalid');
 if(typeof coordinator!=='string'||!path.isAbsolute(coordinator)||coordinator.includes('\0'))fail('coordinator is invalid');
 const resolvedWorkspace=path.resolve(workspace),resolvedAttempt=assertNoReparsePoints(path.resolve(attemptFile),'cleanup attempt file');
 const resolvedCoordinator=assertNoReparsePoints(path.resolve(coordinator),'cleanup transaction coordinator');
 if(!physicallySameOrChild(resolvedWorkspace,resolvedAttempt))fail('attempt file is outside the initiating workspace');
 const controllerRoot=controllerStateDir(resolvedWorkspace,env);
 return {
  runId,blockKey,attempt,token,
  lease:normaliseLease(lease),
  status:normaliseStatusDigests(binding.status),
  workspace:resolvedWorkspace,
  workspaceIdentity:physicalPathIdentity(resolvedWorkspace),
  attemptPathSha256:digest(physicalPathIdentity(resolvedAttempt)),
  controllerRootSha256:digest(physicalPathIdentity(controllerRoot)),
   coordinatorIdentitySha256:digest(physicalPathIdentity(resolvedCoordinator)),
 };
}

function markerFileForBinding(binding,env){
 const root=controllerStateDir(binding.workspace,env);
 const workspaceKey=digest(binding.workspaceIdentity);
 const transactionKey=digest(JSON.stringify([binding.runId,binding.blockKey,binding.attempt]));
 const directory=assertControllerPath(binding.workspace,path.join(root,'cleanup-transactions',workspaceKey),'cleanup transaction directory',env);
 return assertControllerPath(binding.workspace,path.join(directory,transactionKey+'.json'),'cleanup transaction marker',env);
}

function normaliseProof(value,binding){
 if(!object(value)||value.runId!==binding.runId||value.blockKey!==binding.blockKey||value.attempt!==binding.attempt||value.token!==binding.token)fail('proof is not bound to this attempt');
 if(value.kind==='authenticated-exit'){
  if(!sameKeys(value,EXIT_PROOF_KEYS)||value.version!==1||value.authenticated!==true||!Number.isSafeInteger(value.pid)||value.pid<=0||!validTime(value.recordedAt)||!isProcessIdentityBinding(value.launcher)||value.launcher.ProcessId!==value.pid||value.launcherIdentitySha256!==canonicalDigest(value.launcher))fail('authenticated exit proof is invalid');
  const launcher={ProcessId:value.launcher.ProcessId,Started:value.launcher.Started,Name:value.launcher.Name,commandLineSha256:value.launcher.commandLineSha256};
  return {version:1,kind:'authenticated-exit',runId:binding.runId,blockKey:binding.blockKey,attempt:binding.attempt,token:binding.token,pid:value.pid,authenticated:true,launcher,launcherIdentitySha256:canonicalDigest(launcher),recordedAt:value.recordedAt};
 }
 if(value.kind==='no-process'){
  if(!sameKeys(value,NO_PROCESS_PROOF_KEYS)||value.version!==1||!validTime(value.recordedAt))fail('no-process proof is invalid');
  return {version:1,kind:'no-process',runId:binding.runId,blockKey:binding.blockKey,attempt:binding.attempt,token:binding.token,recordedAt:value.recordedAt};
 }
 fail('proof kind is invalid');
}

function phasesArePrefix(phases){
 let pending=false,inflight=false;
 for(const phase of CLEANUP_TRANSACTION_PHASES){
  const value=phases[phase];
  if(value!==PHASE_PENDING&&value!==PHASE_INFLIGHT&&value!==PHASE_DONE)return false;
  if(value===PHASE_PENDING)pending=true;
  else if(value===PHASE_INFLIGHT){
   if(pending||inflight)return false;
   inflight=true;
  }else if(pending||inflight)return false;
 }
 return true;
}

function normaliseJournal(value,binding){
 if(!sameKeys(value,JOURNAL_KEYS)||value.version!==1||value.kind!==JOURNAL_KIND||
   value.runId!==binding.runId||value.blockKey!==binding.blockKey||value.attempt!==binding.attempt||value.token!==binding.token||
   !validTime(value.recordedAt)||!validTime(value.updatedAt)||value.updatedAt<value.recordedAt)
   fail('cleanup journal is invalid');
 const lease=normaliseLease(value.lease,'cleanup journal lease');
 if(lease.id!==binding.lease.id||lease.instanceId!==binding.lease.instanceId)fail('cleanup journal lease is not bound to the marker');
 if(!sameKeys(value.phases,CLEANUP_TRANSACTION_PHASES)||!phasesArePrefix(value.phases))fail('cleanup journal phases are invalid');
 return {
  version:1,kind:JOURNAL_KIND,runId:binding.runId,blockKey:binding.blockKey,attempt:binding.attempt,token:binding.token,
  lease,phases:{lease:value.phases.lease,registry:value.phases.registry,artifacts:value.phases.artifacts},
  recordedAt:value.recordedAt,updatedAt:value.updatedAt,
 };
}

function allPhasesDone(journal){return CLEANUP_TRANSACTION_PHASES.every(phase=>journal.phases[phase]===PHASE_DONE);}

function normaliseMarker(workspace,binding,marker,env){
 const expected=normaliseBinding(workspace,binding,env);
 if(!sameKeys(marker,MARKER_KEYS)||marker.version!==CLEANUP_TRANSACTION_VERSION||marker.kind!==MARKER_KIND||
   marker.workspaceIdentity!==expected.workspaceIdentity||marker.controllerRootSha256!==expected.controllerRootSha256||marker.coordinatorIdentitySha256!==expected.coordinatorIdentitySha256||
   marker.runId!==expected.runId||marker.blockKey!==expected.blockKey||marker.attempt!==expected.attempt||marker.token!==expected.token||
   marker.attemptPathSha256!==expected.attemptPathSha256||!SHA256.test(marker.attemptPathSha256)||
   !validTime(marker.createdAt)||!validTime(marker.updatedAt)||marker.updatedAt<marker.createdAt)
   fail('marker identity is invalid');
 const lease=normaliseLease(marker.lease);
 if(lease.id!==expected.lease.id||lease.instanceId!==expected.lease.instanceId)fail('marker lease is not bound to this attempt');
 const status=normaliseStatusDigests(marker.status);
 if(status.baseSemanticSha256!==expected.status.baseSemanticSha256||status.targetSemanticSha256!==expected.status.targetSemanticSha256)fail('marker status semantics are not bound to this transaction');
 const statusAuthority=normaliseStatusAuthority(marker.statusAuthority,expected);
 const proof=normaliseProof(marker.proof,expected);
 const journal=normaliseJournal(marker.journal,expected);
 if(marker.updatedAt!==journal.updatedAt||proof.recordedAt>journal.recordedAt||journal.recordedAt>marker.updatedAt)fail('marker timestamps are inconsistent');
 const state=allPhasesDone(journal)?FINALIZING_STATE:ACTIVE_STATE;
 if(marker.state!==state)fail('marker state does not match journal phases');
 return {
  version:CLEANUP_TRANSACTION_VERSION,kind:MARKER_KIND,workspaceIdentity:expected.workspaceIdentity,controllerRootSha256:expected.controllerRootSha256,coordinatorIdentitySha256:expected.coordinatorIdentitySha256,
  runId:expected.runId,blockKey:expected.blockKey,attempt:expected.attempt,token:expected.token,attemptPathSha256:expected.attemptPathSha256,
  lease,proof,journal,status,statusAuthority,state,createdAt:marker.createdAt,updatedAt:marker.updatedAt,
 };
}

function readExistingMarker(workspace,binding,env,{missingOk=true}={}){
 const expected=normaliseBinding(workspace,binding,env),file=markerFileForBinding(expected,env);
 let stat;
 try{stat=fs.lstatSync(file);}catch(error){if(error?.code==='ENOENT'&&missingOk)return {file,marker:null};throw error;}
 if(!stat.isFile())fail('controller marker is not a regular file');
 assertNoReparsePoints(file,'cleanup transaction marker');
 const raw=readUtf8Bounded(file,'cleanup transaction marker',MAX_MARKER_BYTES);
 if(raw===null)return {file,marker:null};
 let parsed;try{parsed=JSON.parse(raw);}catch{fail('controller marker is unreadable');}
 return {file,marker:normaliseMarker(workspace,binding,parsed,env)};
}

/**
 * Derive the only allowed durable marker location.  Its path contains hashes,
 * while the marker body carries the full bound identities for validation.
 */
export function cleanupTransactionMarkerFile({workspace,binding,env=process.env}={}){
 const expected=normaliseBinding(workspace,binding,env);
 return markerFileForBinding(expected,env);
}

/**
 * Digest the controller's semantic status projections before passing them in
 * a binding.  The marker retains only these digests, never the status bodies.
 */
export function cleanupTransactionStatusDigests({base,target}={}){
 return {
  baseSemanticSha256:canonicalDigest(normaliseSemanticValue(base)),
  targetSemanticSha256:canonicalDigest(normaliseSemanticValue(target)),
 };
}

/**
 * Build a validated controller-side transaction marker.  `proof` is either a
 * canonical authenticated-exit receipt (including its full launcher binding)
 * or a canonical no-process receipt.  `journal` uses the existing
 * post-exit-cleanup journal schema.  `binding.status` must come from
 * cleanupTransactionStatusDigests so recovery can compare both semantic
 * status boundaries without persisting their full workspace projections.
 */
export function createCleanupTransactionMarker({workspace,binding,proof,journal,statusAuthority,createdAt,updatedAt=createdAt,env=process.env}={}){
 const expected=normaliseBinding(workspace,binding,env);
 const marker={
  version:CLEANUP_TRANSACTION_VERSION,kind:MARKER_KIND,workspaceIdentity:expected.workspaceIdentity,controllerRootSha256:expected.controllerRootSha256,coordinatorIdentitySha256:expected.coordinatorIdentitySha256,
  runId:expected.runId,blockKey:expected.blockKey,attempt:expected.attempt,token:expected.token,attemptPathSha256:expected.attemptPathSha256,
  lease:expected.lease,proof,journal,status:expected.status,statusAuthority,state:ACTIVE_STATE,createdAt,updatedAt,
 };
 // The final state is derived from the validated phase prefix rather than
 // chosen by a caller, so an all-done marker cannot remain reusable.
 marker.state=allPhasesDone(normaliseJournal(journal,expected))?FINALIZING_STATE:ACTIVE_STATE;
 return normaliseMarker(workspace,binding,marker,env);
}

/** Write a new marker once.  Existing state is never overwritten by create. */
export function writeCleanupTransactionMarker({workspace,binding,marker,env=process.env}={}){
 const expected=normaliseBinding(workspace,binding,env),file=markerFileForBinding(expected,env);
 const value=normaliseMarker(workspace,binding,marker,env);
 if(fs.existsSync(file))fail('controller marker already exists; update it instead');
 atomicJson(file,value,()=>assertControllerPath(expected.workspace,file,'cleanup transaction marker',env));
 return clone(value);
}

/** Read and validate a marker against the caller's complete attempt binding. */
export function readCleanupTransactionMarker({workspace,binding,env=process.env}={}){
 const {marker}=readExistingMarker(workspace,binding,env);
 return marker===null?null:clone(marker);
}

/**
 * Read a controller-owned marker while the workspace mirrors may be only a
 * valid prefix of its publication.  The caller supplies every immutable
 * attempt identity except the status digests; those are read from the
 * controller marker and then validated as part of the marker itself.  This is
 * deliberately narrow: it never accepts a workspace-provided status digest as
 * authority for a partial cleanup recovery.
 */
export function readCleanupTransactionMarkerForRecovery({workspace,binding,env=process.env}={}){
 const placeholder=cleanupTransactionStatusDigests({base:{kind:'cleanup-marker-lookup'},target:{kind:'cleanup-marker-lookup'}});
 const expected=normaliseBinding(workspace,{...binding,status:placeholder},env);
 const file=markerFileForBinding(expected,env);
 let stat;
 try{stat=fs.lstatSync(file);}catch(error){if(error?.code==='ENOENT')return null;throw error;}
 if(!stat.isFile())fail('controller marker is not a regular file');
 assertNoReparsePoints(file,'cleanup transaction marker');
 const raw=readUtf8Bounded(file,'cleanup transaction marker',MAX_MARKER_BYTES);
 if(raw===null)return null;
 let parsed;try{parsed=JSON.parse(raw);}catch{fail('controller marker is unreadable');}
 if(!object(parsed?.status))fail('marker status semantics are missing');
 const marker=normaliseMarker(workspace,{...binding,status:parsed.status},parsed,env);
 return clone(marker);
}

/**
 * Fence exactly the next cleanup phase before its external side effect begins.
 * A recovered in-flight fence is deliberately ambiguous: it must be
 * reconciled, never replayed automatically.
 */
export function beginCleanupTransactionMarkerPhase({workspace,binding,phase,updatedAt=Date.now(),env=process.env}={}){
 if(!CLEANUP_TRANSACTION_PHASES.includes(phase))fail('cleanup phase is invalid');
 if(!validTime(updatedAt))fail('update timestamp is invalid');
 const {file,marker}=readExistingMarker(workspace,binding,env,{missingOk:false});
 if(marker===null)fail('controller marker is missing');
 const nextPhase=CLEANUP_TRANSACTION_PHASES.find(name=>marker.journal.phases[name]===PHASE_PENDING);
 if(nextPhase!==phase)fail('cleanup phase is not the next pending phase');
 if(updatedAt<marker.updatedAt)fail('update timestamp moves backwards');
 const next=clone(marker);
 next.journal.phases[phase]=PHASE_INFLIGHT;
 next.updatedAt=updatedAt;next.journal.updatedAt=updatedAt;
 next.state=ACTIVE_STATE;
 const value=normaliseMarker(workspace,binding,next,env);
 atomicJson(file,value,()=>assertControllerPath(path.resolve(workspace),file,'cleanup transaction marker',env));
 return clone(value);
}

/**
 * Commit the external effect fenced by beginCleanupTransactionMarkerPhase().
 * A caller cannot skip the durable in-flight state or complete a different
 * phase after restart.
 */
export function updateCleanupTransactionMarker({workspace,binding,phase,updatedAt=Date.now(),env=process.env}={}){
 if(!CLEANUP_TRANSACTION_PHASES.includes(phase))fail('cleanup phase is invalid');
 if(!validTime(updatedAt))fail('update timestamp is invalid');
 const {file,marker}=readExistingMarker(workspace,binding,env,{missingOk:false});
 if(marker===null)fail('controller marker is missing');
 const nextPhase=CLEANUP_TRANSACTION_PHASES.find(name=>marker.journal.phases[name]!==PHASE_DONE);
 if(nextPhase!==phase||marker.journal.phases[phase]!==PHASE_INFLIGHT)fail('cleanup phase is not in flight');
 if(updatedAt<marker.updatedAt)fail('update timestamp moves backwards');
 const next=clone(marker);
 next.journal.phases[phase]=PHASE_DONE;
 next.updatedAt=updatedAt;next.journal.updatedAt=updatedAt;
 next.state=allPhasesDone(next.journal)?FINALIZING_STATE:ACTIVE_STATE;
 const value=normaliseMarker(workspace,binding,next,env);
 atomicJson(file,value,()=>assertControllerPath(path.resolve(workspace),file,'cleanup transaction marker',env));
 return clone(value);
}

/**
 * Replace only the authenticated source/target pair for the next status
 * publication.  Phase timestamps remain a cleanup-state boundary, so this
 * cannot make a marker appear to have completed a destructive phase.
 */
export function updateCleanupTransactionStatusAuthority({workspace,binding,statusAuthority,env=process.env}={}){
 const {file,marker}=readExistingMarker(workspace,binding,env,{missingOk:false});
 if(marker===null)fail('controller marker is missing');
 const expected=normaliseBinding(workspace,binding,env);
 const next=clone(marker);
 next.statusAuthority=normaliseStatusAuthority(statusAuthority,expected);
 const value=normaliseMarker(workspace,binding,next,env);
 atomicJson(file,value,()=>assertControllerPath(path.resolve(workspace),file,'cleanup transaction marker',env));
 return clone(value);
}

/**
 * Remove only a fully completed marker.  Missing is idempotent; malformed or
 * incomplete controller state is retained and reported for reconciliation.
 */
export function deleteCleanupTransactionMarker({workspace,binding,env=process.env}={}){
 const {file,marker}=readExistingMarker(workspace,binding,env);
 if(marker===null)return false;
 if(marker.state!==FINALIZING_STATE||!allPhasesDone(marker.journal))fail('controller marker is not ready for deletion');
 try{
  const stat=fs.lstatSync(file);
  if(!stat.isFile())fail('controller marker is not a regular file');
  assertNoReparsePoints(file,'cleanup transaction marker');
  fs.unlinkSync(file);
  return true;
 }catch(error){if(error?.code==='ENOENT')return false;throw error;}
}
