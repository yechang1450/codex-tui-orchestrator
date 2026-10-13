import {testTempFamily} from './test-temp-root.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {preflightResumeLedger,runDirectory,runWindows} from '../scripts/core/runner.mjs';
import {validateRecoverySummary} from '../scripts/core/recovery.mjs';

const family=testTempFamily('launcher-preparation-ledger');
fs.mkdirSync(family,{recursive:true});
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function readJson(file){return JSON.parse(fs.readFileSync(file,'utf8'));}

// `reserve` deliberately keeps both of these fields non-enumerable.  This
// narrow test-side interception happens after the real coordinator transaction
// committed its valid lease, but before the runner consumes the response.  It
// models a malformed coordinator acknowledgement which still carries a valid
// private proof and UUID, then makes that proof stale by replacing only the
// durable lease instance.  Production never sees this hook.
function injectMalformedReserveAcknowledgement({coordinator,runId}){
 const nativeDefineProperty=Object.defineProperty;
 const state={injected:false,returnedInstance:null,foreignInstance:null};
 Object.defineProperty=function(target,key,descriptor){
  const isReserveInstance=key==='leaseInstanceId'&&target?.ok===true&&
   Object.prototype.hasOwnProperty.call(target,'reservationProof')&&
   typeof descriptor?.value==='string'&&UUID.test(descriptor.value);
  if(!isReserveInstance)return nativeDefineProperty(target,key,descriptor);
  try{
   const leaseFile=path.join(coordinator,'leases.json');
   const leases=readJson(leaseFile);
   const rows=leases.filter(row=>row?.runId===runId);
   if(rows.length!==1)throw new Error('fixture could not find the just-reserved lease');
   state.returnedInstance=descriptor.value;
   state.foreignInstance=crypto.randomUUID();
   rows[0].leaseInstanceId=state.foreignInstance;
   fs.writeFileSync(leaseFile,JSON.stringify(leases),'utf8');
   delete target.ok;
   state.injected=true;
   return nativeDefineProperty(target,key,descriptor);
  }finally{
   Object.defineProperty=nativeDefineProperty;
  }
 };
 return {state,restore:()=>{Object.defineProperty=nativeDefineProperty;}};
}

// This is intentionally narrower than a fake coordinator.  Let the real
// reserve transaction commit first, then suppress only its two non-enumerable
// acknowledgement capabilities.  The response remains `{ok:true}`, which is
// the dangerous shape: it looks successful to an old caller but has no safe
// same-controller rollback authority or durable instance binding.
function injectProoflessReserveAcknowledgement({coordinator,runId}){
 const nativeDefineProperty=Object.defineProperty;
 const state={omitted:[],injected:false,target:null,committedLease:null};
 Object.defineProperty=function(target,key,descriptor){
  const first=state.target===null&&key==='reservationProof'&&target?.ok===true&&
   descriptor?.value&&typeof descriptor.value==='object';
  const second=state.target===target&&key==='leaseInstanceId'&&target?.ok===true&&
   typeof descriptor?.value==='string'&&UUID.test(descriptor.value);
  if(!first&&!second)return nativeDefineProperty(target,key,descriptor);
  try{
   const leaseFile=path.join(coordinator,'leases.json');
   const rows=readJson(leaseFile).filter(row=>row?.runId===runId);
   if(rows.length!==1)throw new Error('fixture could not find the just-committed reservation');
   if(typeof rows[0].id!=='string'||!UUID.test(rows[0].leaseInstanceId))
    throw new Error('fixture found an invalid committed lease');
   state.target=target;
   state.committedLease={id:rows[0].id,runId:rows[0].runId,leaseInstanceId:rows[0].leaseInstanceId};
   state.omitted.push(key);
   if(second){
    state.injected=true;
    Object.defineProperty=nativeDefineProperty;
   }
   return target;
  }catch(error){
   Object.defineProperty=nativeDefineProperty;
   throw error;
  }
 };
 return {state,restore:()=>{Object.defineProperty=nativeDefineProperty;}};
}

// Model the worst acknowledgement boundary: the coordinator commits its row,
// then a damaged response loses *every* observable acknowledgement field. The
// real private proof remains module-local, while the durable row is replaced
// with a different instance before the runner can consume it. A safe runner
// must recover the original private identity through its own same-process
// acknowledgement capability, retain that identity for reconciliation, and
// never retry the reusable public id.
function injectFullyEmptyReserveAcknowledgement({coordinator,runId}){
 const nativeDefineProperty=Object.defineProperty;
 const state={injected:false,omitted:[],target:null,originalLease:null,foreignLease:null};
 Object.defineProperty=function(target,key,descriptor){
  const first=state.target===null&&key==='reservationProof'&&target?.ok===true&&
   descriptor?.value&&typeof descriptor.value==='object';
  const second=state.target===target&&key==='leaseInstanceId'&&target?.ok===true&&
   typeof descriptor?.value==='string'&&UUID.test(descriptor.value);
  if(!first&&!second)return nativeDefineProperty(target,key,descriptor);
  try{
   const leaseFile=path.join(coordinator,'leases.json');
   const leases=readJson(leaseFile),rows=leases.filter(row=>row?.runId===runId);
   if(rows.length!==1)throw new Error('fixture could not find the just-committed reservation');
   if(typeof rows[0].id!=='string'||!UUID.test(rows[0].leaseInstanceId))
    throw new Error('fixture found an invalid committed lease');
   state.target=target;
   state.originalLease={id:rows[0].id,runId:rows[0].runId,leaseInstanceId:rows[0].leaseInstanceId};
   state.omitted.push(key);
   if(second){
    state.foreignLease={...state.originalLease,leaseInstanceId:crypto.randomUUID()};
    rows[0].leaseInstanceId=state.foreignLease.leaseInstanceId;
    fs.writeFileSync(leaseFile,JSON.stringify(leases),'utf8');
    delete target.ok;
    state.injected=true;
    Object.defineProperty=nativeDefineProperty;
   }
   return target;
  }catch(error){
   Object.defineProperty=nativeDefineProperty;
   throw error;
  }
 };
 return {state,restore:()=>{Object.defineProperty=nativeDefineProperty;}};
}

