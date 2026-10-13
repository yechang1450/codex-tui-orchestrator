import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import * as liveUtils from './live-acceptance-utils.mjs';
const {validateCapacitySample,observedTerminal,capacityAcceptancePassed,boundedChildResult,capacityRequest,orderedCapacityReceipts,liveTimeout,liveConcurrencyOptions,capacityBarrierDecision,settingsFromCommandLine,settingsMatch,receiptConcurrencyPeak,isolatedLiveEnvironment,workspaceHasIdentity,nearestOwnedCodexAncestor}=liveUtils;
import {requestTasks} from '../scripts/core/contracts.mjs';
import {genericProjectSplit} from '../scripts/core/orchestrate-sdk.mjs';

test('capacity prompts preserve one original task per receipt, including quoted path separators',()=>{
  const request=capacityRequest({ids:['91','92','93'],root:'C:\\测试; space\\probe',workspace:'C:\\测试; space',nonce:'nonce'});
  const tasks=requestTasks(request);
  assert.equal(tasks.length,3);
  for(const [index,task] of tasks.entries())assert.match(JSON.stringify(task),new RegExp('项目'+(91+index)));
  assert.match(request,/sum=50005000/);
  assert.match(request,/nonce="nonce"/);
});

test('explicit capacity projects reach deterministic splitting before provider planning',()=>{
  const request=capacityRequest({ids:['91','92','93'],root:'C:\\work\\probe',workspace:'C:\\work',nonce:'bbffdbe8-7213-4632-bd1c-92b890b90ef2'});
  assert.equal(genericProjectSplit(request)?.blocks.length,3);
});

test('project splitting ignores numeric data in nonce and receipt fields',()=>{
  const request=capacityRequest({ids:['91','92','93'],root:'C:\\work\\probe',workspace:'C:\\work',nonce:'9f3a0b2e-7213-4632-bd1c-92b890b90ef2'});
  const split=genericProjectSplit(request);
  assert.deepEqual(split?.blocks.map(block=>block.title),['proj-91','proj-92','proj-93']);
});

const independentBlocks = n => Array.from({length:n},(_,i)=>({key:'B'+(i+1),taskIds:['T'+String(i+1).padStart(3,'0')]}));
const identity=(pid,name,started,commandLine)=>({ProcessId:pid,Name:name,Started:started,CommandLine:commandLine});
function validCapacityReport(count=2){
  const workspace='C:\\acceptance-workspace',runId='acceptance-run',blocks=independentBlocks(count),results={},lifecycleEvidence={},receipts=[];
  const workspaceIdentity='physical:'+workspace.toLowerCase();
  const abortTokenSha256=crypto.createHash('sha256').update('acceptance-abort-token','utf8').digest('hex');
  const workspaceKeySha256=crypto.createHash('sha256').update(workspaceIdentity,'utf8').digest('hex');
  for(const [index,block] of blocks.entries()){
    const base=100000+index*100,launcher=identity(1000+index,'powershell.exe',new Date(base).toISOString(),'launcher-'+block.key),agent=identity(2000+index,'codex.exe',new Date(base+5).toISOString(),'agent-'+block.key),probe=identity(3000+index,'node.exe',new Date(base+10).toISOString(),'probe-'+block.key);
    const started={taskId:block.taskIds[0],id:String(91+index),nonce:'nonce-'+block.key,pid:probe.ProcessId,started:base+20,cwd:workspace};
    const receipt={...started,finished:base+30};receipts.push(receipt);
    const token='token-'+block.key;
    results[block.key]={status:'verified',token,launcher,exitConfirmed:true,exitEvidence:{token,pid:launcher.ProcessId,authenticated:true},attempts:[{number:1,runId,token,taskIds:[...block.taskIds],launcherPid:launcher.ProcessId,launcherObserved:{...launcher}}]};
    const digest=value=>crypto.createHash('sha256').update(value,'utf8').digest('hex');
    const startupReceipt={schema:1,kind:'launcher-start',runId,blockKey:block.key,attempt:1,tokenSha256:digest(token),workspaceKeySha256:digest(workspaceIdentity),launcherPid:launcher.ProcessId,workspaceIdentity,createdAt:base};
    lifecycleEvidence[block.key]={runId,taskIds:[...block.taskIds],launcher:{...launcher},agent:{...agent},probe:{...probe},agentAncestors:[launcher.ProcessId],probeAncestors:[agent.ProcessId,launcher.ProcessId],startupReceipt,started,receipt,finalLauncher:null};
  }
  return {monitorError:null,coreUnchanged:true,closed:true,settingsInherited:true,initiatorBound:true,isolationProofValid:true,startupReceiptsValid:true,workspaceConsistent:true,workspaceIdentity,
    abortTokenSha256,abortRequested:null,abortObserved:null,abortRequestError:null,retainedChildren:[],
    isolationProof:{schema:1,runId,threadBound:true,workspaceIdentity,abortTokenSha256},initiatorProof:{threadBound:true,workspaceIdentity},
    acceptanceFinalization:{schema:1,kind:'acceptance-finalization',runId,workspaceIdentity,workspaceKeySha256,abortTokenSha256,finalizedAt:1},
    engineResult:{code:0},pollResult:{code:0},runnerCapacity:count,capacity:count,taskCount:count,minimumConcurrency:2,peak:count,receiptPeak:count,receiptsValid:true,ordered:true,overlap:true,windowLaunches:count,uniqueLaunchers:count,executionMode:'visible',terminal:'wt',runId,workspace,results:receipts,lifecycleEvidence,
    summary:{runId,workspace,success:true,capacity:count,blocks,results}};
}

