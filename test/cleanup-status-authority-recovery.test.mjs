import {testTempFamily} from './test-temp-root.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createStatusPublisher,createCleanupStatusAuthorityBinding,readRunStatus,repairStatusAuthorityFromCleanupMarker} from '../scripts/core/status-events.mjs';
import {controllerStateDir} from '../scripts/core/controller-state.mjs';
import {physicalPathIdentity} from '../scripts/core/runtime-context.mjs';
import {cleanupTransactionMarkerFile,cleanupTransactionStatusDigests,createCleanupTransactionMarker,writeCleanupTransactionMarker} from '../scripts/core/cleanup-transaction.mjs';

const family=testTempFamily('cleanup-status-authority-recovery');
const sha256=value=>crypto.createHash('sha256').update(String(value),'utf8').digest('hex');
const readJson=file=>JSON.parse(fs.readFileSync(file,'utf8'));

function authorityFile(workspace,runId,env){
  return path.join(controllerStateDir(workspace,env),'status',sha256(physicalPathIdentity(workspace)),runId+'.json');
}

function fixture(){
  fs.mkdirSync(family,{recursive:true});
  const workspace=fs.mkdtempSync(path.join(family,'cleanup-status-authority-workspace-'));
  const controller=fs.mkdtempSync(path.join(family,'cleanup-status-authority-controller-'));
  const env={ORCH_CONTROLLER_ROOT:controller};
  const runId='cleanup-status';
  const dir=path.join(workspace,'temp','orchestrator','runs',runId);fs.mkdirSync(dir,{recursive:true});
  const sum={runId,workspace,generation:1,executionMode:'visible',tasks:[{id:'T001',prompt:'cleanup proof'}],blocks:[{key:'B1',title:'cleanup proof',taskIds:['T001']}],
    results:{B1:{status:'running',attempts:[{number:1}]}},taskResults:{T001:{status:'running'}}};
  createStatusPublisher(dir,{env}).publish(sum,'block.running');
  const source=readJson(path.join(dir,'summary.json'));
  const target=structuredClone(source);
  target.results.B1={...target.results.B1,status:'cleanup-pending',reason:'Post-exit cleanup is pending',endedAt:source.updatedAt+1,
    cleanupPending:{version:1,kind:'post-exit-cleanup',runId,blockKey:'B1',attempt:1,token:'cleanup-status-authority-token',
      lease:{id:'lease-cleanup',instanceId:'11111111-1111-4111-8111-111111111111'},phases:{lease:'pending',registry:'pending',artifacts:'pending'},recordedAt:1,updatedAt:1}};
  target.taskResults.T001={status:'needs-reconciliation',reason:'Post-exit cleanup is pending'};
  target.eventSeq=source.eventSeq+1;target.updatedAt=source.updatedAt+1;
  const statusAuthority=createCleanupStatusAuthorityBinding({workspace,runId,source,target});
  const blockKey='B1',attempt=1,token='cleanup-status-authority-token',lease={id:'lease-cleanup',instanceId:'11111111-1111-4111-8111-111111111111'};
  const attemptFile=path.join(dir,'attempts',blockKey,String(attempt),'attempt.json');fs.mkdirSync(path.dirname(attemptFile),{recursive:true});
  fs.writeFileSync(attemptFile,JSON.stringify({runId,blockKey,number:attempt,token,leaseId:lease.id,leaseInstanceId:lease.instanceId,taskIds:['T001'],file:attemptFile}));
  const coordinator=path.join(controller,'coordinator');fs.mkdirSync(coordinator,{recursive:true});
  const markerBinding={runId,blockKey,attempt,token,attemptFile,coordinator,lease,status:cleanupTransactionStatusDigests({base:{kind:'cleanup-status-source'},target:{kind:'cleanup-status-target'}})};
  const journal={version:1,kind:'post-exit-cleanup',runId,blockKey,attempt,token,lease:{...lease},phases:{lease:'pending',registry:'pending',artifacts:'pending'},recordedAt:1,updatedAt:1};
  const proof={version:1,kind:'no-process',runId,blockKey,attempt,token,recordedAt:1};
  const marker=createCleanupTransactionMarker({workspace,binding:markerBinding,proof,journal,statusAuthority,createdAt:1,env});
  writeCleanupTransactionMarker({workspace,binding:markerBinding,marker,env});
  const {status,...binding}=markerBinding;
  const cleanup=()=>{fs.rmSync(workspace,{recursive:true,force:true});fs.rmSync(controller,{recursive:true,force:true});};
  return {workspace,controller,env,runId,dir,source,target,statusAuthority,marker,markerBinding,binding,cleanup};
}

