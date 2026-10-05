import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {waitForProcessExit} from '../scripts/core/runner.mjs';

const unavailable=()=>{throw new Error('process snapshot timed out');};
const realProbe=pid=>{try{process.kill(pid,0);return true;}catch(error){if(error?.code==='ESRCH')return false;throw error;}};

test('an actually exited process is proven gone when the full process snapshot is unavailable',async()=>{
  const child=spawn(process.execPath,['-e','process.exit(0)'],{windowsHide:true,stdio:'ignore'});
  await once(child,'exit');
  const expected={ProcessId:child.pid,Name:'node.exe',Started:'exited-child',CommandLine:'exited-child'};
  assert.equal(await waitForProcessExit(expected,{timeoutMs:30,intervalMs:10,snapshot:unavailable,probePid:realProbe}),true);
});

test('a live process and unreadable identity never prove exit',async()=>{
  const expected={ProcessId:process.pid,Name:'node.exe',Started:'live',CommandLine:'live'};
  assert.equal(await waitForProcessExit(expected,{timeoutMs:30,intervalMs:10,snapshot:unavailable}),false);
});

for(const code of ['EPERM','EACCES','UNKNOWN'])test(`${code} is not evidence that the process exited`,async()=>{
  const expected={ProcessId:process.pid,Name:'node.exe',Started:'live',CommandLine:'live'};
  const probePid=()=>{throw Object.assign(new Error(code),{code});};
  assert.equal(await waitForProcessExit(expected,{timeoutMs:30,intervalMs:10,probePid,snapshot:unavailable}),false);
});

test('a reused live PID is compared with the saved process identity',async()=>{
  const expected={ProcessId:process.pid,Name:'node.exe',Started:'original',CommandLine:'original'};
  const actual={...expected,Started:'replacement',CommandLine:'replacement'};
  assert.equal(await waitForProcessExit(expected,{snapshot:()=>new Map([[process.pid,actual]])}),true);
  assert.equal(await waitForProcessExit(expected,{timeoutMs:30,intervalMs:10,snapshot:()=>new Map([[process.pid,expected]])}),false);
});
