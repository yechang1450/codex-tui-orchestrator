import test from 'node:test';
import assert from 'node:assert/strict';
import * as liveUtils from './live-acceptance-utils.mjs';
const {validateCapacitySample,observedTerminal,capacityAcceptancePassed,boundedChildResult,capacityRequest,orderedCapacityReceipts,liveTimeout,liveConcurrencyOptions,capacityBarrierDecision,settingsFromCommandLine,settingsMatch,receiptConcurrencyPeak}=liveUtils;
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

test('capacity success requires immutable core, exact concurrency, verified receipts and proven exit',()=>{
  const valid={monitorError:null,coreUnchanged:true,closed:true,settingsInherited:true,engineResult:{code:0},pollResult:{code:0},runnerCapacity:2,capacity:2,taskCount:2,minimumConcurrency:2,peak:2,receiptPeak:2,receiptsValid:true,ordered:true,overlap:true,windowLaunches:2,uniqueLaunchers:2,executionMode:'visible',terminal:'wt',summary:{success:true,capacity:2,blocks:independentBlocks(2),results:{B1:{status:'verified',attempts:[{}]},B2:{status:'verified',attempts:[{}]}}}};
  assert.equal(capacityAcceptancePassed(valid),true);
  for(const patch of [{coreUnchanged:false},{closed:false},{settingsInherited:false},{monitorError:'snapshot failed'},{runnerCapacity:1},{peak:1},{peak:3},{receiptPeak:1},{receiptsValid:false},{ordered:false},{overlap:false},{windowLaunches:3},{uniqueLaunchers:3},{terminal:null},{engineResult:{code:1}},{pollResult:{code:1}},{summary:{success:false,results:valid.summary.results}}])assert.equal(capacityAcceptancePassed({...valid,...patch}),false,JSON.stringify(patch));
  const queued={...valid,taskCount:4,capacity:4,runnerCapacity:4,windowLaunches:4,uniqueLaunchers:4,summary:{success:true,capacity:4,blocks:independentBlocks(4),results:Object.fromEntries(independentBlocks(4).map(b=>[b.key,{status:'verified',attempts:[{}]}]))}};
  assert.equal(capacityAcceptancePassed(queued),true);
  assert.equal(capacityAcceptancePassed({...queued,minimumConcurrency:4}),false);
  assert.equal(capacityAcceptancePassed({...queued,minimumConcurrency:4,peak:4,receiptPeak:4}),true);
  assert.equal(capacityAcceptancePassed({...queued,summary:{...queued.summary,results:{...queued.summary.results,B1:{status:'verified',attempts:[{},{}]}}}}),false);
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

test('a hung acceptance controller cannot hold its parent forever',async()=>{
  let killed=false;
  const timedOut=await boundedChildResult({done:new Promise(()=>{}),child:{kill(){killed=true;}}},20);
  assert.equal(killed,true);assert.equal(timedOut.code,-1);
  killed=false;
  assert.deepEqual(await boundedChildResult({done:Promise.resolve({code:0}),child:{kill(){killed=true;}}},50),{code:0});
  assert.equal(killed,false);
});
