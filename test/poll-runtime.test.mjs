import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {main,parsePollingOptions,loadSummary} from '../scripts/core/poll-windows.mjs';
import {createStatusPublisher} from '../scripts/core/status-events.mjs';
const complete={runId:'poll-test',finishedAt:1,blocks:[{key:'B1'}],tasks:[{id:'T1'}],results:{B1:{status:'verified'}},taskResults:{T1:{status:'verified'}}};
const family=fileURLToPath(new URL('../temp/',import.meta.url));
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