test('a controller cleanup marker repairs only the summary-to-authority crash gap without emitting an event',()=>{
  const f=fixture();try{
    const summaryFile=path.join(f.dir,'summary.json'),eventsFile=path.join(f.dir,'events.jsonl'),authority=authorityFile(f.workspace,f.runId,f.env);
    const sourceAuthority=fs.readFileSync(authority,'utf8'),eventsBefore=fs.readFileSync(eventsFile,'utf8');
    assert.deepEqual(repairStatusAuthorityFromCleanupMarker({workspace:f.workspace,runId:f.runId,binding:f.binding,env:f.env}),{repaired:false,runId:f.runId,state:'source'},'the untouched source/source state is idempotent');
    assert.equal(fs.readFileSync(authority,'utf8'),sourceAuthority);
    assert.equal(fs.readFileSync(eventsFile,'utf8'),eventsBefore);
    fs.writeFileSync(summaryFile,JSON.stringify(f.target));

    const result=repairStatusAuthorityFromCleanupMarker({workspace:f.workspace,runId:f.runId,binding:f.binding,env:f.env});
    assert.deepEqual(result,{repaired:true,runId:f.runId,fromSummarySha256:f.statusAuthority.source.summarySha256,toSummarySha256:f.statusAuthority.target.summarySha256});
    assert.notEqual(fs.readFileSync(authority,'utf8'),sourceAuthority,'the controller authority must advance to the bound target');
    assert.equal(fs.readFileSync(eventsFile,'utf8'),eventsBefore,'authority repair must not manufacture a status event');
    assert.equal(fs.readFileSync(summaryFile,'utf8'),JSON.stringify(f.target),'authority repair must not rewrite the workspace summary');
    assert.equal(readRunStatus(f.workspace,f.runId,{env:f.env}).results.B1.status,'cleanup-pending');
    assert.deepEqual(repairStatusAuthorityFromCleanupMarker({workspace:f.workspace,runId:f.runId,binding:f.binding,env:f.env}),{repaired:false,runId:f.runId,state:'target'},'the target/target state is idempotent');
  }finally{f.cleanup();}
});

test('cleanup authority recovery rejects a summary outside its marker transition and leaves controller state untouched',()=>{
  const f=fixture();try{
    const summaryFile=path.join(f.dir,'summary.json'),eventsFile=path.join(f.dir,'events.jsonl'),authority=authorityFile(f.workspace,f.runId,f.env);
    const tampered=structuredClone(f.target);tampered.results.B1.reason='worker changed unrelated status';
    fs.writeFileSync(summaryFile,JSON.stringify(tampered));
    const beforeAuthority=fs.readFileSync(authority,'utf8'),beforeEvents=fs.readFileSync(eventsFile,'utf8');
    assert.throws(()=>repairStatusAuthorityFromCleanupMarker({workspace:f.workspace,runId:f.runId,binding:f.binding,env:f.env}),/outside the marker transition/i);
    assert.equal(fs.readFileSync(authority,'utf8'),beforeAuthority);
    assert.equal(fs.readFileSync(eventsFile,'utf8'),beforeEvents);
  }finally{f.cleanup();}
});

test('cleanup authority recovery refuses a backward source summary after the target authority is durable',()=>{
  const f=fixture();try{
    const summaryFile=path.join(f.dir,'summary.json'),eventsFile=path.join(f.dir,'events.jsonl'),authority=authorityFile(f.workspace,f.runId,f.env);
    fs.writeFileSync(summaryFile,JSON.stringify(f.target));
    repairStatusAuthorityFromCleanupMarker({workspace:f.workspace,runId:f.runId,binding:f.binding,env:f.env});
    const targetAuthority=fs.readFileSync(authority,'utf8'),eventsBefore=fs.readFileSync(eventsFile,'utf8');
    fs.writeFileSync(summaryFile,JSON.stringify(f.source));
    assert.throws(()=>repairStatusAuthorityFromCleanupMarker({workspace:f.workspace,runId:f.runId,binding:f.binding,env:f.env}),/backward or mixed/i);
    assert.equal(fs.readFileSync(authority,'utf8'),targetAuthority);
    assert.equal(fs.readFileSync(eventsFile,'utf8'),eventsBefore);
  }finally{f.cleanup();}
});

