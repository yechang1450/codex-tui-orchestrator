import {testTempFamily} from './test-temp-root.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn,spawnSync} from 'node:child_process';
import * as core from '../scripts/core/orchestrate-sdk.mjs';
import {processIdentityBinding,processSnapshot} from '../scripts/core/leases.mjs';

const tempDir='C:\\work\\temp';
const ownedRuntime={ProcessId:123,Started:'2026-09-26T00:00:00.0000000Z',Name:'powershell.exe',CommandLine:'powershell.exe -NoProfile -File "C:\\work\\temp\\win-launch-owned.ps1"'};
const owned=processIdentityBinding(ownedRuntime);

test('last-resort close uses the owned launcher handle and exit zero after checking creation time',()=>{
  let live=true,script,options;
  const result=core.terminateOwnedLauncher(owned,{tempDir,snapshot:()=>new Map(live?[[123,ownedRuntime]]:[]),run:(_file,args,spawnOptions)=>{script=args.at(-1);options=spawnOptions;live=false;return {status:0};}});
  assert.equal(result,true);
  assert.match(script,/GetProcessTimes/);assert.match(script,/OpenProcess/);
  assert.match(script,/TerminateProcess\(\$handle,0\)/);
  assert.doesNotMatch(script,/taskkill|WindowsTerminal/);
  assert.match(script,/commandLineSha256|SHA256/,'the child verifier must compare a hash rather than receive a raw command line');
  assert.doesNotMatch(script,new RegExp(ownedRuntime.CommandLine.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')),'the raw launcher command line must not be embedded in a child PowerShell argument');
  assert.equal(options.timeout,15000,'calls without a deadline retain the legacy fixed close timeout');
});

test('last-resort close refuses an expired cleanup deadline before snapshot or PowerShell',()=>{
  let snapshots=0,runs=0;
  const result=core.terminateOwnedLauncher(owned,{
    tempDir,
    deadlineAt:Date.now()-1,
    snapshot:()=>{snapshots++;return new Map([[123,ownedRuntime]]);},
    run:()=>{runs++;return {status:0};}
  });
  assert.equal(result,false);
  assert.equal(snapshots,0,'expiry must prevent process observation');
  assert.equal(runs,0,'expiry must prevent force-close PowerShell');
});

test('last-resort close bounds PowerShell to the remaining cleanup deadline',()=>{
  let options;
  const remainingBudgetMs=10000,deadlineAt=Date.now()+remainingBudgetMs;
  core.terminateOwnedLauncher(owned,{
    tempDir,
    deadlineAt,
    snapshot:()=>new Map([[123,ownedRuntime]]),
    run:(_file,_args,spawnOptions)=>{options=spawnOptions;return {status:1};}
  });
  assert.ok(options?.timeout>0,'deadline close must configure a positive synchronous timeout');
  assert.ok(options.timeout<=remainingBudgetMs,'deadline close must not outlive the supplied cleanup budget');
});

test('visible close treats an expired cleanup deadline as unproven before checking a PID',async()=>{
  const result=await core.closeWindowByPid(999999,owned,{tempDir,deadlineAt:Date.now()-1});
  assert.equal(result,false);
});

test('visible executor close hook forwards its trailing cleanup deadline',()=>{
  const source=fs.readFileSync(fileURLToPath(new URL('../scripts/core/orchestrate-sdk.mjs',import.meta.url)),'utf8');
  assert.match(source,/close:\(pid,expected,\{deadlineAt\}=\{\}\)=>closeWindowByPid\(pid,expected,\{tempDir:controllerWindowsDir\(WORKSPACE\),deadlineAt\}\)/);
});

test('visible cleanup and unregister retain artifacts and reservations after deadline expiry',()=>{
  const root=fs.mkdtempSync(path.join(testTempFamily('owned-launcher-final-close'),'deadline-visible-cleanup-'));
  const files=Object.fromEntries(['lp','pf','pidf','rf'].map(key=>[key,path.join(root,key+'.txt')]));
  const db=path.join(root,'windows.json');
  for(const file of [...Object.values(files),files.pidf+'.self-closed',files.rf+'.self-closed'])fs.writeFileSync(file,'recovery');
  fs.writeFileSync(db,JSON.stringify([{id:'lease-1'}]));
  core.__setOrchHooks({db,alive:()=>true,lock:fn=>fn(),now:()=>Date.now()});
  try{
    const deadlineAt=Date.now()-1;
    assert.equal(core.cleanupVisibleLauncherArtifacts(files,{deadlineAt}),false);
    assert.equal(core.unregisterWindowReservation('lease-1',root,{deadlineAt}),false);
    for(const file of [...Object.values(files),files.pidf+'.self-closed',files.rf+'.self-closed'])assert.equal(fs.existsSync(file),true);
    assert.deepEqual(JSON.parse(fs.readFileSync(db,'utf8')).map(entry=>entry.id),['lease-1']);
  }finally{
    core.__setOrchHooks(null);
    fs.rmSync(root,{recursive:true,force:true});
  }
});

test('visible cleanup and unregister retain their legacy no-deadline behavior',()=>{
  const root=fs.mkdtempSync(path.join(testTempFamily('owned-launcher-final-close'),'deadline-visible-legacy-'));
  const files=Object.fromEntries(['lp','pf','pidf','rf'].map(key=>[key,path.join(root,key+'.txt')]));
  const db=path.join(root,'windows.json');
  for(const file of [...Object.values(files),files.pidf+'.self-closed',files.rf+'.self-closed'])fs.writeFileSync(file,'recovery');
  fs.writeFileSync(db,JSON.stringify([{id:'lease-1'}]));
  core.__setOrchHooks({db,alive:()=>true,lock:fn=>fn(),now:()=>Date.now()});
  try{
    assert.equal(core.cleanupVisibleLauncherArtifacts(files),undefined);
    assert.equal(core.unregisterWindowReservation('lease-1',root),undefined);
    for(const file of [...Object.values(files),files.pidf+'.self-closed',files.rf+'.self-closed'])assert.equal(fs.existsSync(file),false);
    assert.deepEqual(JSON.parse(fs.readFileSync(db,'utf8')),[]);
  }finally{
    core.__setOrchHooks(null);
    fs.rmSync(root,{recursive:true,force:true});
  }
});

test('visible unregister rechecks cleanup deadline after waiting for the registry lock',()=>{
  const root=fs.mkdtempSync(path.join(testTempFamily('owned-launcher-final-close'),'deadline-visible-lock-'));
  const db=path.join(root,'windows.json');
  fs.writeFileSync(db,JSON.stringify([{id:'lease-1'}]));
  core.__setOrchHooks({
    db,
    alive:()=>true,
    now:()=>Date.now(),
    lock:fn=>{
      const until=Date.now()+30;
      while(Date.now()<until){}
      return fn();
    }
  });
  try{
    const result=core.unregisterWindowReservation('lease-1',root,{deadlineAt:Date.now()+5});
    assert.equal(result,false);
    assert.deepEqual(JSON.parse(fs.readFileSync(db,'utf8')).map(entry=>entry.id),['lease-1']);
  }finally{
    core.__setOrchHooks(null);
    fs.rmSync(root,{recursive:true,force:true});
  }
});

test('last-resort close refuses shared hosts, foreign scripts, reused identities and unverifiable snapshots',()=>{
  let calls=0;const run=()=>{calls++;return {status:0};};
  for(const runtime of [undefined,{...ownedRuntime,Name:'WindowsTerminal.exe'},{...ownedRuntime,CommandLine:'powershell.exe -File C:\\elsewhere\\win-launch-owned.ps1'}]){
    const expected=runtime&&processIdentityBinding(runtime);
    assert.equal(core.terminateOwnedLauncher(expected,{tempDir,snapshot:()=>new Map([[123,runtime]]),run}),false);
  }
  assert.equal(core.terminateOwnedLauncher(owned,{tempDir,snapshot:()=>new Map([[123,{...ownedRuntime,Started:'different'}]]),run}),false);
  assert.equal(core.terminateOwnedLauncher(owned,{tempDir,snapshot:()=>{throw new Error('CIM unavailable');},run}),false);
  assert.equal(calls,0);
});

test('owned PowerShell launcher closes with exit zero without a model or terminal host',{skip:process.platform!=='win32'},async()=>{
  const family=testTempFamily('owned-launcher-final-close');fs.mkdirSync(family,{recursive:true});
  const workspace=fs.mkdtempSync(path.join(family,'owned-exit-'));
  const file=path.join(workspace,'win-launch-owned-test.ps1');
  fs.writeFileSync(file,'Start-Sleep -Seconds 60\r\n','utf8');
  const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',file],{windowsHide:true,stdio:'ignore'});
  const finished=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});
  try{
    const runtime=processSnapshot().get(child.pid),expected=processIdentityBinding(runtime);
    assert.ok(expected,'fixture process has a verifiable identity');
    let diagnostic;
    assert.equal(core.terminateOwnedLauncher(expected,{tempDir:workspace,run:(...args)=>{const result=spawnSync(...args);diagnostic={status:result.status,stderr:result.stderr};return result;}}),true,JSON.stringify(diagnostic));
    assert.deepEqual(await finished,{code:0,signal:null});
  }finally{
    if(child.exitCode===null)child.kill();await finished;
    fs.rmSync(workspace,{recursive:true,force:true});
  }
});

test('the final normalized inventory selects inline when a multi-block proposal omitted work',()=>{
  const prepared=core.prepareExecutionPlan('执行甲；执行乙',[{title:'a',tasks:[{prompt:'执行甲'}]},{title:'omission',tasks:[{prompt:'unrelated'}]}]);
  assert.equal(prepared.inline,true);assert.equal(prepared.plan.length,1);
  assert.deepEqual(prepared.tasks.map(t=>t.prompt),['执行甲','执行乙']);
  const independent=core.prepareExecutionPlan('执行甲；执行乙',[{title:'a',tasks:[{prompt:'执行甲'}]},{title:'b',tasks:[{prompt:'执行乙'}]}]);
  assert.equal(independent.inline,false);assert.equal(independent.plan.length,2);
});