// A public acknowledgement projection can also fail during property access.
// The private result-object association must remain available even when the
// advertised proof getter is hostile or damaged. Replace the durable row
// before the getter is installed so a proof-authorized rollback is forced to
// fail closed rather than silently releasing a newer instance.
function injectThrowingReserveProofProjection({coordinator,runId}){
 const nativeDefineProperty=Object.defineProperty;
 const state={injected:false,getterReads:0,target:null,originalLease:null,foreignLease:null};
 Object.defineProperty=function(target,key,descriptor){
  const first=state.target===null&&key==='reservationProof'&&target?.ok===true&&
   descriptor?.value&&typeof descriptor.value==='object';
  const second=state.target===target&&key==='leaseInstanceId'&&target?.ok===true&&
   typeof descriptor?.value==='string'&&UUID.test(descriptor.value);
  if(!first&&!second)return nativeDefineProperty(target,key,descriptor);
  try{
   if(first){
    const leaseFile=path.join(coordinator,'leases.json');
    const leases=readJson(leaseFile),rows=leases.filter(row=>row?.runId===runId);
    if(rows.length!==1)throw new Error('fixture could not find the just-committed reservation');
    if(typeof rows[0].id!=='string'||!UUID.test(rows[0].leaseInstanceId))
     throw new Error('fixture found an invalid committed lease');
    state.target=target;
    state.originalLease={id:rows[0].id,runId:rows[0].runId,leaseInstanceId:rows[0].leaseInstanceId};
    state.foreignLease={...state.originalLease,leaseInstanceId:crypto.randomUUID()};
    rows[0].leaseInstanceId=state.foreignLease.leaseInstanceId;
    fs.writeFileSync(leaseFile,JSON.stringify(leases),'utf8');
    return nativeDefineProperty(target,key,{get(){state.getterReads++;throw new Error('injected reservation proof projection failure');},enumerable:false,configurable:false});
   }
   state.injected=true;
   Object.defineProperty=nativeDefineProperty;
   return nativeDefineProperty(target,key,descriptor);
  }catch(error){
   Object.defineProperty=nativeDefineProperty;
   throw error;
  }
 };
 return {state,restore:()=>{Object.defineProperty=nativeDefineProperty;}};
}

// `reserve()` commits the lease before it projects the private proof and UUID
// onto its compatibility result object.  Throw from the projection itself so
// this is neither a fake coordinator nor a property-read failure: the runner
// must still recover the module-private acknowledgement and release exactly
// the reservation it owns.
function injectThrowingReserveDefineProperty({coordinator,runId,projection='reservationProof'}){
 const nativeDefineProperty=Object.defineProperty;
 const state={injected:false,projection,committedLease:null,target:null};
 Object.defineProperty=function(target,key,descriptor){
  const proofProjection=projection==='reservationProof'&&key==='reservationProof'&&target?.ok===true&&
   descriptor?.value&&typeof descriptor.value==='object';
  const instanceProjection=projection==='leaseInstanceId'&&key==='leaseInstanceId'&&target?.ok===true&&
   Object.prototype.hasOwnProperty.call(target,'reservationProof')&&typeof descriptor?.value==='string'&&UUID.test(descriptor.value);
  if(!proofProjection&&!instanceProjection)return nativeDefineProperty(target,key,descriptor);
  try{
   const rows=readJson(path.join(coordinator,'leases.json')).filter(row=>row?.runId===runId);
   if(rows.length!==1)throw new Error('fixture could not find the just-committed reservation');
   if(typeof rows[0].id!=='string'||!UUID.test(rows[0].leaseInstanceId))
    throw new Error('fixture found an invalid committed lease');
   state.target=target;
   state.committedLease={id:rows[0].id,runId:rows[0].runId,leaseInstanceId:rows[0].leaseInstanceId};
   state.injected=true;
   throw new Error('injected Object.defineProperty reservation acknowledgement projection failure');
  }finally{
   // Keep the fault to the acknowledgement boundary. Later summary/ledger
   // writes use the native operation and expose only the reserve failure.
   Object.defineProperty=nativeDefineProperty;
  }
 };
 return {state,restore:()=>{Object.defineProperty=nativeDefineProperty;}};
}

// The real reserve transaction has already committed when it projects its
// private acknowledgement. Replace the coordinator path with a reparse point
// at that boundary so reservationAcknowledgement() itself rejects the path.
// The runner must treat that lookup error as a malformed acknowledgement,
// never as a usable acknowledgement or a normal capacity retry.
function injectCoordinatorReparseBeforeAcknowledgement({coordinator,runId}){
 const nativeDefineProperty=Object.defineProperty;
 const moved=coordinator+'-original',redirect=coordinator+'-redirect';
 const state={injected:false,target:null,originalLease:null,moved,redirect};
 Object.defineProperty=function(target,key,descriptor){
  const first=key==='reservationProof'&&target?.ok===true&&descriptor?.value&&typeof descriptor.value==='object';
  const second=state.target===target&&key==='leaseInstanceId'&&typeof descriptor?.value==='string'&&UUID.test(descriptor.value);
  if(!first&&!second)return nativeDefineProperty(target,key,descriptor);
  try{
   if(first){
    const rows=readJson(path.join(coordinator,'leases.json')).filter(row=>row?.runId===runId);
    if(rows.length!==1)throw new Error('fixture could not find the just-committed reservation');
    if(typeof rows[0].id!=='string'||!UUID.test(rows[0].leaseInstanceId))
     throw new Error('fixture found an invalid committed lease');
    state.target=target;
    state.originalLease={id:rows[0].id,runId:rows[0].runId,leaseInstanceId:rows[0].leaseInstanceId};
    fs.renameSync(coordinator,moved);
    fs.mkdirSync(redirect);
    fs.writeFileSync(path.join(redirect,'sentinel.txt'),'outside coordinator target','utf8');
    fs.symlinkSync(redirect,coordinator,process.platform==='win32'?'junction':'dir');
    state.injected=true;
   }
   return nativeDefineProperty(target,key,descriptor);
  }finally{
   if(second)Object.defineProperty=nativeDefineProperty;
  }
 };
 return {state,restore:()=>{
  Object.defineProperty=nativeDefineProperty;
  try{if(fs.existsSync(coordinator)&&fs.lstatSync(coordinator).isSymbolicLink())fs.rmdirSync(coordinator);}catch{}
  try{if(fs.existsSync(moved)&&!fs.existsSync(coordinator))fs.renameSync(moved,coordinator);}catch{}
  try{fs.rmSync(redirect,{recursive:true,force:true});}catch{}
 }};
}

