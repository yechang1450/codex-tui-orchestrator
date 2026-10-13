import {testTempFamily} from './test-temp-root.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {canonicalDigest} from '../scripts/core/contracts.mjs';
import {createCleanupStatusAuthorityBinding} from '../scripts/core/status-events.mjs';
import {
  beginCleanupTransactionMarkerPhase,
  cleanupTransactionMarkerFile,
  cleanupTransactionStatusDigests,
  createCleanupTransactionMarker,
  deleteCleanupTransactionMarker,
  readCleanupTransactionMarker,
   readCleanupTransactionMarkerForRecovery,
  updateCleanupTransactionMarker,
  updateCleanupTransactionStatusAuthority,
  writeCleanupTransactionMarker,
} from '../scripts/core/cleanup-transaction.mjs';

const family=testTempFamily('cleanup-transaction');

function fixture(){
 fs.mkdirSync(family,{recursive:true});
 const workspace=fs.mkdtempSync(path.join(family,'cleanup-transaction-workspace-'));
 const controller=fs.mkdtempSync(path.join(family,'cleanup-transaction-controller-'));
 const runId='cleanup-run',blockKey='B1',attempt=1,token='cleanup-token',lease={id:'lease-cleanup',instanceId:crypto.randomUUID()};
 const attemptFile=path.join(workspace,'temp','orchestrator','runs',runId,'attempts',blockKey,String(attempt),'attempt.json');
 fs.mkdirSync(path.dirname(attemptFile),{recursive:true});fs.writeFileSync(attemptFile,JSON.stringify({runId,token,number:attempt}));
  const coordinator=path.join(controller,'coordinator');fs.mkdirSync(coordinator,{recursive:true});
 const env={...process.env,ORCH_CONTROLLER_ROOT:controller};
 const status=cleanupTransactionStatusDigests({base:{status:'cleanup-pending',tasks:['T001']},target:{status:'awaiting-verification',tasks:['T001']}});
 const source={runId,workspace,generation:1,eventSeq:7,tasks:[{id:'T001',prompt:'fixture'}],blocks:[{key:blockKey,title:'fixture',taskIds:['T001']}],results:{[blockKey]:{status:'running',attempts:[]}},taskResults:{T001:{status:'running'}}};
 const target={...source,eventSeq:8,results:{[blockKey]:{status:'cleanup-pending',attempts:[]}},taskResults:{T001:{status:'needs-reconciliation'}}};
 const statusAuthority=createCleanupStatusAuthorityBinding({workspace,runId,source,target});
  const binding={runId,blockKey,attempt,token,attemptFile,coordinator,lease,status};
 const launcher={ProcessId:4242,Started:'fixture-start',Name:'powershell.exe',commandLineSha256:'a'.repeat(64)};
 const proof={version:1,kind:'authenticated-exit',runId,blockKey,attempt,token,pid:4242,authenticated:true,launcher,launcherIdentitySha256:canonicalDigest(launcher),recordedAt:100};
 const journal={version:1,kind:'post-exit-cleanup',runId,blockKey,attempt,token,lease:{...lease},
  phases:{lease:'pending',registry:'pending',artifacts:'pending'},recordedAt:100,updatedAt:100};
 return {workspace,controller,env,binding,proof,journal,statusAuthority,cleanup(){fs.rmSync(workspace,{recursive:true,force:true});fs.rmSync(controller,{recursive:true,force:true});}};
}

test('marker requires a controller-bound status authority transition',()=>{
 const value=fixture();
 try{
  assert.throws(()=>createCleanupTransactionMarker({workspace:value.workspace,binding:value.binding,proof:value.proof,journal:value.journal,createdAt:100,env:value.env}),/status authority/i);
 }finally{value.cleanup();}
});