test('dynamic queueing preserves every independent block instead of changing the plan',()=>{
  const summary={capacity:4,blocks:independentBlocks(4)};
  assert.doesNotThrow(()=>validateCapacitySample(summary,4,2));
  assert.throws(()=>validateCapacitySample({...summary,capacity:2},4,2),/Independent block inventory changed/);
  assert.throws(()=>validateCapacitySample({...summary,blocks:[{key:'B1',taskIds:['T001','T002']},...summary.blocks.slice(2)]},4,2),/Independent block inventory changed/);
  assert.throws(()=>validateCapacitySample(summary,4,5),/Capacity exceeded/);
});

test('live concurrency requests are explicit and a four-task run defaults to proving four overlapping workers',()=>{
  assert.deepEqual(liveConcurrencyOptions({}),{taskCount:2,minimumConcurrency:2});
  assert.deepEqual(liveConcurrencyOptions({ORCH_LIVE_TASKS:'4'}),{taskCount:4,minimumConcurrency:4});
  assert.deepEqual(liveConcurrencyOptions({ORCH_LIVE_TASKS:'4',ORCH_LIVE_MIN_CONCURRENCY:'2'}),{taskCount:4,minimumConcurrency:2});
  for(const env of [{ORCH_LIVE_TASKS:'NaN'},{ORCH_LIVE_TASKS:'1'},{ORCH_LIVE_TASKS:'4',ORCH_LIVE_MIN_CONCURRENCY:'5'},{ORCH_LIVE_TASKS:'4',ORCH_LIVE_MIN_CONCURRENCY:'1'}])assert.throws(()=>liveConcurrencyOptions(env),/ORCH_LIVE/);
});

test('live engine and poll children retain the desktop workspace binding while receiving a fresh isolated controller root',()=>{
  const parentEnv={WORKSPACE_DIR:'C:\\fixture-workspace',CODEX_THREAD_ID:'11111111-2222-4333-8444-555555555555',ORCH_SANDBOX:'workspace-write',ORCH_APPROVAL:'on-request',ORCH_TUI:'wt'};
  const abortToken='_'+ 'a'.repeat(42);
  const env=isolatedLiveEnvironment({parentEnv,runId:'acceptance-live',controllerRoot:'C:\\fixture-controller',stateDir:'C:\\fixture-workspace\\temp\\live-state',abortToken});
  assert.equal(env.WORKSPACE_DIR,parentEnv.WORKSPACE_DIR);
  assert.equal(env.CODEX_THREAD_ID,parentEnv.CODEX_THREAD_ID);
  assert.equal(env.ORCH_SANDBOX,parentEnv.ORCH_SANDBOX);
  assert.equal(env.ORCH_APPROVAL,parentEnv.ORCH_APPROVAL);
  assert.equal(env.ORCH_TUI,parentEnv.ORCH_TUI);
  assert.equal(env.ORCH_ISOLATED_ACCEPTANCE,'1');
  assert.equal(env.ORCH_ISOLATED_ABORT_TOKEN,abortToken);
  assert.equal(env.ORCH_CONTROLLER_ROOT,'C:\\fixture-controller');
  assert.equal(env.ORCH_STATE_DIR,'C:\\fixture-workspace\\temp\\live-state');
  assert.equal(env.ORCH_AGENT,'codex');
  assert.throws(()=>isolatedLiveEnvironment({parentEnv:{...parentEnv,ORCH_COORDINATOR_DIR:'C:\\fixture-shared'},runId:'acceptance-live',controllerRoot:'C:\\fixture-controller',stateDir:'C:\\fixture-workspace\\temp\\live-state',abortToken}),/ORCH_COORDINATOR_DIR/);
  assert.throws(()=>isolatedLiveEnvironment({parentEnv,runId:'acceptance-live',controllerRoot:'C:\\fixture-controller',stateDir:'C:\\fixture-workspace\\temp\\live-state'}),/abort token/);
});