test('launcher preparation failure after reservation removes the unpublished attempt and leaves a recoverable protocol 2 ledger',async()=>{
 const workspace=fs.mkdtempSync(path.join(family,'launcher-preparation-ledger-'));
 const controller=fs.mkdtempSync(path.join(family,'launcher-preparation-controller-'));
 const runId='launcher-preparation-ledger';
 let launcherCalls=0,spawns=0,registers=0,unregisters=0,cleanups=0;
 const hooks={
  plan:async()=>[{title:'prepare failure',tasks:[{prompt:'the launcher callback must fail after capacity was reserved'}]}],
  compact:value=>value,infer:()=>[],prompt:value=>value,
  launcher:()=>{launcherCalls++;throw new Error('synthetic launcher preparation failure');},
  spawn:async()=>{spawns++;return true;},
  register:()=>{registers++;},unregister:()=>{unregisters++;},cleanup:()=>{cleanups++;},
  commit:()=>{},readPid:()=>0,identity:()=>null,close:async()=>{},waitForExit:async()=>true,
  session:async()=>null,wait:async()=>({done:false,exitCode:null}),exitCode:()=>null,
 };
 try{
  const sum=await runWindows('prepare one launcher',hooks,{workspace,runId,capacity:1,coordinator:path.join(controller,'coordinator')});
  assert.equal(launcherCalls,1,'the fixture must fail only after reservation reaches launcher preparation');
  assert.equal(spawns,0,'a failed launcher preparation must not spawn a worker');
  assert.equal(registers,0,'a failed launcher preparation must not register a worker');
  assert.equal(unregisters,0,'a failed launcher preparation has no registry state to clean');
  assert.equal(cleanups,0,'a failed launcher preparation has no launcher artifact to clean');
  assert.equal(sum.success,false);
  assert.equal(sum.results.B1.status,'failed');
  assert.deepEqual(sum.results.B1.attempts,[],'the in-memory ledger must remove the unpublished attempt');

  const summaryFile=path.join(runDirectory(workspace,runId),'summary.json');
  const saved=JSON.parse(fs.readFileSync(summaryFile,'utf8'));
  assert.deepEqual(saved.results.B1.attempts,[],'the persisted ledger must not retain a dangling lease-bound attempt');
  for(const field of ['leaseId','leaseInstanceId','token','launcher','launcherFiles']){
   assert.equal(saved.results.B1[field],undefined,`failed preparation must not publish ${field}`);
  }
  assert.equal(fs.existsSync(path.join(runDirectory(workspace,runId),'attempts','B1','1','attempt.json')),false,
    'the removed attempt must not survive as an unreferenced recovery file');
  assert.doesNotThrow(()=>validateRecoverySummary(saved));
  assert.doesNotThrow(()=>preflightResumeLedger(workspace,runId));
 }finally{
  fs.rmSync(workspace,{recursive:true,force:true});
  fs.rmSync(controller,{recursive:true,force:true});
 }
});

test('a malformed reserve acknowledgement with a valid UUID and stale private rollback retains a bound reconciliation record',async()=>{
 const workspace=fs.mkdtempSync(path.join(family,'malformed-reserve-ack-workspace-'));
 const controller=fs.mkdtempSync(path.join(family,'malformed-reserve-ack-controller-'));
 const coordinator=path.join(controller,'coordinator');
 const runId='malformed-reserve-ack';
 let launcherCalls=0,spawns=0,registers=0,unregisters=0,cleanups=0,closes=0;
 // The coordinator calls use the real future absolute deadline.  Advance only
 // the runner's injected logical clock if the malformed acknowledgement is
 // mishandled as a normal waiting result, keeping the regression quick.
 const executionDeadlineAt=Date.now()+60_000;
 let logicalNow=Date.now();
 const injection=injectMalformedReserveAcknowledgement({coordinator,runId});
 const hooks={
  plan:async()=>[{title:'malformed reserve acknowledgement',tasks:[{prompt:'the runner must retain a durable reconciliation record'}]}],
  compact:value=>value,infer:()=>[],prompt:value=>value,
  launcher:()=>{launcherCalls++;throw new Error('launcher must not run after a malformed reserve acknowledgement');},
  spawn:async()=>{spawns++;return true;},
  register:()=>{registers++;},unregister:()=>{unregisters++;},cleanup:()=>{cleanups++;},
  commit:()=>{},readPid:()=>0,identity:()=>null,close:async()=>{closes++;},waitForExit:async()=>true,
  session:async()=>null,wait:async()=>({done:false,exitCode:null}),exitCode:()=>null,
 };
 try{
  const sum=await runWindows('retain malformed reserve acknowledgement',hooks,{workspace,runId,capacity:1,coordinator,
   executionDeadlineAt,now:()=>logicalNow,pauseMs:async()=>{logicalNow=executionDeadlineAt;}});
  assert.equal(injection.state.injected,true,'the fixture must alter exactly one fresh reservation acknowledgement');
  assert.match(injection.state.returnedInstance,UUID,'the malformed acknowledgement must retain its real valid UUID');
  assert.match(injection.state.foreignInstance,UUID,'the stale durable lease must remain syntactically valid');
  assert.notEqual(injection.state.returnedInstance,injection.state.foreignInstance);
  assert.equal(launcherCalls,0,'a malformed reservation acknowledgement must not prepare a launcher');
  assert.equal(spawns,0,'a malformed reservation acknowledgement must not spawn a worker');
  assert.equal(registers,0,'a malformed reservation acknowledgement must not register a worker');
  assert.equal(unregisters,0,'a stale proof must not unregister a lease by raw id');
  assert.equal(cleanups,0,'a stale proof must not remove recovery artifacts');
  assert.equal(closes,0,'no launcher exists to close on this path');
  assert.equal(sum.success,false);

  const entry=sum.results.B1;
  assert.equal(entry.status,'needs-reconciliation','the runner must retain an unprovable reservation instead of timing out or failing it');
  assert.equal(entry.exitConfirmed,false);
  assert.ok(entry.exitUnprovenAt,'the retained entry must record unresolved ownership');
  assert.equal(entry.leaseInstanceId,injection.state.returnedInstance,'the durable record must bind the response UUID, never the foreign coordinator row');
  assert.match(entry.leaseInstanceId,UUID);
  assert.equal(entry.attempts.length,1,'the retained reservation needs one restart authority');
  const attempt=entry.attempts[0];
  assert.equal(attempt.leaseId,entry.leaseId);
  assert.equal(attempt.leaseInstanceId,entry.leaseInstanceId);
  assert.equal(attempt.exitConfirmed,false);
  assert.ok(attempt.exitUnprovenAt,'the attempt-side authority must also record unresolved ownership');

  const summaryFile=path.join(runDirectory(workspace,runId),'summary.json');
  const saved=readJson(summaryFile),savedEntry=saved.results.B1,savedAttempt=savedEntry.attempts.at(-1);
  assert.equal(savedEntry.status,'needs-reconciliation');
  assert.equal(savedEntry.leaseInstanceId,injection.state.returnedInstance);
  assert.equal(savedAttempt.leaseInstanceId,savedEntry.leaseInstanceId);
  assert.doesNotThrow(()=>validateRecoverySummary(saved),'the retained ledger must remain structurally recoverable');
  assert.deepEqual(readJson(attempt.file).leaseInstanceId,savedEntry.leaseInstanceId,'attempt file must carry the same binding');
  const durableLeases=readJson(path.join(coordinator,'leases.json'));
  assert.deepEqual(durableLeases.filter(row=>row?.id===entry.leaseId).map(row=>row.leaseInstanceId),[injection.state.foreignInstance],
   'a stale private proof must retain the foreign/newer coordinator lease instead of deleting it by id');
 }finally{
  injection.restore();
  fs.rmSync(workspace,{recursive:true,force:true});
  fs.rmSync(controller,{recursive:true,force:true});
 }
});

