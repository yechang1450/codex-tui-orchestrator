import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createStatusPublisher,readRunStatus,readEvents,watchRunStatus,renderRunStatus} from '../scripts/core/status-events.mjs';
const family=fileURLToPath(new URL('../temp/',import.meta.url));
function fixture(){
  fs.mkdirSync(family,{recursive:true});const workspace=fs.mkdtempSync(path.join(family,'status-'));
  const dir=path.join(workspace,'temp','orchestrator','runs','live');fs.mkdirSync(dir,{recursive:true});
  const sum={runId:'live',workspace,generation:1,executionMode:'headless',tasks:[{id:'T001',prompt:'first'},{id:'T002',prompt:'second'}],blocks:[{key:'B1',title:'linked',taskIds:['T001','T002']}],results:{B1:{status:'running',attempts:[{number:1}],launcher:{ProcessId:123}}},taskResults:{T001:{status:'running'},T002:{status:'pending'}}};
  return {workspace,dir,sum,close:()=>fs.rmSync(workspace,{recursive:true,force:true})};
}
test('status snapshots distinguish the active task from the process and survive publisher resume',()=>{
  const f=fixture();try{
    createStatusPublisher(f.dir).publish(f.sum,'task.started');
    let snap=readRunStatus(f.workspace,'live');
    assert.deepEqual(snap.todoList.map(t=>t.status),['running','pending']);
    assert.equal(snap.executionStatus[0].pid,123);assert.equal(snap.executionStatus[0].mode,'headless');
    f.sum.taskResults.T001={status:'awaiting-verification'};
    createStatusPublisher(f.dir).publish(f.sum,'task.completed');
    snap=readRunStatus(f.workspace,'live');assert.equal(snap.eventSeq,2);
    assert.deepEqual(readEvents(f.dir).map(e=>e.seq),[1,2]);
    assert.match(renderRunStatus(snap),/TodoList/);assert.match(renderRunStatus(snap),/Execution/);
    assert.match(renderRunStatus(snap),/T002.*pending/);
  }finally{f.close();}
});
test('event reader ignores an incomplete final write and publisher recovers it without losing later transitions',()=>{
  const f=fixture();try{
    createStatusPublisher(f.dir).publish(f.sum,'block.running');
    fs.appendFileSync(path.join(f.dir,'events.jsonl'),'{"seq":');
    assert.equal(readEvents(f.dir).length,1);
    createStatusPublisher(f.dir).publish(f.sum,'block.verified');
    assert.deepEqual(readEvents(f.dir,{after:1}).map(e=>e.type),['block.verified']);
    fs.appendFileSync(path.join(f.dir,'events.jsonl'),'invalid\n');
    assert.throws(()=>readEvents(f.dir),/event/i);
    assert.throws(()=>readRunStatus(f.workspace,'../foreign'),/run.id/i);
  }finally{f.close();}
});
test('watch starts from the planning inventory and delivers live task changes before finalization without writing',async()=>{
  const f=fixture();const file=path.join(f.dir,'manifest.json');
  fs.writeFileSync(file,JSON.stringify({runId:'live',workspace:f.workspace,tasks:f.sum.tasks,executionMode:'headless'}));
  const original=fs.readFileSync(file,'utf8'),received=[];
  try{
    const publisher=createStatusPublisher(f.dir);
    const watching=watchRunStatus({workspace:f.workspace,runId:'live',intervalMs:10,timeoutMs:1000,onEvent:e=>{
      received.push(e);
      if(e.type==='snapshot')setTimeout(()=>publisher.publish(f.sum,'task.started'),20);
      if(e.type==='task.started')setTimeout(()=>{f.sum.finishedAt=Date.now();f.sum.success=false;publisher.publish(f.sum,'run.failed');},20);
    }});
    await watching;
    assert.deepEqual(received.map(e=>e.type),['snapshot','task.started','run.failed']);
    assert.equal(received[0].todoList.length,2);
    assert.deepEqual(received[1].todoList.map(t=>t.status),['running','pending']);
    assert.equal(fs.readFileSync(file,'utf8'),original);
    assert.equal(fs.readdirSync(f.dir).length,3);
  }finally{f.close();}
});
