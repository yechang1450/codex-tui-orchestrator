import {testTempFamily} from './test-temp-root.mjs';
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {validateRecoverySummary,validateSavedLauncherFiles,hasAuthenticatedExitProof,hasNoProcessProof} from '../scripts/core/recovery.mjs';
import {runWindows,verifyRun,sweepRunProcesses} from '../scripts/core/runner.mjs';
import {recordCheckpoint} from '../scripts/core/checkpoint.mjs';
import {buildTodoList} from '../scripts/core/contracts.mjs';
import {recoveryTasks} from '../scripts/core/recovery.mjs';
import {controllerWindowsDir} from '../scripts/core/controller-state.mjs';
import {physicalPathIdentity} from '../scripts/core/runtime-context.mjs';
const controllerRoot=fs.mkdtempSync(path.join(testTempFamily('recovery-ledger'),'ledger-controller-'));
const oldControllerRoot=process.env.ORCH_CONTROLLER_ROOT;
process.env.ORCH_CONTROLLER_ROOT=controllerRoot;
after(()=>{if(oldControllerRoot===undefined)delete process.env.ORCH_CONTROLLER_ROOT;else process.env.ORCH_CONTROLLER_ROOT=oldControllerRoot;fs.rmSync(controllerRoot,{recursive:true,force:true});});

function fixture(workspace) {
 return {protocol:2,runId:'ledger',workspace,request:'first;second',generation:1,history:[],
  tasks:[{id:'T001',prompt:'first'},{id:'T002',prompt:'second'}],
  plan:[{key:'B1',title:'both',keys:[],dependsOn:[],b:{tasks:[{sourceIds:['T001','T002']}]}}],
  blocks:[{key:'B1',taskIds:['T001','T002']}],results:{B1:{status:'pending',attempts:[]}},
  taskResults:{T001:{status:'pending'},T002:{status:'pending'}}};
}

const leaseInstance='11111111-2222-4333-8444-555555555555';
function durableIdentity(overrides={}){
 return {ProcessId:4242,Started:'2026-10-11T00:00:00.000Z',Name:'powershell.exe',commandLineSha256:'a'.repeat(64),...overrides};
}
function authenticatedExitRecords(){
 const token='proof-token',identity=durableIdentity(),leaseId='ledger-B1';
 return {
   entry:{token,leaseId,leaseInstanceId:leaseInstance,launcher:identity,exitConfirmed:true,
   exitEvidence:{token,pid:4242,authenticated:true,at:100}},
   attempt:{runId:'ledger',token,number:1,leaseId,leaseInstanceId:leaseInstance,launcherPid:4242,launcherObserved:{...identity},exitConfirmed:true,
   exitEvidence:{token,pid:4242,authenticated:true,at:101}},
 };
}
function noProcessLedger(){
 const sum=fixture(process.cwd()),token='no-process-token',leaseId='ledger-B1';
 const proof={version:1,kind:'no-process',runId:'ledger',blockKey:'B1',attempt:1,token,
  lease:{id:leaseId,instanceId:leaseInstance},recordedAt:100};
 const attempt={runId:'ledger',token,number:1,file:'attempt.json',taskIds:['T001','T002'],leaseId,leaseInstanceId:leaseInstance,
  exitConfirmed:true,noProcessProof:structuredClone(proof)};
 const entry={status:'failed',token,leaseId,leaseInstanceId:leaseInstance,exitConfirmed:true,
  noProcessProof:structuredClone(proof),attempts:[attempt]};
 sum.results.B1=entry;
 return {sum,block:sum.blocks[0],entry,attempt};
}