test('a suppressed public reserve acknowledgement rolls back through its private in-process receipt',async()=>{
 const workspace=fs.mkdtempSync(path.join(family,'proofless-reserve-ack-workspace-'));
 const controller=fs.mkdtempSync(path.join(family,'proofless-reserve-ack-controller-'));
 const coordinator=path.join(controller,'coordinator');
 const runId='proofless-reserve-ack';
 const calls={launcher:0,spawn:0,register:0,unregister:0,cleanup:0,close:0,commit:0,readPid:0,identity:0,waitForExit:0,session:0,wait:0,exitCode:0};
 const injection=injectProoflessReserveAcknowledgement({coordinator,runId});
 const hooks={
  plan:async()=>[{title:'proofless reserve acknowledgement',tasks:[{prompt:'the runner must stop before any launcher lifecycle hook'}]}],
  compact:value=>value,infer:()=>[],prompt:value=>value,
  launcher:()=>{calls.launcher++;throw new Error('launcher must not run after a proofless acknowledgement');},
  spawn:async()=>{calls.spawn++;return true;},
  register:()=>{calls.register++;},unregister:()=>{calls.unregister++;},cleanup:()=>{calls.cleanup++;},
  commit:()=>{calls.commit++;},readPid:()=>{calls.readPid++;return 0;},identity:()=>{calls.identity++;return null;},
  close:async()=>{calls.close++;},waitForExit:async()=>{calls.waitForExit++;return true;},
  session:async()=>{calls.session++;return null;},wait:async()=>{calls.wait++;return {done:false,exitCode:null};},exitCode:()=>{calls.exitCode++;return null;},
 };
 try{
  const sum=await runWindows('roll back suppressed reserve acknowledgement',hooks,{workspace,runId,capacity:1,coordinator});
  assert.equal(injection.state.injected,true,'the fixture must suppress exactly the private proof and UUID after commit');
  assert.deepEqual(injection.state.omitted,['reservationProof','leaseInstanceId']);
  assert.equal(injection.state.target.ok,true,'the malformed acknowledgement must still claim success');
  assert.equal(Object.hasOwn(injection.state.target,'reservationProof'),false);
  assert.equal(Object.hasOwn(injection.state.target,'leaseInstanceId'),false);
  assert.match(injection.state.committedLease.leaseInstanceId,UUID,'the real coordinator transaction must commit before its response is malformed');
  assert.equal(sum.success,false);
  assert.deepEqual(calls,{launcher:0,spawn:0,register:0,unregister:0,cleanup:0,close:0,commit:0,readPid:0,identity:0,waitForExit:0,session:0,wait:0,exitCode:0},
   'a proofless acknowledgement must not enter launch, close, or cleanup paths');

  const entry=sum.results.B1;
  assert.equal(entry.status,'failed','a proof-authorized rollback leaves an ordinary failed launch, not a retained lease');
  assert.deepEqual(entry.attempts,[],'the safely rolled back acknowledgement must not create a protocol-2 attempt');
  for(const field of ['leaseId','leaseInstanceId','token','launcher','launcherFiles','exitEvidence','noProcessProof','cleanupPending']){
   assert.equal(entry[field],undefined,`safe rollback must not publish authorizing ${field}`);
  }
  assert.equal(entry.reservationFault,undefined);
  assert.doesNotThrow(()=>validateRecoverySummary(sum),'the safely rolled back ledger must remain structurally readable');
  const forensic=structuredClone(sum);
  const forensicEntry=forensic.results.B1;
  forensicEntry.status='needs-reconciliation';
  forensicEntry.exitConfirmed=false;
  forensicEntry.exitUnprovenAt=1;
  forensicEntry.reservationFault={version:1,kind:'reservation-acknowledgement',at:1,leaseId:injection.state.committedLease.id};
  assert.doesNotThrow(()=>validateRecoverySummary(forensic),'a complete non-authorizing fault marker must be structurally readable');
  const tampered=structuredClone(forensic);
  tampered.results.B1.reservationFault.version=2;
  assert.throws(()=>validateRecoverySummary(tampered),/reservation acknowledgement fault is invalid/i,
   'a malformed forensic marker must not become an accepted recovery shape');

  const saved=readJson(path.join(runDirectory(workspace,runId),'summary.json'));
  assert.equal(saved.results.B1.status,'failed');
  assert.deepEqual(saved.results.B1.attempts,[]);
  assert.equal(saved.results.B1.leaseInstanceId,undefined);
  const durableLeases=readJson(path.join(coordinator,'leases.json')).filter(row=>row?.id===injection.state.committedLease.id);
  assert.deepEqual(durableLeases,[],'the private receipt must release only its own committed lease');
  assert.doesNotThrow(()=>preflightResumeLedger(workspace,runId),
   'the ordinary failed run is safely resumable because its private rollback was proven');
 }finally{
  injection.restore();
  fs.rmSync(workspace,{recursive:true,force:true});
  fs.rmSync(controller,{recursive:true,force:true});
 }
});

