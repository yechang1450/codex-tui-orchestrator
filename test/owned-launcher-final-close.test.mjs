import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn,spawnSync} from 'node:child_process';
import * as core from '../scripts/core/orchestrate-sdk.mjs';
import {processSnapshot} from '../scripts/core/leases.mjs';

const tempDir='C:\\work\\temp';
const owned={ProcessId:123,Started:'2026-09-26T00:00:00.0000000Z',Name:'powershell.exe',CommandLine:'powershell.exe -NoProfile -File "C:\\work\\temp\\win-launch-owned.ps1"'};

test('last-resort close uses the owned launcher handle and exit zero after checking creation time',()=>{
  let live=true,script;
  const result=core.terminateOwnedLauncher(owned,{tempDir,snapshot:()=>new Map(live?[[123,owned]]:[]),run:(_file,args)=>{script=args.at(-1);live=false;return {status:0};}});
  assert.equal(result,true);
  assert.match(script,/GetProcessTimes/);assert.match(script,/OpenProcess/);
  assert.match(script,/TerminateProcess\(\$handle,0\)/);
  assert.doesNotMatch(script,/taskkill|WindowsTerminal/);
});

test('last-resort close refuses shared hosts, foreign scripts, reused identities and unverifiable snapshots',()=>{
  let calls=0;const run=()=>{calls++;return {status:0};};
  for(const expected of [undefined,{...owned,Name:'WindowsTerminal.exe'},{...owned,CommandLine:'powershell.exe -File C:\\elsewhere\\win-launch-owned.ps1'}])
    assert.equal(core.terminateOwnedLauncher(expected,{tempDir,snapshot:()=>new Map([[123,expected]]),run}),false);
  assert.equal(core.terminateOwnedLauncher(owned,{tempDir,snapshot:()=>new Map([[123,{...owned,Started:'different'}]]),run}),false);
  assert.equal(core.terminateOwnedLauncher(owned,{tempDir,snapshot:()=>{throw new Error('CIM unavailable');},run}),false);
  assert.equal(calls,0);
});

test('owned PowerShell launcher closes with exit zero without a model or terminal host',{skip:process.platform!=='win32'},async()=>{
  const family=fileURLToPath(new URL('../temp/',import.meta.url));fs.mkdirSync(family,{recursive:true});
  const workspace=fs.mkdtempSync(path.join(family,'owned-exit-'));
  const file=path.join(workspace,'win-launch-owned-test.ps1');
  fs.writeFileSync(file,'Start-Sleep -Seconds 60\r\n','utf8');
  const child=spawn('powershell.exe',['-NoProfile','-File',file],{windowsHide:true,stdio:'ignore'});
  const finished=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});
  try{
    const expected=processSnapshot().get(child.pid);
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
