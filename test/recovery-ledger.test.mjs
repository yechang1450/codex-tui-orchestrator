import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateRecoverySummary,validateSavedLauncherFiles} from '../scripts/core/recovery.mjs';
import {runWindows,verifyRun} from '../scripts/core/runner.mjs';
import {recordCheckpoint} from '../scripts/core/checkpoint.mjs';
import {buildTodoList} from '../scripts/core/contracts.mjs';
import {recoveryTasks} from '../scripts/core/recovery.mjs';

function fixture(workspace) {
 return {protocol:2,runId:'ledger',workspace,request:'first;second',generation:1,history:[],
  tasks:[{id:'T001',prompt:'first'},{id:'T002',prompt:'second'}],
  plan:[{key:'B1',title:'both',keys:[],dependsOn:[],b:{tasks:[{sourceIds:['T001','T002']}]}}],
  blocks:[{key:'B1',taskIds:['T001','T002']}],results:{B1:{status:'pending',attempts:[]}},
  taskResults:{T001:{status:'pending'},T002:{status:'pending'}}};
}
test('saved recovery ledger rejects inconsistent inventories without mutating input',()=>{
 const valid=fixture(process.cwd()),before=JSON.stringify(valid);
 validateRecoverySummary(valid);assert.equal(JSON.stringify(valid),before);
 const changes=[s=>s.tasks.pop(),s=>s.tasks[0].prompt='changed',s=>s.blocks[0].taskIds.pop(),
  s=>s.blocks[0].taskIds.push('T001'),s=>s.plan=[],s=>s.plan[0].b.tasks[0].sourceIds.reverse(),
  s=>delete s.results.B1,s=>s.results.extra={},s=>delete s.taskResults.T001,
  s=>s.generation=0,s=>s.history=null,s=>delete s.runId,s=>s.runId='',s=>s.runId='../foreign',s=>s.runId=123,s=>s.executionMode='unknown',s=>s.plan[0].dependsOn=['B1'],
  s=>s.results.B1.status='running',s=>s.results.B1.launcherFiles={pidf:'window.pid'},
  s=>s.results.B1.attempts=null,s=>s.results.B1.attempts=[{runId:'foreign',token:'t',file:'x',taskIds:['T001']}]];
 for(const change of changes){const value=structuredClone(valid);change(value);const saved=JSON.stringify(value);
  assert.throws(()=>validateRecoverySummary(value),/Invalid recovery ledger/);
  assert.equal(JSON.stringify(value),saved);
 }
});

test('saved recovery ledger rejects a stale TodoList status',()=>{
 const saved=fixture(process.cwd());
 saved.todoList=buildTodoList(saved.tasks,saved.blocks,saved.taskResults);
 saved.taskResults.T001={status:'verified'};
 assert.throws(()=>validateRecoverySummary(saved),/todo list status mismatch/);
});

