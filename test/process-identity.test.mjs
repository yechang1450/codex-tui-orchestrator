import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {assertDeadlineAvailable, claimRun, coordinatorProcessSnapshotScript, controllerEnvironment, isProcessIdentityBinding, launcherIdentity, processIdentityBinding, processIdentityFailureMessage, processSnapshot, processSnapshotTimeoutBefore, sameProcess, trustedWindowsHelper, trustedWindowsRoot} from '../scripts/core/leases.mjs';
import {providerFixtureToken} from './fixture-provider-tokens.mjs';

test('process snapshot deadline budget preserves the legacy cap and reserves its safe outer window',()=>{
 const now=1_000_000;
 assert.equal(processSnapshotTimeoutBefore(undefined,{now:()=>now}),120_000,'a caller without an absolute deadline keeps the legacy default');
 assert.equal(processSnapshotTimeoutBefore(undefined,{capMs:240_000,now:()=>now}),120_000,'legacy callers remain capped at the process snapshot maximum');
 assert.equal(processSnapshotTimeoutBefore(undefined,{capMs:4_500,now:()=>now}),4_500,'a smaller legacy caller cap remains usable');
 assert.equal(processSnapshotTimeoutBefore(now+30_000,{capMs:7_500,now:()=>now}),7_500,'an absolute deadline must still honor the caller cap');
 assert.equal(processSnapshotTimeoutBefore(now+30_000,{capMs:30_000,now:()=>now}),24_000,'the snapshot budget reserves the five-second outer grace and one-second scheduling margin');
 assert.equal(processSnapshotTimeoutBefore(now+7_000,{capMs:30_000,now:()=>now}),1_000,'the minimum Windows snapshot timeout remains explicit and usable');
 assert.equal(processSnapshotTimeoutBefore(now+6_999,{capMs:30_000,now:()=>now}),null,'an unsafe remainder never falls back to a default snapshot timeout');
 assert.equal(processSnapshotTimeoutBefore('not-a-deadline',{capMs:30_000,now:()=>now}),null,'an invalid supplied deadline fails closed instead of restoring the default timeout');
 assert.equal(processSnapshotTimeoutBefore(String(now+30_000),{capMs:30_000,now:()=>now}),null,'a deadline must remain a numeric timestamp instead of accepting a coercible string');
});

test('deadline preflight reports a stable exhausted outcome',()=>{
 const now=2_000_000;
 assert.doesNotThrow(()=>assertDeadlineAvailable(undefined,'coordinator preflight',{now:()=>now}),'legacy callers may omit an absolute deadline');
 const expected=error=>error?.code==='ORCH_DEADLINE_EXHAUSTED'&&error.message==='ORCH_DEADLINE_EXHAUSTED: coordinator preflight';
 assert.throws(()=>assertDeadlineAvailable(now,'coordinator preflight',{now:()=>now}),expected);
 assert.throws(()=>assertDeadlineAvailable('not-a-deadline','coordinator preflight',{now:()=>now}),expected);
 assert.throws(()=>assertDeadlineAvailable(String(now+1),'coordinator preflight',{now:()=>now}),expected);
});

test('process identity diagnostics retain an outcome code without accepting helper stderr text',()=>{
 const sentinel='C:\\Users\\private\\launcher.ps1 OPENAI_API_KEY=not-for-output';
 for(const status of [null,17,'unexpected']){
  const message=processIdentityFailureMessage(status);
  assert.match(message,/Cannot verify process identities/);
  assert.equal(message.includes(sentinel),false);
  assert.equal(message.includes('stderr'),false);
 }
 assert.match(processIdentityFailureMessage(17),/exit code 17/);
});

test('real process identity preserves parent PID and Unicode command arguments',{skip:process.platform!=='win32'},async()=>{
 const marker='process-\u4e2d\u6587-\u00e9-identity';
 const child=spawn(process.execPath,['-e','setTimeout(()=>{},30000)',marker],{windowsHide:true,stdio:'ignore'});
 try {
  await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
  const actual=processSnapshot().get(child.pid);
  assert.ok(actual);assert.ok(actual.CommandLine.includes(marker),actual.CommandLine);
  assert.equal(actual.ParentProcessId,process.pid,'orphan checks need the real parent identity');
 }finally{const gone=new Promise(r=>child.once('exit',r));child.kill();await gone;}
});

