import {testTempFamily} from './test-temp-root.mjs';
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runWindows} from '../scripts/core/runner.mjs';
import {controllerWindowsDir} from '../scripts/core/controller-state.mjs';
const family=testTempFamily('runner-capacity');fs.mkdirSync(family,{recursive:true});
const controllerRoot=fs.mkdtempSync(path.join(family,'capacity-controller-'));
const oldControllerRoot=process.env.ORCH_CONTROLLER_ROOT;
process.env.ORCH_CONTROLLER_ROOT=controllerRoot;
after(()=>{if(oldControllerRoot===undefined)delete process.env.ORCH_CONTROLLER_ROOT;else process.env.ORCH_CONTROLLER_ROOT=oldControllerRoot;fs.rmSync(controllerRoot,{recursive:true,force:true});});

for(const mixed of [false,true])test(mixed?'capacity recovery never disables the ordinary failure budget':'capacity retries use their own budget and restore pending TodoList state',async()=>{
 const workspace=fs.mkdtempSync(path.join(family,'orch-capacity-run-'));
 fs.mkdirSync(path.join(workspace,'temp'),{recursive:true});
 const original={ORCH_CAPACITY_RETRIES:process.env.ORCH_CAPACITY_RETRIES,ORCH_CAPACITY_RETRY_MS:process.env.ORCH_CAPACITY_RETRY_MS};
 process.env.ORCH_CAPACITY_RETRIES='3';process.env.ORCH_CAPACITY_RETRY_MS='0';
 let launches=0,live=false;const prompts=[],spawnRetries=[];
 const identity={ProcessId:9001,Name:'powershell.exe',Started:'test',CommandLine:'test launcher'};
 const hooks={
  plan:async()=>[{title:'capacity',tasks:[{prompt:'执行任务'}]}],compact:p=>p,infer:()=>[],
  prompt:p=>{prompts.push(p);return p;},
  launcher:(key,_prompt,suffix)=>{++launches;const dir=controllerWindowsDir(workspace),stem=key+'-'+suffix;return {key,lp:path.join(dir,`win-launch-${stem}.ps1`),pf:path.join(dir,`agent-win-${stem}.md`),pidf:path.join(dir,`window-${stem}.pid`),rf:path.join(dir,`win-${stem}.result.json`)};},
  register:()=>{},commit:()=>{},unregister:()=>{},cleanup:()=>{},
  spawn:async(...args)=>{spawnRetries.push(args[3]);live=true;return true;},
  readPid:()=>9001,identity:()=>live?identity:null,waitForExit:async()=>true,
  close:async()=>{live=false;},session:async()=>true,
  wait:async()=>({done:true,exitCode:1,...(mixed&&launches>1?{text:'Unrecoverable CLI startup failure'}:{text:'Selected model is at capacity.',retryable:'capacity'})}),
  exitCode:()=>1,
 };
 try {
  const sum=await runWindows('执行任务',hooks,{workspace,capacity:8,runId:'capacity',auth:'test',maxAttempts:1,coordinator:path.join(controllerRoot,'coordinator')});
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

test('terminal provider quota does not consume the ordinary failure budget',async()=>{
 const workspace=fs.mkdtempSync(path.join(family,'orch-quota-run-'));
 fs.mkdirSync(path.join(workspace,'temp'),{recursive:true});
 let launches=0;
 const identity={ProcessId:9002,Name:'powershell.exe',Started:'test',CommandLine:'test launcher'};
 const hooks={
  plan:async()=>[{title:'quota',tasks:[{prompt:'执行任务'}]}],compact:p=>p,infer:()=>[],
  prompt:p=>p,launcher:(key,_prompt,suffix)=>{++launches;const dir=controllerWindowsDir(workspace),stem=key+'-'+suffix;return {key,lp:path.join(dir,`win-launch-${stem}.ps1`),pf:path.join(dir,`agent-win-${stem}.md`),pidf:path.join(dir,`window-${stem}.pid`),rf:path.join(dir,`win-${stem}.result.json`)};},
  register:()=>{},commit:()=>{},unregister:()=>{},cleanup:()=>{},
  spawn:async()=>true,readPid:()=>9002,identity:()=>identity,waitForExit:async()=>true,
  close:async()=>{},session:async()=>true,
  wait:async()=>({done:true,exitCode:1,text:'usage_limit_exceeded',retryable:'quota',quotaError:'usage_limit_exceeded'}),
  exitCode:()=>1,
 };
 try {
  const sum=await runWindows('执行任务',hooks,{workspace,capacity:8,runId:'quota',auth:'test',maxAttempts:3,coordinator:path.join(controllerRoot,'coordinator')});
  assert.equal(launches,1,'quota failures must stop before a second window');
  assert.equal(sum.success,false);
  assert.equal(sum.results.B1.status,'failed');
  assert.match(sum.results.B1.reason,/quota|usage_limit_exceeded/i);
 } finally { fs.rmSync(workspace,{recursive:true,force:true}); }
});