test('live acceptance requires an explicit execution mode before it can start a real Codex run',()=>{
  const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
  const source=fs.readFileSync(path.join(repo,'test','live-codex.mjs'),'utf8');
  assert.match(source,/const executionMode=String\(process\.env\.ORCH_LIVE_MODE\|\|''\)\.trim\(\);/);
  assert.match(source,/Live acceptance requires explicit ORCH_LIVE_MODE=headless or visible/);
  assert.doesNotMatch(source,/ORCH_LIVE_MODE\|\|'visible'/);
});

test('the real live harness uses the isolated host-bound child environment instead of deleting it',()=>{
  const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
  const source=fs.readFileSync(path.join(repo,'test','live-codex.mjs'),'utf8');
  assert.match(source,/isolatedLiveEnvironment/);
  assert.match(source,/controllerRoot/);
  assert.match(source,/acceptanceAbortSpec/);
  assert.match(source,/requestAcceptanceAbort/);
  assert.match(source,/requestAbort\('monitor-failed'\)/);
  assert.doesNotMatch(source,/delete env\.WORKSPACE_DIR/);
  assert.doesNotMatch(source,/\.kill\(\)/);
  assert.doesNotMatch(source,/acceptance aborted/);
  assert.match(source,/const entry=path\.join\(repo,'scripts',script\)/);
});

test('a deferred memory queue releases active probes without falsely proving the required concurrency',()=>{
  const summary={blocks:independentBlocks(4),results:{B1:{status:'running'},B2:{status:'running'},B3:{status:'deferred'},B4:{status:'deferred'}}};
  const args={summary,readyTaskIds:['T001','T002'],liveBlockKeys:['B1','B2'],minimumConcurrency:4};
  assert.deepEqual(capacityBarrierDecision(args),{release:true,reason:'memory-queue',concurrencyProven:false});
  assert.deepEqual(capacityBarrierDecision({...args,minimumConcurrency:2}),{release:true,reason:'concurrency-proven',concurrencyProven:true});
  assert.equal(capacityBarrierDecision({...args,readyTaskIds:['T001']}).release,false);
  assert.equal(capacityBarrierDecision({...args,summary:{...summary,results:{...summary.results,B3:{status:'launching'}}}}).release,false);
  assert.equal(capacityBarrierDecision({...args,summary:{...summary,results:{...summary.results,B3:{status:'pending'},B4:{status:'pending'}}}}).release,false);
});

test('receipt overlap counts actual simultaneous probes and rejects invalid intervals',()=>{
  assert.equal(receiptConcurrencyPeak([{started:1,finished:5},{started:2,finished:6},{started:5,finished:8},{started:6,finished:9}]),2);
  assert.equal(receiptConcurrencyPeak(Array.from({length:4},(_,i)=>({started:i+1,finished:10+i}))),4);
  assert.equal(receiptConcurrencyPeak([{started:1,finished:1}]),0);
  assert.equal(receiptConcurrencyPeak([{missing:true}]),0);
});

test('worker settings evidence decodes native Windows quoting and checks every inherited field',()=>{
  const expected={model:'gpt-6-luna',effort:'max',serviceTier:'priority'};
  const line=String.raw`"C:\Program Files\codex.exe" exec -m gpt-6-luna -c model_reasoning_effort=max -c "service_tier=\"priority\"" "prompt has -m misleading text"`;
  assert.deepEqual(settingsFromCommandLine(line),expected);
  assert.equal(settingsMatch(expected,settingsFromCommandLine(line)),true);
  assert.equal(settingsMatch(expected,{...expected,effort:'low'}),false);
  assert.equal(settingsMatch(expected,{model:expected.model,effort:expected.effort}),false);
  assert.equal(settingsMatch({},{}),false);
});

