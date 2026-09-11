import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runWindows} from '../scripts/core/runner.mjs';

for(const mixed of [false,true])test(mixed?'capacity recovery never disables the ordinary failure budget':'capacity retries use their own budget and restore pending TodoList state',async()=>{
 const workspace=fs.mkdtempSync(path.join(os.tmpdir(),'orch-capacity-run-'));
 const original={ORCH_CAPACITY_RETRIES:process.env.ORCH_CAPACITY_RETRIES,ORCH_CAPACITY_RETRY_MS:process.env.ORCH_CAPACITY_RETRY_MS};
 process.env.ORCH_CAPACITY_RETRIES='3';process.env.ORCH_CAPACITY_RETRY_MS='0';
 let launches=0,live=false;const prompts=[],spawnRetries=[];
 const identity={ProcessId:9001,Name:'powershell.exe',Started:'test',CommandLine:'test launcher'};
 const hooks={
  plan:async()=>[{title:'capacity',tasks:[{prompt:'执行任务'}]}],compact:p=>p,infer:()=>[],
  prompt:p=>{prompts.push(p);return p;},
  launcher:key=>({key,pidf:path.join(workspace,`window-${++launches}.pid`)}),
  register:()=>{},commit:()=>{},unregister:()=>{},cleanup:()=>{},
  spawn:async(...args)=>{spawnRetries.push(args[3]);live=true;return true;},
  readPid:()=>1,identity:()=>live?identity:null,waitForExit:async()=>true,
  close:async()=>{live=false;},session:async()=>true,
  wait:async()=>({done:true,exitCode:1,text:mixed&&launches>1?'Unrecoverable CLI startup failure':'Selected model is at capacity.'}),
  exitCode:()=>1,
 };
 try {
  const sum=await runWindows('执行任务',hooks,{workspace,capacity:8,runId:'capacity',auth:'test',maxAttempts:1,coordinator:path.join(workspace,'coordinator')});
  const expected=mixed?2:4;
  assert.equal(launches,expected,'capacity attempts must not disable the normal failure limit');
  assert.equal(sum.success,false);
  assert.equal(sum.results.B1.status,'failed');
  assert.equal(sum.taskResults.T001.status,'failed');
  assert.equal(prompts.length,expected);
  assert.deepEqual(spawnRetries,Array(expected).fill(3),'runner must preserve a bounded multi-attempt launcher retry budget');
  for(const prompt of prompts.slice(1))assert.match(prompt,/T001 \(pending\)/);
 } finally {
  if(original.ORCH_CAPACITY_RETRIES===undefined)delete process.env.ORCH_CAPACITY_RETRIES;else process.env.ORCH_CAPACITY_RETRIES=original.ORCH_CAPACITY_RETRIES;
  if(original.ORCH_CAPACITY_RETRY_MS===undefined)delete process.env.ORCH_CAPACITY_RETRY_MS;else process.env.ORCH_CAPACITY_RETRY_MS=original.ORCH_CAPACITY_RETRY_MS;
  fs.rmSync(workspace,{recursive:true,force:true});
 }
});
