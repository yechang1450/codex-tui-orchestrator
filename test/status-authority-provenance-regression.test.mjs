import {testTempFamily} from './test-temp-root.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {
  createCleanupStatusAuthorityBinding,
  createStatusPublisher,
  readRunStatus,
  repairStatusAuthorityFromCleanupMarker,
} from '../scripts/core/status-events.mjs';
import {
  cleanupTransactionMarkerFile,
  cleanupTransactionStatusDigests,
  createCleanupTransactionMarker,
  readCleanupTransactionMarker,
  writeCleanupTransactionMarker,
} from '../scripts/core/cleanup-transaction.mjs';
import {controllerStateDir} from '../scripts/core/controller-state.mjs';
import {physicalPathIdentity} from '../scripts/core/runtime-context.mjs';

const family=testTempFamily('status-authority-provenance-regression');
const sha256=value=>crypto.createHash('sha256').update(String(value),'utf8').digest('hex');
const readJson=file=>JSON.parse(fs.readFileSync(file,'utf8'));

function statusAuthorityFile(workspace,runId,env){
  return path.join(controllerStateDir(workspace,env),'status',sha256(physicalPathIdentity(workspace)),runId+'.json');
}

function durableSnapshot(value){
  return {
    summary:fs.readFileSync(value.summaryFile,'utf8'),
    authority:fs.readFileSync(value.authorityFile,'utf8'),
    events:fs.readFileSync(value.eventsFile,'utf8'),
    marker:fs.existsSync(value.markerFile)?fs.readFileSync(value.markerFile,'utf8'):null,
  };
}

function fixture({persistMarker=false}={}){
  fs.mkdirSync(family,{recursive:true});
  const workspace=fs.mkdtempSync(path.join(family,'status-authority-provenance-workspace-'));
  const controller=fs.mkdtempSync(path.join(family,'status-authority-provenance-controller-'));
  const env={...process.env,ORCH_CONTROLLER_ROOT:controller};
  const runId='status-authority-provenance-run',blockKey='B1',attempt=1,token='status-authority-provenance-token';
  const dir=path.join(workspace,'temp','orchestrator','runs',runId);
  fs.mkdirSync(dir,{recursive:true});
  const initial={
    runId,workspace,generation:1,executionMode:'visible',
    tasks:[{id:'T001',prompt:'provenance fixture'}],
    blocks:[{key:blockKey,title:'provenance fixture',taskIds:['T001']}],
    results:{[blockKey]:{status:'running',attempts:[{number:attempt}]}},
    taskResults:{T001:{status:'running'}},
  };
  createStatusPublisher(dir,{env}).publish(initial,'block.running');
  const source=readJson(path.join(dir,'summary.json'));
  const target=structuredClone(source);
  target.results[blockKey]={...target.results[blockKey],status:'cleanup-pending',reason:'Post-exit cleanup is pending',endedAt:source.updatedAt+1,
    cleanupPending:{version:1,kind:'post-exit-cleanup',runId,blockKey,attempt,token,
      lease:{id:'lease-provenance',instanceId:crypto.randomUUID()},phases:{lease:'pending',registry:'pending',artifacts:'pending'},recordedAt:100,updatedAt:100}};
  target.taskResults.T001={status:'needs-reconciliation',reason:'Post-exit cleanup is pending'};
  target.eventSeq=source.eventSeq+1;
  target.updatedAt=source.updatedAt+1;

  const lease=target.results[blockKey].cleanupPending.lease;
  const attemptFile=path.join(dir,'attempts',blockKey,String(attempt),'attempt.json');
  fs.mkdirSync(path.dirname(attemptFile),{recursive:true});
  fs.writeFileSync(attemptFile,JSON.stringify({runId,blockKey,number:attempt,token}));
  const coordinator=path.join(controller,'coordinator');
  fs.mkdirSync(coordinator,{recursive:true});
  const binding={
    runId,blockKey,attempt,token,attemptFile,coordinator,lease,
    status:cleanupTransactionStatusDigests({base:source,target}),
  };
  const journal={
    version:1,kind:'post-exit-cleanup',runId,blockKey,attempt,token,lease:{...lease},
    phases:{lease:'pending',registry:'pending',artifacts:'pending'},recordedAt:100,updatedAt:100,
  };
  const proof={version:1,kind:'no-process',runId,blockKey,attempt,token,recordedAt:100};
  const statusAuthority=createCleanupStatusAuthorityBinding({workspace,runId,source,target});
  const marker=createCleanupTransactionMarker({
    workspace,binding,proof,journal,statusAuthority,createdAt:100,env,
  });
  const markerFile=cleanupTransactionMarkerFile({workspace,binding,env});
  if(persistMarker)writeCleanupTransactionMarker({workspace,binding,marker,env});
  const summaryFile=path.join(dir,'summary.json');
  const eventsFile=path.join(dir,'events.jsonl');
  const authorityFile=statusAuthorityFile(workspace,runId,env);
  return {
    workspace,controller,env,runId,dir,source,target,binding,marker,markerFile,summaryFile,eventsFile,authorityFile,
    setTargetSummary(){fs.writeFileSync(summaryFile,JSON.stringify(target));},
    cleanup(){fs.rmSync(workspace,{recursive:true,force:true});fs.rmSync(controller,{recursive:true,force:true});},
  };
}