test('live observations accept workspace aliases only when they resolve to the same physical identity',()=>{
  const identityOf=value=>({
    'C:\\workspace':'volume:42',
    'C:\\WORKSPA~1':'volume:42',
    'C:\\other':'volume:99',
  }[value]||(()=>{throw new Error('unresolved');})());
  assert.equal(workspaceHasIdentity('C:\\workspace','volume:42',identityOf),true);
  assert.equal(workspaceHasIdentity('C:\\WORKSPA~1','volume:42',identityOf),true);
  assert.equal(workspaceHasIdentity('C:\\other','volume:42',identityOf),false);
  assert.equal(workspaceHasIdentity('relative','volume:42',identityOf),false);
  assert.equal(workspaceHasIdentity('','volume:42',identityOf),false);
  assert.equal(workspaceHasIdentity('C:\\missing','volume:42',identityOf),false);
  const aliased=structuredClone(validCapacityReport(2));
  aliased.summary.workspace='C:\\WORKSPA~1';
  for(const receipt of aliased.results)receipt.cwd='C:\\WORKSPA~1';
  for(const evidence of Object.values(aliased.lifecycleEvidence)){evidence.started.cwd='C:\\WORKSPA~1';evidence.receipt.cwd='C:\\WORKSPA~1';}
  assert.equal(capacityAcceptancePassed(aliased),true,'final acceptance relies on the separately verified physical workspace identity');
});

test('live observations select the nearest owned Codex process from a nested launcher chain',()=>{
  const row=(ProcessId,ParentProcessId,Name)=>({ProcessId,ParentProcessId,Name,Started:'2026-10-09T00:00:00.000Z',CommandLine:Name+' '+ProcessId});
  const snapshot=new Map([[10,row(10,1,'powershell.exe')],[20,row(20,10,'codex.exe')],[30,row(30,20,'wrapper.exe')],[40,row(40,30,'codex.exe')],[50,row(50,40,'node.exe')]]);
  assert.equal(nearestOwnedCodexAncestor(snapshot,50,10)?.ProcessId,40);
  assert.equal(nearestOwnedCodexAncestor(snapshot,50,20)?.ProcessId,40);
  assert.equal(nearestOwnedCodexAncestor(snapshot,50,999),null);
  snapshot.set(30,row(30,30,'wrapper.exe'));
  assert.equal(nearestOwnedCodexAncestor(snapshot,50,10),null);
});

test('capacity success requires immutable core, exact concurrency, verified receipts and proven exit',()=>{
  const valid=validCapacityReport(2);
  assert.equal(capacityAcceptancePassed(valid),true);
  for(const patch of [{coreUnchanged:false},{closed:false},{initiatorBound:false},{isolationProofValid:false},{startupReceiptsValid:false},{workspaceConsistent:false},{monitorError:'snapshot failed'},{abortRequested:{reason:'monitor-failed'}},{abortObserved:{reason:'monitor-failed'}},{abortRequestError:'record unavailable'},{retainedChildren:[{label:'engine'}]},{abortTokenSha256:'foreign'},{runnerCapacity:1},{peak:1},{peak:3},{receiptPeak:1},{receiptsValid:false},{ordered:false},{overlap:false},{windowLaunches:3},{uniqueLaunchers:3},{terminal:null},{engineResult:{code:1}},{pollResult:{code:1}},{summary:{...valid.summary,success:false}}])assert.equal(capacityAcceptancePassed({...valid,...patch}),false,JSON.stringify(patch));
  const noExit=structuredClone(valid);noExit.summary.results.B1.exitConfirmed=false;assert.equal(capacityAcceptancePassed(noExit),false);
  const wrongExit=structuredClone(valid);wrongExit.summary.results.B1.exitEvidence.token='foreign';assert.equal(capacityAcceptancePassed(wrongExit),false);
  const replacedLauncher=structuredClone(valid);replacedLauncher.summary.results.B1.attempts[0].launcherObserved.Started='2026-10-09T00:00:00.000Z';assert.equal(capacityAcceptancePassed(replacedLauncher),false);
  const wrongProbe=structuredClone(valid);wrongProbe.lifecycleEvidence.B1.started.pid=9999;assert.equal(capacityAcceptancePassed(wrongProbe),false);
  const wrongReceipt=structuredClone(valid);wrongReceipt.lifecycleEvidence.B1.receipt.started++;assert.equal(capacityAcceptancePassed(wrongReceipt),false);
  const missingStartupReceipt=structuredClone(valid);delete missingStartupReceipt.lifecycleEvidence.B1.startupReceipt;assert.equal(capacityAcceptancePassed(missingStartupReceipt),false);
  const wrongStartupReceipt=structuredClone(valid);wrongStartupReceipt.lifecycleEvidence.B1.startupReceipt.launcherPid++;assert.equal(capacityAcceptancePassed(wrongStartupReceipt),false);
  const aliveLauncher=structuredClone(valid);aliveLauncher.lifecycleEvidence.B1.finalLauncher={...aliveLauncher.lifecycleEvidence.B1.launcher};assert.equal(capacityAcceptancePassed(aliveLauncher),false);
  const queued={...validCapacityReport(4),peak:2,receiptPeak:2};
  assert.equal(capacityAcceptancePassed(queued),true);
  assert.equal(capacityAcceptancePassed({...queued,minimumConcurrency:4}),false);
  assert.equal(capacityAcceptancePassed({...queued,minimumConcurrency:4,peak:4,receiptPeak:4}),true);
  assert.equal(capacityAcceptancePassed({...queued,summary:{...queued.summary,results:{...queued.summary.results,B1:{status:'verified',attempts:[{},{}]}}}}),false);
});