test('controller cleanup marker is bound, sequential, and removable only after all phases finish',()=>{
 const value=fixture();
 try{
  const marker=createCleanupTransactionMarker({workspace:value.workspace,binding:value.binding,proof:value.proof,journal:value.journal,statusAuthority:value.statusAuthority,createdAt:100,env:value.env});
  const file=cleanupTransactionMarkerFile({workspace:value.workspace,binding:value.binding,env:value.env});
  assert.equal(file.startsWith(value.controller),true,'marker must live in controller state, not the workspace');
  assert.equal(file.includes(value.binding.runId),false,'controller path must not expose mutable run identities');
  assert.deepEqual(writeCleanupTransactionMarker({workspace:value.workspace,binding:value.binding,marker,env:value.env}),marker);
  assert.throws(()=>writeCleanupTransactionMarker({workspace:value.workspace,binding:value.binding,marker,env:value.env}),/already exists/);
  assert.deepEqual(readCleanupTransactionMarker({workspace:value.workspace,binding:value.binding,env:value.env}),marker);
   const {status,...recoveryBinding}=value.binding;
   assert.deepEqual(readCleanupTransactionMarkerForRecovery({workspace:value.workspace,binding:recoveryBinding,env:value.env}),marker);
  const nextStatusAuthority={...value.statusAuthority,source:{...value.statusAuthority.target},target:{...value.statusAuthority.target}};
  const statusUpdated=updateCleanupTransactionStatusAuthority({workspace:value.workspace,binding:value.binding,statusAuthority:nextStatusAuthority,env:value.env});
  assert.deepEqual(statusUpdated.statusAuthority,nextStatusAuthority);
  assert.throws(()=>updateCleanupTransactionStatusAuthority({workspace:value.workspace,binding:value.binding,statusAuthority:{...nextStatusAuthority,runId:'foreign'},env:value.env}),/status authority binding/i);
   assert.throws(()=>updateCleanupTransactionMarker({workspace:value.workspace,binding:value.binding,phase:'lease',updatedAt:101,env:value.env}),/not in flight/);
   assert.throws(()=>beginCleanupTransactionMarkerPhase({workspace:value.workspace,binding:value.binding,phase:'registry',updatedAt:101,env:value.env}),/next pending phase/);
  assert.throws(()=>deleteCleanupTransactionMarker({workspace:value.workspace,binding:value.binding,env:value.env}),/not ready for deletion/);
   const leaseInflight=beginCleanupTransactionMarkerPhase({workspace:value.workspace,binding:value.binding,phase:'lease',updatedAt:101,env:value.env});
   assert.equal(leaseInflight.state,'active');assert.equal(leaseInflight.journal.phases.lease,'inflight');
   assert.throws(()=>beginCleanupTransactionMarkerPhase({workspace:value.workspace,binding:value.binding,phase:'lease',updatedAt:102,env:value.env}),/next pending phase/);
   const afterLease=updateCleanupTransactionMarker({workspace:value.workspace,binding:value.binding,phase:'lease',updatedAt:102,env:value.env});
  assert.equal(afterLease.state,'active');assert.equal(afterLease.journal.phases.lease,'done');
   beginCleanupTransactionMarkerPhase({workspace:value.workspace,binding:value.binding,phase:'registry',updatedAt:103,env:value.env});
   updateCleanupTransactionMarker({workspace:value.workspace,binding:value.binding,phase:'registry',updatedAt:104,env:value.env});
   beginCleanupTransactionMarkerPhase({workspace:value.workspace,binding:value.binding,phase:'artifacts',updatedAt:105,env:value.env});
   const complete=updateCleanupTransactionMarker({workspace:value.workspace,binding:value.binding,phase:'artifacts',updatedAt:106,env:value.env});
  assert.equal(complete.state,'finalizing');assert.deepEqual(complete.journal.phases,{lease:'done',registry:'done',artifacts:'done'});
  assert.equal(deleteCleanupTransactionMarker({workspace:value.workspace,binding:value.binding,env:value.env}),true);
  assert.equal(readCleanupTransactionMarker({workspace:value.workspace,binding:value.binding,env:value.env}),null);
  assert.equal(deleteCleanupTransactionMarker({workspace:value.workspace,binding:value.binding,env:value.env}),false);
 }finally{value.cleanup();}
});

test('marker rejects wrong caller binding and controller-file tampering before it can advance cleanup',()=>{
 const value=fixture();
 try{
  const marker=createCleanupTransactionMarker({workspace:value.workspace,binding:value.binding,proof:value.proof,journal:value.journal,statusAuthority:value.statusAuthority,createdAt:100,env:value.env});
  writeCleanupTransactionMarker({workspace:value.workspace,binding:value.binding,marker,env:value.env});
  const wrongToken={...value.binding,token:'foreign-token'};
  assert.throws(()=>readCleanupTransactionMarker({workspace:value.workspace,binding:wrongToken,env:value.env}),/marker identity is invalid|attempt token is invalid/);
  const wrongLease={...value.binding,lease:{...value.binding.lease,instanceId:crypto.randomUUID()}};
  assert.throws(()=>readCleanupTransactionMarker({workspace:value.workspace,binding:wrongLease,env:value.env}),/marker lease is not bound/);
  const wrongStatus={...value.binding,status:cleanupTransactionStatusDigests({base:{status:'foreign'},target:{status:'awaiting-verification',tasks:['T001']}})};
  assert.throws(()=>readCleanupTransactionMarker({workspace:value.workspace,binding:wrongStatus,env:value.env}),/status semantics are not bound/);
  const siblingAttempt=path.join(value.workspace,'temp','orchestrator','runs','cleanup-run','attempts','B1','1','sibling.json');fs.writeFileSync(siblingAttempt,'{}');
  assert.throws(()=>readCleanupTransactionMarker({workspace:value.workspace,binding:{...value.binding,attemptFile:siblingAttempt},env:value.env}),/marker identity is invalid/);
  const file=cleanupTransactionMarkerFile({workspace:value.workspace,binding:value.binding,env:value.env});
  const tampered=JSON.parse(fs.readFileSync(file,'utf8'));tampered.coordinatorIdentitySha256='0'.repeat(64);fs.writeFileSync(file,JSON.stringify(tampered));
  assert.throws(()=>updateCleanupTransactionMarker({workspace:value.workspace,binding:value.binding,phase:'lease',updatedAt:101,env:value.env}),/marker identity is invalid/);
 }finally{value.cleanup();}
});