test('status authority repair rejects an in-memory cleanup marker when no controller marker exists',()=>{
  const value=fixture();
  try{
    value.setTargetSummary();
    const before=durableSnapshot(value);
    const forged=structuredClone(value.marker);
    assert.throws(
      ()=>repairStatusAuthorityFromCleanupMarker({workspace:value.workspace,runId:value.runId,binding:value.binding,marker:forged,env:value.env}),
      /controller.*marker|marker.*controller|binding/i,
      'a caller-supplied marker must never authorize a status authority replacement',
    );
    assert.deepEqual(durableSnapshot(value),before,'a rejected memory-only marker must leave summary, authority, events, and marker state unchanged');
  }finally{value.cleanup();}
});

test('status authority repair rejects an incomplete binding before it reads a persisted marker',()=>{
  const value=fixture({persistMarker:true});
  try{
    value.setTargetSummary();
    const before=durableSnapshot(value);
    const incomplete={...value.binding,token:''};
    assert.throws(
      ()=>repairStatusAuthorityFromCleanupMarker({workspace:value.workspace,runId:value.runId,binding:incomplete,env:value.env}),
      /binding|token|attempt/i,
      'marker lookup must be bound to the complete immutable attempt identity',
    );
    assert.deepEqual(durableSnapshot(value),before,'an incomplete binding must not advance controller authority or mutate durable ledgers');
  }finally{value.cleanup();}
});

test('status authority repair reads the persisted controller marker through its complete binding',()=>{
  const value=fixture({persistMarker:true});
  try{
    value.setTargetSummary();
    const before=durableSnapshot(value);
    assert.deepEqual(readCleanupTransactionMarker({workspace:value.workspace,binding:value.binding,env:value.env}),value.marker,'fixture must use a validated controller marker');

    const result=repairStatusAuthorityFromCleanupMarker({workspace:value.workspace,runId:value.runId,binding:value.binding,env:value.env});

    assert.deepEqual(result,{repaired:true,runId:value.runId,
      fromSummarySha256:value.marker.statusAuthority.source.summarySha256,
      toSummarySha256:value.marker.statusAuthority.target.summarySha256});
    const after=durableSnapshot(value);
    assert.equal(after.summary,before.summary,'repair must not rewrite the target workspace summary');
    assert.equal(after.events,before.events,'repair must not append a synthetic status event');
    assert.equal(after.marker,before.marker,'repair must only read the controller marker');
    assert.notEqual(after.authority,before.authority,'target summary with source authority must repair the controller authority');
    assert.equal(readRunStatus(value.workspace,value.runId,{env:value.env}).results.B1.status,'cleanup-pending');
  }finally{value.cleanup();}
});
