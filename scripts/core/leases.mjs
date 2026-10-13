import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {spawn,spawnSync} from 'node:child_process';
import {canonicalKey,keysOverlap} from './contracts.mjs';
import os from 'node:os';
import {assertNoReparsePoints,physicallySameOrChild,physicalPathIdentity} from './runtime-context.mjs';
import {controllerStateDir,assertPrivateControllerRoot} from './controller-state.mjs';
import {redactSensitiveTextForLeaseKey,isCredentialShapedText} from './redaction.mjs';
import {runBackgroundSnapshotHelper} from './background-snapshot-child.mjs';
import {trustedWindowsRoot,trustedWindowsHelper,controllerEnvironment} from './windows-system.mjs';
import {assertPrivateWindowsRoot} from './private-root.mjs';

export {trustedWindowsRoot,trustedWindowsHelper,controllerEnvironment};

// Lease keys are durable conflict identities.  They are intentionally public
// projections rather than raw task/path text, and both newly submitted and
// legacy-loaded rows pass through this same function before overlap checks.
export function publicLeaseKeys(keys,{scopeDir,cwd=process.cwd()}={}) {
  const output=[],seen=new Set();
  for(const key of Array.isArray(keys)?keys:[]) {
    const projected=projectLeaseKey(String(key??''),{scopeDir,cwd});
    if(!seen.has(projected)){seen.add(projected);output.push(projected);}
  }
  return output;
}

function shapeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return '数组';
  return typeof value;
}
// 损坏（解析不了/结构不符）的账本文件：先把原文件原样隔离到 <file>.corrupt-<epochMs>（保留证据 +
// 告警点名），再按 broken 约定处理 —— 默认 fail-closed 抛错（与 registry 的 loadJson 同一口径：
// 畸形状态当成空表静默放行会绕过容量/冲突闸门），但坏文件已经摘走，所以下一次事务会从干净账本
// 重新开始，绝不会因为一条毒记录把整个工作区永久锁死。
// release 路径例外（broken:'empty'）：它在 runWindows 的 finally 里跑，抛错会把"已经跑完的一轮"
// 改判成失败，所以那里必须幂等。
// 读失败（EBUSY/EPERM —— 被别的进程占着、只读、权限不足）永远原样抛出，保持 fail-closed。
function quarantine(file) {
  const target = file + '.corrupt-' + Date.now();
  try { fs.renameSync(file, target); return target; } catch { return null; }
}
function readState(file, shape, label, { broken = 'throw' } = {}) {
  let text;
  try { text = readUtf8Bounded(file,label); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if(text===null)return null;
  let value;
  try { value = JSON.parse(text.replace(/^\uFEFF/, '')); }
  catch (error) { return handle('JSON 解析失败：' + error.message); }
  if (!shape(value)) return handle('结构不符（顶层是 ' + shapeOf(value) + '）');
  return value;
  function handle(reason) {
    const moved = quarantine(file);
    const where = moved ? '原文件已隔离到 ' + moved : '隔离失败（' + file + ' 仍在原位）';
    if (broken === 'empty') {
      console.warn('[orchestrator] ' + label + ' 损坏（' + reason + '）：' + where + '；本次按空账本继续（释放必须幂等）');
      return null;
    }
    throw new Error(label + ' 损坏（' + reason + '）：' + where +
      '；畸形状态不能当成空表静默放行（那会绕过容量/冲突闸门），下一次事务会从干净账本重新开始');
  }
}

const DEFAULT_PROCESS_SNAPSHOT_TIMEOUT_MS=120000;
const MAX_PROCESS_SNAPSHOT_TIMEOUT_MS=120000;
const MIN_PROCESS_SNAPSHOT_TIMEOUT_MS=1000;
const DEFAULT_COORDINATOR_TIMEOUT_MS=120000;
const MAX_COORDINATOR_TIMEOUT_MS=120000;
const COORDINATOR_RELEASE_ACK_TIMEOUT_MS=5000;
const MAX_COORDINATOR_RELEASE_MARKER_BYTES=128;
const COORDINATOR_SNAPSHOT_CACHE_TTL_MS=120000;
export const MAX_CONTROLLER_ARTIFACT_BYTES=8*1024*1024;

const LEASE_MARKER_FILE='lease-marker-hmac-v1.dpapi';
const LEASE_MARKER_HMAC_PREFIX='[REDACTED]~hmac-sha256-v1-';
const LEASE_MARKER_HMAC=/\[REDACTED\]~hmac-sha256-v1-([a-f0-9]{32})-([A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/g;
const LEASE_MARKER_HMAC_PREFIX_RE=/\[REDACTED\]~hmac-sha256-v1-/i;
const LEASE_MARKER_LEGACY=/\[REDACTED\](?!~hmac-sha256-v1-)(?:~sha256-[a-f0-9]{64})?/i;
const leaseMarkerKeyCache=new Map();

function exactObjectKeys(value,expected){
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const keys=Reflect.ownKeys(value);
  return keys.length===expected.length&&keys.every(key=>typeof key==='string'&&expected.includes(key))&&expected.every(key=>Object.hasOwn(value,key));
}
function leaseMarkerScope(scopeDir){
  if(process.platform!=='win32')throw new Error('LEASE_MARKER_KEY_UNAVAILABLE: coordinator marker protection requires Windows DPAPI');
  if(typeof scopeDir!=='string'||!scopeDir.trim())throw new Error('LEASE_MARKER_SCOPE_REQUIRED: sensitive lease keys require a coordinator scope');
  const selected=path.resolve(scopeDir);
  fs.mkdirSync(selected,{recursive:true});
  assertNoReparsePoints(selected,'lease marker coordinator scope');
  const identity=physicalPathIdentity(selected);
  const privateDir=path.join(identity,'private');
  fs.mkdirSync(privateDir,{recursive:true});
  assertNoReparsePoints(privateDir,'lease marker private directory');
  return {identity,file:assertNoReparsePoints(path.join(privateDir,LEASE_MARKER_FILE),'lease marker key file')};
}
function dpapiLeaseMarker(mode,input){
  const script=mode==='protect'
    ? "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $raw=[Console]::In.ReadToEnd(); $bytes=[Text.Encoding]::UTF8.GetBytes($raw); [Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)))"
    : "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $raw=[Console]::In.ReadToEnd().Trim(); $bytes=[Convert]::FromBase64String($raw); [Console]::Out.Write([Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)))";
  const result=spawnSync(trustedWindowsHelper('powershell'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',script],{
    input:String(input??''),encoding:'utf8',windowsHide:true,timeout:30000,cwd:trustedWindowsRoot(),env:controllerEnvironment(),maxBuffer:64*1024,
  });
  if(result.error||result.status!==0)throw new Error('LEASE_MARKER_KEY_UNAVAILABLE: cannot access the CurrentUser DPAPI marker key');
  return String(result.stdout||'').trim();
}
function markerKeyFingerprint(file){
  assertNoReparsePoints(file,'lease marker key file');
  const stat=fs.statSync(file);
  if(!stat.isFile()||stat.size<=0||stat.size>64*1024)throw new Error('LEASE_MARKER_KEY_UNAVAILABLE: invalid sealed marker key');
  // File metadata alone is not a security boundary: an attacker able to
  // replace a local file can preserve its byte length and timestamp.  Hash the
  // bounded sealed payload before consulting the in-memory key cache so a
  // changed DPAPI envelope is always parsed again and rejected if invalid.
  const sealed=readUtf8Bounded(file,'sealed lease marker key',64*1024);
  if(sealed===null)throw new Error('LEASE_MARKER_KEY_UNAVAILABLE: sealed marker key disappeared');
  return `${stat.size}:${stat.mtimeMs}:${crypto.createHash('sha256').update(sealed,'utf8').digest('hex')}`;
}
function parseLeaseMarkerEnvelope(sealed,identity){
  if(!/^[A-Za-z0-9+/]+={0,2}$/.test(sealed))throw new Error('LEASE_MARKER_KEY_UNAVAILABLE: invalid sealed marker key');
  let envelope;
  try{envelope=JSON.parse(dpapiLeaseMarker('unprotect',sealed));}
  catch(error){if(String(error?.message||error).startsWith('LEASE_MARKER_KEY_'))throw error;throw new Error('LEASE_MARKER_KEY_UNAVAILABLE: invalid protected marker key');}
  if(!exactObjectKeys(envelope,['version','kind','scopeIdentity','keyId','key'])||envelope.version!==1||envelope.kind!=='lease-marker-key'||envelope.scopeIdentity!==identity||
    !/^[a-f0-9]{32}$/.test(envelope.keyId)||typeof envelope.key!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(envelope.key)||Buffer.from(envelope.key,'base64url').length!==32)
    throw new Error(envelope?.scopeIdentity&&envelope.scopeIdentity!==identity?'LEASE_MARKER_KEY_MISMATCH: marker key belongs to another coordinator':'LEASE_MARKER_KEY_UNAVAILABLE: invalid protected marker key');
  return {keyId:envelope.keyId,key:envelope.key};
}
function readLeaseMarkerKey(scope,{create}){
  let fingerprint;
  try{fingerprint=markerKeyFingerprint(scope.file);}
  catch(error){
    if(error?.code!=='ENOENT')throw error;
    if(!create)throw new Error('LEASE_MARKER_KEY_UNAVAILABLE: existing lease marker key is unavailable');
    const envelope={version:1,kind:'lease-marker-key',scopeIdentity:scope.identity,keyId:crypto.randomBytes(16).toString('hex'),key:crypto.randomBytes(32).toString('base64url')};
    const sealed=dpapiLeaseMarker('protect',JSON.stringify(envelope));
    let fd;
    try{
      assertNoReparsePoints(path.dirname(scope.file),'lease marker private directory');
      fd=fs.openSync(scope.file,'wx',0o600);fs.writeFileSync(fd,sealed,'utf8');fs.fsyncSync(fd);
    }catch(writeError){
      if(writeError?.code!=='EEXIST')throw new Error('LEASE_MARKER_KEY_UNAVAILABLE: cannot persist marker key');
    }finally{if(fd!==undefined)fs.closeSync(fd);}
    fingerprint=markerKeyFingerprint(scope.file);
  }
  const cached=leaseMarkerKeyCache.get(scope.identity);
  if(cached?.file===scope.file&&cached.fingerprint===fingerprint)return cached;
  const sealed=readUtf8Bounded(scope.file,'sealed lease marker key',64*1024)?.trim();
  if(!sealed)throw new Error('LEASE_MARKER_KEY_UNAVAILABLE: existing lease marker key is unavailable');
  const parsed=parseLeaseMarkerEnvelope(sealed,scope.identity);
  const entry={...parsed,file:scope.file,fingerprint};leaseMarkerKeyCache.set(scope.identity,entry);return entry;
}
function leaseMarkerKey(scopeDir,options={}){return readLeaseMarkerKey(leaseMarkerScope(scopeDir),{create:options.create!==false});}
function markerForLeaseMatch(scopeDir,match){
  const key=leaseMarkerKey(scopeDir);
  const tag=crypto.createHmac('sha256',Buffer.from(key.key,'base64url')).update('codex-tui-orchestrator/lease-marker/v1\0','utf8').update(String(match),'utf8').digest('base64url');
  return LEASE_MARKER_HMAC_PREFIX+key.keyId+'-'+tag;
}
function validateExistingLeaseMarkers(value,scopeDir){
  const raw=String(value);
  const matches=[...raw.matchAll(LEASE_MARKER_HMAC)];
  // A valid marker elsewhere must not mask a truncated or forged HMAC prefix.
  // Remove every complete marker first, then reject any remaining versioned
  // prefix before an opaque durable key can be accepted.
  const remainder=raw.replace(LEASE_MARKER_HMAC,'');
  if(LEASE_MARKER_HMAC_PREFIX_RE.test(remainder))throw new Error('LEASE_MARKER_INVALID_FORMAT: malformed coordinator-scoped HMAC marker');
  if(!matches.length)return false;
  const key=leaseMarkerKey(scopeDir,{create:false});
  if(matches.some(match=>match[1]!==key.keyId))throw new Error('LEASE_MARKER_KEY_MISMATCH: lease marker belongs to another coordinator');
  return true;
}
function projectLeaseKey(value,{scopeDir,cwd}){
  const raw=String(value??'');
  if(LEASE_MARKER_LEGACY.test(raw))throw new Error('LEASE_MARKER_LEGACY_FORMAT: reconcile leases created before coordinator-scoped HMAC markers');
  const canonical=canonicalKey(raw,cwd);
  const hasExistingMarkers=validateExistingLeaseMarkers(raw,scopeDir);
  const sensitive=isCredentialShapedText(canonical);
  if(hasExistingMarkers){
    if(sensitive)throw new Error('LEASE_MARKER_MIXED_FORMAT: a durable HMAC marker cannot be combined with fresh sensitive text');
    return raw;
  }
  if(!sensitive)return raw;
  if(!scopeDir)throw new Error('LEASE_MARKER_SCOPE_REQUIRED: sensitive lease keys require a coordinator scope');
  const pathKey=/^(file|dir):(.*)$/i.exec(canonical);
  const project=segment=>redactSensitiveTextForLeaseKey(segment,match=>markerForLeaseMatch(scopeDir,match));
  return pathKey?pathKey[1].toLowerCase()+':'+pathKey[2].split('/').map(project).join('/'):project(canonical);
}

export function readUtf8Bounded(file,label='controller artifact',maxBytes=MAX_CONTROLLER_ARTIFACT_BYTES) {
  let fd;
  try { fd=fs.openSync(file,'r'); }
  catch(error) { if(error.code==='ENOENT')return null; throw error; }
  try {
    if(!Number.isSafeInteger(maxBytes)||maxBytes<1)throw new RangeError(`${label} has an invalid byte safety limit`);
    const opened=fs.fstatSync(fd,{bigint:true});
    if(!opened.isFile())throw new Error(`${label} is not a regular file: ${file}`);
    if(opened.size>BigInt(maxBytes))throw new Error(`${label} exceeds the ${maxBytes} byte safety limit: ${file}`);
    const buffer=Buffer.allocUnsafe(maxBytes+1);let offset=0;
    while(offset<=maxBytes){
      const count=fs.readSync(fd,buffer,offset,maxBytes+1-offset,null);
      if(count===0)break;offset+=count;
    }
    if(offset>maxBytes)throw new Error(`${label} exceeds the ${maxBytes} byte safety limit: ${file}`);
    const current=fs.statSync(file,{bigint:true});
    if(opened.dev!==current.dev||opened.ino!==current.ino)throw new Error(`${label} changed during read: ${file}`);
    assertNoReparsePoints(file,label);
    return buffer.subarray(0,offset).toString('utf8');
  } finally { fs.closeSync(fd); }
}
function coordinatorNonceMarkerMatches(ticket,nonce,{suffix,prefix,label}) {
  if(typeof ticket!=='string'||!ticket||typeof nonce!=='string'||!nonce)return false;
  const marker=ticket+suffix,expected=`${prefix}:${nonce}`;
  try {
    assertNoReparsePoints(marker,label);
    const stat=fs.statSync(marker);
    if(!stat.isFile()||!Number.isSafeInteger(Number(stat.size))||stat.size<=0||stat.size>MAX_COORDINATOR_RELEASE_MARKER_BYTES)return false;
    const text=readUtf8Bounded(marker,label,MAX_COORDINATOR_RELEASE_MARKER_BYTES);
    assertNoReparsePoints(marker,label);
    return text===expected;
  } catch { return false; }
}
export function coordinatorReleaseMarkerMatches(ticket,nonce) {
  return coordinatorNonceMarkerMatches(ticket,nonce,{suffix:'.released',prefix:'released',label:'coordinator release receipt'});
}
export function coordinatorReleaseSignalMatches(ticket,nonce) {
  return coordinatorNonceMarkerMatches(ticket,nonce,{suffix:'.release',prefix:'release',label:'coordinator release signal'});
}
export function coordinatorReleaseAcknowledgementMatches(ticket,nonce) {
  // `.ack` must be the receipt's hard link, not merely another marker with
  // matching text. The file identity check makes helper cleanup ownership
  // observable and prevents a late caller from authorizing a recreated ack.
  if(!coordinatorReleaseMarkerMatches(ticket,nonce))return false;
  if(!coordinatorNonceMarkerMatches(ticket,nonce,{suffix:'.ack',prefix:'released',label:'coordinator release acknowledgement'}))return false;
  const receipt=ticket+'.released',acknowledgement=ticket+'.ack';
  try {
    assertNoReparsePoints(receipt,'coordinator release receipt');
    assertNoReparsePoints(acknowledgement,'coordinator release acknowledgement');
    const receiptStat=fs.statSync(receipt,{bigint:true});
    const acknowledgementStat=fs.statSync(acknowledgement,{bigint:true});
    assertNoReparsePoints(receipt,'coordinator release receipt');
    assertNoReparsePoints(acknowledgement,'coordinator release acknowledgement');
    return receiptStat.isFile()&&acknowledgementStat.isFile()&&
      receiptStat.dev===acknowledgementStat.dev&&receiptStat.ino!==0n&&
      receiptStat.ino===acknowledgementStat.ino&&receiptStat.nlink>=2n&&acknowledgementStat.nlink>=2n;
  } catch { return false; }
}
export function waitForCoordinatorReleaseAcknowledgement(ticket,nonce,{timeoutMs=5000}={}) {
  const bounded=Math.max(0,Math.min(COORDINATOR_RELEASE_ACK_TIMEOUT_MS,Math.ceil(Number(timeoutMs)||0)));
  const deadline=Date.now()+bounded,waiter=new Int32Array(new SharedArrayBuffer(4));
  while(true){
    if(coordinatorReleaseMarkerMatches(ticket,nonce))return true;
    const remaining=deadline-Date.now();
    if(remaining<=0)return false;
    Atomics.wait(waiter,0,0,Math.min(25,remaining));
  }
}
function coordinatorReleaseIssue(code,detail) {
  const error=new Error(`${code}: ${detail}`);
  error.name='CoordinatorReleaseError';
  error.code=code;
  return error;
}
function coordinatorMarkerWrite(ticket,nonce,{suffix,prefix,label,matches,code}) {
  const marker=ticket+suffix;
  try {
    assertNoReparsePoints(marker,label);
    fs.writeFileSync(marker,`${prefix}:${nonce}`,{encoding:'utf8',flag:'wx'});
    assertNoReparsePoints(marker,label);
    return;
  } catch(error) {
    // A repeated release of this exact attempt is safe; any foreign/stale
    // marker is not a release authority and must remain a visible failure.
    if(error?.code==='EEXIST'&&matches(ticket,nonce))return;
    const ioCode=typeof error?.code==='string'&&/^[A-Z0-9_]+$/.test(error.code)?error.code:'IO_FAILURE';
    throw coordinatorReleaseIssue(code,`${label} could not be written or verified (${ioCode})`);
  }
}
function coordinatorReceiptAcknowledgement(ticket,nonce) {
  const receipt=ticket+'.released',acknowledgement=ticket+'.ack';
  try {
    // Validate the nonce-bound, regular receipt before creating its hard link.
    // A successful exclusive link is then the linearization point: it proves
    // that this acknowledgement was bound to that receipt at that instant.
    // The helper is allowed to observe the link and clean both paths before
    // this synchronous call returns, so no post-link pathname read can be a
    // prerequisite for successful acknowledgement.
    if(!coordinatorReleaseMarkerMatches(ticket,nonce))throw new Error('release receipt content mismatch');
    assertNoReparsePoints(receipt,'coordinator release receipt');
    assertNoReparsePoints(acknowledgement,'coordinator release acknowledgement');
    // An exclusive hard link is the acknowledgement. Unlike a fresh write,
    // it cannot appear after the helper has removed the receipt on timeout.
    fs.linkSync(receipt,acknowledgement);
  } catch(error) {
    // An acknowledgement is one exclusive link attempt. A collision is never
    // idempotent success: only the helper owns marker cleanup, and a caller
    // must surface this post-release handoff fault instead of guessing who
    // created the existing path.
    const ioCode=typeof error?.code==='string'&&/^[A-Z0-9_]+$/.test(error.code)?error.code:'IO_FAILURE';
    throw coordinatorReleaseIssue('ORCH_COORDINATOR_RELEASE_ACK_SIGNAL_FAILED',`the verified release receipt could not be acknowledged (${ioCode})`);
  }
}
function committedCoordinatorReleaseWarning(issue) {
  const warning=new Error(`${issue.code}: ${issue.message.replace(/^[^:]+:\s*/, '')}; durable coordinator work may already be committed and must not be retried automatically`);
  warning.name='CoordinatorReleaseCommitWarning';
  warning.code=issue.code;
  warning.committed=true;
  process.emitWarning(warning);
}
function incompleteCoordinatorReleaseWarning(issue) {
  const warning=new Error(`${issue.code}: ${issue.message.replace(/^[^:]+:\s*/, '')}; coordinator transaction did not commit`);
  warning.name='CoordinatorReleaseIncompleteWarning';
  warning.code=issue.code;
  warning.committed=false;
  process.emitWarning(warning);
}
function ledgerRevision(file) {
  let fd;
  try {
    assertNoReparsePoints(file,'coordinator ledger');
    fd=fs.openSync(file,'r');
    const stat=fs.fstatSync(fd);
    if(!stat.isFile()||!Number.isSafeInteger(Number(stat.size))||Number(stat.size)>MAX_CONTROLLER_ARTIFACT_BYTES)return 'unknown';
    const bytes=Buffer.allocUnsafe(MAX_CONTROLLER_ARTIFACT_BYTES+1);let count=0;
    while(count<bytes.length){const read=fs.readSync(fd,bytes,count,bytes.length-count,count);if(read===0)break;count+=read;}
    if(count>MAX_CONTROLLER_ARTIFACT_BYTES)return 'unknown';
    return crypto.createHash('sha256').update(bytes.subarray(0,count)).digest('hex');
  } catch(error) {
    if(error.code==='ENOENT')return 'absent';
    return 'unknown';
  } finally { if(fd!==undefined)fs.closeSync(fd); }
}
const COMMAND_LINE_SHA256=/^[a-f0-9]{64}$/;
function validRuntimeProcessIdentity(value) {
  return !!value&&typeof value==='object'&&Number.isSafeInteger(value.ProcessId)&&value.ProcessId>0&&
    typeof value.Started==='string'&&typeof value.Name==='string'&&(value.CommandLine===null||typeof value.CommandLine==='string');
}
function commandLineSha256(commandLine) {
  return crypto.createHash('sha256').update(commandLine===null?'null:':'string:'+String(commandLine),'utf8').digest('hex');
}
export function processIdentityBinding(value) {
  if(!validRuntimeProcessIdentity(value))return null;
  return {ProcessId:value.ProcessId,Started:value.Started,Name:value.Name,commandLineSha256:commandLineSha256(value.CommandLine)};
}
function processSnapshotIdentityBinding(value) {
  const live=processIdentityBinding(value);
  if(live)return live;
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.hasOwn(value,'CommandLine'))return null;
  const binding={ProcessId:value.ProcessId,Started:value.Started,Name:value.Name,commandLineSha256:value.commandLineSha256};
  return validProcessIdentity(binding)?binding:null;
}
function hasExactOwnKeys(value,expected) {
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const actual=Reflect.ownKeys(value);
  return actual.length===expected.length&&
    actual.every(key=>typeof key==='string'&&expected.includes(key))&&
    expected.every(key=>Object.hasOwn(value,key));
}
function validProcessIdentity(value) {
  // Controller records are deliberately a different shape from a live process
  // snapshot. A legacy record with CommandLine is never adopted: it may carry a
  // user prompt and cannot be made private merely by rewriting it during resume.
  return hasExactOwnKeys(value,['ProcessId','Started','Name','commandLineSha256'])&&Number.isSafeInteger(value.ProcessId)&&value.ProcessId>0&&
    typeof value.Started==='string'&&typeof value.Name==='string'&&typeof value.commandLineSha256==='string'&&
    COMMAND_LINE_SHA256.test(value.commandLineSha256);
}
export function isProcessIdentityBinding(value) { return validProcessIdentity(value); }
const LEASE_INSTANCE_ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function validLeaseRecord(value) {
  return !!value&&typeof value==='object'&&typeof value.id==='string'&&value.id.length>0&&Array.isArray(value.keys)&&
    (validProcessIdentity(value.owner)||validProcessIdentity(value.launcher));
}
function validRunOwner(value) {
  return !!value&&typeof value==='object'&&typeof value.token==='string'&&value.token.length>0&&validProcessIdentity(value.owner);
}
function copyProcessIdentityBinding(value) {
  return {ProcessId:value.ProcessId,Started:value.Started,Name:value.Name,commandLineSha256:value.commandLineSha256};
}
function sameProcessBinding(left,right) {
  return validProcessIdentity(left)&&validProcessIdentity(right)&&
    left.ProcessId===right.ProcessId&&left.Started===right.Started&&left.Name===right.Name&&
    left.commandLineSha256===right.commandLineSha256;
}
const reservationProofs=new WeakMap();
const invalidatedReservationProofs=new WeakSet();
// The coordinator result object is an in-process acknowledgement envelope.
// Keep its capability association private so a broken non-enumerable property
// projection cannot make a committed reservation look like an ordinary
// capacity retry.  The map is intentionally process-local and cannot survive
// JSON, a child process, or a controller restart.
const reservationAcknowledgements=new WeakMap();
function projectReservationAcknowledgement(result,key,value) {
  try {
    Object.defineProperty(result,key,{value,enumerable:false,writable:false,configurable:false});
    return true;
  } catch {
    // The private WeakMap receipt remains authoritative.  Let the runner see
    // the missing public projection as a malformed acknowledgement and use
    // that receipt for a proof-bound rollback or reconciliation record; do
    // not throw after the coordinator transaction has already committed.
    return false;
  }
}
function reservationProofError(code,message) {
  const error=new Error(message);
  error.code=code;
  return error;
}
function createReservationProof({physicalDir,id,leaseInstanceId,owner}) {
  const proof=Object.freeze({});
  reservationProofs.set(proof,{physicalDir,id,leaseInstanceId,owner:copyProcessIdentityBinding(owner)});
  return proof;
}
function reservationProofState(proof,physicalDir,id) {
  if(proof===undefined)return null;
  if(!proof||typeof proof!=='object')throw reservationProofError('ORCH_RESERVATION_PROOF_INVALID','Reservation proof is not a private same-process capability');
  const state=reservationProofs.get(proof);
  if(!state){
    if(invalidatedReservationProofs.has(proof))throw reservationProofError('ORCH_RESERVATION_PROOF_STALE','Reservation proof has already been released');
    throw reservationProofError('ORCH_RESERVATION_PROOF_INVALID','Reservation proof is not issued by this controller module');
  }
  if(state.physicalDir!==physicalDir||state.id!==id)throw reservationProofError('ORCH_RESERVATION_PROOF_SCOPE_MISMATCH','Reservation proof does not match this coordinator lease');
  if(state.owner.ProcessId!==process.pid)throw reservationProofError('ORCH_RESERVATION_PROOF_STALE','Reservation proof no longer belongs to this controller process');
  return state;
}

// The acknowledgement fields returned by `reserve()` are a convenient
// projection, not the authority for a same-controller rollback.  When an
// acknowledgement is malformed after the transaction committed, the runner
// still needs the proof-bound instance id to write a fail-closed recovery
// record.  This accessor deliberately accepts only the opaque in-process
// capability; it never serializes or extends that capability beyond its
// original coordinator/id/process scope.
export function reservationAcknowledgement(dir,id,result) {
  if(!result||typeof result!=='object')return null;
  const proof=reservationAcknowledgements.get(result);
  if(proof===undefined)return null;
  if(typeof dir!=='string'||!dir.trim()||typeof id!=='string'||!id) {
    throw reservationProofError('ORCH_RESERVATION_PROOF_INVALID','Reservation acknowledgement lookup requires a coordinator directory and lease id');
  }
  assertNoReparsePoints(dir,'coordinator directory');
  const state=reservationProofState(proof,physicalPathIdentity(dir),id);
  return Object.freeze({reservationProof:proof,leaseInstanceId:state.leaseInstanceId});
}
function invalidateReservationProof(proof) {
  if(!proof||typeof proof!=='object'||!reservationProofs.has(proof))return;
  reservationProofs.delete(proof);
  invalidatedReservationProofs.add(proof);
}
function normalizedLeaseRecord(value,physicalDir) {
  // `transaction` is an extension boundary: callers can mutate its lease
  // array directly.  Persist an explicit allowlist here instead of relying on
  // every caller to avoid attaching prompt or process-snapshot objects.
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const normalized={};
  if(typeof value.id==='string')normalized.id=value.id;
  if(typeof value.runId==='string')normalized.runId=value.runId;
  if(value.leaseInstanceId!==undefined){
    if(typeof value.leaseInstanceId!=='string'||!LEASE_INSTANCE_ID.test(value.leaseInstanceId))throw new Error('Coordinator lease contains an invalid lease instance id');
    normalized.leaseInstanceId=value.leaseInstanceId;
  }
  if(Array.isArray(value.keys))normalized.keys=publicLeaseKeys(value.keys.filter(key=>typeof key==='string'),{scopeDir:physicalDir});
  for(const field of ['owner','launcher']){
    if(value[field]===undefined)continue;
    if(!validProcessIdentity(value[field]))throw new Error('Coordinator lease contains an unsupported legacy process identity');
    normalized[field]=copyProcessIdentityBinding(value[field]);
  }
  for(const field of ['capacity','memoryCostMB','reservedAt']){
    if(Number.isFinite(value[field]))normalized[field]=value[field];
  }
  if(typeof value.pidFile==='string')normalized.pidFile=value.pidFile;
  return Object.keys(normalized).length?normalized:null;
}
function normalizedLeaseLedger(leases,physicalDir) {
  const normalized=[];
  for(const lease of leases){
    const record=normalizedLeaseRecord(lease,physicalDir);
    if(record)normalized.push(record);
  }
  return normalized;
}
function normalizedRunOwnerRecord(value) {
  if(!value||typeof value!=='object'||Array.isArray(value)||typeof value.token!=='string'||!value.token.length||!validProcessIdentity(value.owner))return null;
  return {owner:copyProcessIdentityBinding(value.owner),token:value.token};
}
function normalizedRunOwnerLedger(owners) {
  const normalized={};
  for(const [key,value] of Object.entries(owners||{})){
    const record=normalizedRunOwnerRecord(value);
    if(record)normalized[key]=record;
  }
  return normalized;
}

function coordinatorTimeoutMs() {
  const configured=Number(process.env.ORCH_COORDINATOR_TIMEOUT_MS);
  return Math.max(1000,Math.min(MAX_COORDINATOR_TIMEOUT_MS,
    Math.ceil(Number.isFinite(configured)&&configured>0?configured:DEFAULT_COORDINATOR_TIMEOUT_MS)));
}

const SNAPSHOT_CIM_GATE_NAME='Local\\CodexTuiOrchestrator.ProcessSnapshot.CimGate.v3';
const SNAPSHOT_OUTER_GRACE_MS=5000;
const SNAPSHOT_SCHEDULING_MARGIN_MS=1000;
// Dynamic-memory sampling is advisory.  Keep its work separate from identity
// and coordinator calls so an active collection of windows cannot turn its
// own periodic bookkeeping into critical-path CIM starvation.
const BACKGROUND_PROCESS_SNAPSHOT_TIMEOUT_MS=3000;
const BACKGROUND_SNAPSHOT_MUTEX_NAME='Local\\CodexTuiOrchestrator.ProcessSnapshot.Background.v1';
const BACKGROUND_SNAPSHOT_BUSY='__ORCH_BACKGROUND_SNAPSHOT_BUSY__';

function boundedProcessSnapshotTimeout(capMs) {
  return Math.max(MIN_PROCESS_SNAPSHOT_TIMEOUT_MS,Math.min(MAX_PROCESS_SNAPSHOT_TIMEOUT_MS,
    Math.ceil(Number(capMs)||DEFAULT_PROCESS_SNAPSHOT_TIMEOUT_MS)));
}
function epochMilliseconds(now) {
  const value=typeof now==='function'?now():now;
  return Number.isFinite(Number(value))?Number(value):null;
}
function suppliedDeadline(deadlineAt) {
  if(deadlineAt===undefined||deadlineAt===null)return null;
  return typeof deadlineAt==='number'&&Number.isSafeInteger(deadlineAt)?deadlineAt:null;
}
function deadlineExhausted(stage) {
  const label=typeof stage==='string'&&stage.trim()?stage.trim():'execution';
  const error=new Error('ORCH_DEADLINE_EXHAUSTED: '+label);
  error.code='ORCH_DEADLINE_EXHAUSTED';
  return error;
}

// A deadline is an absolute wall-clock timestamp shared by all coordinator
// observations. With no deadline, retain the established process-snapshot
// normalization. With one, reserve the helper outer grace and one scheduling
// window so a too-small remainder can never become a fresh default timeout.
export function processSnapshotTimeoutBefore(deadlineAt,{capMs=DEFAULT_PROCESS_SNAPSHOT_TIMEOUT_MS,now=Date.now}={}) {
  const cap=boundedProcessSnapshotTimeout(capMs);
  if(deadlineAt===undefined||deadlineAt===null)return cap;
  const deadline=suppliedDeadline(deadlineAt),current=epochMilliseconds(now);
  if(deadline===null||current===null)return null;
  const available=Math.floor(deadline-current-SNAPSHOT_OUTER_GRACE_MS-SNAPSHOT_SCHEDULING_MARGIN_MS);
  return available<MIN_PROCESS_SNAPSHOT_TIMEOUT_MS?null:Math.min(cap,available);
}

function coordinatorProcessSnapshotWaitMs(deadlineAt) {
  assertDeadlineAvailable(deadlineAt,'coordinator process snapshot');
  const configuredWaitMs=Math.max(1000,Math.min(MAX_PROCESS_SNAPSHOT_TIMEOUT_MS,
    Math.ceil(Number(process.env.ORCH_PROCESS_SNAPSHOT_TIMEOUT_MS)||DEFAULT_PROCESS_SNAPSHOT_TIMEOUT_MS)));
  const waitMs=processSnapshotTimeoutBefore(deadlineAt,{capMs:configuredWaitMs});
  if(waitMs===null)throw deadlineExhausted('coordinator process snapshot');
  return waitMs;
}

// Callers use this before a durable coordinator side effect. It deliberately
// checks the exact absolute deadline rather than inventing a replacement
// duration; snapshot-specific safety remains with processSnapshotTimeoutBefore.
export function assertDeadlineAvailable(deadlineAt,stage,{now=Date.now}={}) {
  if(deadlineAt===undefined||deadlineAt===null)return null;
  const deadline=suppliedDeadline(deadlineAt),current=epochMilliseconds(now);
  if(deadline===null||current===null||deadline<=current)throw deadlineExhausted(stage);
  return deadline;
}

// Process helper stderr is an external diagnostic surface. It may include a
// command line on a provider or WMI failure, so durable identity errors expose
// only a bounded outcome category and exit status.
export function processIdentityFailureMessage(status) {
  const outcome=status===null?'timeout or interrupted':Number.isSafeInteger(status)?'exit code '+status:'unavailable exit status';
  return 'Cannot verify process identities (PowerShell '+outcome+')';
}

// This name protects a single coordinator cache producer, not all workspaces
// on the machine. The path is deliberately hashed so the kernel namespace
// never discloses a user workspace/controller locator.
export function coordinatorSnapshotCacheMutexName(physicalDir) {
  const value=String(physicalDir??'').trim();
  if(!value)throw new Error('Coordinator snapshot cache mutex requires a physical directory identity');
  const canonical=(process.platform==='win32'?value.replaceAll('/','\\').toLowerCase():value);
  return 'Local\\CodexTuiOrchestrator.ProcessSnapshot.Cache.v2.'+
    crypto.createHash('sha256').update(canonical,'utf8').digest('hex');
}
function assertSnapshotNamedObject(value,kind) {
  const name=String(value??'');
  const cache=/^Local\\CodexTuiOrchestrator\.ProcessSnapshot\.Cache\.v2\.[a-f0-9]{64}$/;
  const gate=/^Local\\CodexTuiOrchestrator\.ProcessSnapshot\.CimGate\.v3(?:\.[A-Za-z0-9_-]{1,64})?$/;
  if((kind==='cache'?cache:gate).test(name))return name;
  throw new Error('Invalid process snapshot '+kind+' named object');
}
// A named semaphore retains its count when a killed helper cannot run its
// finally block, permanently reducing the session-wide CIM capacity. Two
// named mutex lanes retain the same maximum of two callers while Windows marks
// a killed holder as abandoned, letting the next bounded WaitAny recover the
// specific lane and release only that lane afterwards.
function cimGateMutexLanesScript(value) {
  const gateName=assertSnapshotNamedObject(value,'gate');
  const quote=item=>"'"+String(item).replaceAll("'","''")+"'";
  const first=quote(gateName+'.0'),second=quote(gateName+'.1');
  return `$cimGateLaneNames=@(${first},${second})
$cimLanes=@([Threading.Mutex]::new($false,$cimGateLaneNames[0]),[Threading.Mutex]::new($false,$cimGateLaneNames[1]))
$script:cimLane=$null;$script:cimLaneIndex=-1
function Enter-CimGate {
  if($null -ne $script:cimLane){throw 'CIM gate re-entry is not allowed'}
  $laneIndex=-1
  try{$laneIndex=[Threading.WaitHandle]::WaitAny($cimLanes,(Get-RemainingMilliseconds))}
  catch [Threading.AbandonedMutexException]{$laneIndex=$_.Exception.MutexIndex}
  if($laneIndex -eq [Threading.WaitHandle]::WaitTimeout){throw 'CIM gate timeout'}
  if($laneIndex -lt 0 -or $laneIndex -ge $cimLanes.Count){throw 'CIM gate abandoned lane index unavailable'}
  $script:cimLane=$cimLanes[$laneIndex];$script:cimLaneIndex=$laneIndex
}
function Exit-CimGate {if($null -ne $script:cimLane){try{$script:cimLane.ReleaseMutex()|Out-Null}finally{$script:cimLane=$null;$script:cimLaneIndex=-1}}}`;
}

export function processSnapshot(timeoutMs=Number(process.env.ORCH_PROCESS_SNAPSHOT_TIMEOUT_MS)||DEFAULT_PROCESS_SNAPSHOT_TIMEOUT_MS) {
  if(process.platform!=='win32')throw new Error('Visible TUI runtime currently requires Windows');
  const waitMs=Math.max(1000,Math.min(MAX_PROCESS_SNAPSHOT_TIMEOUT_MS,Math.ceil(Number(timeoutMs)||DEFAULT_PROCESS_SNAPSHOT_TIMEOUT_MS)));
  // Bound actual WMI concurrency without serializing unrelated cache reads.
  // The PowerShell operation owns the full business deadline; Node only adds
  // a short cleanup grace so a useful stage-specific failure reaches callers.
  const script=`$ErrorActionPreference='Stop';$waitMs=${waitMs};$deadline=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()+$waitMs
function Get-RemainingMilliseconds{$left=[int]($deadline-[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds());if($left -le 0){throw 'CIM operation timeout'};return $left}
${cimGateMutexLanesScript(SNAPSHOT_CIM_GATE_NAME)}
try{Enter-CimGate;try{$timeoutSec=[Math]::Max(1,[Math]::Ceiling((Get-RemainingMilliseconds)/1000.0));[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);Get-CimInstance Win32_Process -OperationTimeoutSec $timeoutSec | Select-Object ProcessId,ParentProcessId,Name,CommandLine,@{n="WorkingSet64";e={[long]$_.WorkingSetSize}},@{n="PeakWorkingSet64";e={[long]$_.PeakWorkingSetSize*1024}},@{n="Started";e={$_.CreationDate.ToUniversalTime().ToString("o")}} | ConvertTo-Json -Compress}finally{Exit-CimGate}}finally{$cimLanes|ForEach-Object {$_.Dispose()}}`;
  const result=spawnSync(trustedWindowsHelper('powershell'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',script],
    {encoding:'utf8',windowsHide:true,timeout:waitMs+SNAPSHOT_OUTER_GRACE_MS,cwd:trustedWindowsRoot(),env:controllerEnvironment()});
  if(result.status!==0)throw new Error(processIdentityFailureMessage(result.status));
  return new Map(JSON.parse(result.stdout).map(p=>[p.ProcessId,p]));
}
function backgroundProcessSnapshotScript(waitMs) {
  const quote=value=>"'"+String(value).replaceAll("'","''")+"'";
  const sampler=quote(BACKGROUND_SNAPSHOT_MUTEX_NAME);
  const first=quote(SNAPSHOT_CIM_GATE_NAME+'.0'),second=quote(SNAPSHOT_CIM_GATE_NAME+'.1');
  // A sampler first proves that both critical lanes are idle.  It then gives
  // one lane back before touching WMI, so one coordinator-critical observation
  // can always begin while a best-effort full sample is running.
  return `$ErrorActionPreference='Stop';$waitMs=${waitMs};$deadline=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()+$waitMs
function Get-RemainingMilliseconds{$left=[int]($deadline-[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds());if($left -le 0){throw 'Background CIM operation timeout'};return $left}
$sampler=$null;$cimLanes=@();$samplerHeld=$false;$firstHeld=$false;$secondHeld=$false;$busy=$false;$rows=$null;$primary=$null;$cleanup=$null
try{
  $sampler=[Threading.Mutex]::new($false,${sampler})
  $cimLanes=@([Threading.Mutex]::new($false,${first}),[Threading.Mutex]::new($false,${second}))
  try{$samplerHeld=$sampler.WaitOne(0)}catch [Threading.AbandonedMutexException]{$samplerHeld=$true}
  if(-not $samplerHeld){$busy=$true}
  if(-not $busy){try{$firstHeld=$cimLanes[0].WaitOne(0)}catch [Threading.AbandonedMutexException]{$firstHeld=$true};if(-not $firstHeld){$busy=$true}}
  if(-not $busy){try{$secondHeld=$cimLanes[1].WaitOne(0)}catch [Threading.AbandonedMutexException]{$secondHeld=$true};if(-not $secondHeld){$busy=$true}}
  if(-not $busy){
    try{$cimLanes[1].ReleaseMutex()|Out-Null}finally{$secondHeld=$false}
    $timeoutSec=[Math]::Max(1,[Math]::Ceiling((Get-RemainingMilliseconds)/1000.0))
    [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
    $rows=@(Get-CimInstance Win32_Process -OperationTimeoutSec $timeoutSec | Select-Object ProcessId,ParentProcessId,@{n="WorkingSet64";e={[long]$_.WorkingSetSize}})
  }
}catch{$primary=$_}finally{
  if($secondHeld){try{$cimLanes[1].ReleaseMutex()|Out-Null}catch{if($null -eq $cleanup){$cleanup=$_}}finally{$secondHeld=$false}}
  if($firstHeld){try{$cimLanes[0].ReleaseMutex()|Out-Null}catch{if($null -eq $cleanup){$cleanup=$_}}finally{$firstHeld=$false}}
  if($samplerHeld){try{$sampler.ReleaseMutex()|Out-Null}catch{if($null -eq $cleanup){$cleanup=$_}}finally{$samplerHeld=$false}}
  foreach($cimLane in $cimLanes){try{$cimLane.Dispose()}catch{if($null -eq $cleanup){$cleanup=$_}}}
  if($null -ne $sampler){try{$sampler.Dispose()}catch{if($null -eq $cleanup){$cleanup=$_}}}
}
if($null -ne $primary){throw $primary}
if($null -ne $cleanup){throw $cleanup}
if($busy){[Console]::Out.Write(${quote(BACKGROUND_SNAPSHOT_BUSY)})}else{ConvertTo-Json -InputObject @($rows) -Compress}`;
}
// This API is deliberately best-effort: `null` means a deliberate no-sample
// outcome (proven contention or caller cancellation). A provider/PowerShell/
// JSON failure stays an error so callers never mistake a broken observation
// for an empty process table.
export async function tryBackgroundProcessSnapshot({signal}={}) {
  if(process.platform!=='win32')return null;
  const result=await runBackgroundSnapshotHelper({
    command:trustedWindowsHelper('powershell'),
    args:['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',backgroundProcessSnapshotScript(BACKGROUND_PROCESS_SNAPSHOT_TIMEOUT_MS)],
    spawnOptions:{windowsHide:true,stdio:['ignore','pipe','ignore'],cwd:trustedWindowsRoot(),env:controllerEnvironment()},
    signal,maxOutputBytes:MAX_CONTROLLER_ARTIFACT_BYTES*2,
    timeoutMs:BACKGROUND_PROCESS_SNAPSHOT_TIMEOUT_MS+SNAPSHOT_OUTER_GRACE_MS,
  });
  if(result===null)return null;
  if(result.status!==0)throw new Error('Background process snapshot failed ('+processIdentityFailureMessage(result.status)+')');
  const stdout=String(result.stdout||'').trim();
  if(stdout===BACKGROUND_SNAPSHOT_BUSY)return null;
  let rows;
  try{rows=JSON.parse(stdout);}catch{throw new Error('Invalid background process snapshot response');}
  if(!Array.isArray(rows))throw new Error('Invalid background process snapshot response');
  const processes=new Map();
  for(const value of rows){
    if(!value||typeof value!=='object'||Array.isArray(value)||
      !Number.isSafeInteger(value.ProcessId)||value.ProcessId<0||
      !Number.isSafeInteger(value.ParentProcessId)||value.ParentProcessId<0||
      !Number.isSafeInteger(value.WorkingSet64)||value.WorkingSet64<0||
      !hasExactOwnKeys(value,['ProcessId','ParentProcessId','WorkingSet64'])||processes.has(value.ProcessId))
      throw new Error('Invalid background process snapshot response');
    processes.set(value.ProcessId,{ProcessId:value.ProcessId,ParentProcessId:value.ParentProcessId,WorkingSet64:value.WorkingSet64});
  }
  return processes;
}
// Windows PowerShell 5.1's provider and .NET file APIs otherwise apply the
// legacy path parser to the coordinator snapshot cache. Keep this conversion
// at the PowerShell boundary: Node continues to own the physical path identity,
// reparse checks, and every ledger file path in its original spelling.
export function windowsPowerShellCachePath(value) {
  const raw=String(value);
  if(/^\\\\\?\\/.test(raw)){
    if(!raw.includes('/')&&(/^\\\\\?\\[A-Za-z]:\\/.test(raw)||/^\\\\\?\\UNC\\[^\\/]+\\[^\\/]+(?:\\|$)/i.test(raw)))return raw;
    throw new Error('Windows PowerShell cache path must be an absolute local or UNC path: '+raw);
  }
  if(/^\\\\(?![.?]\\)[^\\/?]+\\[^\\/?]+(?:[\\/]|$)/.test(raw))return '\\\\?\\UNC\\'+raw.slice(2).replaceAll('/','\\');
  if(/^[A-Za-z]:[\\/]/.test(raw))return '\\\\?\\'+raw.replaceAll('/','\\');
  throw new Error('Windows PowerShell cache path must be an absolute local or UNC path: '+raw);
}
export function coordinatorProcessSnapshotScript(cacheFile,{maxBytes=MAX_CONTROLLER_ARTIFACT_BYTES,ttlMs=COORDINATOR_SNAPSHOT_CACHE_TTL_MS,caller=process.pid,waitMs=DEFAULT_PROCESS_SNAPSHOT_TIMEOUT_MS,forceFresh=false,cacheMutexName,cimGateName,deadlineAt}={}) {
  const quote=value=>"'"+String(value).replaceAll("'","''")+"'";
  const cachePath=quote(windowsPowerShellCachePath(cacheFile));
  const cacheName=assertSnapshotNamedObject(cacheMutexName??coordinatorSnapshotCacheMutexName(path.dirname(cacheFile)),'cache');
  const gateName=assertSnapshotNamedObject(cimGateName??SNAPSHOT_CIM_GATE_NAME,'gate');
  const cimGateScript=cimGateMutexLanesScript(gateName);
  // The coordinator computes an absolute deadline once. Keep the legacy
  // relative window only when callers intentionally omit it; otherwise a
  // delayed PowerShell startup must consume the caller's remaining budget,
  // never manufacture another full waitMs interval.
  const supplied=suppliedDeadline(deadlineAt);
  if(deadlineAt!==undefined&&deadlineAt!==null&&supplied===null)throw deadlineExhausted('coordinator process snapshot');
  const deadlineExpression=supplied===null
    ?'[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()+$waitMs'
    :String(supplied);
  // Legacy cache hits deliberately did not spend their relative wait window
  // before touching a validated cache. Only an explicitly supplied absolute
  // caller deadline needs a pre-cache check.
  const deadlinePreflight=supplied===null?'':'Get-RemainingMilliseconds|Out-Null';
  // The same rule applies after a CIM call: an absolute caller budget must
  // still be live before it can publish advisory state or return an answer.
  // Omitted deadlines retain the legacy relative-timeout behavior exactly.
  const deadlinePostCollection=supplied===null?'':'Get-RemainingMilliseconds|Out-Null';
  return `
$ErrorActionPreference='Stop';$OutputEncoding=[Text.UTF8Encoding]::new($false);[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$cachePath=${cachePath};$maxBytes=${maxBytes};$ttlMs=${ttlMs};$callerPid=${caller};$waitMs=${waitMs};$forceFresh=${forceFresh?'$true':'$false'};$cacheMutexName=${quote(cacheName)};$cimGateName=${quote(gateName)}
$deadline=${deadlineExpression}
$cacheMutex=[Threading.Mutex]::new($false,$cacheMutexName);$cacheHeld=$false
function Get-RemainingMilliseconds {
  $left=[long]($deadline-[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
  if($left -le 0){throw 'CIM operation timeout'}
  return [int][Math]::Min($left,[long]$waitMs)
}
${cimGateScript}
function Get-ProcessRows([int]$pidValue){
  Enter-CimGate
  try {$timeoutSec=[Math]::Max(1,[Math]::Ceiling((Get-RemainingMilliseconds)/1000.0));@(Get-CimInstance Win32_Process -Filter "ProcessId = $pidValue" -OperationTimeoutSec $timeoutSec | Select-Object ProcessId,ParentProcessId,Name,CommandLine,@{n='WorkingSet64';e={[long]$_.WorkingSetSize}},@{n='PeakWorkingSet64';e={[long]$_.PeakWorkingSetSize*1024}},@{n='Started';e={$_.CreationDate.ToUniversalTime().ToString('o')}})}
  finally {Exit-CimGate}
}
function Get-AllProcessRows {
  Enter-CimGate
  try {$observedAt=[DateTime]::UtcNow;$timeoutSec=[Math]::Max(1,[Math]::Ceiling((Get-RemainingMilliseconds)/1000.0));[pscustomobject]@{observedAt=$observedAt;processes=@(Get-CimInstance Win32_Process -OperationTimeoutSec $timeoutSec | Select-Object ProcessId,ParentProcessId,Name,CommandLine,@{n='WorkingSet64';e={[long]$_.WorkingSetSize}},@{n='PeakWorkingSet64';e={[long]$_.PeakWorkingSetSize*1024}},@{n='Started';e={$_.CreationDate.ToUniversalTime().ToString('o')}})}}
  finally {Exit-CimGate}
}
function Test-ProcessRowShape($row){
  if($null -eq $row){return $false};$pidValue=0
  if(-not [int]::TryParse([string]$row.ProcessId,[ref]$pidValue) -or $pidValue -lt 0){return $false}
  if($row.Started -isnot [string] -or $row.Name -isnot [string]){return $false}
  $parent=0L;$working=0L;$peak=0L
  if(-not [long]::TryParse([string]$row.ParentProcessId,[ref]$parent) -or -not [long]::TryParse([string]$row.WorkingSet64,[ref]$working) -or -not [long]::TryParse([string]$row.PeakWorkingSet64,[ref]$peak)){return $false}
  return $true
}
function Test-LiveProcessRow($row){
  return (Test-ProcessRowShape $row) -and ($null -ne $row.PSObject.Properties['CommandLine']) -and ($null -eq $row.CommandLine -or $row.CommandLine -is [string])
}
function Test-ExactPropertyNames($value,[string[]]$expected){
  if($null -eq $value){return $false}
  $properties=@($value.PSObject.Properties)
  if($properties.Count -ne $expected.Count){return $false}
  $seen=[System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
  foreach($property in $properties){if(-not $seen.Add([string]$property.Name)){return $false}}
  foreach($name in $expected){if(-not $seen.Contains($name)){return $false}}
  return $true
}
function Test-PersistedProcessRow($row){
  return (Test-ExactPropertyNames $row @('ProcessId','ParentProcessId','Name','WorkingSet64','PeakWorkingSet64','Started','commandLineSha256')) -and (Test-ProcessRowShape $row) -and ($null -ne $row.PSObject.Properties['commandLineSha256']) -and $row.commandLineSha256 -is [string] -and $row.commandLineSha256 -match '^[a-f0-9]{64}$'
}
function Get-CommandLineSha256($commandLine){
  $prefix=if($null -eq $commandLine){'null:'}else{'string:'}
  $bytes=[Text.UTF8Encoding]::new($false).GetBytes($prefix+[string]$commandLine)
  try{([Security.Cryptography.SHA256]::Create().ComputeHash($bytes)|ForEach-Object ToString x2)-join ''}finally{if($bytes){[Array]::Clear($bytes,0,$bytes.Length)}}
}
function To-PersistedProcessRow($row){
  [ordered]@{ProcessId=[int]$row.ProcessId;ParentProcessId=[long]$row.ParentProcessId;Name=[string]$row.Name;WorkingSet64=[long]$row.WorkingSet64;PeakWorkingSet64=[long]$row.PeakWorkingSet64;Started=[string]$row.Started;commandLineSha256=(Get-CommandLineSha256 $row.CommandLine)}
}
function Get-ObservedAt($value){
  if($value -isnot [string]){return $null}
  try{
    $parsed=[DateTime]::ParseExact($value,'o',[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
    if($parsed.ToString('o') -cne $value){return $null}
    return $parsed
  }catch{return $null}
}
function Get-CurrentProcessStarted([int]$pidValue){
  try{
    $candidate=[Diagnostics.Process]::GetProcessById($pidValue)
    try{if($candidate.HasExited){return $null};$started=$candidate.StartTime.ToUniversalTime();if($candidate.HasExited){return $null};return $started}
    finally{$candidate.Dispose()}
  }catch{return $null}
}
function Test-ObservedCacheOwner($row,$observedAt){
  if($null -eq $row -or $null -eq $observedAt -or -not (Test-PersistedProcessRow $row)){return $false}
  $started=Get-CurrentProcessStarted ([int]$row.ProcessId)
  if($null -eq $started -or $started -gt $observedAt){return $false}
  # CIM exposes creation time at microsecond precision while Process.StartTime
  # retains the final 100 ns digit. Normalize only that documented precision gap.
  $ticks=$started.Ticks-($started.Ticks % 10)
  return $row.Started -ceq ([DateTime]::new($ticks,[DateTimeKind]::Utc).ToString('o'))
}
function Test-CacheObservedBeforeCallerBirth([int]$pidValue,$observedAt){
  if($null -eq $observedAt){return $false}
  $started=Get-CurrentProcessStarted $pidValue
  return $null -ne $started -and $started -gt $observedAt
}
function Read-Cache([bool]$repair=$false) {
  # Callers may validate a bounded schema-3 cache without the producer mutex.
  # Only a lock holder may remove a malformed legacy record; a lock-free reader
  # simply rejects it and asks the repair path to re-read under the mutex.
  function Reject-Cache {
    if($repair){
      try{
        if([IO.File]::Exists($cachePath)){
          $candidate=Get-Item -LiteralPath $cachePath -Force
          if(($candidate.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0){Remove-Item -LiteralPath $cachePath -Force -ErrorAction SilentlyContinue}
        }
      }catch{}
    }
    return $null
  }
  try {
    if(-not [IO.File]::Exists($cachePath)){return $null}
    $item=Get-Item -LiteralPath $cachePath -Force
    if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.Length -le 0 -or $item.Length -gt $maxBytes){return $null}
    # A retained reader must not prevent Publish-Cache from atomically replacing
    # this file. Delete sharing leaves the reader bound to its complete old
    # handle while the producer publishes the complete replacement.
    $stream=[IO.File]::Open($cachePath,[IO.FileMode]::Open,[IO.FileAccess]::Read,([IO.FileShare]::Read -bor [IO.FileShare]::Delete))
    try{$buffer=New-Object byte[] ($maxBytes+1);$count=0;while($count -lt $buffer.Length){$read=$stream.Read($buffer,$count,$buffer.Length-$count);if($read -le 0){break};$count+=$read};if($count -gt $maxBytes){return $null};$text=[Text.UTF8Encoding]::new($false,$true).GetString($buffer,0,$count)}finally{$stream.Dispose()}
    $cache=($text | ConvertFrom-Json -ErrorAction Stop)
    if(-not (Test-ExactPropertyNames $cache @('schema','createdAt','observedAt','processes'))){return (Reject-Cache)}
    $created=[long]$cache.createdAt;$age=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()-$created
    if(($cache.schema -is [int] -or $cache.schema -is [long]) -and [int]$cache.schema -in @(1,2)){return (Reject-Cache)}
    if(($cache.schema -isnot [int] -and $cache.schema -isnot [long]) -or [int]$cache.schema -ne 3 -or $age -lt 0 -or $age -gt $ttlMs -or $cache.processes -isnot [System.Array]){return $null}
    $observedAt=Get-ObservedAt $cache.observedAt
    $createdAt=[DateTimeOffset]::FromUnixTimeMilliseconds($created).UtcDateTime
    if($null -eq $observedAt -or $observedAt -gt $createdAt.AddMilliseconds(1)){return (Reject-Cache)}
    $rows=@($cache.processes);if($rows.Count -le 0){return $null}
    foreach($row in $rows){if(-not (Test-PersistedProcessRow $row)){return (Reject-Cache)}}
    return [pscustomobject]@{observedAt=$observedAt;processes=$rows}
  } catch {return $null}
}
function Publish-Cache($snapshot){
  $observedAt=$snapshot.observedAt
  if($observedAt -isnot [DateTime]){throw 'Coordinator process snapshot has an invalid observation time.'}
  $rows=@($snapshot.processes)
  $payload=@{schema=3;createdAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();observedAt=$observedAt.ToUniversalTime().ToString('o');processes=@($rows|ForEach-Object {To-PersistedProcessRow $_})}|ConvertTo-Json -Compress -Depth 6
  $bytes=[Text.UTF8Encoding]::new($false).GetBytes($payload)
  if($bytes.Length -gt $maxBytes){throw 'Coordinator process snapshot exceeds cache safety limit.'}
  $temp=$cachePath+'.'+[Guid]::NewGuid().ToString('N')+'.tmp'
  try {
    [IO.File]::WriteAllBytes($temp,$bytes)
    if([IO.File]::Exists($cachePath)){$item=Get-Item -LiteralPath $cachePath -Force;if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'Coordinator process snapshot cache is a reparse point.'};$backup=$cachePath+'.'+[Guid]::NewGuid().ToString('N')+'.bak';[IO.File]::Replace($temp,$cachePath,$backup,$true);if([IO.File]::Exists($backup)){[IO.File]::Delete($backup)}}else{[IO.File]::Move($temp,$cachePath)}
  } finally {if([IO.File]::Exists($temp)){[IO.File]::Delete($temp)}}
}
$primaryError=$null
try {
  # Cache reads avoid CIM contention, but an explicit absolute caller budget
  # still expires before any cache activity; it cannot become a cache hit.
  ${deadlinePreflight}
  # Publish-Cache uses an atomic replacement, so a lock-free read can observe
  # only the complete previous cache or a complete newly published cache. Its
  # bounded schema/reparse/TTL validation stays fail-closed; a miss, malformed
  # value, or forced refresh is re-read and repaired only under the mutex.
  $cached=if($forceFresh){$null}else{Read-Cache $false};$fresh=$false;$observedAt=$null
  if($null -eq $cached){
    try {
      try{$cacheHeld=$cacheMutex.WaitOne((Get-RemainingMilliseconds))}catch [Threading.AbandonedMutexException]{$cacheHeld=$true}
      if(-not $cacheHeld){throw 'Process snapshot cache mutex timeout'}
      # A peer can publish a complete valid cache between the lock-free reject
      # and this acquisition. Re-read under the producer lock before deciding
      # whether this caller must enumerate and replace it.
      $cached=if($forceFresh){$null}else{Read-Cache $true}
      if($null -eq $cached){
        $snapshot=Get-AllProcessRows
        $rows=@($snapshot.processes);$observedAt=$snapshot.observedAt
        if($rows.Count -le 0){throw 'Process snapshot returned no rows.'}
        foreach($row in $rows){if(-not (Test-LiveProcessRow $row)){throw 'Process snapshot returned an invalid row.'}}
        ${deadlinePostCollection}
        Publish-Cache $snapshot;$fresh=$true
      }
    } finally {
      if($cacheHeld){try{$cacheMutex.ReleaseMutex()}finally{$cacheHeld=$false}}
    }
  }
  if(-not $fresh){
    $rows=@($cached.processes);$observedAt=$cached.observedAt
  }
  $ownerLive=$false;$needsTargetedOwnerRead=$false
  if(-not $fresh){
    $cachedOwner=@($rows | Where-Object { [int]$_.ProcessId -eq $callerPid }) | Select-Object -First 1
    # A schema-3 row is reusable only when its raw full snapshot began after
    # this still-running caller was created. A pre-birth cache cannot prove a
    # later caller, but also cannot safely become a new full observation just
    # because that caller arrived. Query only this caller below, retain the
    # advisory cache, and keep fresh=false so it authorizes no negative lease
    # evidence. A post-birth mismatch follows the same raw targeted fallback.
    if(Test-ObservedCacheOwner $cachedOwner $observedAt){
      $owner=$cachedOwner
    }elseif(Test-CacheObservedBeforeCallerBirth $callerPid $observedAt){
      $needsTargetedOwnerRead=$true
    }else{
      $needsTargetedOwnerRead=$true
    }
  }
  if($fresh -and $null -eq $owner){
    $owner=@($rows | Where-Object { [int]$_.ProcessId -eq $callerPid }) | Select-Object -First 1
    if($null -eq $owner){$needsTargetedOwnerRead=$true}
  }
  if($needsTargetedOwnerRead){
    $owner=@(Get-ProcessRows $callerPid) | Select-Object -First 1
    if($null -eq $owner -or -not (Test-LiveProcessRow $owner) -or [int]$owner.ProcessId -ne $callerPid){throw 'Coordinator owner identity unavailable'}
    $rows=@($rows | Where-Object { [int]$_.ProcessId -ne $callerPid })+@($owner)
  }
  if($null -eq $owner){throw 'Coordinator owner identity unavailable'}
  $ownerLive=$true
  ${deadlinePostCollection}
  $result=@{fresh=$fresh;processes=@($rows);owner=$owner;ownerLive=$ownerLive}
  $result|ConvertTo-Json -Compress -Depth 6
} catch {$primaryError=$_;throw} finally {
  $cleanupError=$null
  try {
    # A cache-release failure must not skip the acquired CIM lane's release.
    try {if($cacheHeld){try{$cacheMutex.ReleaseMutex()}finally{$cacheHeld=$false}}}
    finally {Exit-CimGate}
  } catch {$cleanupError=$_}
  $disposeError=$null
  try {$cacheMutex.Dispose()} catch {$disposeError=$_}
  foreach($cimLane in $cimLanes){try{$cimLane.Dispose()}catch{if($null -eq $disposeError){$disposeError=$_}}}
  # If the main observation already failed, preserve it over secondary cleanup
  # faults. With no primary error, surface the first cleanup failure only after
  # every named handle has had a disposal attempt.
  if($null -eq $primaryError){if($null -ne $cleanupError){throw $cleanupError};if($null -ne $disposeError){throw $disposeError}}
}`;
}
function coordinatorProcessSnapshot(dir,forceFresh=false,deadlineAt) {
  if(process.platform!=='win32')throw new Error('Visible TUI runtime currently requires Windows');
  const waitMs=coordinatorProcessSnapshotWaitMs(deadlineAt);
  const physicalDir=physicalPathIdentity(dir);
  const cacheFile=assertNoReparsePoints(path.join(physicalDir,'process-snapshot-cache.json'),'coordinator process snapshot cache');
  const script=coordinatorProcessSnapshotScript(cacheFile,{maxBytes:MAX_CONTROLLER_ARTIFACT_BYTES,ttlMs:COORDINATOR_SNAPSHOT_CACHE_TTL_MS,caller:process.pid,waitMs,forceFresh,cacheMutexName:coordinatorSnapshotCacheMutexName(physicalDir),deadlineAt});
  assertDeadlineAvailable(deadlineAt,'coordinator process snapshot');
  const result=spawnSync(trustedWindowsHelper('powershell'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',script],
    {encoding:'utf8',windowsHide:true,timeout:waitMs+SNAPSHOT_OUTER_GRACE_MS,maxBuffer:MAX_CONTROLLER_ARTIFACT_BYTES*2,cwd:trustedWindowsRoot(),env:controllerEnvironment()});
  if(result.status!==0)throw new Error(processIdentityFailureMessage(result.status));
  let value;try{value=JSON.parse(result.stdout);}catch(error){throw new Error('Invalid coordinator process snapshot response: '+error.message);}
  if(typeof value?.fresh!=='boolean'||value.ownerLive!==true||!Array.isArray(value.processes)||!value.owner)throw new Error('Invalid coordinator process snapshot response');
  const processes=new Map();
  for(const item of value.processes){
    const hasRawCommandLine=item&&(item.CommandLine===null||typeof item.CommandLine==='string');
    const hasBoundCommandLine=item&&!Object.hasOwn(item,'CommandLine')&&typeof item.commandLineSha256==='string'&&COMMAND_LINE_SHA256.test(item.commandLineSha256);
    if(!item||!Number.isSafeInteger(item.ProcessId)||item.ProcessId<0||typeof item.Started!=='string'||typeof item.Name!=='string'||(!hasRawCommandLine&&!hasBoundCommandLine))throw new Error('Invalid coordinator process snapshot row');
    processes.set(item.ProcessId,item);
  }
  const owner=processes.get(process.pid);
  const ownerBinding=processSnapshotIdentityBinding(owner),reportedOwnerBinding=processSnapshotIdentityBinding(value.owner);
  if(!owner||!ownerBinding||!reportedOwnerBinding||(!sameRuntimeProcess(owner,value.owner)&&!sameProcess(ownerBinding,reportedOwnerBinding)))throw new Error('Coordinator owner identity unavailable');
  return {processes,fresh:value.fresh,ownerLive:true};
}
function transactionObservation(dir,snapshot,forceFresh=false,deadlineAt) {
  assertDeadlineAvailable(deadlineAt,'coordinator process snapshot');
  if(snapshot===processSnapshot)return coordinatorProcessSnapshot(dir,forceFresh,deadlineAt);
  // Existing injected snapshot providers receive no arguments. Expose the
  // absolute budget only to the new deadline-aware path so omission retains
  // that compatibility contract exactly.
  const value=deadlineAt===undefined||deadlineAt===null
    ?snapshot()
    :snapshot({forceFresh,deadlineAt});
  if(value instanceof Map)return {processes:value,fresh:true,ownerLive:false};
  if(value&&value.processes instanceof Map&&typeof value.fresh==='boolean')return {processes:value.processes,fresh:value.fresh,ownerLive:false};
  throw new Error('Invalid process snapshot observation');
}
export function sameProcess(expected,actual) {
  // `expected` must be a persisted public-safe binding. Reject legacy raw
  // CommandLine records rather than silently accepting and perpetuating them.
  const actualHash=validRuntimeProcessIdentity(actual)?commandLineSha256(actual.CommandLine):validProcessIdentity(actual)?actual.commandLineSha256:null;
  return validProcessIdentity(expected)&&!!actualHash&&
    expected.ProcessId===actual.ProcessId&&expected.Started===actual.Started&&expected.Name===actual.Name&&
    expected.commandLineSha256===actualHash;
}
function sameRuntimeProcess(expected,actual) {
  return validRuntimeProcessIdentity(expected)&&validRuntimeProcessIdentity(actual)&&
    expected.ProcessId===actual.ProcessId&&expected.Started===actual.Started&&expected.Name===actual.Name&&expected.CommandLine===actual.CommandLine;
}
const DEFAULT_HEADLESS_WORKER=fileURLToPath(new URL('./headless-worker.mjs',import.meta.url));
function validatedHeadlessWorkerEntry(value) {
  const entry=value===undefined?DEFAULT_HEADLESS_WORKER:value;
  try {
    if(typeof entry!=='string'||!path.isAbsolute(entry))return null;
    const resolved=path.resolve(entry);
    assertNoReparsePoints(resolved,'headless worker entry');
    if(!fs.statSync(resolved).isFile())return null;
    return resolved;
  } catch { return null; }
}

export function launcherIdentity(pid,pidFile,snapshot=processSnapshot(),{workerEntry}={}) {
  const actual=snapshot.get(Number(pid));
  if(!pidFile)return null;
  const commandHasToken=(command,file)=>{
    const normalized=String(command||'').toLowerCase().replaceAll('/','\\');
    const escaped=String(file).toLowerCase().replaceAll('/','\\').replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    return new RegExp('(?:^|[\\s"\'])'+escaped+'(?=[\\s"\']|$)').test(normalized);
  };
  if(path.basename(pidFile).startsWith('exec-')){
    const expectedWorker=validatedHeadlessWorkerEntry(workerEntry);
    if(!expectedWorker)return null;
    const args=String(actual?.CommandLine||'').toLowerCase().replaceAll('/','\\');
    const contains=file=>new RegExp('(?:^|\\s)"?'+file.toLowerCase().replaceAll('/','\\').replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'"?(?=\\s|$)').test(args);
    return /^node(?:\.exe)?$/i.test(actual?.Name||'')&&contains(expectedWorker)&&contains(pidFile.replace(/\.pid$/,'.json'))?processIdentityBinding(actual):null;
  }
  const script=path.join(path.dirname(pidFile),path.basename(pidFile).replace(/^window-/,'win-launch-').replace(/\.pid$/,'.ps1'));
  if(!/^(powershell|pwsh)\.exe$/i.test(actual?.Name||'')||!commandHasToken(actual?.CommandLine,script))return null;
  return processIdentityBinding(actual);
}

export function coordinatorDir(workspace,env=process.env) {
  if(env.ORCH_COORDINATOR_DIR){
    const selected=path.resolve(workspace,env.ORCH_COORDINATOR_DIR);
    if(isCredentialShapedText(selected))throw new Error('SENSITIVE_RUN_IDENTITY: credential-shaped coordinator cannot be used in durable controller state');
    if(physicallySameOrChild(workspace,selected))throw new Error('ORCH_COORDINATOR_DIR cannot be inside the initiating workspace');
    return assertPrivateControllerRoot(selected);
  }
  const selected=path.join(controllerStateDir(workspace,env),'codex-coordinator');
  if(isCredentialShapedText(selected))throw new Error('SENSITIVE_RUN_IDENTITY: credential-shaped coordinator cannot be used in durable controller state');
  return assertPrivateControllerRoot(selected);
}
export function atomicJson(file,value,guard){
  const parent=assertNoReparsePoints(path.dirname(file),'atomic JSON parent');
  fs.mkdirSync(parent,{recursive:true});
  assertNoReparsePoints(parent,'atomic JSON parent');
  assertNoReparsePoints(file,'atomic JSON target');
  guard?.();
  if(fs.existsSync(file)&&fs.statSync(file).isDirectory()){
    const error=new Error(`EISDIR: cannot replace directory with JSON file: ${file}`);error.code='EISDIR';throw error;
  }
  const tmp=file+'.'+crypto.randomUUID()+'.tmp',deadline=performance.now()+5000;
  try {
    assertNoReparsePoints(tmp,'atomic JSON temporary');
    const fd=fs.openSync(tmp,'wx');
    try { fs.writeFileSync(fd,JSON.stringify(value,null,2));fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    guard?.();
    while(true){
      try{guard?.();assertNoReparsePoints(parent,'atomic JSON parent');assertNoReparsePoints(file,'atomic JSON target');fs.renameSync(tmp,file);return;}
      catch(error){
        const remaining=deadline-performance.now();
        if(process.platform!=='win32'||!['EPERM','EACCES','EBUSY'].includes(error.code)||remaining<=0)throw error;
        // A Windows reader or scanner may temporarily deny delete sharing.
        // Keep the original intact and retry only the atomic replacement.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,Math.min(50,remaining));
      }
    }
  }finally{fs.rmSync(tmp,{force:true});}
}
function coordinatorTransaction(dir,fn,snapshot=processSnapshot,{forceFresh=false,deadlineAt,reservationProof,expectedLeaseId,cleanupLeaseIdentity}={}) {
  assertDeadlineAvailable(deadlineAt,'coordinator transaction');
  // A default Windows observation needs its full safe minimum, outer grace,
  // and scheduling margin. Reject an insufficient absolute budget before the
  // coordinator directory exists instead of creating state and restoring a
  // fresh 120-second process snapshot window.
  if(reservationProof===undefined&&snapshot===processSnapshot)coordinatorProcessSnapshotWaitMs(deadlineAt);
  assertNoReparsePoints(dir,'coordinator directory');
  fs.mkdirSync(dir,{recursive:true});
  assertDeadlineAvailable(deadlineAt,'coordinator transaction');
  assertNoReparsePoints(dir,'coordinator directory');
  // Resolve 8.3, UNC and junction aliases after the directory exists. Every
  // contender then hashes and passes the same physical coordinator path to
  // the named mutex helper instead of maintaining separate locks for lexical
  // spellings of one leases.json.
  const physicalDir = physicalPathIdentity(dir);
  const proof=reservationProofState(reservationProof,physicalDir,expectedLeaseId);
  if(proof&&snapshot!==processSnapshot)throw reservationProofError('ORCH_RESERVATION_PROOF_SNAPSHOT_OVERRIDE','Reservation proof cannot be combined with an injected process snapshot');
  if(proof&&forceFresh)throw reservationProofError('ORCH_RESERVATION_PROOF_FRESH_OVERRIDE','Reservation proof cannot authorize a fresh process observation');
  const nativeCoordinatorLock=snapshot===processSnapshot||proof!==null;
  const lock=path.join(dir,'mutex.json'),file=path.join(dir,'leases.json');
  const ownersFile=path.join(dir,'run-owners.json');
  // Capture both ledger revisions before the snapshot/cache wait. The only
  // negative evidence that can prune entries comes from this call's fresh
  // producer; cache hits retain valid identities until a producer sees them.
  const initialRevisions=new Map([[file,ledgerRevision(file)],[ownersFile,ledgerRevision(ownersFile)]]);
  const proofObservation=proof?{processes:new Map([[proof.owner.ProcessId,proof.owner]]),fresh:false,ownerLive:true}:null;
  const {processes,fresh,ownerLive}=proofObservation??transactionObservation(physicalDir,snapshot,forceFresh,deadlineAt);
  const runtimeOwner=processes.get(process.pid);
  const owner=proof?copyProcessIdentityBinding(proof.owner):(snapshot===processSnapshot&&ownerLive?processSnapshotIdentityBinding(runtimeOwner):processIdentityBinding(runtimeOwner));
  if(!owner)throw new Error('Coordinator owner identity unavailable');
  // A snapshot can consume the remainder while it waits for CIM/cache state.
  // Do not let a formerly valid deadline authorize a callback, ticket helper,
  // or ledger transition after the observation has returned.
  assertDeadlineAvailable(deadlineAt,'coordinator transaction observation');
  // A kernel mutex is released by Windows on a crash. Unlike a stale lockfile,
  // it cannot be reclaimed by two contenders or strand an empty lock forever.
  let unlock=()=>({ok:true});
  if(nativeCoordinatorLock) {
    // 票据放在系统临时目录（短路径）而不是协调器目录：协调器目录可能超过 260 字符或带尾随点，
    // Windows PowerShell 在那种路径上写不了 .ready —— 实测会白等 21 秒再以 "Coordinator mutex
    // acquisition failed" 收场，调用方拿不到真因。票据是一次性握手文件，本身也不属于运行产物。
     const ticketDir=path.join(os.tmpdir(),'codex-tui-orchestrator-locks',
       crypto.createHash('sha256').update(physicalDir.toLowerCase()).digest('hex').slice(0,16));
    assertNoReparsePoints(ticketDir,'coordinator ticket directory');
    // TEMP/TMP are caller-controlled. The nonce handshake is authority-bearing
    // until its verified release receipt, so refuse a shared ticket root before
    // creating any marker a different Windows principal could replace.
    try{assertPrivateWindowsRoot(ticketDir,{powershell:trustedWindowsHelper('powershell')});}
    catch{
      const error=new Error('CONTROLLER_TICKET_ROOT_UNSAFE_ACL: coordinator ticket storage must be a local directory writable only by the current Windows user, SYSTEM, and Administrators');
      error.code='CONTROLLER_TICKET_ROOT_UNSAFE_ACL';
      throw error;
    }
    assertDeadlineAvailable(deadlineAt,'coordinator ticket preparation');
    fs.mkdirSync(ticketDir,{recursive:true});
    assertNoReparsePoints(ticketDir,'coordinator ticket directory after creation');
    const ticket=path.join(ticketDir,'lock-'+crypto.randomUUID());
     for(const suffix of ['.ready','.release','.released','.ack']){try{const marker=ticket+suffix;assertNoReparsePoints(marker,'coordinator ticket marker');fs.rmSync(marker,{force:true});}catch(error){throw new Error('Coordinator ticket preparation failed: '+error.message);}}
    // The distributed script is intentionally unsigned. Explicitly bypass the
    // user's RemoteSigned policy for this bounded, plugin-owned helper; without
    // it Windows rejects the file before it can publish the ready handshake.
    const helperSpawnedAt=Date.now();
    const localReadyDeadlineAt=helperSpawnedAt+coordinatorTimeoutMs();
    const readyDeadlineAt=deadlineAt===undefined||deadlineAt===null
      ?localReadyDeadlineAt
      :Math.min(deadlineAt,localReadyDeadlineAt);
    const lockWaitMs=readyDeadlineAt-helperSpawnedAt;
    const nonce=crypto.randomBytes(32).toString('base64url');
    assertDeadlineAvailable(deadlineAt,'coordinator helper spawn');
    if(lockWaitMs<=0)throw deadlineExhausted('coordinator helper spawn');
     const child=spawn(trustedWindowsHelper('powershell'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('./lease-lock.ps1',import.meta.url)),'-Directory',physicalDir,'-Ticket',ticket,'-Nonce',nonce,'-Owner',String(owner.ProcessId),'-Started',owner.Started,'-WaitMs',String(lockWaitMs),'-ReadyDeadlineAt',String(readyDeadlineAt),'-ReceiptAckWaitMs',String(COORDINATOR_RELEASE_ACK_TIMEOUT_MS)],{windowsHide:true,stdio:'ignore',cwd:trustedWindowsRoot(),env:controllerEnvironment()});
    child.on('error',()=>{});child.unref();
    // The helper has its own bounded mutex wait.  A later caller deadline must
    // not leave Node polling for a helper that has already stopped waiting;
    // an earlier caller deadline remains authoritative for timeout reporting.
    let ready=false;
    while(true){
      // Verify the nonce-bound marker before examining the clock. A marker that
      // arrived at the boundary owns a real helper mutex and must enter the
      // release-protected finally path below, rather than being abandoned.
      ready=coordinatorNonceMarkerMatches(ticket,nonce,{suffix:'.ready',prefix:'ready',label:'coordinator ready marker'});
      if(ready)break;
      const remaining=readyDeadlineAt-Date.now();
      if(remaining<=0)break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,Math.min(25,remaining));
    }
    unlock=()=>{
      try{
        coordinatorMarkerWrite(ticket,nonce,{suffix:'.release',prefix:'release',label:'coordinator release signal',matches:coordinatorReleaseSignalMatches,code:'ORCH_COORDINATOR_RELEASE_SIGNAL_FAILED'});
      }catch(error){return {ok:false,error};}
      // Atomics.wait blocks this Node thread, so child.exitCode cannot be
      // updated by libuv until after this synchronous transaction returns.
      // The helper publishes its nonce-bound receipt strictly after
      // ReleaseMutex. A late helper owns cleanup; Node must not delete a
      // receipt that it did not successfully verify.
      if(!waitForCoordinatorReleaseAcknowledgement(ticket,nonce)){
        return {ok:false,error:coordinatorReleaseIssue('ORCH_COORDINATOR_RELEASE_ACK_TIMEOUT','the helper did not publish a verified post-release receipt before the bounded acknowledgement deadline')};
      }
      try{
        // The helper retains cleanup ownership. Link the verified receipt
        // instead of creating a new ack marker, so a helper that already
        // cleaned a late receipt cannot be followed by an orphaned `.ack`.
        coordinatorReceiptAcknowledgement(ticket,nonce);
      }catch(error){return {ok:false,error};}
      return {ok:true};
    };
    if(!ready){
      // A missing ready nonce means Node never established this attempt's
      // handshake. Do not create `.release`: the helper may already have
      // exited, and only a helper that accepted a real release cleans it.
      // A caller-owned absolute deadline is a typed execution timeout even if
      // it expired before the helper completed its nonce-bound handshake.
      // With no caller deadline, or when only the helper-local window ended,
      // retain the acquisition diagnosis below.
      assertDeadlineAvailable(deadlineAt,'coordinator mutex ready handshake');
      const error=new Error('Coordinator mutex acquisition failed (dir='+dir+'，ticket='+ticket+'；'+
        'helper did not publish a ready nonce；'+
        '常见原因：协调器目录不可写、Windows PowerShell 不可用，或同名互斥锁被其它协调器长期持有');
      error.code='ORCH_COORDINATOR_MUTEX_ACQUISITION_FAILED';
      throw error;
    }
  }
  let committed=false,primaryFailure=null;
  try {
    // This sits inside the helper-owning try/finally. A ready handshake can
    // consume the final budget; reject the expired operation before any ledger
    // read/normalization or callback side effect, while still releasing the
    // mutex and completing its receipt handoff below.
    assertDeadlineAvailable(deadlineAt,'coordinator transaction execution');
    const observation={processes,fresh,changed(target){
      const before=initialRevisions.get(target)??'unknown',after=ledgerRevision(target);
      return before==='unknown'||after==='unknown'||before!==after;
    }};
    const leasesChanged=observation.changed(file);
    const rawLeases=readState(file,Array.isArray,'协调器租约表 '+file)||[];
    // Validate the exact durable row before general malformed-row filtering or
    // duplicate repair. A same-process proof may only mutate its own current
    // instance; silently filtering a corrupt proof row would turn corruption
    // into an idempotent release, while duplicate compaction could erase a
    // later instance with the same id.
    if(proof){
      const candidates=rawLeases.filter(lease=>lease&&typeof lease==='object'&&!Array.isArray(lease)&&lease.id===proof.id);
      if(candidates.length>1)throw reservationProofError('ORCH_RESERVATION_PROOF_STALE','Reservation proof matches multiple durable lease rows');
      if(candidates.length===1){
        const current=candidates[0];
        if(!validLeaseRecord(current)||!LEASE_INSTANCE_ID.test(current.leaseInstanceId||'')||
          current.leaseInstanceId!==proof.leaseInstanceId||!sameProcessBinding(current.owner,proof.owner))
          throw reservationProofError('ORCH_RESERVATION_PROOF_STALE','Reservation proof no longer matches the durable lease instance');
      }
    }
    // Post-exit cleanup does not have the private same-process proof, but it
    // still carries the durable run and lease-instance identity recorded when
    // the reservation was created. Validate that identity against the raw
    // ledger before filtering malformed rows or compacting duplicate ids. A
    // later reservation can reuse an id, and ordinary repair would otherwise
    // make a duplicate or malformed target appear absent and turn an unsafe
    // cleanup into an idempotent release.
    if(cleanupLeaseIdentity){
      const candidates=rawLeases.filter(lease=>lease&&typeof lease==='object'&&!Array.isArray(lease)&&lease.id===cleanupLeaseIdentity.id);
      if(candidates.length>1)
        throw reservationProofError('ORCH_CLEANUP_LEASE_AMBIGUOUS','Post-exit cleanup lease identity is ambiguous');
      if(candidates.length===1){
        const current=candidates[0];
        if(!validLeaseRecord(current)||current.runId!==cleanupLeaseIdentity.runId||current.leaseInstanceId!==cleanupLeaseIdentity.leaseInstanceId)
          throw reservationProofError('ORCH_CLEANUP_LEASE_MISMATCH','Post-exit cleanup lease belongs to a newer, different, or malformed run');
      }
    }
    let leases=rawLeases;
    leases=leases.filter(l=>{
      // 畸形/外来条目绝不能毒死协调器：非对象直接剪掉；没有 owner 的条目按"新鲜度"兜底
      // （90s 内当作可能正在写入而保留，过后自愈剪掉），绝不在这里解引用 undefined。
      // 回归：test/lease-poison.test.mjs（修前这里是裸 TypeError，160 次并发事务实测 159 次死在这）。
      if(!l||typeof l!=='object')return false;
      // Legacy entries persist a raw command line. Do not adopt, retain, or
      // rewrite them: they cannot safely authorize recovery after this update.
      if((l.owner!==undefined&&!validProcessIdentity(l.owner))||(l.launcher!==undefined&&!validProcessIdentity(l.launcher)))return false;
      if(l.launcher&&sameProcess(l.launcher,processes.get(l.launcher.ProcessId)))return true;
      if(!fresh&&validLeaseRecord(l))return true;
      if(fresh&&leasesChanged&&validLeaseRecord(l))return true;
      if(fresh&&l.pidFile){let pid=0;try{pid=Number((readUtf8Bounded(l.pidFile,'lease pid',128)||'').replace(/^\uFEFF/,''));}catch{};const found=launcherIdentity(pid,l.pidFile,processes);if(found){l.launcher=found;return true;}}
      if(!l.owner)return Date.now()-(l.reservedAt||0)<90000;
      return sameProcess(l.owner,processes.get(l.owner.ProcessId))||Date.now()-(l.reservedAt||0)<90000;
    });
    // Normalize legacy rows before any conflict/admission callback.  A raw
    // historic key and a newly projected key must compare in the same public
    // namespace; otherwise an upgrade could accidentally allow overlap.
    for(const lease of leases)if(lease&&typeof lease==='object'&&Array.isArray(lease.keys))lease.keys=publicLeaseKeys(lease.keys,{scopeDir:physicalDir});
    // 重复 id 只可能是外部写坏/被篡改（reserve 自己写不进重复项）：不收敛的话容量会被重复计数，
    // 同 id 的块会被"existing reservation"永久挡在门外。保留 reservedAt 最新的那条。
    const indexById=new Map(),unique=[];
    for(const lease of leases){
      const id=lease.id;
      if(typeof id!=='string'||!id){unique.push(lease);continue;}
      const index=indexById.get(id);
      if(index===undefined){indexById.set(id,unique.length);unique.push(lease);continue;}
      if((Number(lease.reservedAt)||0)>(Number(unique[index].reservedAt)||0))unique[index]=lease;
    }
    if(unique.length!==leases.length)console.warn('[orchestrator] 协调器租约表含重复 id（'+leases.length+' -> '+unique.length+' 条）；已收敛为最新记录，避免容量重复计数');
    leases=unique;
    assertDeadlineAvailable(deadlineAt,'coordinator transaction callback');
    const result=fn(leases,owner,processes,observation,physicalDir);
    assertDeadlineAvailable(deadlineAt,'coordinator lease ledger commit');
    atomicJson(file,normalizedLeaseLedger(leases,physicalDir),()=>assertDeadlineAvailable(deadlineAt,'coordinator lease ledger commit'));
    committed=true;
    return result;
  }catch(error){
    primaryFailure=error;
    throw error;
  }finally{
    const outcome=unlock();
    if(!outcome.ok){
      // The callback and atomic ledger replacement already completed. Throwing
      // here would make callers retry a state transition that may be durable.
      // Preserve the public return value and emit a typed, observable warning.
      if(committed)committedCoordinatorReleaseWarning(outcome.error);
      // If the transaction itself failed, keep that primary error intact but
      // do not conceal a release-protocol fault that operators must reconcile.
      else if(primaryFailure)incompleteCoordinatorReleaseWarning(outcome.error);
      else throw outcome.error;
    }
  }
}
export function transaction(dir,fn,snapshot=processSnapshot,options={}) {
  const {reservationProof,expectedLeaseId,cleanupLeaseIdentity,...publicOptions}=options;
  if(reservationProof!==undefined||expectedLeaseId!==undefined||cleanupLeaseIdentity!==undefined)
    throw reservationProofError('ORCH_RESERVATION_PROOF_INVALID','Private lease lifecycle options are only valid for internal coordinator operations');
  return coordinatorTransaction(dir,fn,snapshot,publicOptions);
}
export function reserve(dir,rec,capacity,snapshot,memoryAdmission,{keyCwd=process.cwd(),deadlineAt}={}) {
  if(typeof rec?.id!=='string'||!rec.id.trim())throw new Error('Coordinator reservation id must be a non-empty string');
  const defaultSnapshot=snapshot===undefined||snapshot===processSnapshot;
  let proofState=null;
  const result=transaction(dir,(leases,owner,processes,observation,physicalDir)=>{
    const publicRecord={...rec,keys:publicLeaseKeys(rec?.keys,{scopeDir:physicalDir,cwd:keyCwd})};
    if(leases.some(l=>l.id===publicRecord.id))return {ok:false,reason:'existing reservation'};
    const limit=Math.min(capacity,...leases.map(l=>l.capacity||capacity));
    if(leases.length>=limit)return {ok:false,reason:'capacity'};
    if(leases.some(l=>keysOverlap(l.keys,publicRecord.keys)))return {ok:false,reason:'conflict'};
    if(memoryAdmission&&!memoryAdmission(leases,publicRecord,observation.fresh?processes:new Map()))return {ok:false,reason:'memory'};
    const {owner:_ignoredOwner,launcher:requestedLauncher,leaseInstanceId:_callerLeaseInstanceId,reservationProof:_callerReservationProof,...rest}=publicRecord;
    const launcher=requestedLauncher===undefined?undefined:(validProcessIdentity(requestedLauncher)?requestedLauncher:processIdentityBinding(requestedLauncher));
    if(requestedLauncher!==undefined&&!launcher)throw new Error('Invalid launcher process identity');
    const leaseInstanceId=crypto.randomUUID();
    leases.push({...rest,...(launcher?{launcher}:{}),owner,leaseInstanceId,capacity,reservedAt:Date.now()});
    proofState={physicalDir,id:publicRecord.id,leaseInstanceId,owner};
    return {ok:true};
  },snapshot,{deadlineAt});
  if(result?.ok&&defaultSnapshot&&proofState){
    const reservationProof=createReservationProof(proofState);
    reservationAcknowledgements.set(result,reservationProof);
    projectReservationAcknowledgement(result,'reservationProof',reservationProof);
  }
  // The same durable instance id is needed by a later controller to release a
  // post-exit cleanup journal safely.  Keep the compatibility return shape
  // unchanged for ordinary callers: this is deliberately non-enumerable, like
  // the in-process reservation proof above.
  if(result?.ok&&proofState)projectReservationAcknowledgement(result,'leaseInstanceId',proofState.leaseInstanceId);
  return result;
}
export function bind(dir,id,launcher,snapshot=processSnapshot,{deadlineAt,reservationProof}={}){return coordinatorTransaction(dir,leases=>{const l=leases.find(l=>l.id===id);if(!l)throw new Error('Reservation expired');const binding=validProcessIdentity(launcher)?launcher:processIdentityBinding(launcher);if(!binding)throw new Error('Invalid launcher process identity');l.launcher=binding;},snapshot,{deadlineAt,reservationProof,expectedLeaseId:id});}
export function release(dir,id,snapshot=processSnapshot,{deadlineAt,reservationProof}={}){
  const result=coordinatorTransaction(dir,leases=>{const index=leases.findIndex(l=>l.id===id);if(index>=0)leases.splice(index,1);},snapshot,{deadlineAt,reservationProof,expectedLeaseId:id});
  if(reservationProof!==undefined)invalidateReservationProof(reservationProof);
  return result;
}

// Recovery has no access to the private same-process reservation capability.
// Refuse to remove a row merely because its reusable public id matches: a
// former controller's cleanup journal must never delete a newer reservation.
// A missing row is idempotent success because a crash can occur after the
// lease mutation and before the cleanup journal advances its phase.
export function releaseMatchingLease(dir,{id,runId,leaseInstanceId},snapshot=processSnapshot,{deadlineAt}={}){
  if(typeof id!=='string'||!id||typeof runId!=='string'||!runId||typeof leaseInstanceId!=='string'||!LEASE_INSTANCE_ID.test(leaseInstanceId))
    throw new Error('Invalid post-exit cleanup lease identity');
  return coordinatorTransaction(dir,leases=>{
    const matches=leases.filter(lease=>lease&&typeof lease==='object'&&lease.id===id);
    if(!matches.length)return {released:false};
    if(matches.length!==1)throw reservationProofError('ORCH_CLEANUP_LEASE_AMBIGUOUS','Post-exit cleanup lease identity is ambiguous');
    const lease=matches[0];
    if(lease.runId!==runId||lease.leaseInstanceId!==leaseInstanceId)
      throw reservationProofError('ORCH_CLEANUP_LEASE_MISMATCH','Post-exit cleanup lease belongs to a newer or different run');
    leases.splice(leases.indexOf(lease),1);
    return {released:true};
  },snapshot,{deadlineAt,cleanupLeaseIdentity:{id,runId,leaseInstanceId}});
}

export function prepare(dir,id,pidFile,snapshot=processSnapshot,{deadlineAt,reservationProof}={}){return coordinatorTransaction(dir,leases=>{const l=leases.find(l=>l.id===id);if(!l)throw new Error("Reservation expired");l.pidFile=pidFile;},snapshot,{deadlineAt,reservationProof,expectedLeaseId:id});}

const FRESH_RUN_OWNER_RECHECK=Symbol('fresh-run-owner-recheck');
export function claimRun(dir,key,snapshot=processSnapshot,{deadlineAt}={}) {
  const attempt=forceFresh=>transaction(dir,(_leases,owner,processes,observation)=>{
    const file=path.join(dir,'run-owners.json');
    const owners=readState(file,value=>!!value&&typeof value==='object'&&!Array.isArray(value),'运行占用账本 '+file)||{};
    const ownersChanged=observation.changed(file);
    for(const [id,r] of Object.entries(owners)){
      // 条目本身被写坏（不是对象/没有 owner）时直接剪掉，绝不解引用 undefined。
      if(!r||typeof r!=='object'||!r.owner||typeof r.owner!=='object'){delete owners[id];continue;}
      if(!sameProcess(r.owner,processes.get(r.owner.ProcessId))&&!(validRunOwner(r)&&(!observation.fresh||ownersChanged)))delete owners[id];
    }
    const incumbent=owners[key];
    if(incumbent){
      // A cache hit is advisory: a dead controller may still be listed until a
      // complete process snapshot proves otherwise. A positive cached row can
      // be stale after a controller crash and PID reuse too, so every valid
      // same-key advisory collision gets exactly one fresh recheck. Changed
      // ledgers, failed/indeterminate fresh observations, and a confirmed
      // live owner stay fail-closed.
      if(!observation.fresh&&!forceFresh&&validRunOwner(incumbent))return FRESH_RUN_OWNER_RECHECK;
      throw new Error('Run already has a live controller');
    }
    const claim={owner:copyProcessIdentityBinding(owner),token:crypto.randomUUID()};
    owners[key]=claim;
    assertDeadlineAvailable(deadlineAt,'coordinator run-owner ledger commit');
    atomicJson(file,normalizedRunOwnerLedger(owners),()=>assertDeadlineAvailable(deadlineAt,'coordinator run-owner ledger commit'));
    return claim;
  },snapshot,{forceFresh,deadlineAt});
  const initial=attempt(false);
  return initial===FRESH_RUN_OWNER_RECHECK?attempt(true):initial;
}
export function releaseRun(dir,key,claim,snapshotOrOptions=processSnapshot,options={}) {
  const suppliedOptions=typeof snapshotOrOptions==='function'?options:(snapshotOrOptions||{});
  const snapshot=typeof snapshotOrOptions==='function'?snapshotOrOptions:processSnapshot;
  const deadlineAt=suppliedOptions.deadlineAt;
  return transaction(dir,(_leases,_owner,processes)=>{
    // 释放必须幂等：runWindows 的 finally 调它，账本被删/被写坏时抛错会把"已经跑完的一轮"改判成失败。
    const file=path.join(dir,'run-owners.json');
    const owners=readState(file,value=>!!value&&typeof value==='object'&&!Array.isArray(value),'运行占用账本 '+file,{broken:'empty'})||{};
    // token 只用于区分同一进程的不同占用；任务子进程可以读到 token，
    // 所以释放还必须绑定当前进程的 PID、启动时间、名称和命令行摘要。
    // A coordinator cache row also carries process telemetry fields. Project it
    // to the exact durable binding before comparison; otherwise a valid cached
    // owner is mistaken for an untrusted, differently-shaped identity and its
    // matching claim can never be released.
    const current=processSnapshotIdentityBinding(processes.get(process.pid)),entry=owners[key];
    if(!claim?.token||!sameProcess(claim.owner,current)||entry?.token!==claim.token||!sameProcess(entry.owner,current))return;
    delete owners[key];
    assertDeadlineAvailable(deadlineAt,'coordinator run-owner ledger commit');
    atomicJson(file,normalizedRunOwnerLedger(owners),()=>assertDeadlineAvailable(deadlineAt,'coordinator run-owner ledger commit'));
  },snapshot,{deadlineAt});
}