test('cleanup authority recovery requires both marker-bound target digest and acceptance invariant',()=>{
  const f=fixture();try{
    const summaryFile=path.join(f.dir,'summary.json'),authority=authorityFile(f.workspace,f.runId,f.env);
    fs.writeFileSync(summaryFile,JSON.stringify(f.target));
    const markerFile=cleanupTransactionMarkerFile({workspace:f.workspace,binding:f.markerBinding,env:f.env});
    const forged=JSON.parse(fs.readFileSync(markerFile,'utf8'));forged.statusAuthority.target.acceptanceInvariantSha256='f'.repeat(64);fs.writeFileSync(markerFile,JSON.stringify(forged));
    const before=fs.readFileSync(authority,'utf8');
    assert.throws(()=>repairStatusAuthorityFromCleanupMarker({workspace:f.workspace,runId:f.runId,binding:f.binding,env:f.env}),/outside the marker transition/i);
    assert.equal(fs.readFileSync(authority,'utf8'),before);
  }finally{f.cleanup();}
});

test('publisher gives a cleanup marker writer the fixed authenticated source and exact public target before summary replacement',()=>{
  const f=fixture();try{
    const summaryFile=path.join(f.dir,'summary.json'),eventsFile=path.join(f.dir,'events.jsonl'),authority=authorityFile(f.workspace,f.runId,f.env);
    const sourceText=fs.readFileSync(summaryFile,'utf8'),sourceAuthority=fs.readFileSync(authority,'utf8'),eventsBefore=fs.readFileSync(eventsFile,'utf8');
    const next=structuredClone(f.source);
    next.results.B1={...next.results.B1,status:'cleanup-pending',reason:'Post-exit cleanup is pending'};
    let received;
    createStatusPublisher(f.dir,{env:f.env}).publish(next,'block.B1.cleanup-pending',{beforeSummaryWrite:boundary=>{
      received=boundary;
      assert.equal(fs.readFileSync(summaryFile,'utf8'),sourceText,'the callback must run before the workspace summary is replaced');
      assert.equal(fs.readFileSync(authority,'utf8'),sourceAuthority,'the callback must run before controller authority advances');
      assert.equal(boundary.kind,'cleanup-status-authority');
      assert.equal(Object.isFrozen(boundary.statusAuthority),true);
      assert.equal(Object.isFrozen(boundary.statusAuthority.source),true);
      assert.equal(Object.isFrozen(boundary.statusAuthority.target),true);
    }});
    const target=readJson(summaryFile),targetAuthority=readJson(authority);
    assert.ok(received);
    assert.equal(targetAuthority.sha256,received.statusAuthority.target.summarySha256);
    assert.equal(targetAuthority.acceptanceInvariantSha256,received.statusAuthority.target.acceptanceInvariantSha256);
    assert.equal(received.statusAuthority.source.summarySha256,JSON.parse(sourceAuthority).sha256);
    assert.notEqual(fs.readFileSync(eventsFile,'utf8'),eventsBefore,'the ordinary publisher may append its one real status event after committing authority');
    assert.equal(readRunStatus(f.workspace,f.runId,{env:f.env}).eventSeq,target.eventSeq);
  }finally{f.cleanup();}
});

test('publisher refuses an asynchronous cleanup pre-write hook before replacing its summary',()=>{
  const f=fixture();try{
    const summaryFile=path.join(f.dir,'summary.json'),eventsFile=path.join(f.dir,'events.jsonl'),authority=authorityFile(f.workspace,f.runId,f.env);
    const before={summary:fs.readFileSync(summaryFile,'utf8'),events:fs.readFileSync(eventsFile,'utf8'),authority:fs.readFileSync(authority,'utf8')};
    const next=structuredClone(f.source);next.results.B1={...next.results.B1,status:'cleanup-pending'};
    assert.throws(()=>createStatusPublisher(f.dir,{env:f.env}).publish(next,'block.B1.cleanup-pending',{beforeSummaryWrite:()=>Promise.resolve()}),/must finish synchronously/i);
    assert.equal(fs.readFileSync(summaryFile,'utf8'),before.summary);
    assert.equal(fs.readFileSync(eventsFile,'utf8'),before.events);
    assert.equal(fs.readFileSync(authority,'utf8'),before.authority);
  }finally{f.cleanup();}
});