test('a fully empty reserve acknowledgement never retries its public id and retains the original private lease identity',async()=>{
 const workspace=fs.mkdtempSync(path.join(family,'empty-reserve-ack-workspace-'));
 const controller=fs.mkdtempSync(path.join(family,'empty-reserve-ack-controller-'));
 const coordinator=path.join(controller,'coordinator');
 const runId='empty-reserve-ack';
 const calls={launcher:0,spawn:0,register:0,unregister:0,cleanup:0,close:0,commit:0,readPid:0,identity:0,waitForExit:0,session:0,wait:0,exitCode:0};
 const injection=injectFullyEmptyReserveAcknowledgement({coordinator,runId});
 const executionDeadlineAt=Date.now()+60_000;
 let logicalNow=Date.now(),pauseCalls=0;
 const hooks={
  plan:async()=>[{title:'empty reserve acknowledgement',tasks:[{prompt:'the runner must retain the private reservation identity without launching'}]}],
  compact:value=>value,infer:()=>[],prompt:value=>value,
  launcher:()=>{calls.launcher++;throw new Error('launcher must not run after a fully empty acknowledgement');},
  spawn:async()=>{calls.spawn++;return true;},
  register:()=>{calls.register++;},unregister:()=>{calls.unregister++;},cleanup:()=>{calls.cleanup++;},
  commit:()=>{calls.commit++;},readPid:()=>{calls.readPid++;return 0;},identity:()=>{calls.identity++;return null;},
  close:async()=>{calls.close++;},waitForExit:async()=>{calls.waitForExit++;return true;},
  session:async()=>{calls.session++;return null;},wait:async()=>{calls.wait++;return {done:false,exitCode:null};},exitCode:()=>{calls.exitCode++;return null;},
 };
 try{
  const sum=await runWindows('retain fully empty reserve acknowledgement',hooks,{workspace,runId,capacity:1,coordinator,
   executionDeadlineAt,now:()=>logicalNow,pauseMs:async()=>{pauseCalls++;logicalNow=executionDeadlineAt;}});
  assert.equal(injection.state.injected,true,'the fixture must hide every acknowledgement field after the real reservation commits');
  assert.deepEqual(injection.state.omitted,['reservationProof','leaseInstanceId']);
  assert.equal(injection.state.target.ok,undefined,'the fixture must remove the ordinary success bit too');
  assert.match(injection.state.originalLease.leaseInstanceId,UUID);
  assert.match(injection.state.foreignLease.leaseInstanceId,UUID);
  assert.notEqual(injection.state.originalLease.leaseInstanceId,injection.state.foreignLease.leaseInstanceId);
  assert.equal(pauseCalls,0,'an unknown committed acknowledgement must not retry the reusable public id');
  assert.deepEqual(calls,{launcher:0,spawn:0,register:0,unregister:0,cleanup:0,close:0,commit:0,readPid:0,identity:0,waitForExit:0,session:0,wait:0,exitCode:0},
   'an empty acknowledgement must not enter launch, close, or cleanup paths');

  const entry=sum.results.B1;
  assert.equal(sum.success,false);
  assert.equal(entry.status,'needs-reconciliation');
  assert.equal(entry.exitConfirmed,false);
  assert.ok(entry.exitUnprovenAt,'the fault must carry a durable resume blocker');
  assert.equal(entry.leaseInstanceId,injection.state.originalLease.leaseInstanceId,
   'the recovery record must use the original private acknowledgement identity, never the foreign durable row');
  assert.equal(entry.attempts.length,1,'the original private identity must have one protocol-2 restart authority');
  const attempt=entry.attempts[0];
  assert.equal(attempt.leaseId,entry.leaseId);
  assert.equal(attempt.leaseInstanceId,entry.leaseInstanceId);
  assert.equal(attempt.exitConfirmed,false);
  assert.ok(attempt.exitUnprovenAt);
  assert.doesNotThrow(()=>validateRecoverySummary(sum));

  const summaryFile=path.join(runDirectory(workspace,runId),'summary.json');
  const saved=readJson(summaryFile),savedEntry=saved.results.B1,savedAttempt=savedEntry.attempts.at(-1);
  assert.equal(savedEntry.status,'needs-reconciliation');
  assert.equal(savedEntry.leaseInstanceId,injection.state.originalLease.leaseInstanceId);
  assert.equal(savedAttempt.leaseInstanceId,savedEntry.leaseInstanceId);
  assert.equal(readJson(attempt.file).leaseInstanceId,savedEntry.leaseInstanceId);
  const durableLeases=readJson(path.join(coordinator,'leases.json')).filter(row=>row?.id===injection.state.originalLease.id);
  assert.deepEqual(durableLeases.map(row=>({id:row.id,runId:row.runId,leaseInstanceId:row.leaseInstanceId})),[injection.state.foreignLease],
   'the runner must not raw-release the replaced lease by its reusable id');
  assert.throws(()=>preflightResumeLedger(workspace,runId),/launcher exit remains unproven.*B1.*reconcile/i,
   'preflight must refuse automatic replay of the unknown committed acknowledgement');
 }finally{
  injection.restore();
  fs.rmSync(workspace,{recursive:true,force:true});
  fs.rmSync(controller,{recursive:true,force:true});
 }
});