test('capacity success requires a bound controller acceptance finalization record',()=>{
  const valid=validCapacityReport(2);
  assert.equal(capacityAcceptancePassed(valid),true);
  for(const patch of [
    {acceptanceFinalization:null},
    {acceptanceFinalization:{...valid.acceptanceFinalization,kind:'foreign-finalization'}},
    {acceptanceFinalization:{...valid.acceptanceFinalization,runId:'foreign-run'}},
    {acceptanceFinalization:{...valid.acceptanceFinalization,workspaceIdentity:'physical:foreign'}},
    {acceptanceFinalization:{...valid.acceptanceFinalization,workspaceKeySha256:'foreign'}},
    {acceptanceFinalization:{...valid.acceptanceFinalization,abortTokenSha256:'foreign'}},
    {acceptanceFinalization:{...valid.acceptanceFinalization,finalizedAt:0}},
  ])assert.equal(capacityAcceptancePassed({...valid,...patch}),false,JSON.stringify(patch));
});

test('exactly full receipt sets do not require a nonexistent overflow task',()=>{
  assert.equal(orderedCapacityReceipts([{finished:20},{started:10}],2),true);
  assert.equal(orderedCapacityReceipts([{finished:10},{finished:20},{started:21}],2),true);
  assert.equal(orderedCapacityReceipts([{finished:10},{finished:20},{started:19}],2),false);
  assert.equal(orderedCapacityReceipts([{finished:20}],2),false);
});

test('merged block ordering follows task membership and rejects missing or duplicated receipts',()=>{
  const blocks=[{taskIds:['T001','T003']},{taskIds:['T002']}];
  const results=[{started:1,finished:10},{started:2,finished:40},{started:11,finished:20}];
  assert.equal(orderedCapacityReceipts(results,2,blocks),true);
  assert.equal(orderedCapacityReceipts([...results.slice(0,2),{started:9,finished:20}],2,blocks),false);
  assert.equal(orderedCapacityReceipts(results,2,[{taskIds:['T001','T001']},{taskIds:['T002']}]),false);
});

test('live timeout is configurable but always finite and bounded',()=>{
  assert.equal(liveTimeout({}),600000);
  assert.equal(liveTimeout({ORCH_LIVE_TIMEOUT_MS:'900000'}),900000);
  for(const v of ['NaN','Infinity','-1','0','21600001'])assert.throws(()=>liveTimeout({ORCH_LIVE_TIMEOUT_MS:v}),/Invalid ORCH_LIVE_TIMEOUT_MS/);
});

test('terminal evidence follows the actual launch, including conhost fallback',()=>{
  assert.equal(observedTerminal('visible','spawned visible codex TUI (Windows Terminal): test'),'wt');
  assert.equal(observedTerminal('visible','spawned visible codex TUI (inactive console): test'),'conhost');
  assert.equal(observedTerminal('visible','launcher never started'),null);
  assert.equal(observedTerminal('headless',''),null);
});

test('a hung acceptance controller reports an unproven timeout without force-killing its child',async()=>{
  let killCalls=0;
  const timedOut=await boundedChildResult({done:new Promise(()=>{}),child:{kill(){killCalls++;}}},20);
  assert.deepEqual(timedOut,{code:-1,timedOut:true,error:'Acceptance child did not exit before its deadline'});
  assert.equal(killCalls,0);
  assert.deepEqual(await boundedChildResult({done:Promise.resolve({code:0}),child:{kill(){killCalls++;}}},50),{code:0});
  assert.equal(killCalls,0);
});
