import {testTempFamily} from './test-temp-root.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {main,parsePollingOptions,loadSummary} from '../scripts/core/poll-windows.mjs';
import {createStatusPublisher} from '../scripts/core/status-events.mjs';
const complete={runId:'poll-test',finishedAt:1,blocks:[{key:'B1'}],tasks:[{id:'T1'}],results:{B1:{status:'verified'}},taskResults:{T1:{status:'verified'}}};
const family=testTempFamily('poll-runtime');
test('poll rejects invalid timing, missing values and unknown flags',()=>{
 for(const args of [['--timeoutMs','Infinity'],['--timeoutMs','NaN'],['--timeoutMs','-1'],['--timeoutMs',''],['--intervalMs','0'],['--timeoutMs'],['--unknown'],['toString','1']])assert.throws(()=>parsePollingOptions(['--run-id','poll-test',...args]),/POLL_ARGUMENT_INVALID/);
 assert.equal(parsePollingOptions(['--run-id','poll-test','--timeoutMs','0']).timeoutMs,0);
});
test('poll sleeps only for the remaining deadline budget',async()=>{
 let time=0;const waits=[];const previous=process.exitCode;
 try{
  await main(['--run-id','poll-test','--timeoutMs','20','--intervalMs','5000'],{now:()=>time,sleep:async ms=>{waits.push(ms);time+=ms;},load:()=>null,log:()=>{},error:()=>{}});
  assert.deepEqual(waits,[20]);assert.equal(process.exitCode,1);
 }finally{process.exitCode=previous;}
});
test('poll fails closed before a completed isolated acceptance can report success',async()=>{
 const previous=process.exitCode,errors=[];
 try{
  await main(['--run-id','poll-test','--timeoutMs','0'],{
   abort:()=>({kind:'acceptance-abort',runId:'poll-test'}),
   load:()=>{throw new Error('an abort must prevent summary loading');},
   log:()=>{},error:message=>errors.push(message)
  });
  assert.equal(process.exitCode,1);
  assert.deepEqual(errors,['[poll-windows] isolated acceptance aborted runId=poll-test']);
 }finally{process.exitCode=previous;}
});
test('poll contains malformed isolated abort authority errors',async()=>{
 const previous=process.exitCode,errors=[],secret='abort-token-must-not-appear';
 try{
  await main(['--run-id','poll-test','--timeoutMs','0'],{
   abort:()=>{throw new Error('malformed abort record '+secret);},
   load:()=>{throw new Error('an invalid abort authority must prevent summary loading');},
   log:()=>{},error:message=>errors.push(message)
  });
  assert.equal(process.exitCode,1);
  assert.deepEqual(errors,['[poll-windows] isolated acceptance abort authority unavailable runId=poll-test']);
  assert.doesNotMatch(JSON.stringify(errors),new RegExp(secret));
 }finally{process.exitCode=previous;}
});
test('poll summary loading requires controller authority and stays bounded',()=>{
 const root=fs.mkdtempSync(path.join(family,'poll-summary-'));
 const controller=fs.mkdtempSync(path.join(family,'poll-summary-controller-'));
 const previous=process.env.ORCH_CONTROLLER_ROOT;process.env.ORCH_CONTROLLER_ROOT=controller;
 const dir=path.join(root,'temp','orchestrator','runs','poll-test');fs.mkdirSync(dir,{recursive:true});
 try{
  fs.writeFileSync(path.join(dir,'summary.json'),JSON.stringify({...complete,workspace:root}));
  assert.equal(loadSummary(root,'poll-test'),null,'workspace-authored terminal summary must not be trusted');
  createStatusPublisher(dir).publish({...complete,workspace:root},'run.finished');
  assert.equal(loadSummary(root,'poll-test')?.runId,'poll-test','controller-published summary remains readable');
  fs.writeFileSync(path.join(dir,'summary.json'),'x'.repeat(4*1024*1024+1));
  assert.equal(loadSummary(root,'poll-test'),null,'oversized summary must be rejected');
 }finally{
  if(previous===undefined)delete process.env.ORCH_CONTROLLER_ROOT;else process.env.ORCH_CONTROLLER_ROOT=previous;
  fs.rmSync(root,{recursive:true,force:true});fs.rmSync(controller,{recursive:true,force:true});
 }
});
test('process inspection failure cannot produce success',async()=>{
 await assert.rejects(main(['--run-id','poll-test'],{load:()=>complete,snapshot:()=>{throw new Error('inspection unavailable');},log:()=>{},error:()=>{}}),/inspection unavailable/);
});
test('verified result must be observed closed twice before success',async()=>{
 let time=0,calls=0;const previous=process.exitCode;
 try{
  await main(['--run-id','poll-test','--timeoutMs','2000','--intervalMs','500'],{now:()=>time,sleep:async ms=>{time+=ms;},load:()=>complete,snapshot:()=>{calls++;return new Map();},log:()=>{},error:()=>{}});
  assert.equal(calls,2);assert.equal(process.exitCode,0);
 }finally{process.exitCode=previous;}
});

test('isolated polling refuses a successful exit until the controller commits its terminal finalization',async()=>{
 let time=0;const logs=[],errors=[],previous=process.exitCode;
 try{
  await main(['--run-id','poll-test','--timeoutMs','2000','--intervalMs','500'],{
   isolatedAcceptance:true,abort:()=>null,finalization:()=>null,
   now:()=>time,sleep:async ms=>{time+=ms;},load:()=>complete,snapshot:()=>new Map(),log:message=>logs.push(message),error:message=>errors.push(message),
  });
  assert.equal(process.exitCode,1);
  assert.equal(logs.some(message=>String(message).includes('"success":true')),false);
  assert.deepEqual(errors,['[poll-windows] isolated acceptance finalization unavailable runId=poll-test']);
 }finally{process.exitCode=previous;}
});

test('isolated polling accepts a controller-committed finalization after two closed observations',async()=>{
 let time=0,calls=0;const logs=[],previous=process.exitCode;
 try{
  await main(['--run-id','poll-test','--timeoutMs','2000','--intervalMs','500'],{
   isolatedAcceptance:true,abort:()=>null,finalization:()=>({kind:'acceptance-finalization',runId:'poll-test'}),
   now:()=>time,sleep:async ms=>{time+=ms;},load:()=>complete,snapshot:()=>{calls++;return new Map();},log:message=>logs.push(message),error:()=>{},
  });
  assert.equal(calls,2);
  assert.equal(process.exitCode,0);
  assert.equal(logs.some(message=>String(message).includes('"success":true')),true);
 }finally{process.exitCode=previous;}
});
