import test from 'node:test';
import assert from 'node:assert/strict';
import {validateCapacitySample,observedTerminal,capacityAcceptancePassed,boundedChildResult,capacityRequest,orderedCapacityReceipts,liveTimeout} from './live-acceptance-utils.mjs';
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

test('a smaller dynamic block count is accepted while excess concurrency stays fatal',()=>{
  assert.doesNotThrow(()=>validateCapacitySample({capacity:3},3,3));
  // dynamic 内存预算模式：规划期合并会得到更少的块（capacity 更小），这是允许的。
  assert.doesNotThrow(()=>validateCapacitySample({capacity:2},3,2));
  // 真实并发超过 harness 上限依然是致命错误。
  assert.throws(()=>validateCapacitySample({capacity:3},3,4),/Capacity exceeded/);
});

test('capacity success requires immutable core, exact concurrency, verified receipts and proven exit',()=>{
  const valid={monitorError:null,coreUnchanged:true,closed:true,engineResult:{code:0},pollResult:{code:0},runnerCapacity:2,capacity:2,peak:2,receiptsValid:true,ordered:true,overlap:true,windowLaunches:2,uniqueLaunchers:2,executionMode:'visible',terminal:'wt',summary:{success:true,results:{B1:{status:'verified'},B2:{status:'verified'}}}};
  assert.equal(capacityAcceptancePassed(valid),true);
  for(const patch of [{coreUnchanged:false},{closed:false},{monitorError:'snapshot failed'},{runnerCapacity:1},{peak:1},{peak:3},{receiptsValid:false},{ordered:false},{overlap:false},{windowLaunches:3},{uniqueLaunchers:3},{terminal:null},{engineResult:{code:1}},{pollResult:{code:1}},{summary:{success:false,results:valid.summary.results}}])assert.equal(capacityAcceptancePassed({...valid,...patch}),false,JSON.stringify(patch));
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
  assert.equal(liveTimeout({}),180000);
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