test('a throwing public reservation-proof projection retains the private bound acknowledgement for reconciliation',async()=>{
 const workspace=fs.mkdtempSync(path.join(family,'throwing-reserve-proof-workspace-'));
 const controller=fs.mkdtempSync(path.join(family,'throwing-reserve-proof-controller-'));
 const coordinator=path.join(controller,'coordinator');
 const runId='throwing-reserve-proof';
 const calls={launcher:0,spawn:0,register:0,unregister:0,cleanup:0,close:0,commit:0,readPid:0,identity:0,waitForExit:0,session:0,wait:0,exitCode:0};
 const injection=injectThrowingReserveProofProjection({coordinator,runId});
 const hooks={
  plan:async()=>[{title:'throwing reservation proof projection',tasks:[{prompt:'the runner must recover its private acknowledgement before any launcher lifecycle hook'}]}],
  compact:value=>value,infer:()=>[],prompt:value=>value,
  launcher:()=>{calls.launcher++;throw new Error('launcher must not run after a throwing acknowledgement projection');},
  spawn:async()=>{calls.spawn++;return true;},
  register:()=>{calls.register++;},unregister:()=>{calls.unregister++;},cleanup:()=>{calls.cleanup++;},
  commit:()=>{calls.commit++;},readPid:()=>{calls.readPid++;return 0;},identity:()=>{calls.identity++;return null;},
  close:async()=>{calls.close++;},waitForExit:async()=>{calls.waitForExit++;return true;},
  session:async()=>{calls.session++;return null;},wait:async()=>{calls.wait++;return {done:false,exitCode:null};},exitCode:()=>{calls.exitCode++;return null;},
 };
 try{
  const sum=await runWindows('retain throwing reservation proof projection',hooks,{workspace,runId,capacity:1,coordinator});
  assert.equal(injection.state.injected,true,'the fixture must replace the public proof projection after the reservation commits');
  assert.ok(injection.state.getterReads>0,'the runner must encounter the damaged public projection');
  assert.match(injection.state.originalLease.leaseInstanceId,UUID);
  assert.match(injection.state.foreignLease.leaseInstanceId,UUID);
  assert.notEqual(injection.state.originalLease.leaseInstanceId,injection.state.foreignLease.leaseInstanceId);
  assert.deepEqual(calls,{launcher:0,spawn:0,register:0,unregister:0,cleanup:0,close:0,commit:0,readPid:0,identity:0,waitForExit:0,session:0,wait:0,exitCode:0},
   'a throwing acknowledgement projection must not enter launch, close, or cleanup paths');

  const entry=sum.results.B1;
  assert.equal(sum.success,false);
  assert.equal(entry.status,'needs-reconciliation');
  assert.equal(entry.exitConfirmed,false);
  assert.ok(entry.exitUnprovenAt);
  assert.equal(entry.leaseInstanceId,injection.state.originalLease.leaseInstanceId,
   'the recovery record must retain the original private acknowledgement identity');
  assert.equal(entry.attempts.length,1);
  const attempt=entry.attempts[0];
  assert.equal(attempt.leaseId,entry.leaseId);
  assert.equal(attempt.leaseInstanceId,entry.leaseInstanceId);
  assert.equal(attempt.exitConfirmed,false);
  assert.ok(attempt.exitUnprovenAt);
  assert.doesNotThrow(()=>validateRecoverySummary(sum));

  const summaryFile=path.join(runDirectory(workspace,runId),'summary.json');
  const saved=readJson(summaryFile),savedEntry=saved.results.B1,savedAttempt=savedEntry.attempts.at(-1);
  assert.equal(savedEntry.status,'needs-reconciliation');
  assert.equal(savedEntry.leaseInstanceId,injection.state.originalLease.leaseInstanceId);
  assert.equal(savedAttempt.leaseInstanceId,savedEntry.leaseInstanceId);
  assert.equal(readJson(attempt.file).leaseInstanceId,savedEntry.leaseInstanceId);
  const durableLeases=readJson(path.join(coordinator,'leases.json')).filter(row=>row?.id===injection.state.originalLease.id);
  assert.deepEqual(durableLeases.map(row=>({id:row.id,runId:row.runId,leaseInstanceId:row.leaseInstanceId})),[injection.state.foreignLease],
   'the runner must not raw-release the replaced lease by its reusable id');
  assert.throws(()=>preflightResumeLedger(workspace,runId),/launcher exit remains unproven.*B1.*reconcile/i,
   'preflight must refuse automatic replay after a throwing acknowledgement projection');
 }finally{
  injection.restore();
  fs.rmSync(workspace,{recursive:true,force:true});
  fs.rmSync(controller,{recursive:true,force:true});
 }
});

