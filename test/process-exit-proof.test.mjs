import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {waitForProcessExit} from '../scripts/core/runner.mjs';
import {processIdentityBinding} from '../scripts/core/leases.mjs';

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
  let at=0,pauses=0;
  const pauseMs=async ms=>{
    at+=ms;
    if(++pauses>3)throw new Error('relative timeout was not honored');
  };
  assert.equal(await waitForProcessExit(expected,{timeoutMs:30,intervalMs:10,snapshot:unavailable,now:()=>at,pauseMs}),false);
  assert.equal(pauses,3);
});

test('a relative timeout also bounds a continuously matching snapshot',async()=>{
  const expected={ProcessId:process.pid,Name:'node.exe',Started:'live',CommandLine:'live'};
  let at=0,pauses=0;
  const pauseMs=async ms=>{
    at+=ms;
    if(++pauses>3)throw new Error('matching snapshot bypassed the relative timeout');
  };
  assert.equal(await waitForProcessExit(expected,{timeoutMs:30,intervalMs:10,snapshot:()=>new Map([[process.pid,expected]]),now:()=>at,pauseMs}),false);
  assert.equal(pauses,3);
});

test('a zero relative timeout does not start a process snapshot',async()=>{
  const expected={ProcessId:process.pid,Name:'node.exe',Started:'live',CommandLine:'live'};
  let snapshots=0;
  assert.equal(await waitForProcessExit(expected,{timeoutMs:0,snapshot:()=>{snapshots++;return new Map();}}),false);
  assert.equal(snapshots,0);
});

test('an invalid absolute exit deadline is rejected before polling',async()=>{
  const expected={ProcessId:process.pid,Name:'node.exe',Started:'live',CommandLine:'live'};
  await assert.rejects(waitForProcessExit(expected,{deadlineAt:Number.NaN}),/deadlineAt must be an absolute integer timestamp/);
});

test('an earlier absolute deadline never expands the relative exit budget',async()=>{
  const expected={ProcessId:process.pid,Name:'node.exe',Started:'live',CommandLine:'live'};
  let at=0;const pauses=[];
  assert.equal(await waitForProcessExit(expected,{
    timeoutMs:50,intervalMs:10,deadlineAt:15,snapshot:()=>new Map([[process.pid,expected]]),now:()=>at,
    pauseMs:async ms=>{pauses.push(ms);at+=ms;},
  }),false);
  assert.deepEqual(pauses,[10,5]);
});

for(const code of ['EPERM','EACCES','UNKNOWN'])test(`${code} is not evidence that the process exited`,async()=>{
  const expected={ProcessId:process.pid,Name:'node.exe',Started:'live',CommandLine:'live'};
  const probePid=()=>{throw Object.assign(new Error(code),{code});};
  assert.equal(await waitForProcessExit(expected,{timeoutMs:30,intervalMs:10,deadlineAt:Date.now()+30,probePid,snapshot:unavailable}),false);
});

test('a reused live PID is compared with the saved process identity',async()=>{
  const runtime={ProcessId:process.pid,Name:'node.exe',Started:'original',CommandLine:'original'};
  const expected=processIdentityBinding(runtime);
  const actual={...runtime,Started:'replacement',CommandLine:'replacement'};
  assert.equal(await waitForProcessExit(expected,{snapshot:()=>new Map([[process.pid,actual]])}),true);
  assert.equal(await waitForProcessExit(expected,{timeoutMs:30,intervalMs:10,deadlineAt:Date.now()+30,snapshot:()=>new Map([[process.pid,runtime]])}),false);
});