test('saved recovery checkpoints must belong to a recorded attempt before recovery can run',()=>{
 const saved=fixture(process.cwd());
 const attempt={runId:'ledger',token:'attempt-token',file:'attempt.json',taskIds:['T001']};
 const checkpoint={id:'T001',runId:'ledger',token:'attempt-token',state:'completed'};
 saved.results.B1={status:'failed',endedAt:1,attempts:[attempt]};
 saved.taskResults.T001={status:'failed',checkpoint};
 validateRecoverySummary(saved);
 for(const change of [{id:'T002'},{runId:'foreign'},{token:'foreign'},{state:'unexpected'},{id:undefined},{token:undefined}]){
  const damaged=structuredClone(saved);Object.assign(damaged.taskResults.T001.checkpoint,change);
  assert.throws(()=>validateRecoverySummary(damaged),/Invalid recovery ledger/,JSON.stringify(change));
 }
 const unrecorded=structuredClone(saved);unrecorded.results.B1.attempts=[];
 assert.throws(()=>validateRecoverySummary(unrecorded),/Invalid recovery ledger/);
 const invalid=structuredClone(saved);invalid.taskResults.T001.checkpoint={state:'invalid'};
 validateRecoverySummary(invalid);
});
test('visible launcher evidence is bound to the current run token before adoption',()=>{
 const root=fs.mkdtempSync(path.join(fileURLToPath(new URL('../temp/',import.meta.url)),'launcher-binding-'));
 try{
  const runId='ledger',workspace=root,attemptFile=path.join(root,'temp','orchestrator','runs',runId,'attempts','B1','1','attempt.json');
  fs.mkdirSync(path.dirname(attemptFile),{recursive:true});
  const attempt={runId,token:'ledger-B1-a1-token',number:1,file:attemptFile,taskIds:['T001']};
  const dir=path.join(root,'temp'),suffix='foreign-a1',files={lp:path.join(dir,'win-launch-'+suffix+'.ps1'),pf:path.join(dir,'agent-win-'+suffix+'.md'),pidf:path.join(dir,'window-'+suffix+'.pid'),rf:path.join(dir,'win-'+suffix+'.result.json')};
  fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(files.lp,`$token = '${attempt.token}'`);fs.writeFileSync(files.pf,'__ORCH_DONE__ '+attempt.token);fs.writeFileSync(files.pidf,'123');
  const sum={runId,workspace};const entry={token:attempt.token,launcherFiles:files};
  assert.throws(()=>validateSavedLauncherFiles(sum,{key:'B1'},entry,attempt,{requireLiveFiles:true}),/bound to this run attempt/);
  files.lp=path.join(dir,'win-launch-'+runId+'-a1.ps1');files.pf=path.join(dir,'agent-win-'+runId+'-a1.md');files.pidf=path.join(dir,'window-'+runId+'-a1.pid');files.rf=path.join(dir,'win-'+runId+'-a1.result.json');
  fs.writeFileSync(files.lp,`$token = '${attempt.token}'`);fs.writeFileSync(files.pf,'__ORCH_DONE__ '+attempt.token);fs.writeFileSync(files.pidf,'123');
  validateSavedLauncherFiles(sum,{key:'B1'},entry,attempt,{requireLiveFiles:true});
  files.pf=path.join(dir,'agent-win-'+runId+'-a1.md');fs.writeFileSync(files.pf,'__ORCH_DONE__ foreign-token');
  assert.throws(()=>validateSavedLauncherFiles(sum,{key:'B1'},entry,attempt,{requireLiveFiles:true}),/ownership token mismatch/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('safe retry clears an old failed or verified task status before composing receipts',()=>{
 const dir=fs.mkdtempSync(path.join(fileURLToPath(new URL('../temp/',import.meta.url)),'retry-receipt-'));
 try {
  const result=recoveryTasks([{id:'T001',prompt:'retry'}],{T001:{state:'completed'}},{T001:{retrySafe:true,checks:[{type:'file',path:'missing'}]}},dir);
  assert.deepEqual(result.pending,['T001']);
  assert.equal(result.uncertain.length,0);
  assert.equal(result.results.T001.status,'pending');
  assert.equal(result.results.T001.checkpoint.state,'completed');
 } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
test('resume rejects damaged ledger before any hook or persisted state changes',async()=>{
 const family=fileURLToPath(new URL('../temp/',import.meta.url));fs.mkdirSync(family,{recursive:true});
 const root=fs.mkdtempSync(path.join(family,'ledger-corruption-'));
 try{
  const dir=path.join(root,'temp/orchestrator/runs/ledger');fs.mkdirSync(dir,{recursive:true});
  const saved=fixture(root);saved.blocks[0].taskIds.pop();saved.finishedAt=1;
  const file=path.join(dir,'summary.json'),raw=JSON.stringify(saved);fs.writeFileSync(file,raw);
  const checks=path.join(dir,'acceptance.json');fs.writeFileSync(checks,'{}');let calls=0;
  const hooks=new Proxy({}, {get(){calls++;throw new Error('Unexpected execution hook');}});
  await assert.rejects(runWindows('',hooks,{workspace:root,capacity:8,runId:'ledger',resume:true}),/Invalid recovery ledger/);
  assert.throws(()=>verifyRun(root,'ledger'),/Invalid recovery ledger/);
  assert.equal(calls,0);assert.equal(fs.readFileSync(file,'utf8'),raw);assert.equal(fs.readFileSync(checks,'utf8'),'{}');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('verifyRun rebuilds the local goal mirror from verified task state',()=>{
 const family=fileURLToPath(new URL('../temp/',import.meta.url));fs.mkdirSync(family,{recursive:true});
 const root=fs.mkdtempSync(path.join(family,'goal-refresh-'));
 try{
  const dir=path.join(root,'temp/orchestrator/runs/goal-refresh');fs.mkdirSync(dir,{recursive:true});
  const attemptFile=path.join(dir,'attempts','B1','1','attempt.json');fs.mkdirSync(path.dirname(attemptFile),{recursive:true});
  const attempt={runId:'goal-refresh',token:'token',taskIds:['T001']};fs.writeFileSync(attemptFile,JSON.stringify(attempt));
  recordCheckpoint(attemptFile,'T001','started');recordCheckpoint(attemptFile,'T001','completed');
  const tasks=[{id:'T001',prompt:'first'}],blocks=[{key:'B1',taskIds:['T001']}];
  const summary={protocol:2,runId:'goal-refresh',workspace:root,request:'first',capacity:8,generation:1,history:[],finishedAt:1,
   tasks,plan:[{key:'B1',title:'both',keys:[],dependsOn:[],b:{tasks:[{sourceIds:['T001']} ]}}],blocks,
   results:{B1:{status:'awaiting-verification',endedAt:1,attempts:[{...attempt,file:attemptFile}]}},
   taskResults:{T001:{status:'awaiting-verification'}},todoList:buildTodoList(tasks,blocks,{T001:{status:'awaiting-verification'}}),
   coordinator:path.join(root,'temp/orchestrator/coordinator')};
  fs.writeFileSync(path.join(dir,'summary.json'),JSON.stringify(summary));
  const evidence=path.join(root,'evidence.json');fs.writeFileSync(evidence,JSON.stringify({ok:true}));
  const checks=path.join(dir,'acceptance.json');fs.writeFileSync(checks,JSON.stringify({T001:[{type:'json',path:'evidence.json',equals:{ok:true}}]}));
  fs.writeFileSync(path.join(dir,'goal.json'),JSON.stringify({version:1,runId:'goal-refresh',workspace:root,objective:'first',status:'active',tasks:[{id:'T001',status:'pending',block:'B1'}],blocks:[{key:'B1',title:'both',status:'active',taskIds:['T001']}]}));
  assert.equal(verifyRun(root,'goal-refresh',checks),true);
  const goal=JSON.parse(fs.readFileSync(path.join(dir,'goal.json'),'utf8'));
  assert.equal(goal.status,'completed');assert.equal(goal.tasks[0].status,'verified');assert.equal(goal.summaryGeneration,1);
  const final=JSON.parse(fs.readFileSync(path.join(dir,'summary.json')));
  const event=JSON.parse(fs.readFileSync(path.join(dir,'events.jsonl'),'utf8').trim());
  assert.equal(event.type,'verify.completed');assert.equal(event.executionStatus[0].status,'verified');
  assert.equal(final.eventSeq,event.seq);assert.equal(goal.eventSeq,event.seq);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('resume rejects a goal mirror with a different run identity',async()=>{
 const family=fileURLToPath(new URL('../temp/',import.meta.url));fs.mkdirSync(family,{recursive:true});
 const root=fs.mkdtempSync(path.join(family,'goal-identity-'));
 try{
  const dir=path.join(root,'temp/orchestrator/runs/ledger');fs.mkdirSync(dir,{recursive:true});
  const saved=fixture(root);saved.finishedAt=1;fs.writeFileSync(path.join(dir,'summary.json'),JSON.stringify(saved));
  fs.writeFileSync(path.join(dir,'goal.json'),JSON.stringify({version:1,runId:'foreign',workspace:root}));
  fs.writeFileSync(path.join(dir,'acceptance.json'),'{}');let calls=0;
  const hooks=new Proxy({}, {get(){calls++;throw new Error('Unexpected execution hook');}});
  await assert.rejects(runWindows('',hooks,{workspace:root,capacity:8,runId:'ledger',resume:true}),/goal mirror identity mismatch/);
  assert.equal(calls,0);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
