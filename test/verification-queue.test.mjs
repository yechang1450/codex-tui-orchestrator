import {testTempFamily} from './test-temp-root.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createVerificationQueue} from '../scripts/core/verification-queue.mjs';
import {collectVerification} from '../scripts/core/runner.mjs';
import {recoveryTasks} from '../scripts/core/recovery.mjs';

test('verification queue is FIFO and never runs two inspections at once',async()=>{
  const q=createVerificationQueue(),events=[],release=[];let active=0,peak=0;
  const jobs=[1,2,3].map(id=>q.enqueue('B'+id,async()=>{
    active++;peak=Math.max(peak,active);events.push('start-'+id);
    await new Promise(resolve=>release.push(resolve));
    events.push('end-'+id);active--;
  }));
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(events,['start-1']);release.shift()();await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(events,['start-1','end-1','start-2']);release.shift()();await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(events,['start-1','end-1','start-2','end-2','start-3']);release.shift()();await Promise.all(jobs);
  assert.equal(peak,1);assert.deepEqual(q.stats(),{started:3,finished:3,maxConcurrency:1});
});

test('a failed inspection does not stop the following inspection',async()=>{
  const q=createVerificationQueue(),seen=[];
  await assert.rejects(q.enqueue('bad',async()=>{seen.push('bad');throw new Error('inspection failed');}),/inspection failed/);
  await q.enqueue('good',async()=>seen.push('good'));await q.drain();assert.deepEqual(seen,['bad','good']);
});

test('parent proves exited work without a child checkpoint and recovery never repeats proven work',()=>{
  const id='T1', dir=fs.mkdtempSync(path.join(testTempFamily('verification-queue'),'verification-proof-'));
  const file=path.join(dir,'attempt.json'), attempt={runId:'r',token:'t',taskIds:[id],file};
  fs.writeFileSync(file,JSON.stringify(attempt));
  try {
    const sum={runId:'r',blocks:[{key:'B1',taskIds:[id]}],results:{B1:{endedAt:1,exitConfirmed:true,attempts:[attempt]}},taskResults:{}};
    const checks={T1:[{type:'absent',path:'this-test-path-does-not-exist'}]};
    collectVerification(sum,checks,process.cwd(),{allowParentInspection:true});
    assert.equal(sum.taskResults.T1.status,'verified');
    assert.equal(sum.taskResults.T1.inspection.token,'t');
    collectVerification(sum,checks,process.cwd(),{allowParentInspection:true});
    assert.equal(sum.taskResults.T1.status,'verified','a second inspection retains parent proof');
    const recovery=recoveryTasks([{id}],{},checks,process.cwd(),sum.taskResults);
    assert.deepEqual(recovery.verified,[],'an inspection receipt without a durable child checkpoint is not verified on recovery');
    assert.deepEqual(recovery.pending,[id]);
    sum.results.B1.exitConfirmed=false;sum.taskResults={};
    collectVerification(sum,checks,process.cwd(),{allowParentInspection:true});
    assert.notEqual(sum.taskResults.T1.status,'verified','live or ambiguous process exit cannot grant success');
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