test('a throwing reserve proof projection rolls back its committed lease through the private receipt',async()=>{
 const workspace=fs.mkdtempSync(path.join(family,'throwing-define-property-workspace-'));
 const controller=fs.mkdtempSync(path.join(family,'throwing-define-property-controller-'));
 const coordinator=path.join(controller,'coordinator');
 const runId='throwing-define-property-reserve-proof';
 const calls={launcher:0,spawn:0,register:0,unregister:0,cleanup:0,close:0,commit:0,readPid:0,identity:0,waitForExit:0,session:0,wait:0,exitCode:0};
 // This trips before reserve returns an acknowledgement to the runner.  The
 // committed row therefore has no usable public proof or UUID; only reserve's
 // private same-process receipt can safely release it.
 const injection=injectThrowingReserveDefineProperty({coordinator,runId});
 const hooks={
  plan:async()=>[{title:'throwing defineProperty reserve projection',tasks:[{prompt:'rollback must happen before any launcher lifecycle hook'}]}],
  compact:value=>value,infer:()=>[],prompt:value=>value,
  launcher:()=>{calls.launcher++;throw new Error('launcher must not run after a reserve projection failure');},
  spawn:async()=>{calls.spawn++;return true;},
  register:()=>{calls.register++;},unregister:()=>{calls.unregister++;},cleanup:()=>{calls.cleanup++;},
  commit:()=>{calls.commit++;},readPid:()=>{calls.readPid++;return 0;},identity:()=>{calls.identity++;return null;},
  close:async()=>{calls.close++;},waitForExit:async()=>{calls.waitForExit++;return true;},
  session:async()=>{calls.session++;return null;},wait:async()=>{calls.wait++;return {done:false,exitCode:null};},exitCode:()=>{calls.exitCode++;return null;},
 };
 try{
  let sum;
  await assert.doesNotReject(async()=>{sum=await runWindows('roll back throwing reserve projection',hooks,{workspace,runId,capacity:1,coordinator});},
   'a projection failure after commit must become a failed run result, not escape the runner');
  assert.equal(injection.state.injected,true,'the fixture must throw only after a real coordinator reservation commits');
  assert.equal(injection.state.target?.ok,true,'the failed target must be the positive reserve acknowledgement');
  assert.match(injection.state.committedLease.leaseInstanceId,UUID);
  assert.equal(sum.success,false);
  assert.deepEqual(calls,{launcher:0,spawn:0,register:0,unregister:0,cleanup:0,close:0,commit:0,readPid:0,identity:0,waitForExit:0,session:0,wait:0,exitCode:0},
   'the runner must not enter launcher, close, or cleanup hooks after a failed acknowledgement projection');

  const entry=sum.results.B1;
  assert.equal(entry.status,'failed');
  assert.deepEqual(entry.attempts,[],'a proof-authorized pre-launch rollback must create no recovery attempt');
  for(const field of ['leaseId','leaseInstanceId','token','launcher','launcherFiles','exitEvidence','noProcessProof','cleanupPending']){
   assert.equal(entry[field],undefined,`the failed projection must not publish ${field}`);
  }
  assert.doesNotThrow(()=>validateRecoverySummary(sum),'the in-memory failure ledger must remain valid');

  const summaryFile=path.join(runDirectory(workspace,runId),'summary.json');
  const saved=readJson(summaryFile);
  assert.equal(saved.results.B1.status,'failed');
  assert.deepEqual(saved.results.B1.attempts,[],'the persisted ledger must not retain an unlaunched attempt');
  assert.equal(fs.existsSync(path.join(runDirectory(workspace,runId),'attempts','B1','1','attempt.json')),false,
   'the failed projection must not create an orphan attempt file');
  assert.doesNotThrow(()=>validateRecoverySummary(saved));
  assert.doesNotThrow(()=>preflightResumeLedger(workspace,runId),'the ordinary failed run must remain safely resumable');
  assert.deepEqual(readJson(path.join(coordinator,'leases.json')).filter(row=>row?.runId===runId),[],
   'the private receipt must proof-authorize rollback of the real committed lease');
 }finally{
  injection.restore();
  fs.rmSync(workspace,{recursive:true,force:true});
  fs.rmSync(controller,{recursive:true,force:true});
 }
});

test('a throwing reserve instance projection rolls back its committed lease through the private receipt',async()=>{
 const workspace=fs.mkdtempSync(path.join(family,'throwing-define-property-instance-workspace-'));
 const controller=fs.mkdtempSync(path.join(family,'throwing-define-property-instance-controller-'));
 const coordinator=path.join(controller,'coordinator');
 const runId='throwing-define-property-reserve-instance';
 const calls={launcher:0,spawn:0,register:0,unregister:0,cleanup:0,close:0,commit:0,readPid:0,identity:0,waitForExit:0,session:0,wait:0,exitCode:0};
 // This intentionally lets the first, proof projection succeed and interrupts
 // only the second projection.  The same private receipt must still authorize
 // rollback of the already-committed coordinator row.
 const injection=injectThrowingReserveDefineProperty({coordinator,runId,projection:'leaseInstanceId'});
 const hooks={
  plan:async()=>[{title:'throwing defineProperty instance projection',tasks:[{prompt:'the second reserve projection must roll back before any launcher lifecycle hook'}]}],
  compact:value=>value,infer:()=>[],prompt:value=>value,
  launcher:()=>{calls.launcher++;throw new Error('launcher must not run after an instance projection failure');},
  spawn:async()=>{calls.spawn++;return true;},
  register:()=>{calls.register++;},unregister:()=>{calls.unregister++;},cleanup:()=>{calls.cleanup++;},
  commit:()=>{calls.commit++;},readPid:()=>{calls.readPid++;return 0;},identity:()=>{calls.identity++;return null;},
  close:async()=>{calls.close++;},waitForExit:async()=>{calls.waitForExit++;return true;},
  session:async()=>{calls.session++;return null;},wait:async()=>{calls.wait++;return {done:false,exitCode:null};},exitCode:()=>{calls.exitCode++;return null;},
 };
 try{
  let sum;
  await assert.doesNotReject(async()=>{sum=await runWindows('roll back throwing reserve instance projection',hooks,{workspace,runId,capacity:1,coordinator});},
   'a second projection failure after commit must become a failed run result, not escape the runner');
  assert.equal(injection.state.projection,'leaseInstanceId');
  assert.equal(injection.state.injected,true,'the fixture must interrupt the second projection after a real coordinator reservation commits');
  assert.equal(injection.state.target?.ok,true,'the failed target must be the positive reserve acknowledgement');
  assert.equal(Object.hasOwn(injection.state.target,'reservationProof'),true,
   'the first private proof projection must complete before the instance projection throws');
  assert.equal(Object.hasOwn(injection.state.target,'leaseInstanceId'),false,
   'the instance id must not be publicly projected when its own write throws');
  assert.match(injection.state.committedLease.leaseInstanceId,UUID);
  assert.equal(sum.success,false);
  assert.deepEqual(calls,{launcher:0,spawn:0,register:0,unregister:0,cleanup:0,close:0,commit:0,readPid:0,identity:0,waitForExit:0,session:0,wait:0,exitCode:0},
   'the runner must not enter launcher, close, or cleanup hooks after the second failed acknowledgement projection');

  const entry=sum.results.B1;
  assert.equal(entry.status,'failed');
  assert.deepEqual(entry.attempts,[],'a proof-authorized pre-launch rollback must create no recovery attempt');
  for(const field of ['leaseId','leaseInstanceId','token','launcher','launcherFiles','exitEvidence','noProcessProof','cleanupPending']){
   assert.equal(entry[field],undefined,`the failed second projection must not publish ${field}`);
  }
  assert.doesNotThrow(()=>validateRecoverySummary(sum),'the in-memory failure ledger must remain valid');

  const summaryFile=path.join(runDirectory(workspace,runId),'summary.json');
  const saved=readJson(summaryFile);
  assert.equal(saved.results.B1.status,'failed');
  assert.deepEqual(saved.results.B1.attempts,[],'the persisted ledger must not retain an unlaunched attempt');
  assert.equal(fs.existsSync(path.join(runDirectory(workspace,runId),'attempts','B1','1','attempt.json')),false,
   'the failed second projection must not create an orphan attempt file');
  assert.doesNotThrow(()=>validateRecoverySummary(saved));
  assert.doesNotThrow(()=>preflightResumeLedger(workspace,runId),'the ordinary failed run must remain safely resumable');
  assert.deepEqual(readJson(path.join(coordinator,'leases.json')).filter(row=>row?.runId===runId),[],
   'the private receipt must proof-authorize rollback of the real committed lease after the second projection fails');
 }finally{
  injection.restore();
  fs.rmSync(workspace,{recursive:true,force:true});
  fs.rmSync(controller,{recursive:true,force:true});
 }
});

