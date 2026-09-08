import test from 'node:test';
import assert from 'node:assert/strict';
import {main,parsePollingOptions} from '../scripts/core/poll-windows.mjs';
const complete={runId:'poll-test',finishedAt:1,blocks:[{key:'B1'}],tasks:[{id:'T1'}],results:{B1:{status:'verified'}},taskResults:{T1:{status:'verified'}}};
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
