import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createVisibleExecutionHooks,waitForSessionFile,waitTaskComplete} from '../scripts/core/orchestrate-sdk.mjs';

test('visible execution hooks preserve deadline context and established callback positions',async()=>{
 const controller=new AbortController();
 const context={deadlineAt:Date.now()+10_000,signal:controller.signal,stage:'execution fixture'};
 const captured={};
 const hooks=createVisibleExecutionHooks({
  agent:'codex',
  spawnWindow:async(...args)=>{captured.spawn=args;return {ok:true};},
  readPid:()=>4321,
  sessionWait:async(...args)=>{captured.session=args;return 'session-file';},
  taskWait:async(...args)=>{captured.wait=args;return {done:true};},
  exitCode:()=>7,
 });
 const shouldAbort=()=>false;
 assert.deepEqual(await hooks.spawn('launcher.ps1','title','launcher.pid',3,'token',context),{ok:true});
 assert.deepEqual(captured.spawn,['launcher.ps1','title','launcher.pid',3,'token',true,null,context]);
 assert.equal(hooks.readPid('launcher.pid'),4321);
 assert.equal(await hooks.session('match',50,'result.json',shouldAbort,context),'session-file');
 assert.deepEqual(captured.session,['match',50,'result.json',shouldAbort,context]);
 assert.deepEqual(await hooks.wait('session-file',60,'result.json','token','launcher.pid',shouldAbort,context),{done:true});
 assert.deepEqual(captured.wait,['session-file',60,'result.json','token','launcher.pid',shouldAbort,context]);
 assert.equal(hooks.exitCode('result.json'),7);
});

test('visible polling returns promptly when the execution context is already cancelled',async()=>{
 const controller=new AbortController();
 const context={deadlineAt:Date.now()+10_000,signal:controller.signal,stage:'execution fixture'};
 controller.abort();
 const started=Date.now();
 assert.equal(await waitForSessionFile('unreachable-token',60_000,'',()=>false,context),null);
 const visible=await waitTaskComplete('missing-rollout.jsonl',60_000,'','unreachable-token','missing.pid',()=>false,context);
 assert.equal(visible.executionDeadline,true);
 assert.ok(Date.now()-started<250,'a pre-cancelled context must not enter the normal polling delays');
});

test('visible completion stops report reconciliation promptly when acceptance is aborted',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orch-visible-acceptance-abort-'));
 const resultFile=path.join(dir,'result.json');
 const rolloutFile=path.join(dir,'rollout.jsonl');
 const controller=new AbortController();
 let abortChecks=0;
 const shouldAbort=()=>++abortChecks>=2;
 const context={deadlineAt:Date.now()+10_000,signal:controller.signal,stage:'acceptance abort fixture'};
 let pending;
 try{
  fs.writeFileSync(resultFile,JSON.stringify({__EXIT__:0}),'utf8');
  pending=waitTaskComplete(rolloutFile,60_000,resultFile,'fixture-token',undefined,shouldAbort,context);
  const raced=await Promise.race([
   pending.then(result=>({result})),
   new Promise(resolve=>setTimeout(()=>{controller.abort();resolve({timedOut:true});},700)),
  ]);
  assert.equal(raced.timedOut,undefined,'acceptance abort must not wait for the report reconciliation timeout');
  assert.equal(raced.result.aborted,true);
  assert.equal(raced.result.done,false);
  assert.equal(raced.result.verified,false);
 }finally{
  controller.abort();
  await pending?.catch(()=>{});
  fs.rmSync(dir,{recursive:true,force:true});
 }
});

test('visible completion stops post-close capacity annotation promptly when acceptance is aborted',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orch-visible-annotation-abort-'));
 const resultFile=path.join(dir,'result.json');
 const rolloutFile=path.join(dir,'rollout.jsonl');
 const controller=new AbortController();
 let abortChecks=0;
 // The outer wait and report reader each see a non-aborted decision.  The
 // following capacity-annotation phase must see the same acceptance callback
 // and stop before its normal two-second diagnostic tail.
 const shouldAbort=()=>++abortChecks>=3;
 const context={deadlineAt:Date.now()+10_000,signal:controller.signal,stage:'annotation abort fixture'};
 let pending;
 try{
  fs.writeFileSync(resultFile,JSON.stringify({__EXIT__:0,__REPORT__:'finished'}),'utf8');
  pending=waitTaskComplete(rolloutFile,60_000,resultFile,'fixture-token',undefined,shouldAbort,context);
  const raced=await Promise.race([
   pending.then(result=>({result})),
   new Promise(resolve=>setTimeout(()=>{controller.abort();resolve({timedOut:true});},700)),
  ]);
  assert.equal(raced.timedOut,undefined,'acceptance abort must not wait for the post-close capacity annotation timeout');
  assert.equal(raced.result.aborted,true);
  assert.equal(raced.result.done,false);
  assert.equal(raced.result.verified,false);
 }finally{
  controller.abort();
  await pending?.catch(()=>{});
  fs.rmSync(dir,{recursive:true,force:true});
 }
});

test('visible retry path keeps the execution context through popup confirmation and warmup',()=>{
 const source=fs.readFileSync(fileURLToPath(new URL('../scripts/core/orchestrate-sdk.mjs',import.meta.url)),'utf8');
 const start=source.indexOf('async function spawnWindowWithRetry');
 const end=source.indexOf('\nfunction releaseAuxiliaryWindow',start);
 assert.ok(start>=0&&end>start,'the visible retry implementation must have a bounded source region');
 const retry=source.slice(start,end);
 const popup=retry.indexOf('windowGenuinelyPopped(pidf, token, lp, context)');
 const warmup=retry.indexOf('await warmupWindow(pidf, token, context)');
 assert.ok(popup>=0&&warmup>popup,'a visible retry must carry its deadline context through popup confirmation before warmup');
 assert.match(retry,/spawnVisibleWindow\(lp, title, context\)/,'the actual launch call must receive the execution context');
 assert.match(source,/spawnInactiveWindow\([\s\S]{0,400}executionContextTimeout\(15000, context\)/,'the native launch helper timeout must be capped by the same context');
});