test('a reparse failure while reading the private acknowledgement retains the committed lease for reconciliation',{skip:process.platform!=='win32'},async()=>{
 const workspace=fs.mkdtempSync(path.join(family,'reparse-acknowledgement-workspace-'));
 const controller=fs.mkdtempSync(path.join(family,'reparse-acknowledgement-controller-'));
 const coordinator=path.join(controller,'coordinator');
 const runId='reparse-acknowledgement';
 const calls={launcher:0,spawn:0,register:0,unregister:0,cleanup:0,close:0,commit:0,readPid:0,identity:0,waitForExit:0,session:0,wait:0,exitCode:0};
 const injection=injectCoordinatorReparseBeforeAcknowledgement({coordinator,runId});
 const hooks={
  plan:async()=>[{title:'reparse acknowledgement lookup',tasks:[{prompt:'a rejected coordinator path must retain the unresolved reservation before launch'}]}],
  compact:value=>value,infer:()=>[],prompt:value=>value,
  launcher:()=>{calls.launcher++;throw new Error('launcher must not run after acknowledgement lookup rejects a reparse point');},
  spawn:async()=>{calls.spawn++;return true;},
  register:()=>{calls.register++;},unregister:()=>{calls.unregister++;},cleanup:()=>{calls.cleanup++;},
  commit:()=>{calls.commit++;},readPid:()=>{calls.readPid++;return 0;},identity:()=>{calls.identity++;return null;},
  close:async()=>{calls.close++;},waitForExit:async()=>{calls.waitForExit++;return true;},
  session:async()=>{calls.session++;return null;},wait:async()=>{calls.wait++;return {done:false,exitCode:null};},exitCode:()=>{calls.exitCode++;return null;},
 };
 try{
  let runError;
  try{await runWindows('retain a reparse-damaged acknowledgement',hooks,{workspace,runId,capacity:1,coordinator});}
  catch(error){runError=error;}
  assert.match(runError?.message||'',/reparse point/i,
   'the replaced coordinator path must fail closed after the runner records reconciliation evidence');
  assert.equal(injection.state.injected,true,'the fixture must replace the coordinator path only after the real reservation commits');
  assert.equal(fs.lstatSync(coordinator).isSymbolicLink(),true,'the acknowledgement lookup must encounter a real reparse point');
  assert.deepEqual(calls,{launcher:0,spawn:0,register:0,unregister:0,cleanup:0,close:0,commit:0,readPid:0,identity:0,waitForExit:0,session:0,wait:0,exitCode:0},
   'a failed acknowledgement lookup must not enter launcher, close, or cleanup hooks');

  const saved=readJson(path.join(runDirectory(workspace,runId),'summary.json'));
  const entry=saved.results.B1;
  assert.equal(entry.status,'needs-reconciliation');
  assert.equal(entry.exitConfirmed,false);
  assert.ok(entry.exitUnprovenAt);
  assert.equal(entry.leaseId,injection.state.originalLease.id);
  assert.equal(entry.leaseInstanceId,injection.state.originalLease.leaseInstanceId,
   'the durable recovery record must preserve the original lease instance from the public acknowledgement');
  assert.equal(entry.attempts.length,1);
  assert.equal(entry.attempts[0].leaseInstanceId,entry.leaseInstanceId);
  assert.doesNotThrow(()=>validateRecoverySummary(saved));
  assert.equal(fs.readFileSync(path.join(injection.state.redirect,'sentinel.txt'),'utf8'),'outside coordinator target',
   'the failed release must not follow the replacement coordinator path');
  const durableLeases=readJson(path.join(injection.state.moved,'leases.json')).filter(row=>row?.id===entry.leaseId);
  assert.deepEqual(durableLeases.map(row=>({id:row.id,runId:row.runId,leaseInstanceId:row.leaseInstanceId})),[injection.state.originalLease],
   'the private acknowledgement failure must retain rather than raw-release the committed lease');
  assert.throws(()=>preflightResumeLedger(workspace,runId),/launcher exit remains unproven|reparse/i,
   'automatic resume must refuse the unresolved acknowledgement state');
 }finally{
  injection.restore();
  fs.rmSync(workspace,{recursive:true,force:true});
  fs.rmSync(controller,{recursive:true,force:true});
 }
});