test('run ownership persists an irreversible command-line binding and verifies it against a live snapshot',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'codex-tui-private-owner-'));
 const privateToken=providerFixtureToken('openai-named','private-value');
 const owner={ProcessId:process.pid,Started:'2026-10-09T00:00:00.000Z',Name:'node.exe',CommandLine:`node orchestrate-sdk.mjs --run "OPENAI_API_KEY=${privateToken}"`};
 try {
  const claim=claimRun(dir,'run:privacy',()=>new Map([[owner.ProcessId,owner]]));
  const saved=JSON.parse(fs.readFileSync(path.join(dir,'run-owners.json'),'utf8'))['run:privacy'].owner;
  assert.equal(saved.CommandLine,undefined,'durable owner records must never retain raw command lines');
  assert.match(saved.commandLineSha256,/^[a-f0-9]{64}$/,'durable owner records bind the exact command line by hash');
  assert.equal(claim.owner.CommandLine,undefined,'claim result must be safe to pass into a public run summary');
  assert.equal(sameProcess(saved,owner),true,'a bound record accepts its original live process');
  assert.equal(sameProcess(saved,{...owner,CommandLine:'node orchestrate-sdk.mjs --run "different"'}),false,'the binding rejects a changed command line');
  assert.equal(sameProcess(owner,owner),false,'legacy raw persisted identities fail closed');
 } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('a durable process binding rejects extra fields and purges a poisoned run owner',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'codex-tui-owner-extra-field-'));
 const live={ProcessId:process.pid,Started:'2026-10-10T00:00:00.000Z',Name:'node.exe',CommandLine:'node orchestrate-sdk.mjs'};
 const poisoned={...processIdentityBinding(live),prompt:'PRIVATE⟪persisted-owner-prompt⟫'};
 try {
  assert.equal(isProcessIdentityBinding(poisoned),false,'a durable binding may contain only its identity fields');
  assert.equal(sameProcess(poisoned,live),false,'an extra durable field cannot authenticate a live process');
  fs.writeFileSync(path.join(dir,'run-owners.json'),JSON.stringify({protected:{owner:poisoned,token:'old-token'}}));
  const claim=claimRun(dir,'protected',()=>new Map([[process.pid,live]]));
  const persisted=fs.readFileSync(path.join(dir,'run-owners.json'),'utf8');
  assert.notEqual(claim.token,'old-token');
  assert.equal(persisted.includes('PRIVATE⟪persisted-owner-prompt⟫'),false,'the poisoned durable field must be removed during recovery');
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('coordinator snapshot cache persists process bindings without raw command lines',{skip:process.platform!=='win32'},()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'codex-tui-snapshot-private-')),cache=path.join(dir,'process-snapshot-cache.json');
 try {
  const script=coordinatorProcessSnapshotScript(cache,{caller:process.pid,ttlMs:60_000,waitMs:20_000,forceFresh:true});
  const result=spawnSync(trustedWindowsHelper('powershell'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',script],{encoding:'utf8',windowsHide:true,cwd:trustedWindowsRoot(),env:controllerEnvironment()});
  assert.equal(result.status,0,result.stderr);
  const persisted=JSON.parse(fs.readFileSync(cache,'utf8'));
  assert.equal(persisted.schema,3);
  assert.match(persisted.observedAt,/^\d{4}-\d{2}-\d{2}T.*Z$/,'the cache must record when the raw OS snapshot began');
  assert.deepEqual(Object.keys(persisted).sort(),['createdAt','observedAt','processes','schema']);
  assert.ok(persisted.processes.length>0);
  for(const row of persisted.processes){
   assert.equal(Object.hasOwn(row,'CommandLine'),false);
   assert.match(row.commandLineSha256,/^[a-f0-9]{64}$/);
  }
 } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('a legacy raw coordinator cache is purged before a fresh bound snapshot is published',{skip:process.platform!=='win32'},()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'codex-tui-legacy-cache-')),cache=path.join(dir,'process-snapshot-cache.json');
 const legacy='OPENAI_API_KEY=legacy-cache-value';
 try {
  fs.writeFileSync(cache,JSON.stringify({schema:1,createdAt:Date.now(),processes:[{CommandLine:legacy}]}),'utf8');
  const script=coordinatorProcessSnapshotScript(cache,{caller:process.pid,ttlMs:60_000,waitMs:20_000,forceFresh:false});
  const result=spawnSync(trustedWindowsHelper('powershell'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',script],{encoding:'utf8',windowsHide:true,cwd:trustedWindowsRoot(),env:controllerEnvironment()});
  assert.equal(result.status,0,result.stderr);
  const persisted=fs.readFileSync(cache,'utf8');
  assert.equal(persisted.includes(legacy),false);
  assert.equal(JSON.parse(persisted).schema,3);
 } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('a legacy schema-2 cache is purged before it can be reused',{skip:process.platform!=='win32'},()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'codex-tui-schema2-raw-cache-')),cache=path.join(dir,'process-snapshot-cache.json');
 const legacy='OPENAI_API_KEY=schema2-raw-cache-value';
 try {
  fs.writeFileSync(cache,JSON.stringify({schema:2,createdAt:Date.now(),processes:[{
   ProcessId:424242,ParentProcessId:0,Name:'node.exe',WorkingSet64:1,PeakWorkingSet64:1,Started:'2026-10-09T00:00:00.000Z',CommandLine:legacy,
  }]}),'utf8');
  const script=coordinatorProcessSnapshotScript(cache,{caller:process.pid,ttlMs:60_000,waitMs:20_000,forceFresh:false});
  const result=spawnSync(trustedWindowsHelper('powershell'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',script],{encoding:'utf8',windowsHide:true,cwd:trustedWindowsRoot(),env:controllerEnvironment()});
  assert.equal(result.status,0,result.stderr);
  const persisted=fs.readFileSync(cache,'utf8');
  const repaired=JSON.parse(persisted);
  assert.equal(persisted.includes(legacy),false,'a legacy cache must not retain a raw command line');
  assert.equal(repaired.schema,3,'schema-2 caches must be purged instead of being accepted as an advisory identity source');
  for(const row of repaired.processes){
   assert.equal(Object.hasOwn(row,'CommandLine'),false);
   assert.match(row.commandLineSha256,/^[a-f0-9]{64}$/);
  }
 } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('a schema-3 cache carrying a raw command line is purged before it can be reused',{skip:process.platform!=='win32'},()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'codex-tui-schema3-raw-cache-')),cache=path.join(dir,'process-snapshot-cache.json');
 const legacy='OPENAI_API_KEY=schema3-raw-cache-value';
 try {
  fs.writeFileSync(cache,JSON.stringify({schema:3,createdAt:Date.now(),observedAt:new Date().toISOString().replace('Z','0000Z'),processes:[{
   ProcessId:424242,ParentProcessId:0,Name:'node.exe',WorkingSet64:1,PeakWorkingSet64:1,Started:'2026-10-09T00:00:00.000Z',CommandLine:legacy,
  }]}),'utf8');
  const script=coordinatorProcessSnapshotScript(cache,{caller:process.pid,ttlMs:60_000,waitMs:20_000,forceFresh:false});
  const result=spawnSync(trustedWindowsHelper('powershell'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',script],{encoding:'utf8',windowsHide:true,cwd:trustedWindowsRoot(),env:controllerEnvironment()});
  assert.equal(result.status,0,result.stderr);
  const persisted=fs.readFileSync(cache,'utf8');
  assert.equal(persisted.includes(legacy),false,'an active-schema cache must not retain a raw command line');
  assert.equal(JSON.parse(persisted).schema,3);
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test('a schema-3 cache carrying unrecognized fields is purged before reuse',{skip:process.platform!=='win32'},()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'codex-tui-schema2-extra-cache-')),cache=path.join(dir,'process-snapshot-cache.json');
 const sentinel='PRIVATE⟪schema2-cache-extra-field⟫';
 try {
  fs.writeFileSync(cache,JSON.stringify({schema:3,createdAt:Date.now(),observedAt:new Date().toISOString().replace('Z','0000Z'),processes:[{
   ProcessId:424242,ParentProcessId:0,Name:'node.exe',WorkingSet64:1,PeakWorkingSet64:1,Started:'2026-10-09T00:00:00.000Z',commandLineSha256:'0'.repeat(64),prompt:sentinel,
  }],prompt:sentinel}),'utf8');
  const script=coordinatorProcessSnapshotScript(cache,{caller:process.pid,ttlMs:60_000,waitMs:20_000,forceFresh:false});
  const result=spawnSync(trustedWindowsHelper('powershell'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',script],{encoding:'utf8',windowsHide:true,cwd:trustedWindowsRoot(),env:controllerEnvironment()});
  assert.equal(result.status,0,result.stderr);
  const persisted=JSON.parse(fs.readFileSync(cache,'utf8'));
  assert.equal(JSON.stringify(persisted).includes(sentinel),false,'unknown raw data must not survive a cache refresh');
  assert.deepEqual(Object.keys(persisted).sort(),['createdAt','observedAt','processes','schema']);
  for(const row of persisted.processes)assert.deepEqual(Object.keys(row).sort(),['Name','ParentProcessId','PeakWorkingSet64','ProcessId','Started','WorkingSet64','commandLineSha256']);
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('a cached process binding cannot authenticate a launcher without a fresh raw snapshot',()=>{
 const pidf=path.join(os.tmpdir(),'window-private-cache.pid');
 const script=path.join(os.tmpdir(),'win-launch-private-cache.ps1');
 const live={ProcessId:42,Started:'now',Name:'powershell.exe',CommandLine:`powershell.exe -File "${script}"`};
 const cached=processIdentityBinding(live);
 assert.equal(launcherIdentity(live.ProcessId,pidf,new Map([[live.ProcessId,cached]])),null);
 assert.equal(sameProcess(cached,live),true,'the binding remains usable for liveness checks after a fresh row is obtained');
});
