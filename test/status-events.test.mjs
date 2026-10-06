import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createStatusPublisher,readRunStatus,readEvents,watchRunStatus,renderRunStatus,latestRunId} from '../scripts/core/status-events.mjs';
const family=fileURLToPath(new URL('../temp/',import.meta.url));
function fixture(){
  fs.mkdirSync(family,{recursive:true});const workspace=fs.mkdtempSync(path.join(family,'status-'));
  const previousControllerRoot=process.env.ORCH_CONTROLLER_ROOT;
  const controllerRoot=fs.mkdtempSync(path.join(family,'status-controller-'));
  process.env.ORCH_CONTROLLER_ROOT=controllerRoot;
  const dir=path.join(workspace,'temp','orchestrator','runs','live');fs.mkdirSync(dir,{recursive:true});
  const sum={runId:'live',workspace,generation:1,executionMode:'headless',tasks:[{id:'T001',prompt:'first'},{id:'T002',prompt:'second'}],blocks:[{key:'B1',title:'linked',taskIds:['T001','T002']}],results:{B1:{status:'running',attempts:[{number:1}],launcher:{ProcessId:123}}},taskResults:{T001:{status:'running'},T002:{status:'pending'}}};
  return {workspace,dir,sum,close:()=>{if(previousControllerRoot===undefined)delete process.env.ORCH_CONTROLLER_ROOT;else process.env.ORCH_CONTROLLER_ROOT=previousControllerRoot;fs.rmSync(workspace,{recursive:true,force:true});fs.rmSync(controllerRoot,{recursive:true,force:true});}};
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

test('planning manifest cannot claim a completed or successful state without controller authority',()=>{
  const f=fixture();try{
    const file=path.join(f.dir,'manifest.json');
    fs.writeFileSync(file,JSON.stringify({runId:'live',workspace:f.workspace,tasks:f.sum.tasks,success:true,finishedAt:Date.now()}));
    assert.throws(()=>readRunStatus(f.workspace,'live'),/planning ledger|unauthenticated/i);
    fs.writeFileSync(file,JSON.stringify({runId:'live',workspace:f.workspace,tasks:f.sum.tasks,taskResults:{T001:{status:'verified'}}}));
    assert.throws(()=>readRunStatus(f.workspace,'live'),/planning ledger|unauthenticated/i);
  }finally{f.close();}
});

test('watch retries a summary-authority publication gap without emitting an unauthenticated snapshot',async()=>{
  const f=fixture();try{
    // A summary without the controller-owned digest is never emitted.  The
    // watcher retries the publication window and then fails closed at timeout.
    fs.writeFileSync(path.join(f.dir,'summary.json'),JSON.stringify({...f.sum,success:true,finishedAt:Date.now()}));
    const received=[];
    await assert.rejects(()=>watchRunStatus({workspace:f.workspace,runId:'live',intervalMs:10,timeoutMs:40,onEvent:e=>received.push(e)}),/authority|unauthenticated/i);
    assert.deepEqual(received,[]);
  }finally{f.close();}
});

test('status readers refuse a runs junction before following it outside the workspace',t=>{
  const root=fs.mkdtempSync(path.join(family,'status-boundary-'));
  const outside=fs.mkdtempSync(path.join(family,'status-outside-'));
  t.after(()=>{fs.rmSync(root,{recursive:true,force:true});fs.rmSync(outside,{recursive:true,force:true});});
  const runs=path.join(root,'temp','orchestrator','runs');
  fs.mkdirSync(path.dirname(runs),{recursive:true});
  try{fs.symlinkSync(outside,runs,'junction');}
  catch{try{fs.symlinkSync(outside,runs,'dir');}catch(error){if(error?.code==='EPERM')return;throw error;}}
  fs.mkdirSync(path.join(outside,'leak'),{recursive:true});
  fs.writeFileSync(path.join(outside,'leak','summary.json'),JSON.stringify({runId:'leak',workspace:root}));
  assert.throws(()=>latestRunId(root),/symbolic link|junction|reparse/i);
  assert.throws(()=>readRunStatus(root,'leak'),/symbolic link|junction|reparse/i);
  assert.throws(()=>readEvents(path.join(runs,'leak')),/symbolic link|junction|reparse/i);
  assert.throws(()=>createStatusPublisher(path.join(runs,'leak')),/symbolic link|junction|reparse/i);
});

test('status readers revalidate a ledger after a concurrent path replacement',t=>{
  const root=fs.mkdtempSync(path.join(family,'status-race-'));
  const outside=fs.mkdtempSync(path.join(family,'status-race-outside-'));
  t.after(()=>{fs.rmSync(root,{recursive:true,force:true});fs.rmSync(outside,{recursive:true,force:true});});
  const runDir=path.join(root,'temp','orchestrator','runs','race');
  fs.mkdirSync(runDir,{recursive:true});
  fs.writeFileSync(path.join(runDir,'summary.json'),JSON.stringify({runId:'race',workspace:root}));
  const externalDir=path.join(outside,'race');fs.mkdirSync(externalDir,{recursive:true});
  fs.writeFileSync(path.join(externalDir,'summary.json'),JSON.stringify({runId:'race',workspace:root,secret:'EXTERNAL-SECRET-READ'}));
  const originalOpen=fs.openSync;
  let swapped=false;
  fs.openSync=function(file,...args){
    if(!swapped&&path.basename(String(file))==='summary.json'){
      swapped=true;
      fs.rmSync(runDir,{recursive:true,force:true});
      try{fs.symlinkSync(externalDir,runDir,'junction');}
      catch{fs.symlinkSync(externalDir,runDir,'dir');}
    }
    return originalOpen.call(this,file,...args);
  };
  try{assert.throws(()=>readRunStatus(root,'race'),/symbolic link|junction|reparse/i);}
  finally{fs.openSync=originalOpen;}
});

test('status readers reject an ABA replacement by comparing the open ledger identity',t=>{
  const root=fs.mkdtempSync(path.join(family,'status-aba-'));
  const outside=fs.mkdtempSync(path.join(family,'status-aba-outside-'));
  t.after(()=>{fs.rmSync(root,{recursive:true,force:true});fs.rmSync(outside,{recursive:true,force:true});});
  const runDir=path.join(root,'temp','orchestrator','runs','race');
  fs.mkdirSync(runDir,{recursive:true});
  fs.writeFileSync(path.join(runDir,'summary.json'),JSON.stringify({runId:'race',workspace:root}));
  const externalDir=path.join(outside,'race');fs.mkdirSync(externalDir,{recursive:true});
  fs.writeFileSync(path.join(externalDir,'summary.json'),JSON.stringify({runId:'race',workspace:root,secret:'EXTERNAL-SECRET-READ'}));
  const originalOpen=fs.openSync;
  let swapped=false;
  fs.openSync=function(file,...args){
    if(!swapped&&path.basename(String(file))==='summary.json'){
      swapped=true;
      const parked=runDir+'.parked';fs.renameSync(runDir,parked);
      try{fs.symlinkSync(externalDir,runDir,'junction');}
      catch{fs.symlinkSync(externalDir,runDir,'dir');}
      const fd=originalOpen.call(this,file,...args);
      fs.unlinkSync(runDir);fs.renameSync(parked,runDir);
      return fd;
    }
    return originalOpen.call(this,file,...args);
  };
  try{assert.throws(()=>readRunStatus(root,'race'),/changed during read|reparse/i);}
  finally{fs.openSync=originalOpen;}
});

test('status publisher revalidates before appending after a concurrent path replacement',t=>{
  const root=fs.mkdtempSync(path.join(family,'status-publish-race-'));
  const outside=fs.mkdtempSync(path.join(family,'status-publish-race-outside-'));
  t.after(()=>{fs.rmSync(root,{recursive:true,force:true});fs.rmSync(outside,{recursive:true,force:true});});
  const runDir=path.join(root,'temp','orchestrator','runs','race');
  fs.mkdirSync(runDir,{recursive:true});
  const externalDir=path.join(outside,'race');fs.mkdirSync(externalDir,{recursive:true});
  const eventsFile=path.join(externalDir,'events.jsonl');fs.writeFileSync(eventsFile,'OUTSIDE-BEFORE\n');
  const sum={runId:'race',workspace:root,generation:1,tasks:[{id:'T001',prompt:'safe'}],blocks:[{key:'B1',title:'safe',taskIds:['T001']}],results:{B1:{status:'running',attempts:[{number:1}]}},taskResults:{T001:{status:'running'}}};
  const publisher=createStatusPublisher(runDir);
  const originalOpen=fs.openSync;
  let swapped=false;
  fs.openSync=function(file,...args){
    if(!swapped&&path.basename(String(file))==='events.jsonl'){
      swapped=true;
      fs.rmSync(runDir,{recursive:true,force:true});
      try{fs.symlinkSync(externalDir,runDir,'junction');}
      catch{fs.symlinkSync(externalDir,runDir,'dir');}
    }
    return originalOpen.call(this,file,...args);
  };
  try{assert.throws(()=>publisher.publish(sum),/symbolic link|junction|reparse/i);}
  finally{fs.openSync=originalOpen;}
  assert.equal(fs.readFileSync(eventsFile,'utf8'),'OUTSIDE-BEFORE\n');
});

test('status publisher guards the atomic snapshot before a concurrent directory replacement',t=>{
  const root=fs.mkdtempSync(path.join(family,'status-summary-race-'));
  const outside=fs.mkdtempSync(path.join(family,'status-summary-race-outside-'));
  t.after(()=>{fs.rmSync(root,{recursive:true,force:true});fs.rmSync(outside,{recursive:true,force:true});});
  const runDir=path.join(root,'temp','orchestrator','runs','race');
  fs.mkdirSync(runDir,{recursive:true});
  const externalDir=path.join(outside,'race');fs.mkdirSync(externalDir,{recursive:true});
  const sum={runId:'race',workspace:root,generation:1,tasks:[{id:'T001',prompt:'SECRET-SNAPSHOT'}],blocks:[{key:'B1',title:'safe',taskIds:['T001']}],results:{B1:{status:'running',attempts:[{number:1}]}},taskResults:{T001:{status:'running'}}};
  const publisher=createStatusPublisher(runDir);
  const originalMkdir=fs.mkdirSync;
  let swapped=false;
  fs.mkdirSync=function(dir,...args){
    if(!swapped&&path.resolve(String(dir))===path.resolve(runDir)){
      swapped=true;
      fs.rmSync(runDir,{recursive:true,force:true});
      try{fs.symlinkSync(externalDir,runDir,'junction');}
      catch{fs.symlinkSync(externalDir,runDir,'dir');}
    }
    return originalMkdir.call(this,dir,...args);
  };
  try{assert.throws(()=>publisher.publish(sum),/symbolic link|junction|reparse/i);}
  finally{fs.mkdirSync=originalMkdir;}
  assert.equal(fs.existsSync(path.join(externalDir,'summary.json')),false);
});

test('latest run selection revalidates after the runs directory is replaced',t=>{
  const root=fs.mkdtempSync(path.join(family,'status-latest-race-'));
  const outside=fs.mkdtempSync(path.join(family,'status-latest-race-outside-'));
  t.after(()=>{fs.rmSync(root,{recursive:true,force:true});fs.rmSync(outside,{recursive:true,force:true});});
  const runs=path.join(root,'temp','orchestrator','runs');
  const externalRuns=path.join(outside,'runs');
  fs.mkdirSync(runs,{recursive:true});fs.mkdirSync(path.join(externalRuns,'leak'),{recursive:true});
  fs.writeFileSync(path.join(externalRuns,'leak','summary.json'),JSON.stringify({runId:'leak',workspace:root}));
  const originalReadDir=fs.readdirSync;
  let swapped=false;
  fs.readdirSync=function(dir,...args){
    const entries=originalReadDir.call(this,dir,...args);
    if(!swapped&&path.resolve(String(dir))===path.resolve(runs)){
      swapped=true;
      fs.rmSync(runs,{recursive:true,force:true});
      try{fs.symlinkSync(externalRuns,runs,'junction');}
      catch{fs.symlinkSync(externalRuns,runs,'dir');}
    }
    return entries;
  };
  try{assert.throws(()=>latestRunId(root),/symbolic link|junction|reparse/i);}
  finally{fs.readdirSync=originalReadDir;}
});

test('watch refuses events belonging to another run',async()=>{
  const f=fixture();try{
    createStatusPublisher(f.dir).publish(f.sum,'task.started');
    fs.writeFileSync(path.join(f.dir,'events.jsonl'),JSON.stringify({schema:1,seq:2,runId:'foreign',type:'run.finished',finishedAt:1})+'\n');
    const received=[];
    await assert.rejects(()=>watchRunStatus({workspace:f.workspace,runId:'live',intervalMs:10,timeoutMs:100,onEvent:e=>received.push(e)}),/identity/i);
    assert.ok(received.every(e=>e.runId==='live'));
  }finally{f.close();}
});

test('watch does not terminate or publish a forged terminal event',async()=>{
  const f=fixture();try{
    createStatusPublisher(f.dir).publish(f.sum,'task.started');
    const received=[];
    await assert.rejects(()=>watchRunStatus({workspace:f.workspace,runId:'live',intervalMs:10,timeoutMs:60,onEvent:event=>{
      received.push(event);
      if(event.type==='snapshot')fs.appendFileSync(path.join(f.dir,'events.jsonl'),JSON.stringify({schema:1,seq:2,runId:'live',type:'run.finished',at:Date.now(),finishedAt:Date.now(),success:false})+'\n');
    }}),/timed out/i);
    assert.deepEqual(received.map(event=>event.type),['snapshot']);
  }finally{f.close();}
});

test('a fresh status publisher binds every later publication to its first run',()=>{
  const f=fixture();try{
    const publisher=createStatusPublisher(f.dir);
    publisher.publish(f.sum);
    assert.throws(()=>publisher.publish({...f.sum,runId:'foreign'}),/identity/i);
  }finally{f.close();}
});