test('marker construction rejects unbound proof, invalid phase order, and an attempt outside the workspace',()=>{
 const value=fixture();
 try{
  const invalidProof={...value.proof,token:'foreign'};
  assert.throws(()=>createCleanupTransactionMarker({workspace:value.workspace,binding:value.binding,proof:invalidProof,journal:value.journal,statusAuthority:value.statusAuthority,createdAt:100,env:value.env}),/proof is not bound/);
  const forgedLauncherDigest={...value.proof,launcherIdentitySha256:'0'.repeat(64)};
  assert.throws(()=>createCleanupTransactionMarker({workspace:value.workspace,binding:value.binding,proof:forgedLauncherDigest,journal:value.journal,statusAuthority:value.statusAuthority,createdAt:100,env:value.env}),/authenticated exit proof is invalid/);
  const mismatchedLauncher={...value.proof,launcher:{...value.proof.launcher,ProcessId:99},launcherIdentitySha256:canonicalDigest({...value.proof.launcher,ProcessId:99})};
  assert.throws(()=>createCleanupTransactionMarker({workspace:value.workspace,binding:value.binding,proof:mismatchedLauncher,journal:value.journal,statusAuthority:value.statusAuthority,createdAt:100,env:value.env}),/authenticated exit proof is invalid/);
  const invalidJournal={...value.journal,phases:{lease:'pending',registry:'done',artifacts:'pending'}};
  assert.throws(()=>createCleanupTransactionMarker({workspace:value.workspace,binding:value.binding,proof:value.proof,journal:invalidJournal,statusAuthority:value.statusAuthority,createdAt:100,env:value.env}),/journal phases are invalid/);
  const foreignFile=path.join(value.controller,'foreign-attempt.json');fs.writeFileSync(foreignFile,'{}');
  assert.throws(()=>createCleanupTransactionMarker({workspace:value.workspace,binding:{...value.binding,attemptFile:foreignFile},proof:value.proof,journal:value.journal,statusAuthority:value.statusAuthority,createdAt:100,env:value.env}),/outside the initiating workspace/);
 }finally{value.cleanup();}
});

test('no-process proof remains a distinct canonical marker proof',()=>{
 const value=fixture();
 try{
  const noProcess={version:1,kind:'no-process',runId:value.binding.runId,blockKey:value.binding.blockKey,attempt:value.binding.attempt,token:value.binding.token,recordedAt:100};
  const marker=createCleanupTransactionMarker({workspace:value.workspace,binding:value.binding,proof:noProcess,journal:value.journal,statusAuthority:value.statusAuthority,createdAt:100,env:value.env});
  assert.equal(marker.proof.kind,'no-process');
  assert.throws(()=>createCleanupTransactionMarker({workspace:value.workspace,binding:value.binding,proof:{...noProcess,pid:1},journal:value.journal,statusAuthority:value.statusAuthority,createdAt:100,env:value.env}),/no-process proof is invalid/);
 }finally{value.cleanup();}
});

test('semantic status digests are stable for equivalent values and reject non-JSON state',()=>{
 const left=cleanupTransactionStatusDigests({base:{result:{a:1,b:['x',true]}},target:{state:'done'}});
 const right=cleanupTransactionStatusDigests({base:{result:{b:['x',true],a:1}},target:{state:'done'}});
 assert.deepEqual(left,right);
 const protoSemantic=cleanupTransactionStatusDigests({base:JSON.parse('{"__proto__":{"changed":true}}'),target:{state:'done'}});
 const emptySemantic=cleanupTransactionStatusDigests({base:{},target:{state:'done'}});
 assert.notEqual(protoSemantic.baseSemanticSha256,emptySemantic.baseSemanticSha256,'an own __proto__ status field must remain semantic input');
 assert.throws(()=>cleanupTransactionStatusDigests({base:{state:undefined},target:{state:'done'}}),/status semantic value is invalid/);
});