test('authenticated exit proof binds all saved launcher identities, not merely their shared PID',()=>{
 const {entry,attempt}=authenticatedExitRecords();
 assert.equal(hasAuthenticatedExitProof(entry,attempt),true);
 for(const [field,value] of [
  ['Started','2026-10-11T00:00:01.000Z'],
  ['Name','pwsh.exe'],
  ['commandLineSha256','b'.repeat(64)],
 ]){
  const altered=structuredClone(attempt);altered.launcherObserved[field]=value;
  assert.equal(hasAuthenticatedExitProof(entry,altered),false,field+' mismatch must reject a PID-only alias');
 }
 const missing=structuredClone(attempt);delete missing.launcherObserved;
 const noEntry=structuredClone(entry);delete noEntry.launcher;
 assert.equal(hasAuthenticatedExitProof(noEntry,missing),false,'a PID receipt without a durable launcher identity is not proof of ownership');
 const stringPid=structuredClone(attempt);stringPid.launcherPid='4242';
 assert.equal(hasAuthenticatedExitProof(entry,stringPid),false,'a serialized PID cannot substitute for the bound integer identity');
 const wrongLease=structuredClone(attempt);wrongLease.leaseId='foreign-lease';
 assert.equal(hasAuthenticatedExitProof(entry,wrongLease),false,'an authenticated exit receipt cannot authorize a different lease');
});

test('no-process proof requires a mirrored lease-bound latest attempt receipt',()=>{
 const valid=noProcessLedger();
 assert.equal(hasNoProcessProof(valid.sum,valid.block,valid.entry,valid.attempt),true);
 validateRecoverySummary(valid.sum);

 const journaled=noProcessLedger();
 const journal={version:1,kind:'post-exit-cleanup',runId:'ledger',blockKey:'B1',attempt:1,token:journaled.attempt.token,
  lease:{id:journaled.entry.leaseId,instanceId:journaled.entry.leaseInstanceId},
  phases:{lease:'pending',registry:'pending',artifacts:'pending'},recordedAt:100,updatedAt:100};
 journaled.entry.status='cleanup-pending';journaled.entry.cleanupPending=journal;
 journaled.attempt.cleanupPending=structuredClone(journal);
 validateRecoverySummary(journaled.sum);

 const cases=[
  ['attempt run id does not bind the receipt',value=>{
   value.attempt.runId='foreign-run';
  }],
  ['attempt token does not bind the receipt',value=>{
   value.attempt.token='foreign-token';
  }],
  ['proof lease id does not bind the active lease',value=>{
   value.entry.noProcessProof.lease.id='foreign-lease';value.attempt.noProcessProof.lease.id='foreign-lease';
  }],
  ['attempt lease instance does not bind the receipt',value=>{
   value.attempt.leaseInstanceId='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  }],
  ['proof block key does not bind the current block',value=>{
   value.entry.noProcessProof.blockKey='B2';value.attempt.noProcessProof.blockKey='B2';
  }],
  ['proof attempt number does not bind the latest attempt',value=>{
   value.entry.noProcessProof.attempt=2;value.attempt.noProcessProof.attempt=2;
  }],
  ['entry and attempt receipts are not mirrored',value=>{
   value.attempt.noProcessProof.recordedAt=101;
  }],
  ['receipt omits the lease binding',value=>{
   delete value.entry.noProcessProof.lease;delete value.attempt.noProcessProof.lease;
  }],
 ];
 for(const [name,mutate] of cases){
  const value=noProcessLedger();mutate(value);
  assert.equal(hasNoProcessProof(value.sum,value.block,value.entry,value.attempt),false,name);
  assert.throws(()=>validateRecoverySummary(value.sum),/Invalid recovery ledger/,name);
 }
});

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

test('recovery rejects legacy raw command-line identities before they can authorize a resumed launcher',()=>{
 const saved=fixture(process.cwd());
 saved.results.B1={status:'failed',launcher:{ProcessId:42,Name:'powershell.exe',Started:'legacy',CommandLine:'powershell -File win-launch.ps1'},attempts:[{runId:'ledger',token:'attempt-token',file:'attempt.json',taskIds:['T001','T002']}]};
 assert.throws(()=>validateRecoverySummary(saved),/legacy raw launcher identity/i);
});

test('saved recovery ledger rejects a stale TodoList status',()=>{
 const saved=fixture(process.cwd());
 saved.todoList=buildTodoList(saved.tasks,saved.blocks,saved.taskResults);
 saved.taskResults.T001={status:'verified'};
 assert.throws(()=>validateRecoverySummary(saved),/todo list status mismatch/);
});

test('saved recovery checkpoints must belong to a recorded attempt before recovery can run',()=>{
 const saved=fixture(process.cwd());
 const attempt={runId:'ledger',token:'attempt-token',file:'attempt.json',taskIds:['T001'],leaseId:'ledger-B1',leaseInstanceId:leaseInstance};
 const checkpoint={id:'T001',runId:'ledger',token:'attempt-token',state:'completed'};
 saved.results.B1={status:'failed',token:attempt.token,leaseId:attempt.leaseId,leaseInstanceId:attempt.leaseInstanceId,endedAt:1,attempts:[attempt]};
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
 const root=fs.mkdtempSync(path.join(testTempFamily('recovery-ledger'),'launcher-binding-'));
 try{
  const runId='ledger',workspace=root,attemptFile=path.join(root,'temp','orchestrator','runs',runId,'attempts','B1','1','attempt.json');
  fs.mkdirSync(path.dirname(attemptFile),{recursive:true});
  const attempt={runId,token:'ledger-B1-a1-token',number:1,file:attemptFile,taskIds:['T001']};
  const dir=controllerWindowsDir(workspace),suffix='foreign-a1',files={lp:path.join(dir,'win-launch-'+suffix+'.ps1'),pf:path.join(dir,'agent-win-'+suffix+'.md'),pidf:path.join(dir,'window-'+suffix+'.pid'),rf:path.join(dir,'win-'+suffix+'.result.json')};
  fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(files.lp,`$token = '${attempt.token}'`);fs.writeFileSync(files.pf,'__ORCH_DONE__ '+attempt.token);fs.writeFileSync(files.pidf,'123');
  const sum={runId,workspace};const entry={token:attempt.token,launcherFiles:files};
  assert.throws(()=>validateSavedLauncherFiles(sum,{key:'B1'},entry,attempt,{requireLiveFiles:true}),/bound to this run attempt/);
  files.lp=path.join(dir,'win-launch-B1-'+runId+'-a1.ps1');files.pf=path.join(dir,'agent-win-B1-'+runId+'-a1.md');files.pidf=path.join(dir,'window-B1-'+runId+'-a1.pid');files.rf=path.join(dir,'win-B1-'+runId+'-a1.result.json');
  fs.writeFileSync(files.lp,`$token = '${attempt.token}'`);fs.writeFileSync(files.pf,'__ORCH_DONE__ '+attempt.token);fs.writeFileSync(files.pidf,'123');
  validateSavedLauncherFiles(sum,{key:'B1'},entry,attempt,{requireLiveFiles:true});
  files.pf=path.join(dir,'agent-win-B1-'+runId+'-a1.md');fs.writeFileSync(files.pf,'__ORCH_DONE__ foreign-token');
  assert.throws(()=>validateSavedLauncherFiles(sum,{key:'B1'},entry,attempt,{requireLiveFiles:true}),/ownership token mismatch/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('visible recovery carries its durable startup receipt descriptor to identity-bound verification',()=>{
 const workspace=fs.mkdtempSync(path.join(testTempFamily('recovery-ledger'),'visible-receipt-ledger-'));
 try{
  const runId='ledger',token='ledger-B1-a1-token',attempt={runId,token,number:1,file:path.join(workspace,'temp','orchestrator','runs',runId,'attempts','B1','1','attempt.json'),taskIds:['T001']};
  const dir=controllerWindowsDir(workspace),suffix='B1-'+runId+'-a1';fs.mkdirSync(dir,{recursive:true});fs.mkdirSync(path.dirname(attempt.file),{recursive:true});
  const workspaceIdentity=physicalPathIdentity(workspace),digest=value=>crypto.createHash('sha256').update(String(value),'utf8').digest('hex');
  const receipt={schema:1,kind:'launcher-start',file:path.join(controllerRoot,'acceptance-proofs',`startup-${runId}-B1-a1.json`),runId,blockKey:'B1',attempt:1,token,tokenSha256:digest(token),workspaceIdentity,workspaceKeySha256:digest(workspaceIdentity)};
  const files={lp:path.join(dir,'win-launch-'+suffix+'.ps1'),pf:path.join(dir,'agent-win-'+suffix+'.md'),pidf:path.join(dir,'window-'+suffix+'.pid'),rf:path.join(dir,'win-'+suffix+'.result.json'),startupReceipt:receipt};
  const sum={runId,workspace},entry={token,launcherFiles:files};
  validateSavedLauncherFiles(sum,{key:'B1'},entry,attempt);
  assert.deepEqual(files.startupReceipt,receipt,'recovery must preserve the descriptor for the authenticated receipt verifier');
 }finally{fs.rmSync(workspace,{recursive:true,force:true});}
});

test('saved visible launcher cannot adopt a sibling block with the same run and attempt',()=>{
 const workspace=path.join(testTempFamily('recovery-ledger'),'sibling-ledger');
 const runId='ledger',attempt={runId,token:'ledger-B1-a1-token',number:1,
  file:path.join(workspace,'temp','orchestrator','runs',runId,'attempts','B1','1','attempt.json'),taskIds:['T001']};
 const dir=controllerWindowsDir(workspace),suffix='B2-ledger-a1';
 const files={lp:path.join(dir,'win-launch-'+suffix+'.ps1'),pf:path.join(dir,'agent-win-'+suffix+'.md'),
  pidf:path.join(dir,'window-'+suffix+'.pid'),rf:path.join(dir,'win-'+suffix+'.result.json')};
 assert.throws(()=>validateSavedLauncherFiles({runId,workspace},{key:'B1'},
  {token:attempt.token,launcherFiles:files},attempt),/bound to this run attempt/);
 files.lp=path.join(dir,'win-launch-B1-ledger-a1-extra.ps1');
 assert.throws(()=>validateSavedLauncherFiles({runId,workspace},{key:'B1'},
  {token:attempt.token,launcherFiles:files},attempt),/bound to this run attempt/);
});

test('final sweep retains a saved sibling launcher identity before closing any process',async()=>{
 const workspace=path.join(testTempFamily('recovery-ledger'),'sibling-sweep'),runId='ledger';
 const attempt={runId,token:'ledger-B1-a1-token',number:1,
  file:path.join(workspace,'temp','orchestrator','runs',runId,'attempts','B1','1','attempt.json'),taskIds:['T001']};
 const dir=controllerWindowsDir(workspace),suffix='B2-ledger-a1';
 const launcherFiles={lp:path.join(dir,'win-launch-'+suffix+'.ps1'),pf:path.join(dir,'agent-win-'+suffix+'.md'),
  pidf:path.join(dir,'window-'+suffix+'.pid'),rf:path.join(dir,'win-'+suffix+'.result.json')};
 const summary={runId,workspace,blocks:[{key:'B1',taskIds:['T001']}],
  results:{B1:{status:'failed',token:attempt.token,attempts:[attempt],launcherFiles,
   launcher:{ProcessId:424242,Name:'powershell.exe',Started:'fixture',CommandLine:'fixture'}}}};
 let closes=0;
 const result=await sweepRunProcesses(summary,{close:async()=>{closes++;},waitForExit:async()=>false,
  identify:()=>summary.results.B1.launcher});
 assert.equal(closes,0);
 assert.equal(result.failed,0);
 assert.equal(result.retained,1);
 assert.equal(summary.results.B1.exitConfirmed,false);
 assert.match(summary.results.B1.reason,/bound protocol 2 lease instance/);
});

test('recovery fails closed for a legacy non-Codex ledger before reading its launcher paths',()=>{
 const workspace=path.join(testTempFamily('recovery-ledger'),'legacy-ledger');
 assert.throws(
  ()=>validateSavedLauncherFiles({runId:'ledger',workspace,agent:'foreign-agent'},{key:'B.1'},{},{}),
  /LEGACY_AGENT_UNSUPPORTED: recovery only accepts Codex ledgers/,
 );
});

test('safe retry clears an old failed or verified task status before composing receipts',()=>{
 const dir=fs.mkdtempSync(path.join(testTempFamily('recovery-ledger'),'retry-receipt-'));
 try {
  const result=recoveryTasks([{id:'T001',prompt:'retry'}],{T001:{state:'completed'}},{T001:{retrySafe:true,checks:[{type:'file',path:'missing'}]}},dir);
  assert.deepEqual(result.pending,['T001']);
  assert.equal(result.uncertain.length,0);
  assert.equal(result.results.T001.status,'pending');
  assert.equal(result.results.T001.checkpoint.state,'completed');
 } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
test('resume rejects damaged ledger before any hook or persisted state changes',async()=>{
 const family=testTempFamily('recovery-ledger');fs.mkdirSync(family,{recursive:true});
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
 const family=testTempFamily('recovery-ledger');fs.mkdirSync(family,{recursive:true});
 const root=fs.mkdtempSync(path.join(family,'goal-refresh-'));
 try{
  const dir=path.join(root,'temp/orchestrator/runs/goal-refresh');fs.mkdirSync(dir,{recursive:true});
  const attemptFile=path.join(dir,'attempts','B1','1','attempt.json');fs.mkdirSync(path.dirname(attemptFile),{recursive:true});
  const leaseId='goal-refresh-B1';
  const attempt={runId:'goal-refresh',token:'token',number:1,file:attemptFile,taskIds:['T001'],leaseId,leaseInstanceId:leaseInstance};fs.writeFileSync(attemptFile,JSON.stringify(attempt));
  recordCheckpoint(attemptFile,'T001','started');recordCheckpoint(attemptFile,'T001','completed');
  const tasks=[{id:'T001',prompt:'first'}],blocks=[{key:'B1',taskIds:['T001']}];
  const summary={protocol:2,runId:'goal-refresh',workspace:root,request:'first',capacity:8,generation:1,history:[],finishedAt:1,
   tasks,plan:[{key:'B1',title:'both',keys:[],dependsOn:[],b:{tasks:[{sourceIds:['T001']} ]}}],blocks,
   results:{B1:{status:'awaiting-verification',token:attempt.token,leaseId,leaseInstanceId:leaseInstance,endedAt:1,attempts:[{...attempt,file:attemptFile}]}},
   taskResults:{T001:{status:'awaiting-verification'}},todoList:buildTodoList(tasks,blocks,{T001:{status:'awaiting-verification'}}),
   coordinator:path.join(controllerRoot,'coordinator')};
  fs.writeFileSync(path.join(dir,'summary.json'),JSON.stringify(summary));
  const evidence=path.join(root,'evidence.json');fs.writeFileSync(evidence,JSON.stringify({ok:true}));
  const checks=path.join(dir,'acceptance.json');fs.writeFileSync(checks,JSON.stringify({T001:[{type:'json',path:'evidence.json',equals:{ok:true}}]}));
  fs.writeFileSync(path.join(dir,'goal.json'),JSON.stringify({version:1,runId:'goal-refresh',workspace:root,objective:'first',status:'active',tasks:[{id:'T001',status:'pending',block:'B1'}],blocks:[{key:'B1',title:'both',status:'active',taskIds:['T001']}]}));
  assert.equal(verifyRun(root,'goal-refresh',checks,{coordinator:path.join(controllerRoot,'coordinator'),override:true}),true);
  const goal=JSON.parse(fs.readFileSync(path.join(dir,'goal.json'),'utf8'));
  assert.equal(goal.status,'completed');assert.equal(goal.tasks[0].status,'verified');assert.equal(goal.summaryGeneration,1);
  const final=JSON.parse(fs.readFileSync(path.join(dir,'summary.json')));
  const event=JSON.parse(fs.readFileSync(path.join(dir,'events.jsonl'),'utf8').trim());
  assert.equal(event.type,'verify.completed');assert.equal(event.executionStatus[0].status,'verified');
  assert.equal(final.eventSeq,event.seq);assert.equal(goal.eventSeq,event.seq);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('resume rejects a goal mirror with a different run identity',async()=>{
 const family=testTempFamily('recovery-ledger');fs.mkdirSync(family,{recursive:true});
 const root=fs.mkdtempSync(path.join(family,'goal-identity-'));
 try{
  const dir=path.join(root,'temp/orchestrator/runs/ledger');fs.mkdirSync(dir,{recursive:true});
   const saved=fixture(root);saved.finishedAt=1;saved.coordinator=path.join(controllerRoot,'coordinator');fs.writeFileSync(path.join(dir,'summary.json'),JSON.stringify(saved));
  fs.writeFileSync(path.join(dir,'goal.json'),JSON.stringify({version:1,runId:'foreign',workspace:root}));
  fs.writeFileSync(path.join(dir,'acceptance.json'),'{}');let calls=0;
  const hooks=new Proxy({}, {get(){calls++;throw new Error('Unexpected execution hook');}});
   await assert.rejects(runWindows('',hooks,{workspace:root,capacity:8,runId:'ledger',resume:true,coordinator:saved.coordinator}),/goal mirror identity mismatch/);
  assert.equal(calls,0);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
