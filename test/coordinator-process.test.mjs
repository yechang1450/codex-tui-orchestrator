import {testTempFamily} from './test-temp-root.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import * as leases from '../scripts/core/leases.mjs';
import {bind,claimRun,coordinatorDir,prepare,processIdentityBinding,processSnapshot,release,reserve,transaction} from '../scripts/core/leases.mjs';
import {controllerStateDir} from '../scripts/core/controller-state.mjs';
import {controllerWindowsDir} from '../scripts/core/controller-state.mjs';
import {physicalPathIdentity} from '../scripts/core/runtime-context.mjs';
const family=testTempFamily('coordinator-process');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const within=(promise,timeoutMs,fallback=null)=>new Promise((resolve,reject)=>{
 let timer,settled=false;
 const finish=(action,value)=>{if(settled)return;settled=true;clearTimeout(timer);action(value);};
 timer=setTimeout(()=>finish(resolve,fallback),timeoutMs);
 Promise.resolve(promise).then(value=>finish(resolve,value),error=>finish(reject,error));
});
// Process snapshots are live and may contain a command line. Durable leases,
// owners and cache rows carry only its binding: raw command lines can contain
// prompts or credentials and must never be written to controller state.
const missingRuntimeProcess={ProcessId:987654321,Started:'2020-01-01T00:00:00.000Z',Name:'powershell.exe',CommandLine:'powershell.exe -File stale.ps1'};
const missingProcessIdentity=processIdentityBinding(missingRuntimeProcess);
const cachedProcessRow=(identity,extra={})=>({ProcessId:identity.ProcessId,Started:identity.Started,Name:identity.Name,commandLineSha256:identity.commandLineSha256,ParentProcessId:1,WorkingSet64:1,PeakWorkingSet64:1,...extra});
const cacheObservedAt=()=>new Date().toISOString().replace('Z','0000Z');
const schema3Cache=(processes,{observedAt=cacheObservedAt(),createdAt=Date.now()}={})=>({schema:3,createdAt,observedAt,processes});
const powershellQuote=value=>"'"+String(value).replaceAll("'","''")+"'";
function runCoordinatorSnapshotScript(cache,options={}) {
 const script=leases.coordinatorProcessSnapshotScript(cache,options);
 return spawnSync(leases.trustedWindowsHelper('powershell'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',script],{
  encoding:'utf8',windowsHide:true,timeout:options.waitMs?options.waitMs+2500:5000,cwd:leases.trustedWindowsRoot(),env:leases.controllerEnvironment(),
 });
}
function writeCurrentProcessSnapshotCacheFixture(dir){
 const script=`$p=[Diagnostics.Process]::GetProcessById(${process.pid});try{[Console]::Out.Write($p.StartTime.ToUniversalTime().ToString('o'))}finally{$p.Dispose()}`;
 const result=spawnSync(leases.trustedWindowsHelper('powershell'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',script],{
  encoding:'utf8',windowsHide:true,timeout:5_000,cwd:leases.trustedWindowsRoot(),env:leases.controllerEnvironment(),
 });
 assert.equal(result.status,0,result.stderr||'the cache fixture could not resolve the current process start time');
 const started=String(result.stdout||'').trim();
 assert.match(started,/^\d{4}-\d{2}-\d{2}T.*Z$/,'the cache fixture must use the same UTC process-start representation as its consumer');
 const observedAt=cacheObservedAt(),createdAt=Date.now();
 leases.atomicJson(path.join(dir,'process-snapshot-cache.json'),schema3Cache([{
  ProcessId:process.pid,ParentProcessId:process.ppid||1,Name:path.basename(process.execPath),WorkingSet64:Math.max(1,process.memoryUsage().rss),PeakWorkingSet64:Math.max(1,process.memoryUsage().rss),Started:started,
  commandLineSha256:crypto.createHash('sha256').update('coordinator-test-cache-fixture','utf8').digest('hex'),
 }],{observedAt,createdAt}));
}
async function waitForPath(file,label,timeoutMs=5_000){
 const deadline=Date.now()+timeoutMs;
 while(!fs.existsSync(file)&&Date.now()<deadline)await pause(20);
 assert.ok(fs.existsSync(file),label);
}
function startV3MutexLaneHolder({lane,ready,release,observeLane,holdMs=60_000}){
 const script=`$ErrorActionPreference='Stop';$lane=[Threading.Mutex]::new($false,${powershellQuote(lane)});$observer=$null;$held=$false;try{if(${observeLane?'$true':'$false'}){$observer=[Threading.Mutex]::new($false,${powershellQuote(observeLane||'')})};try{$held=$lane.WaitOne(5000)}catch [Threading.AbandonedMutexException]{$held=$true};if(-not $held){throw 'test CIM lane holder timed out'};[IO.File]::WriteAllText(${powershellQuote(ready)},'ready',[Text.UTF8Encoding]::new($false));$deadline=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()+${holdMs};while(-not [IO.File]::Exists(${powershellQuote(release)}) -and [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -lt $deadline){Start-Sleep -Milliseconds 10}}finally{if($held){$lane.ReleaseMutex()};if($observer){$observer.Dispose()};$lane.Dispose()}`;
 const child=spawn(leases.trustedWindowsHelper('powershell'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',script],{
  windowsHide:true,stdio:'ignore',cwd:leases.trustedWindowsRoot(),env:leases.controllerEnvironment(),
 });
 const done=new Promise(resolve=>{child.once('error',error=>resolve({code:null,error}));child.once('exit',(code,signal)=>resolve({code,signal}));});
 return {child,done};
}
async function stopV3MutexLaneHolder(holder,release){
 if(!holder)return;
 try{fs.writeFileSync(release,'release');}catch{}
 const outcome=await within(holder.done,5_000);
 if(outcome===null&&holder.child.exitCode===null){holder.child.kill();await within(holder.done,3_000,undefined);}
}
function coordinatorLeaseMutexName(directory){
 return 'Local\\TuiOrchestrator.Leases.'+crypto.createHash('sha256').update(String(directory).toLowerCase(),'utf8').digest('hex').toUpperCase();
}
function startCoordinatorLeaseMutexHolder({directory,ready,release,holdMs=60_000}){
 const mutexName=coordinatorLeaseMutexName(directory);
 const script=`$ErrorActionPreference='Stop';$mutex=[Threading.Mutex]::new($false,${powershellQuote(mutexName)});$held=$false;try{$held=$mutex.WaitOne(3000);if(-not $held){throw 'lease mutex test holder timed out'};[IO.File]::WriteAllText(${powershellQuote(ready)},'ready',[Text.UTF8Encoding]::new($false));$deadline=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()+${Number(holdMs)};while(-not [IO.File]::Exists(${powershellQuote(release)}) -and [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -lt $deadline){Start-Sleep -Milliseconds 10}}finally{if($held){$mutex.ReleaseMutex()};$mutex.Dispose()}`;
 const child=spawn(leases.trustedWindowsHelper('powershell'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',script],{
  windowsHide:true,stdio:'ignore',cwd:leases.trustedWindowsRoot(),env:leases.controllerEnvironment(),
 });
 const done=new Promise(resolve=>{child.once('error',error=>resolve({code:null,error}));child.once('exit',(code,signal)=>resolve({code,signal}));});
 return {child,done};
}
async function stopCoordinatorLeaseMutexHolder(holder,release){
 if(!holder)return;
 try{fs.writeFileSync(release,'release');}catch{}
 const outcome=await within(holder.done,5_000);
 if(outcome===null&&holder.child.exitCode===null){holder.child.kill();await within(holder.done,3_000,undefined);}
}
function assertCoordinatorSnapshotCache(dir){
 const cache=path.join(dir,'process-snapshot-cache.json');
 let firstFresh,secondFresh;
 transaction(dir,(_leases,_owner,_processes,observation)=>{firstFresh=observation?.fresh;});
 assert.equal(firstFresh,true,'first cache observation must publish a complete snapshot');
 const first=fs.readFileSync(cache,'utf8');
 const parsed=JSON.parse(first);
  assert.equal(parsed.schema,3);
  assert.match(parsed.observedAt,/^\d{4}-\d{2}-\d{2}T.*Z$/,'the cache records the start of its raw OS observation');
  assert.ok(Array.isArray(parsed.processes)&&parsed.processes.length>0,'published cache must be readable by Node');
  for(const row of parsed.processes){
   assert.match(row.commandLineSha256,/^[a-f0-9]{64}$/,'the cache must retain only a command-line binding');
   assert.equal(Object.hasOwn(row,'CommandLine'),false,'the cache must never retain a raw command line');
  }
 transaction(dir,(_leases,_owner,_processes,observation)=>{secondFresh=observation?.fresh;});
 assert.equal(secondFresh,false,'second observation must read the published cache');
 assert.equal(fs.readFileSync(cache,'utf8'),first,'a cache hit must preserve the published file');
}
test('Codex default coordinator is isolated from the generic TUI pool',()=>{
 const workspace=path.resolve(family,'..'),env={...process.env,ORCH_COORDINATOR_DIR:''};
 const dir=coordinatorDir(workspace,env);
 assert.equal(path.basename(dir),'codex-coordinator');
 assert.notEqual(dir,path.join(workspace,'temp','orchestrator','coordinator'));
 if(process.platform==='win32')assert.equal(coordinatorDir(path.join(workspace,'other-workspace'),env),dir);
});
test('a bounded worker deadline releases its own admitted reservation after parent silence',async t=>{
 fs.mkdirSync(family,{recursive:true});const dir=fs.mkdtempSync(path.join(family,'worker-timeout-cleanup-'));
 const module=new URL('../scripts/core/leases.mjs',import.meta.url).href;
 const worker=path.join(dir,'worker.mjs'),reservationFile=path.join(dir,'run0.reserve.json'),releaseFile=path.join(dir,'run0.release.json');
 fs.writeFileSync(worker,crossProcessWorkerSource(module,"reserve(dir,{id,runId:id,keys:['timeout:'+id]},1)"));
 const child=spawn(process.execPath,[worker,dir,'run0',String(Date.now()+1_000)],{windowsHide:true,stdio:'ignore'});
 const exited=new Promise(resolve=>{child.once('exit',(code,signal)=>resolve({code,signal,error:null}));child.once('error',error=>resolve({code:null,signal:null,error:error?.message||String(error)}));});
 let primaryFailure=null,exitResult=null;
 try{
  const deadline=Date.now()+180_000;
  let reservation;
  while(Date.now()<deadline){
   try{reservation=JSON.parse(fs.readFileSync(reservationFile,'utf8'));break;}
   catch(error){if(!['ENOENT','EACCES','EPERM'].includes(error?.code)&&!(error instanceof SyntaxError))throw error;await pause(50);}
  }
  assert.ok(reservation,'bounded wait for worker reservation artifact expired');
  assert.equal(reservation.ok,true,JSON.stringify(reservation));
  assert.deepEqual(reservation.coordinatorReleaseWarnings,[],'reservation must not conceal a coordinator release warning');
  exitResult=await within(exited,180_000);
  assert.ok(exitResult,'bounded wait for worker deadline cleanup expired');
  assert.deepEqual(exitResult,{code:1,signal:null,error:null},'the self-cleaning timeout is a deliberate non-success worker outcome');
  const timeoutResult=JSON.parse(fs.readFileSync(releaseFile,'utf8'));
  assert.equal(timeoutResult.attempted,false,'a silent parent must not be represented as a normal release signal');
  assert.equal(timeoutResult.ok,false);
  assert.equal(timeoutResult.error,'test worker release signal deadline exceeded');
  assert.equal(timeoutResult.timeoutCleanup?.attempted,true,JSON.stringify(timeoutResult));
  assert.equal(timeoutResult.timeoutCleanup?.ok,true,JSON.stringify(timeoutResult));
  assert.deepEqual(timeoutResult.timeoutCleanup?.coordinatorReleaseWarnings,[],JSON.stringify(timeoutResult));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir,'leases.json'),'utf8')),[],'the worker timeout cleanup must durably remove its own admitted lease');
 }catch(error){primaryFailure=error;throw error;}finally{
  const cleanupFailures=[];
  if(child.exitCode===null){try{fs.writeFileSync(path.join(dir,'release'),'release');}catch(error){cleanupFailures.push(error);}}
  if(exitResult===null){
   const cleanup=await within(exited,180_000);
   if(cleanup===null){
    child.kill();
    const terminated=await within(exited,30_000);
    if(terminated===null)cleanupFailures.push(new Error('worker timeout-cleanup fixture did not terminate after bounded cleanup'));
   }
  }
  try{fs.rmSync(dir,{recursive:true,force:true});}catch(error){cleanupFailures.push(error);}
  if(cleanupFailures.length){
   t.diagnostic(`worker timeout-cleanup fixture failure(s): ${cleanupFailures.map(error=>error.message).join(' | ')}`);
   const cleanupError=new AggregateError(cleanupFailures,'worker timeout-cleanup fixture cleanup failed');
   if(primaryFailure)throw new AggregateError([primaryFailure,cleanupError],'worker timeout-cleanup assertion failed and fixture cleanup was incomplete');
   throw cleanupError;
  }
 }
});
test('default coordinator authority stays outside a child-writable workspace',()=>{
 fs.mkdirSync(family,{recursive:true});const root=fs.mkdtempSync(path.join(family,'coordinator-authority-'));
 try{
  const workspace=path.join(root,'workspace'),codexHome=path.join(root,'codex-home');
  fs.mkdirSync(workspace);fs.mkdirSync(codexHome);
  const env={...process.env,CODEX_HOME:codexHome,ORCH_COORDINATOR_DIR:''};
  const dir=coordinatorDir(workspace,env);
  assert.ok(dir.startsWith(path.join(codexHome,'state','plugins','codex-tui-orchestrator')));
  assert.equal(coordinatorDir(path.join(root,'other-workspace'),env),dir);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('an advisory cache hit preserves a valid negative lease even when its ledger is unchanged',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'coordinator-cache-hit-'));
 try{
  const stale={id:'stale-lease',keys:['dir:stale'],owner:missingProcessIdentity,reservedAt:1};
  fs.writeFileSync(path.join(dir,'leases.json'),JSON.stringify([stale]));
  const snapshot=()=>({processes:new Map([[process.pid,{ProcessId:process.pid,Started:'current',Name:process.execPath,CommandLine:process.argv.join(' ')}]]),fresh:false});
  let fresh;
  transaction(dir,(_leases,_owner,_processes,observation)=>{fresh=observation?.fresh;},snapshot);
  assert.equal(fresh,false,'cache hit must be labeled advisory');
  assert.ok(JSON.parse(fs.readFileSync(path.join(dir,'leases.json'),'utf8')).some(lease=>lease.id==='stale-lease'));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('a fresh producer can reclaim an old negative lease when the ledger is stable',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'coordinator-cache-producer-'));
 try{
  fs.writeFileSync(path.join(dir,'leases.json'),JSON.stringify([{id:'stale-lease',keys:['dir:stale'],owner:missingProcessIdentity,reservedAt:1}]));
  const snapshot=()=>({processes:new Map([[process.pid,{ProcessId:process.pid,Started:'current',Name:process.execPath,CommandLine:process.argv.join(' ')}]]),fresh:true});
  transaction(dir,(_leases,_owner,_processes,observation)=>assert.equal(observation?.fresh,true),snapshot);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir,'leases.json'),'utf8')),[]);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('a fresh producer preserves a negative lease when its ledger changed after observation',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'coordinator-fresh-revision-'));
 try{
  const file=path.join(dir,'leases.json'),stale={id:'stale-lease',keys:['dir:stale'],owner:missingProcessIdentity,reservedAt:1};
  fs.writeFileSync(file,JSON.stringify([stale]));
  const snapshot=()=>{fs.writeFileSync(file,JSON.stringify([stale,{id:'concurrent',keys:['dir:other'],owner:missingProcessIdentity,reservedAt:1}]));return new Map([[process.pid,{ProcessId:process.pid,Started:'current',Name:process.execPath,CommandLine:process.argv.join(' ')}]]);};
  transaction(dir,()=>{},snapshot);
  const ids=JSON.parse(fs.readFileSync(file,'utf8')).map(lease=>lease.id);
  assert.ok(ids.includes('stale-lease'));
  assert.ok(ids.includes('concurrent'));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('a same-key positive advisory owner collision forces one fresh recheck before reclaiming a stable stale owner',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'run-owner-cache-hit-'));
 try{
  const stale={owner:missingProcessIdentity,token:'stale-token'};
  const file=path.join(dir,'run-owners.json');
  fs.writeFileSync(file,JSON.stringify({stale}));
  let calls=0;
  const snapshot=()=>{
   calls++;
   const processes=new Map([[process.pid,{ProcessId:process.pid,Started:'current',Name:process.execPath,CommandLine:process.argv.join(' ')}]]);
    if(calls===1)processes.set(missingRuntimeProcess.ProcessId,missingRuntimeProcess);
   return {processes,fresh:calls===2};
  };
  const claim=claimRun(dir,'stale',snapshot);
  assert.equal(calls,2,'one positive advisory collision may request exactly one fresh recheck');
  assert.notEqual(claim.token,'stale-token');
  assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).stale.token,claim.token);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('a same-key positive advisory owner collision confirms a still-live controller with one fresh recheck',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'run-owner-live-'));
 try{
  const liveRuntime={ProcessId:987654321,Started:'2026-10-09T00:00:00.000Z',Name:'node.exe',CommandLine:'node controller.mjs'};
  const live=processIdentityBinding(liveRuntime);
  fs.writeFileSync(path.join(dir,'run-owners.json'),JSON.stringify({same:{owner:live,token:'live-token'}}));
  let calls=0;
  const snapshot=()=>({processes:new Map([[process.pid,{ProcessId:process.pid,Started:'current',Name:process.execPath,CommandLine:process.argv.join(' ')}],[liveRuntime.ProcessId,liveRuntime]]),fresh:++calls>1});
  assert.throws(()=>claimRun(dir,'same',snapshot),/Run already has a live controller/);
  assert.equal(calls,2,'a positive advisory owner must be confirmed by one fresh recheck');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'run-owners.json'),'utf8')).same.token,'live-token');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('an expired transaction stops before coordinator, snapshot, ticket, or helper handoff side effects',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'coordinator-expired-preflight-'));
 const dir=path.join(root,'not-created');
 const ticketRoot=path.join(os.tmpdir(),'codex-tui-orchestrator-locks');
 const ticketEntries=fs.existsSync(ticketRoot)?fs.readdirSync(ticketRoot).sort():[];
 let snapshotCalls=0,callbackCalls=0;
 try{
  const deadlineAt=Date.now()-1;
  const expected=error=>error?.code==='ORCH_DEADLINE_EXHAUSTED'&&/coordinator transaction/.test(error.message);
  assert.throws(
   ()=>transaction(dir,()=>{callbackCalls++;},()=>{snapshotCalls++;throw new Error('snapshot must not run after an expired coordinator preflight');},{deadlineAt}),
   expected,
  );
  assert.equal(fs.existsSync(dir),false,'the coordinator directory must remain absent');
  assert.equal(fs.existsSync(path.join(dir,'leases.json')),false,'no lease ledger may be written');
  assert.equal(fs.existsSync(path.join(dir,'run-owners.json')),false,'no run-owner ledger may be written');
  assert.equal(fs.existsSync(path.join(dir,'process-snapshot-cache.json')),false,'no snapshot cache may be written');
  assert.equal(snapshotCalls,0,'an expired transaction must not begin an identity snapshot that could lead to helper startup');
  assert.equal(callbackCalls,0,'an expired transaction must not invoke its ledger callback');
  assert.deepEqual(fs.existsSync(ticketRoot)?fs.readdirSync(ticketRoot).sort():[],ticketEntries,'an expired transaction must not create a coordinator ticket directory');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('an unsafe default snapshot budget stops before creating coordinator state',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'coordinator-unsafe-budget-'));
 const dir=path.join(root,'not-created');
 const ticketRoot=path.join(os.tmpdir(),'codex-tui-orchestrator-locks');
 const ticketEntries=fs.existsSync(ticketRoot)?fs.readdirSync(ticketRoot).sort():[];
 let callbackCalls=0;
 try{
  // A 1-second remainder cannot reserve the snapshot's outer grace, scheduling
  // margin, and minimum safe CIM timeout. It must fail before mkdir, rather
  // than create an empty coordinator and then silently regain the 120s default.
  const deadlineAt=Date.now()+1_000;
  const expected=error=>error?.code==='ORCH_DEADLINE_EXHAUSTED'&&/coordinator process snapshot/.test(error.message);
  assert.throws(()=>transaction(dir,()=>{callbackCalls++;},undefined,{deadlineAt}),expected);
  assert.equal(fs.existsSync(dir),false,'a budget too small for the default snapshot must not create a coordinator directory');
  assert.equal(callbackCalls,0);
  assert.deepEqual(fs.existsSync(ticketRoot)?fs.readdirSync(ticketRoot).sort():[],ticketEntries,'an unsafe default snapshot budget must not create a ticket directory');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('the PowerShell snapshot script honors a supplied absolute deadline instead of renewing it at startup',t=>{
 if(process.platform!=='win32')return t.skip('Windows PowerShell snapshot integration only');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'coordinator-script-deadline-'));
 const cache=path.join(dir,'process-snapshot-cache.json');
 try{
  const result=runCoordinatorSnapshotScript(cache,{caller:process.pid,waitMs:15_000,deadlineAt:Date.now()-1});
  assert.notEqual(result.status,0,'an already expired absolute budget must reject before any WMI/cache work');
  assert.equal(fs.existsSync(cache),false,'the expired script must not publish a snapshot cache');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('the PowerShell snapshot script does not publish a cache after its absolute deadline expires during collection',t=>{
 if(process.platform!=='win32')return t.skip('Windows PowerShell snapshot integration only');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'coordinator-script-post-snapshot-deadline-'));
 const cache=path.join(dir,'process-snapshot-cache.json');
 try{
  const deadlineAt=Date.now()+60_000;
  const marker='$rows=@($snapshot.processes);$observedAt=$snapshot.observedAt';
  const original=leases.coordinatorProcessSnapshotScript(cache,{caller:process.pid,waitMs:30_000,deadlineAt});
  assert.ok(original.includes(marker),'fixture must advance the clock only after the live snapshot has returned');
  // This controlled clock transition models a WMI call that completes at the
  // deadline. The generated production script must check again before its
  // advisory publish; the old script wrote the cache and returned success.
  const script=original.replace(marker,`$rows=@($snapshot.processes);$deadline=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()-1;$observedAt=$snapshot.observedAt`);
  const result=spawnSync(leases.trustedWindowsHelper('powershell'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',script],{
   encoding:'utf8',windowsHide:true,timeout:35_000,cwd:leases.trustedWindowsRoot(),env:leases.controllerEnvironment(),
  });
  assert.notEqual(result.status,0,'a collection that reaches its deadline must fail before publishing the advisory cache');
  assert.equal(fs.existsSync(cache),false,'a post-collection expiration must not publish a cache');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('the PowerShell snapshot script does not return a cache hit after its absolute deadline expires',t=>{
 if(process.platform!=='win32')return t.skip('Windows PowerShell snapshot integration only');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'coordinator-script-post-cache-deadline-'));
 const cache=path.join(dir,'process-snapshot-cache.json');
 try{
  const runtime=processSnapshot().get(process.pid),binding=processIdentityBinding(runtime);
  fs.writeFileSync(cache,JSON.stringify(schema3Cache([cachedProcessRow(binding,{ParentProcessId:runtime.ParentProcessId||1,WorkingSet64:runtime.WorkingSet64||1,PeakWorkingSet64:runtime.PeakWorkingSet64||1})])));
  const marker='$ownerLive=$true';
  const original=leases.coordinatorProcessSnapshotScript(cache,{caller:process.pid,waitMs:30_000,deadlineAt:Date.now()+60_000});
  assert.ok(original.includes(marker),'fixture must advance the clock immediately before the final response guard');
  const script=original.replace(marker,`$ownerLive=$true;$deadline=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()-1`);
  const result=spawnSync(leases.trustedWindowsHelper('powershell'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',script],{
   encoding:'utf8',windowsHide:true,timeout:35_000,cwd:leases.trustedWindowsRoot(),env:leases.controllerEnvironment(),
  });
  assert.notEqual(result.status,0,'a cache hit whose absolute deadline expires during validation must not return an advisory response');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('a transaction gives its injected process snapshot one unchanged absolute deadline',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'coordinator-deadline-observation-'));
 const deadlineAt=Date.now()+30_000;
 const observations=[];
 const snapshot=options=>{
  observations.push(options);
  return new Map([[process.pid,{ProcessId:process.pid,Started:'current',Name:process.execPath,CommandLine:process.argv.join(' ')}]]);
 };
 try{
  transaction(dir,()=>{},snapshot,{deadlineAt});
  assert.deepEqual(observations,[{forceFresh:false,deadlineAt}],
   'the observation receives the caller absolute deadline instead of a renewed default timeout');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('a transaction whose snapshot consumes its deadline stops before its callback or ledger',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'coordinator-deadline-after-snapshot-'));
 const originalNow=Date.now;
 const deadlineAt=1_000_010;
 let now=1_000_000;
 let callbackCalls=0;
 const snapshot=()=>{
  now=deadlineAt;
  return new Map([[process.pid,{ProcessId:process.pid,Started:'current',Name:process.execPath,CommandLine:process.argv.join(' ')}]]);
 };
 try{
  Date.now=()=>now;
  assert.throws(()=>transaction(dir,()=>{callbackCalls++;},snapshot,{deadlineAt}),error=>error?.code==='ORCH_DEADLINE_EXHAUSTED');
  assert.equal(callbackCalls,0,'a deadline exhausted while observing process identity must stop before user callback effects');
  assert.equal(fs.existsSync(path.join(dir,'leases.json')),false,'a deadline exhausted while observing process identity must not commit a ledger');
 }finally{Date.now=originalNow;fs.rmSync(dir,{recursive:true,force:true});}
});
test('a deadline exhausted immediately after helper ready blocks the callback and still releases the helper',t=>{
 if(process.platform!=='win32')return t.skip('Windows helper lifecycle only');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'coordinator-deadline-after-ready-'));
 const physical=physicalPathIdentity(dir).toLowerCase();
 const ticketDir=path.join(os.tmpdir(),'codex-tui-orchestrator-locks',crypto.createHash('sha256').update(physical,'utf8').digest('hex').slice(0,16));
  const originalNow=Date.now,originalOpen=fs.openSync,originalReadSync=fs.readSync,originalClose=fs.closeSync;
  const deadlineAt=originalNow()+60_000;
  const normalizedTicketDir=path.resolve(ticketDir).toLowerCase(),normalizedLeases=path.resolve(dir,'leases.json').toLowerCase();
  const fileDescriptors=new Map(),descriptorText=new Map();
  let returnExpiredOnce=false,callbackCalls=0,sawVerifiedReadyRead=false,didInjectExpiry=false,leaseReadCalls=0;
  try{
   Date.now=()=>{
    if(returnExpiredOnce){returnExpiredOnce=false;didInjectExpiry=true;return deadlineAt;}
    return originalNow();
   };
   fs.openSync=(target,...args)=>{
    const fd=originalOpen(target,...args);
    if(typeof target==='string'){fileDescriptors.set(fd,path.resolve(target).toLowerCase());}
    return fd;
   };
   // The production reader consumes the ready marker through fs.readSync on an
   // owned descriptor, so the injector must observe that same low-level read
   // path rather than a buffered readFileSync call.
   fs.readSync=(fd,buffer,offset,length,position)=>{
    const count=originalReadSync(fd,buffer,offset,length,position);
    const resolved=fileDescriptors.get(fd);
    if(resolved&&count>0){
     const text=(descriptorText.get(fd)||'')+buffer.toString('utf8',offset,offset+count);
     descriptorText.set(fd,text);
     if(path.dirname(resolved)===normalizedTicketDir&&resolved.endsWith('.ready')&&/^ready:[A-Za-z0-9_-]{43}$/.test(text.trim())){
      sawVerifiedReadyRead=true;
      returnExpiredOnce=true;
     }
     if(resolved===normalizedLeases)leaseReadCalls++;
    }
    return count;
   };
   fs.closeSync=(fd,...args)=>{
    try{return originalClose(fd,...args);}finally{fileDescriptors.delete(fd);descriptorText.delete(fd);}
   };
  assert.throws(()=>transaction(dir,()=>{callbackCalls++;},undefined,{deadlineAt}),error=>
   error?.code==='ORCH_DEADLINE_EXHAUSTED'&&error.message==='ORCH_DEADLINE_EXHAUSTED: coordinator transaction execution');
  assert.equal(sawVerifiedReadyRead,true,'the test must read a complete nonce-bound ready marker through its own descriptor before expiring its clock');
  assert.equal(didInjectExpiry,true,'the post-ready expiry hook must run');
  assert.equal(callbackCalls,0,'the callback must not run after helper-ready consumed the deadline');
  assert.equal(leaseReadCalls,0,'the post-ready deadline guard must run before the lease ledger is read');
  const cleanupDeadline=originalNow()+8_500;
  let leftovers=[];
  do{
   leftovers=fs.existsSync(ticketDir)?fs.readdirSync(ticketDir).filter(name=>/^lock-[0-9a-f-]+\.(?:ready|release|released|ack)$/i.test(name)):[];
   if(!leftovers.length)break;
   Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,25);
  }while(originalNow()<cleanupDeadline);
  assert.deepEqual(leftovers,[],'the expired transaction must still release the helper and let it clean its markers');
 }finally{
  Date.now=originalNow;
  fs.openSync=originalOpen;
   fs.readSync=originalReadSync;
   fs.closeSync=originalClose;
  fs.rmSync(ticketDir,{recursive:true,force:true});
  fs.rmSync(dir,{recursive:true,force:true});
 }
});
test('a caller deadline that expires before verified helper-ready stays typed and never signals release',async t=>{
 if(process.platform!=='win32')return t.skip('Windows helper lifecycle only');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'coordinator-deadline-before-ready-'));
 const physical=physicalPathIdentity(dir),ticketDir=path.join(os.tmpdir(),'codex-tui-orchestrator-locks',crypto.createHash('sha256').update(physical.toLowerCase(),'utf8').digest('hex').slice(0,16));
 const holderReady=path.join(dir,'holder.ready'),holderRelease=path.join(dir,'holder.release');
 const originalNow=Date.now,originalStat=fs.statSync,originalWrite=fs.writeFileSync,originalTimeout=process.env.ORCH_COORDINATOR_TIMEOUT_MS;
 const deadlineAt=originalNow()+60_000;
 let holder,sawReadyPoll=false,forceExpiry=false,callbackCalls=0,releaseWrites=[];
 try{
  writeCurrentProcessSnapshotCacheFixture(dir);
  holder=startCoordinatorLeaseMutexHolder({directory:physical,ready:holderReady,release:holderRelease});
  await waitForPath(holderReady,'the pre-ready deadline holder did not acquire the coordinator mutex');
  process.env.ORCH_COORDINATOR_TIMEOUT_MS='1000';
  Date.now=()=>forceExpiry?deadlineAt:originalNow();
  fs.statSync=(target,...args)=>{
   if(String(target).endsWith('.ready')){sawReadyPoll=true;forceExpiry=true;}
   return originalStat(target,...args);
  };
  fs.writeFileSync=(target,...args)=>{
   if(String(target).endsWith('.release'))releaseWrites.push(String(target));
   return originalWrite(target,...args);
  };
  assert.throws(()=>transaction(dir,()=>{callbackCalls++;},undefined,{deadlineAt}),error=>
   error?.code==='ORCH_DEADLINE_EXHAUSTED'&&error.message==='ORCH_DEADLINE_EXHAUSTED: coordinator mutex ready handshake');
  assert.equal(sawReadyPoll,true,'the deadline must be injected from an actual pre-ready poll, not an earlier preflight');
  assert.equal(callbackCalls,0,'a pre-ready deadline must stop before the callback');
  assert.equal(fs.existsSync(path.join(dir,'leases.json')),false,'a pre-ready deadline must not commit a lease ledger');
  assert.deepEqual(releaseWrites,[],'without a verified ready nonce, Node must not signal release');
 }finally{
  Date.now=originalNow;
  fs.statSync=originalStat;
  fs.writeFileSync=originalWrite;
  if(originalTimeout===undefined)delete process.env.ORCH_COORDINATOR_TIMEOUT_MS;else process.env.ORCH_COORDINATOR_TIMEOUT_MS=originalTimeout;
  await stopCoordinatorLeaseMutexHolder(holder,holderRelease);
  const cleanupDeadline=Date.now()+8_500;
  let leftovers=[];
  do{
   leftovers=fs.existsSync(ticketDir)?fs.readdirSync(ticketDir).filter(name=>/^lock-[0-9a-f-]+\.(?:ready|release|released|ack)$/i.test(name)):[];
   if(!leftovers.length)break;
   await pause(25);
  }while(Date.now()<cleanupDeadline);
  fs.rmSync(ticketDir,{recursive:true,force:true});
  fs.rmSync(dir,{recursive:true,force:true});
 }
});
test('a shorter helper-ready timeout remains bounded when the caller deadline is later',async t=>{
 if(process.platform!=='win32')return t.skip('Windows helper lifecycle only');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'coordinator-local-ready-timeout-'));
 const physical=physicalPathIdentity(dir),ticketDir=path.join(os.tmpdir(),'codex-tui-orchestrator-locks',crypto.createHash('sha256').update(physical.toLowerCase(),'utf8').digest('hex').slice(0,16));
 const holderReady=path.join(dir,'holder.ready'),holderRelease=path.join(dir,'holder.release');
 const originalTimeout=process.env.ORCH_COORDINATOR_TIMEOUT_MS,originalWrite=fs.writeFileSync;
 let holder,callbackCalls=0,releaseWrites=[];
 try{
  writeCurrentProcessSnapshotCacheFixture(dir);
  holder=startCoordinatorLeaseMutexHolder({directory:physical,ready:holderReady,release:holderRelease});
  await waitForPath(holderReady,'the local-timeout holder did not acquire the coordinator mutex');
  process.env.ORCH_COORDINATOR_TIMEOUT_MS='1000';
  fs.writeFileSync=(target,...args)=>{
   if(String(target).endsWith('.release'))releaseWrites.push(String(target));
   return originalWrite(target,...args);
  };
  const started=performance.now();
  assert.throws(()=>transaction(dir,()=>{callbackCalls++;},undefined,{deadlineAt:Date.now()+20_000}),error=>error?.code==='ORCH_COORDINATOR_MUTEX_ACQUISITION_FAILED');
  const elapsed=performance.now()-started;
  assert.ok(elapsed<10_000,`the helper-ready wait ignored its one-second local bound (${Math.round(elapsed)}ms)`);
  assert.equal(callbackCalls,0,'a local helper-ready timeout must stop before the callback');
  assert.equal(fs.existsSync(path.join(dir,'leases.json')),false,'a local helper-ready timeout must not commit a lease ledger');
  assert.deepEqual(releaseWrites,[],'without a verified ready nonce, a local timeout must not signal release');
 }finally{
  fs.writeFileSync=originalWrite;
  if(originalTimeout===undefined)delete process.env.ORCH_COORDINATOR_TIMEOUT_MS;else process.env.ORCH_COORDINATOR_TIMEOUT_MS=originalTimeout;
  await stopCoordinatorLeaseMutexHolder(holder,holderRelease);
  const cleanupDeadline=Date.now()+8_500;
  let leftovers=[];
  do{
   leftovers=fs.existsSync(ticketDir)?fs.readdirSync(ticketDir).filter(name=>/^lock-[0-9a-f-]+\.(?:ready|release|released|ack)$/i.test(name)):[];
   if(!leftovers.length)break;
   await pause(25);
  }while(Date.now()<cleanupDeadline);
  fs.rmSync(ticketDir,{recursive:true,force:true});
  fs.rmSync(dir,{recursive:true,force:true});
 }
});
for(const [kind,invoke,ledger] of [
 ['lease',dir=>transaction(dir,leases=>{leases.push({id:'deadline-lease',keys:['dir:deadline']});},()=>new Map([[process.pid,{ProcessId:process.pid,Started:'current',Name:process.execPath,CommandLine:process.argv.join(' ')}]]),{deadlineAt:1_000_010}),'leases.json'],
 ['run-owner',dir=>claimRun(dir,'deadline-run',()=>new Map([[process.pid,{ProcessId:process.pid,Started:'current',Name:process.execPath,CommandLine:process.argv.join(' ')}]]),{deadlineAt:1_000_010}),'run-owners.json'],
])test(`a ${kind} ledger cannot commit after its Windows atomic rename retry exhausts the deadline`,t=>{
 if(process.platform!=='win32')return t.skip('Windows atomic rename retry only');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),`coordinator-${kind}-deadline-retry-`));
 const originalNow=Date.now,originalRename=fs.renameSync;
 let now=1_000_000,renameCalls=0;
 try{
  Date.now=()=>now;
  fs.renameSync=(...args)=>{
   renameCalls++;
   if(renameCalls===1){
    now=1_000_010;
    const error=new Error('simulated Windows sharing violation');error.code='EPERM';throw error;
   }
   return originalRename(...args);
  };
  assert.throws(()=>invoke(dir),error=>error?.code==='ORCH_DEADLINE_EXHAUSTED');
  assert.equal(renameCalls,1,'the retry boundary must reject the expired deadline before another replace attempt');
  assert.equal(fs.existsSync(path.join(dir,ledger)),false,`the ${kind} ledger must not publish after deadline exhaustion`);
 }finally{
  Date.now=originalNow;
  fs.renameSync=originalRename;
  fs.rmSync(dir,{recursive:true,force:true});
 }
});
test('claimRun gives its cache-hit and forced-fresh owner observations the same deadline',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'run-owner-deadline-recheck-'));
 const deadlineAt=Date.now()+30_000;
 const stale={owner:missingProcessIdentity,token:'stale-token'};
 const observations=[];
 try{
  fs.writeFileSync(path.join(dir,'run-owners.json'),JSON.stringify({same:stale}));
  const claim=claimRun(dir,'same',options=>{
   observations.push(options);
   const processes=new Map([[process.pid,{ProcessId:process.pid,Started:'current',Name:process.execPath,CommandLine:process.argv.join(' ')}]]);
   if(!options.forceFresh)processes.set(missingRuntimeProcess.ProcessId,missingRuntimeProcess);
   return {processes,fresh:options.forceFresh};
  },{deadlineAt});
  assert.notEqual(claim.token,stale.token);
  assert.deepEqual(observations,[{forceFresh:false,deadlineAt},{forceFresh:true,deadlineAt}],
   'the forced-fresh recheck must consume the original caller deadline rather than allocate a new window');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('no-deadline injected snapshots receive zero arguments through transaction and claimRun recheck',()=>{
 const transactionDir=fs.mkdtempSync(path.join(os.tmpdir(),'coordinator-no-deadline-transaction-'));
 const claimDir=fs.mkdtempSync(path.join(os.tmpdir(),'coordinator-no-deadline-claim-'));
 const stale={owner:missingProcessIdentity,token:'stale-token'};
 const transactionCalls=[],claimCalls=[];
 try{
  const current=()=>new Map([[process.pid,{ProcessId:process.pid,Started:'current',Name:process.execPath,CommandLine:process.argv.join(' ')}]]);
  transaction(transactionDir,()=>{},function(...args){transactionCalls.push(args);return current();});
  fs.writeFileSync(path.join(claimDir,'run-owners.json'),JSON.stringify({same:stale}));
  const claim=claimRun(claimDir,'same',function(...args){
   claimCalls.push(args);
   const processes=current();
   if(claimCalls.length===1)processes.set(missingRuntimeProcess.ProcessId,missingRuntimeProcess);
   return {processes,fresh:claimCalls.length===2};
  });
  assert.notEqual(claim.token,stale.token,'the positive advisory owner must reach its forced-fresh recheck');
  assert.deepEqual(transactionCalls,[[]],'a legacy injected transaction snapshot must receive no options object');
  assert.deepEqual(claimCalls,[[],[]],'both the cache-hit and forced-fresh injected claim snapshots must receive zero arguments');
 }finally{
  fs.rmSync(transactionDir,{recursive:true,force:true});
  fs.rmSync(claimDir,{recursive:true,force:true});
 }
});
test('reservation lifecycle wrappers retain the transaction deadline preflight',()=>{
 const deadlineAt=Date.now()-1;
 const expected=error=>error?.code==='ORCH_DEADLINE_EXHAUSTED';
 const invoke={
  claimRun:dir=>claimRun(dir,'expired',undefined,{deadlineAt}),
  reserve:dir=>reserve(dir,{id:'expired',keys:['dir:expired']},1,undefined,undefined,{deadlineAt}),
  bind:dir=>bind(dir,'expired',{ProcessId:process.pid,Started:'current',Name:process.execPath,CommandLine:process.argv.join(' ')},undefined,{deadlineAt}),
  prepare:dir=>prepare(dir,'expired',path.join(dir,'window-expired.pid'),undefined,{deadlineAt}),
  release:dir=>release(dir,'expired',undefined,{deadlineAt}),
 };
 for(const [operation,run] of Object.entries(invoke)){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),`coordinator-${operation}-deadline-`));
  const dir=path.join(root,'not-created');
  try{
   assert.throws(()=>run(dir),expected,`${operation} must preserve an expired deadline`);
   assert.equal(fs.existsSync(dir),false,`${operation} must not create coordinator state after deadline exhaustion`);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
 }
});
test('a same-key advisory owner collision propagates a failed fresh recheck without retrying again',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'run-owner-fresh-failure-'));
 try{
  const stale={owner:missingProcessIdentity,token:'stale-token'};
  const file=path.join(dir,'run-owners.json');
  fs.writeFileSync(file,JSON.stringify({same:stale}));
  let calls=0;
  const snapshot=()=>{
   calls++;
    if(calls===1)return {processes:new Map([[process.pid,{ProcessId:process.pid,Started:'current',Name:process.execPath,CommandLine:process.argv.join(' ')}],[missingRuntimeProcess.ProcessId,missingRuntimeProcess]]),fresh:false};
   throw new Error('fresh snapshot unavailable');
  };
  assert.throws(()=>claimRun(dir,'same',snapshot),/fresh snapshot unavailable/);
  assert.equal(calls,2,'a failed forced recheck must not spin or bypass the failure');
  assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).same.token,'stale-token');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('a same-key advisory owner collision rejects reclaim when the fresh recheck sees a changed ledger',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'run-owner-fresh-changed-same-key-'));
 try{
  const stale={owner:missingProcessIdentity,token:'stale-token'};
  const file=path.join(dir,'run-owners.json');
  fs.writeFileSync(file,JSON.stringify({same:stale}));
  let calls=0;
  const snapshot=()=>{
   calls++;
   if(calls===2)fs.writeFileSync(file,JSON.stringify({same:stale,concurrent:{owner:missingProcessIdentity,token:'concurrent-token'}}));
    const processes=new Map([[process.pid,{ProcessId:process.pid,Started:'current',Name:process.execPath,CommandLine:process.argv.join(' ')}]]);
    if(calls===1)processes.set(missingRuntimeProcess.ProcessId,missingRuntimeProcess);
    return {processes,fresh:calls===2};
  };
  assert.throws(()=>claimRun(dir,'same',snapshot),/Run already has a live controller/);
  assert.equal(calls,2,'only one forced recheck is permitted');
  const owners=JSON.parse(fs.readFileSync(file,'utf8'));
  assert.equal(owners.same.token,'stale-token');
  assert.equal(owners.concurrent.token,'concurrent-token');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('the default coordinator bypasses its advisory cache once before reclaiming a same-key stale owner',t=>{
 if(process.platform!=='win32')return t.skip('Windows process snapshot cache integration only');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'run-owner-default-cache-hit-'));
 try{
  const current=processSnapshot().get(process.pid),currentBinding=processIdentityBinding(current);
  const createdAt=Date.now()-1000;
  const oldOwner=cachedProcessRow(missingProcessIdentity);
  fs.writeFileSync(path.join(dir,'process-snapshot-cache.json'),JSON.stringify(schema3Cache([cachedProcessRow(currentBinding,{ParentProcessId:current.ParentProcessId||1,WorkingSet64:current.WorkingSet64||1,PeakWorkingSet64:current.PeakWorkingSet64||1}),oldOwner],{createdAt})));
  fs.writeFileSync(path.join(dir,'run-owners.json'),JSON.stringify({same:{owner:missingProcessIdentity,token:'stale-token'}}));
  const claim=claimRun(dir,'same');
  assert.notEqual(claim.token,'stale-token');
  assert.ok(JSON.parse(fs.readFileSync(path.join(dir,'process-snapshot-cache.json'),'utf8')).createdAt>createdAt,'the retry must publish a fresh complete process snapshot');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('a fresh run-owner observation reclaims a stale owner only while its ledger is stable',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'run-owner-fresh-revision-'));
 try{
  const file=path.join(dir,'run-owners.json');
  fs.writeFileSync(file,JSON.stringify({stale:{owner:missingProcessIdentity,token:'stale-token'}}));
  const snapshot=()=>new Map([[process.pid,{ProcessId:process.pid,Started:'current',Name:process.execPath,CommandLine:process.argv.join(' ')}]]);
  claimRun(dir,'new-run',snapshot);
  const owners=JSON.parse(fs.readFileSync(file,'utf8'));
  assert.equal(owners.stale,undefined);
  assert.ok(owners['new-run']);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('a fresh run-owner observation preserves valid owners when its ledger changed',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'run-owner-fresh-changed-'));
 try{
  const file=path.join(dir,'run-owners.json'),stale={owner:missingProcessIdentity,token:'stale-token'};
  fs.writeFileSync(file,JSON.stringify({stale}));
  const snapshot=()=>{fs.writeFileSync(file,JSON.stringify({stale,concurrent:{owner:missingProcessIdentity,token:'concurrent-token'}}));return new Map([[process.pid,{ProcessId:process.pid,Started:'current',Name:process.execPath,CommandLine:process.argv.join(' ')}]]);};
  claimRun(dir,'new-run',snapshot);
  const owners=JSON.parse(fs.readFileSync(file,'utf8'));
  assert.equal(owners.stale.token,'stale-token');
  assert.equal(owners.concurrent.token,'concurrent-token');
  assert.ok(owners['new-run']);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('a cache hit cannot use cached process memory to admit a reservation',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'coordinator-cache-memory-'));
 try{
  let admissionSnapshot;
  const snapshot=()=>({processes:new Map([[process.pid,{ProcessId:process.pid,Started:'current',Name:process.execPath,CommandLine:process.argv.join(' '),WorkingSet64:1,PeakWorkingSet64:1}]]),fresh:false});
  const result=reserve(dir,{id:'candidate',keys:['dir:candidate'],memoryCostMB:100},4,snapshot,(_leases,_record,processes)=>{admissionSnapshot=processes;return processes.has(process.pid);});
  assert.deepEqual(result,{ok:false,reason:'memory'});
  assert.ok(admissionSnapshot instanceof Map);
  assert.equal(admissionSnapshot.size,0,'advisory process memory must not reduce the reservation estimate');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('reserve rejects a missing durable lease id before it can create unaddressable state',()=>{
 const dir=path.join(os.tmpdir(),'coordinator-reserve-missing-id-'+crypto.randomUUID());
 let snapshotCalls=0;
 try{
  assert.throws(()=>reserve(dir,{keys:['dir:missing-id']},1,()=>{
    snapshotCalls++;
    return new Map([[process.pid,{ProcessId:process.pid,Started:'current',Name:process.execPath,CommandLine:process.argv.join(' ')}]]);
  }),/reservation id must be a non-empty string/i);
  assert.equal(snapshotCalls,0,'input validation must occur before process observation');
  assert.equal(fs.existsSync(dir),false,'input validation must occur before any coordinator directory is created');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('a same-process reservation proof binds one lease instance and rejects a released proof',t=>{
 if(process.platform!=='win32')return t.skip('Windows same-process reservation proof integration only');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'coordinator-reservation-proof-'));
 try{
  const first=reserve(dir,{id:'proof',keys:['dir:proof']},1);
  assert.equal(first.ok,true);
  assert.ok(Object.hasOwn(first,'reservationProof'),'a committed default reservation must issue an in-memory proof');
  assert.deepEqual(Object.keys(first),['ok'],'the private proof must not enter callers that enumerate or serialize reservation results');
  const proof=first.reservationProof;
  assert.ok(Object.isFrozen(proof));
  assert.deepEqual(Object.keys(proof),[],'the proof must carry no enumerable durable data');
  const leasesFile=path.join(dir,'leases.json'),cacheFile=path.join(dir,'process-snapshot-cache.json');
  let ledger=JSON.parse(fs.readFileSync(leasesFile,'utf8'));
  assert.match(ledger[0].leaseInstanceId,/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,'the durable row must bind the proof to one generated lease instance');
  const cache=JSON.parse(fs.readFileSync(cacheFile,'utf8'));
  cache.createdAt=0;
  fs.writeFileSync(cacheFile,JSON.stringify(cache));
  const staleCache=fs.readFileSync(cacheFile,'utf8');
  prepare(dir,'proof',path.join(dir,'proof.pid'),undefined,{reservationProof:proof});
  bind(dir,'proof',ledger[0].owner,undefined,{reservationProof:proof});
  release(dir,'proof',undefined,{reservationProof:proof});
  assert.equal(fs.readFileSync(cacheFile,'utf8'),staleCache,'same-process proof mutations must not refresh an expired snapshot cache');
  assert.deepEqual(JSON.parse(fs.readFileSync(leasesFile,'utf8')),[]);
  assert.throws(()=>release(dir,'proof',undefined,{reservationProof:proof}),error=>error?.code==='ORCH_RESERVATION_PROOF_STALE');
  const second=reserve(dir,{id:'proof',keys:['dir:proof']},1);
  const secondLedger=fs.readFileSync(leasesFile,'utf8');
  assert.throws(()=>release(dir,'proof',undefined,{reservationProof:proof}),error=>error?.code==='ORCH_RESERVATION_PROOF_STALE');
  assert.equal(fs.readFileSync(leasesFile,'utf8'),secondLedger,'an old proof must not delete a newly reused id');
  release(dir,'proof',undefined,{reservationProof:second.reservationProof});
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('a reservation proof still waits for the normal coordinator mutex',async t=>{
 if(process.platform!=='win32')return t.skip('Windows reservation proof mutex integration only');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'coordinator-proof-mutex-'));
 const ready=path.join(dir,'mutex.ready'),releaseFile=path.join(dir,'mutex.release');
 let holder;
 try{
  const admitted=reserve(dir,{id:'proof-lock',keys:['dir:proof-lock']},1);
  holder=startCoordinatorLeaseMutexHolder({directory:dir,ready,release:releaseFile,holdMs:6_000});
  await waitForPath(ready,'the coordinator mutex holder must be ready before a proof mutation starts');
  const started=Date.now();
  prepare(dir,'proof-lock',path.join(dir,'proof-lock.pid'),undefined,{reservationProof:admitted.reservationProof});
  assert.ok(Date.now()-started>=4_000,'a proof mutation must wait behind the same named coordinator mutex');
  const ledger=JSON.parse(fs.readFileSync(path.join(dir,'leases.json'),'utf8'));
  assert.equal(ledger[0].pidFile,path.join(dir,'proof-lock.pid'));
  release(dir,'proof-lock',undefined,{reservationProof:admitted.reservationProof});
 }finally{
  await stopCoordinatorLeaseMutexHolder(holder,releaseFile);
  fs.rmSync(dir,{recursive:true,force:true});
 }
});
test('a reservation proof refuses a tampered owner and ignores caller instance ids',t=>{
 if(process.platform!=='win32')return t.skip('Windows reservation proof tamper integration only');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'coordinator-proof-tamper-'));
 try{
  const callerInstance='00000000-0000-4000-8000-000000000000';
  const admitted=reserve(dir,{id:'proof-tamper',keys:['dir:proof-tamper'],leaseInstanceId:callerInstance},1);
  const file=path.join(dir,'leases.json'),ledger=JSON.parse(fs.readFileSync(file,'utf8'));
  assert.notEqual(ledger[0].leaseInstanceId,callerInstance,'callers must not choose the durable proof instance id');
  ledger[0].owner={...ledger[0].owner,Started:'tampered-owner-start'};
  fs.writeFileSync(file,JSON.stringify(ledger));
  const before=fs.readFileSync(file,'utf8');
  assert.throws(()=>prepare(dir,'proof-tamper',path.join(dir,'proof-tamper.pid'),undefined,{reservationProof:admitted.reservationProof}),error=>error?.code==='ORCH_RESERVATION_PROOF_STALE');
  assert.equal(fs.readFileSync(file,'utf8'),before,'a rejected proof must not rewrite a tampered lease row');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('a reservation proof can use the coordinator handshake inside a deadline too short for a new CIM observation',t=>{
 if(process.platform!=='win32')return t.skip('Windows reservation proof deadline integration only');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'coordinator-proof-deadline-'));
 try{
  const admitted=reserve(dir,{id:'proof-deadline',keys:['dir:proof-deadline']},1);
  const pidFile=path.join(dir,'proof-deadline.pid');
  const ordinaryDeadline=Date.now()+6_500;
  assert.throws(()=>prepare(dir,'proof-deadline',pidFile,undefined,{deadlineAt:ordinaryDeadline}),error=>error?.code==='ORCH_DEADLINE_EXHAUSTED',
    'an ordinary mutation must reserve the full snapshot safety window before it starts');
  const before=fs.readFileSync(path.join(dir,'leases.json'),'utf8');
  const proofDeadline=Date.now()+6_500;
  prepare(dir,'proof-deadline',pidFile,undefined,{deadlineAt:proofDeadline,reservationProof:admitted.reservationProof});
  const after=fs.readFileSync(path.join(dir,'leases.json'),'utf8');
  assert.notEqual(after,before,'the proof path must still perform its durable coordinator mutation');
  assert.equal(JSON.parse(after)[0].pidFile,pidFile);
  release(dir,'proof-deadline',undefined,{reservationProof:admitted.reservationProof});
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('a reservation proof rejects snapshot substitution without mutating its lease',t=>{
 if(process.platform!=='win32')return t.skip('Windows reservation proof override integration only');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'coordinator-proof-override-'));
 try{
  const admitted=reserve(dir,{id:'proof-override',keys:['dir:proof-override']},1);
  const file=path.join(dir,'leases.json'),before=fs.readFileSync(file,'utf8');
  assert.throws(()=>prepare(dir,'proof-override',path.join(dir,'proof-override.pid'),()=>new Map(),{reservationProof:admitted.reservationProof}),
    error=>error?.code==='ORCH_RESERVATION_PROOF_SNAPSHOT_OVERRIDE');
  assert.equal(fs.readFileSync(file,'utf8'),before,'a rejected snapshot override must not rewrite the lease');
  release(dir,'proof-override',undefined,{reservationProof:admitted.reservationProof});
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('a reservation proof cannot authorize an arbitrary exported coordinator transaction',t=>{
 if(process.platform!=='win32')return t.skip('Windows reservation proof transaction boundary integration only');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'coordinator-proof-generic-transaction-'));
 try{
  const first=reserve(dir,{id:'proof-a',keys:['dir:proof-a']},2);
  const second=reserve(dir,{id:'proof-b',keys:['dir:proof-b']},2);
  const file=path.join(dir,'leases.json'),before=fs.readFileSync(file,'utf8');
  assert.throws(()=>transaction(dir,leases=>{
    const index=leases.findIndex(lease=>lease.id==='proof-b');
    if(index>=0)leases.splice(index,1);
  },undefined,{reservationProof:first.reservationProof,expectedLeaseId:'proof-a'}),
  error=>error?.code==='ORCH_RESERVATION_PROOF_INVALID');
  assert.equal(fs.readFileSync(file,'utf8'),before,'a proof for one lifecycle must not mutate another lease through the generic callback API');
  release(dir,'proof-a',undefined,{reservationProof:first.reservationProof});
  release(dir,'proof-b',undefined,{reservationProof:second.reservationProof});
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('a proof rejects a malformed durable owner before ledger filtering can erase it',t=>{
 if(process.platform!=='win32')return t.skip('Windows reservation proof malformed-row integration only');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'coordinator-proof-invalid-owner-'));
 try{
  const admitted=reserve(dir,{id:'proof-invalid-owner',keys:['dir:proof-invalid-owner']},1);
  const file=path.join(dir,'leases.json'),ledger=JSON.parse(fs.readFileSync(file,'utf8'));
  ledger[0].owner={ProcessId:ledger[0].owner.ProcessId,Started:ledger[0].owner.Started,Name:7,commandLineSha256:ledger[0].owner.commandLineSha256};
  fs.writeFileSync(file,JSON.stringify(ledger));
  const before=fs.readFileSync(file,'utf8');
  assert.throws(()=>release(dir,'proof-invalid-owner',undefined,{reservationProof:admitted.reservationProof}),
    error=>error?.code==='ORCH_RESERVATION_PROOF_STALE');
  assert.equal(fs.readFileSync(file,'utf8'),before,'a malformed row must remain for reconciliation instead of being silently erased');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('a proof rejects duplicate durable rows before duplicate compaction can erase its lease',t=>{
 if(process.platform!=='win32')return t.skip('Windows reservation proof duplicate-row integration only');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'coordinator-proof-duplicate-'));
 try{
  const admitted=reserve(dir,{id:'proof-duplicate',keys:['dir:proof-duplicate']},1);
  const file=path.join(dir,'leases.json'),ledger=JSON.parse(fs.readFileSync(file,'utf8'));
  ledger.push({...ledger[0],leaseInstanceId:crypto.randomUUID(),reservedAt:Number(ledger[0].reservedAt)-1});
  fs.writeFileSync(file,JSON.stringify(ledger));
  const before=fs.readFileSync(file,'utf8');
  assert.throws(()=>release(dir,'proof-duplicate',undefined,{reservationProof:admitted.reservationProof}),
    error=>error?.code==='ORCH_RESERVATION_PROOF_STALE');
  assert.equal(fs.readFileSync(file,'utf8'),before,'a duplicate row must remain intact until explicit reconciliation');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('post-exit cleanup rejects duplicate raw lease ids before duplicate compaction can select one',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'coordinator-cleanup-duplicate-'));
 try{
  const file=path.join(dir,'leases.json');
  const runtime={ProcessId:process.pid,Started:'current',Name:process.execPath,CommandLine:process.argv.join(' ')};
  const owner=processIdentityBinding(runtime);
  const identity={id:'cleanup-duplicate',runId:'run-a',leaseInstanceId:'00000000-0000-4000-8000-000000000001'};
  const target={...identity,keys:['dir:cleanup-duplicate'],owner,capacity:1,reservedAt:2};
  const duplicate={...target,runId:'run-b',leaseInstanceId:'00000000-0000-4000-8000-000000000002',reservedAt:1};
  fs.writeFileSync(file,JSON.stringify([target,duplicate]));
  const before=fs.readFileSync(file,'utf8');
  const snapshot=()=>new Map([[process.pid,runtime]]);
  assert.throws(()=>leases.releaseMatchingLease(dir,identity,snapshot),error=>error?.code==='ORCH_CLEANUP_LEASE_AMBIGUOUS');
  assert.equal(fs.readFileSync(file,'utf8'),before,'an ambiguous raw target must not be compacted or rewritten');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('post-exit cleanup rejects a malformed mismatched raw target before filtering can erase it',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'coordinator-cleanup-mismatch-'));
 try{
  const file=path.join(dir,'leases.json');
  const runtime={ProcessId:process.pid,Started:'current',Name:process.execPath,CommandLine:process.argv.join(' ')};
  const identity={id:'cleanup-mismatch',runId:'run-a',leaseInstanceId:'00000000-0000-4000-8000-000000000003'};
  const mismatched={id:identity.id,runId:'run-b',leaseInstanceId:'00000000-0000-4000-8000-000000000004',keys:['dir:cleanup-mismatch'],owner:{ProcessId:process.pid}};
  fs.writeFileSync(file,JSON.stringify([mismatched]));
  const before=fs.readFileSync(file,'utf8');
  const snapshot=()=>new Map([[process.pid,runtime]]);
  assert.throws(()=>leases.releaseMatchingLease(dir,identity,snapshot),error=>error?.code==='ORCH_CLEANUP_LEASE_MISMATCH');
  assert.equal(fs.readFileSync(file,'utf8'),before,'a mismatched raw target must remain for reconciliation instead of becoming an idempotent release');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('post-exit cleanup keeps a genuinely absent lease idempotent',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'coordinator-cleanup-absent-'));
 try{
  const file=path.join(dir,'leases.json');
  fs.writeFileSync(file,'[]');
  const runtime={ProcessId:process.pid,Started:'current',Name:process.execPath,CommandLine:process.argv.join(' ')};
  const snapshot=()=>new Map([[process.pid,runtime]]);
  const result=leases.releaseMatchingLease(dir,{id:'cleanup-absent',runId:'run-a',leaseInstanceId:'00000000-0000-4000-8000-000000000005'},snapshot);
  assert.deepEqual(result,{released:false});
  assert.equal(fs.readFileSync(file,'utf8'),'[]','an absent target remains an idempotent no-op');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('post-exit cleanup removes only one exact raw lease identity',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'coordinator-cleanup-exact-'));
 try{
  const file=path.join(dir,'leases.json');
  const runtime={ProcessId:process.pid,Started:'current',Name:process.execPath,CommandLine:process.argv.join(' ')};
  const owner=processIdentityBinding(runtime);
  const identity={id:'cleanup-exact',runId:'run-a',leaseInstanceId:'00000000-0000-4000-8000-000000000006'};
  const target={...identity,keys:['dir:cleanup-exact'],owner,capacity:1,reservedAt:1};
  const other={id:'other-lease',runId:'run-b',leaseInstanceId:'00000000-0000-4000-8000-000000000007',keys:['dir:other-lease'],owner,capacity:1,reservedAt:2};
  fs.writeFileSync(file,JSON.stringify([target,other]));
  const snapshot=()=>new Map([[process.pid,runtime]]);
  assert.deepEqual(leases.releaseMatchingLease(dir,identity,snapshot),{released:true});
  assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')).map(lease=>lease.id),['other-lease']);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('a malformed coordinator snapshot cache triggers a fresh enumeration',t=>{
 if(process.platform!=='win32')return t.skip('Windows process snapshot cache integration only');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'coordinator-cache-corrupt-'));
 try{
  const cache=path.join(dir,'process-snapshot-cache.json');
  fs.writeFileSync(cache,'{not json');
  let fresh;
  transaction(dir,(_leases,_owner,_processes,observation)=>{fresh=observation?.fresh;});
  assert.equal(fresh,true,'cache corruption must force a fresh complete enumeration');
  const repaired=JSON.parse(fs.readFileSync(cache,'utf8'));
  assert.equal(repaired.schema,3);
  assert.ok(Array.isArray(repaired.processes)&&repaired.processes.length>0);
  assert.ok(repaired.processes.every(row=>typeof row.commandLineSha256==='string'&&!Object.hasOwn(row,'CommandLine')));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('Windows PowerShell cache paths preserve legal local and UNC roots while rejecting malformed extended paths',()=>{
 assert.deepEqual([
  leases.windowsPowerShellCachePath('C:\\runtime\\cache'),
  leases.windowsPowerShellCachePath('\\\\server\\share\\cache'),
  leases.windowsPowerShellCachePath('\\\\server\\share/cache'),
  leases.windowsPowerShellCachePath('\\\\server\\share\\cache/leaf'),
  leases.windowsPowerShellCachePath('\\\\?\\C:\\runtime\\cache'),
  leases.windowsPowerShellCachePath('\\\\?\\UNC\\server\\share\\cache'),
 ],['\\\\?\\C:\\runtime\\cache','\\\\?\\UNC\\server\\share\\cache','\\\\?\\UNC\\server\\share\\cache','\\\\?\\UNC\\server\\share\\cache\\leaf','\\\\?\\C:\\runtime\\cache','\\\\?\\UNC\\server\\share\\cache']);
 assert.throws(()=>leases.windowsPowerShellCachePath('relative\\cache'),/absolute/i);
 assert.throws(()=>leases.windowsPowerShellCachePath('\\\\.\\pipe\\cache'),/absolute/i,'must retain the device-namespace rejection');
 for(const malformed of ['\\\\?\\relative\\cache','\\\\?\\C:relative\\cache','\\\\?\\UNC\\server','\\\\?\\UNC\\server\\','\\\\?\\C:\\cache/leaf','\\\\?\\UNC\\server\\share\\cache/leaf']){
  assert.throws(()=>leases.windowsPowerShellCachePath(malformed),/absolute|extended/i,`must reject malformed extended path ${malformed}`);
 }
});
test('coordinator cache PowerShell script receives an extended remote UNC cache path',()=>{
 const cacheFile='\\\\server\\share\\coordinator\\process-snapshot-cache.json';
 const script=leases.coordinatorProcessSnapshotScript?.(cacheFile);
 assert.equal(typeof script,'string','the script builder must expose the exact -Command payload');
 // No remote SMB share is available to this isolated test. Inspect the exact
 // -Command payload instead of mislabeling a local administrative share as remote.
 const cacheAssignment=script.split('\n').find(line=>line.startsWith('$cachePath='))?.split(';')[0];
 assert.equal(cacheAssignment,"$cachePath='\\\\?\\UNC\\server\\share\\coordinator\\process-snapshot-cache.json'");
});
test('coordinator snapshot cache mutex is scoped to a canonical controller without exposing its path',()=>{
 const first=leases.coordinatorSnapshotCacheMutexName('C:\\canonical\\controller-a');
 const same=leases.coordinatorSnapshotCacheMutexName('C:\\canonical\\controller-a');
 const second=leases.coordinatorSnapshotCacheMutexName('C:\\canonical\\controller-b');
 assert.match(first,/^Local\\CodexTuiOrchestrator\.ProcessSnapshot\.Cache\.v2\.[a-f0-9]{64}$/);
 assert.equal(first,same,'one canonical controller needs one producer lock');
 assert.notEqual(first,second,'unrelated controllers must not serialize cache producers');
 assert.equal(first.includes('controller'),false,'the Windows named object must not reveal a controller path');
});
test('v3 CIM gate records a recoverable mutex lane and releases only that lane',()=>{
 const source=fs.readFileSync(fileURLToPath(new URL('../scripts/core/leases.mjs',import.meta.url)),'utf8');
 const direct=source.slice(source.indexOf('export function processSnapshot'),source.indexOf('// Windows PowerShell cache path'));
 const script=leases.coordinatorProcessSnapshotScript('C:\\coordinator\\process-snapshot-cache.json',{caller:1234});
 assert.match(source,/SNAPSHOT_CIM_GATE_NAME='Local\\\\CodexTuiOrchestrator\.ProcessSnapshot\.CimGate\.v3'/,
   'the v3 namespace must not reopen a possibly stranded v2 semaphore');
 assert.doesNotMatch(source,/\[Threading\.Semaphore\]::new/,
   'neither direct nor coordinator snapshots may retain an unrecoverable semaphore permit');
 assert.match(direct,/cimGateMutexLanesScript\(SNAPSHOT_CIM_GATE_NAME\)/,
   'the direct process snapshot must use the same recoverable v3 lane primitive');
 assert.match(script,/\$cimLanes=@\(\[Threading\.Mutex\]::new\(\$false,\$cimGateLaneNames\[0\]\),\[Threading\.Mutex\]::new\(\$false,\$cimGateLaneNames\[1\]\)\)/,
   'the coordinator must create exactly two named mutex lanes');
 assert.match(script,/\[Threading\.WaitHandle\]::WaitAny\(\$cimLanes,\(Get-RemainingMilliseconds\)\)/,
   'a helper must acquire either live lane with one bounded WaitAny call');
 assert.match(script,/catch \[Threading\.AbandonedMutexException\]\{\$laneIndex=\$_.Exception\.MutexIndex\}/,
   'an abandoned mutex must use Windows reported lane identity rather than inventing one');
 assert.match(script,/if\(\$laneIndex -lt 0 -or \$laneIndex -ge \$cimLanes\.Count\)\{throw 'CIM gate abandoned lane index unavailable'\}/,
   'an unknown abandoned lane must fail closed');
 assert.match(script,/\$script:cimLane=\$cimLanes\[\$laneIndex\];\$script:cimLaneIndex=\$laneIndex/,
   'the acquired lane identity must persist in script scope for exact release');
 assert.match(script,/if\(\$null -ne \$script:cimLane\)\{try\{\$script:cimLane\.ReleaseMutex\(\)\|Out-Null\}finally\{\$script:cimLane=\$null;\$script:cimLaneIndex=-1\}\}/,
   'release must target the acquired lane and clear its recorded identity');
 assert.match(script,/foreach\(\$cimLane in \$cimLanes\)\{try\{\$cimLane\.Dispose\(\)\}catch\{if\(\$null -eq \$disposeError\)\{\$disposeError=\$_\}\}\}/,
   'both lane handles must be disposed independently after the snapshot script completes');
});
test('v3 CIM Node wrappers retain the bounded outer helper grace',()=>{
 const source=fs.readFileSync(fileURLToPath(new URL('../scripts/core/leases.mjs',import.meta.url)),'utf8');
 const direct=source.slice(source.indexOf('export function processSnapshot'),source.indexOf('// Windows PowerShell cache path'));
 const coordinator=source.slice(source.indexOf('function coordinatorProcessSnapshot('),source.indexOf('function transactionObservation('));
 assert.match(source,/const SNAPSHOT_OUTER_GRACE_MS=5000;/);
 assert.match(direct,/timeout:waitMs\+SNAPSHOT_OUTER_GRACE_MS/,
   'the direct helper must retain a finite cleanup grace after its operation deadline');
 assert.match(coordinator,/timeout:waitMs\+SNAPSHOT_OUTER_GRACE_MS/,
   'the coordinator helper must retain the same bounded cleanup grace');
});
test('direct processSnapshot uses the available default v3 lane while lane zero is held',async t=>{
 if(process.platform!=='win32')return t.skip('Windows direct process snapshot integration only');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'direct-cim-v3-lane-'));
 const lane='Local\\CodexTuiOrchestrator.ProcessSnapshot.CimGate.v3.0';
 const ready=path.join(dir,'lane.ready'),release=path.join(dir,'lane.release');
 let holder;
 try{
  // Hold only one global default lane: a concurrent unrelated snapshot still
  // has lane one, while this call proves the direct path uses the shared v3
  // WaitAny primitive rather than a test-only configuration path.
  holder=startV3MutexLaneHolder({lane,ready,release,holdMs:20_000});
  await waitForPath(ready,'the default v3 lane zero holder must be live before the direct snapshot starts');
  const snapshot=processSnapshot(15_000);
  assert.ok(snapshot.get(process.pid),'the direct snapshot must complete through the remaining default v3 lane');
 }finally{
  await stopV3MutexLaneHolder(holder,release);
  fs.rmSync(dir,{recursive:true,force:true});
 }
});
test('background memory sampling declines while either default v3 lane is busy',async t=>{
 if(process.platform!=='win32')return t.skip('Windows background snapshot integration only');
 assert.equal(typeof leases.tryBackgroundProcessSnapshot,'function',
   'dynamic-memory sampling requires a low-priority snapshot API');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'background-cim-v3-busy-'));
 const lane='Local\\CodexTuiOrchestrator.ProcessSnapshot.CimGate.v3.0';
 const ready=path.join(dir,'lane.ready'),release=path.join(dir,'lane.release');
 let holder;
 try{
  holder=startV3MutexLaneHolder({lane,ready,release,holdMs:20_000});
  await waitForPath(ready,'the held v3 lane must be live before the background sample starts');
  const started=Date.now();
  const sampled=await leases.tryBackgroundProcessSnapshot();
  assert.equal(sampled,null,'background sampling must yield instead of occupying the remaining critical lane');
  assert.ok(Date.now()-started<5_000,'a busy background sample must not wait behind the v3 gate');
  const critical=processSnapshot(15_000);
  assert.ok(critical.get(process.pid),'a coordinator-critical snapshot must retain the remaining lane');
 }finally{
  await stopV3MutexLaneHolder(holder,release);
  fs.rmSync(dir,{recursive:true,force:true});
 }
});
test('background sampling releases its first v3 lane when the second lane is already busy',async t=>{
 if(process.platform!=='win32')return t.skip('Windows background snapshot integration only');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'background-cim-v3-partial-'));
 const lane='Local\\CodexTuiOrchestrator.ProcessSnapshot.CimGate.v3.1';
 const ready=path.join(dir,'lane.ready'),release=path.join(dir,'lane.release');
 let holder;
 try{
  holder=startV3MutexLaneHolder({lane,ready,release,holdMs:20_000});
  await waitForPath(ready,'the second v3 lane must be held before the partial-acquire probe starts');
  const sampled=await leases.tryBackgroundProcessSnapshot();
  assert.equal(sampled,null,'a sampler that cannot prove both lanes idle must yield');
  const critical=processSnapshot(15_000);
  assert.ok(critical.get(process.pid),'the first lane must have been released for a critical snapshot');
 }finally{
  await stopV3MutexLaneHolder(holder,release);
  fs.rmSync(dir,{recursive:true,force:true});
 }
});
test('background sampling yields while another sampler owns its low-priority mutex',async t=>{
 if(process.platform!=='win32')return t.skip('Windows background snapshot integration only');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'background-sampler-mutex-'));
 const lane='Local\\CodexTuiOrchestrator.ProcessSnapshot.Background.v1';
 const ready=path.join(dir,'sampler.ready'),release=path.join(dir,'sampler.release');
 let holder;
 try{
  holder=startV3MutexLaneHolder({lane,ready,release,holdMs:20_000});
  await waitForPath(ready,'the low-priority sampler mutex holder must be ready');
  assert.equal(await leases.tryBackgroundProcessSnapshot(),null,'a second low-priority sampler must yield without waiting');
  const critical=processSnapshot(15_000);
  assert.ok(critical.get(process.pid),'sampler mutex contention must not consume either critical lane');
 }finally{
  await stopV3MutexLaneHolder(holder,release);
  fs.rmSync(dir,{recursive:true,force:true});
 }
});
test('background memory sampling returns only the ephemeral memory-tree fields it needs',async t=>{
 if(process.platform!=='win32')return t.skip('Windows background snapshot integration only');
 const source=fs.readFileSync(fileURLToPath(new URL('../scripts/core/leases.mjs',import.meta.url)),'utf8');
 const begin=source.indexOf('function backgroundProcessSnapshotScript');
 const end=source.indexOf('// This API is deliberately best-effort',begin);
 const script=source.slice(begin,end);
 assert.doesNotMatch(script,/\bName,CommandLine\b|\bPeakWorkingSet64\b/,
   'advisory memory sampling must not serialize process command lines or unused identity fields');
 const sampled=await leases.tryBackgroundProcessSnapshot();
 assert.ok(sampled instanceof Map,'an admitted background sample must return a process map');
 assert.ok(sampled.get(process.pid),'the ephemeral sample must include its own helper caller');
 for(const row of sampled.values())assert.deepEqual(Object.keys(row).sort(),['ParentProcessId','ProcessId','WorkingSet64'],
   'the Node-side advisory map must exclude raw command lines and unused process metadata');
});
test('background memory sampling admits at most one concurrent low-priority helper',async t=>{
 if(process.platform!=='win32')return t.skip('Windows background snapshot integration only');
 const [first,second]=await Promise.all([leases.tryBackgroundProcessSnapshot(),leases.tryBackgroundProcessSnapshot()]);
 const maps=[first,second].filter(value=>value instanceof Map),skips=[first,second].filter(value=>value===null);
 assert.equal(maps.length,1,'the sampler mutex must admit exactly one helper when both critical lanes begin idle');
 assert.equal(skips.length,1,'the competing sampler must yield rather than queue or consume a critical lane');
 assert.ok(maps[0].get(process.pid),'the admitted helper must return a live ephemeral map');
});
test('an aborted background sample yields and leaves the low-priority sampler recoverable',async t=>{
 if(process.platform!=='win32')return t.skip('Windows background snapshot integration only');
 const controller=new AbortController();
 const pending=leases.tryBackgroundProcessSnapshot({signal:controller.signal});
 const abortTimer=setTimeout(()=>controller.abort(),10);
 let cancelled;
 try{cancelled=await pending;}finally{clearTimeout(abortTimer);}
 assert.equal(cancelled,null,'cancellation must be represented as no advisory sample');
 const recovered=await leases.tryBackgroundProcessSnapshot();
 assert.ok(recovered instanceof Map,'the next background sample must recover after its predecessor is cancelled');
 assert.ok(recovered.get(process.pid));
});
test('background sampling holds only one critical CIM lane while it observes processes',()=>{
 const source=fs.readFileSync(fileURLToPath(new URL('../scripts/core/leases.mjs',import.meta.url)),'utf8');
 const begin=source.indexOf('function backgroundProcessSnapshotScript');
 const end=source.indexOf('// This API is deliberately best-effort',begin);
 const script=source.slice(begin,end);
 const releaseSecond=script.indexOf('$cimLanes[1].ReleaseMutex()|Out-Null');
 const observe=script.indexOf('Get-CimInstance Win32_Process');
 assert.ok(releaseSecond>=0&&observe>releaseSecond,'a low-priority sample must return one lane before WMI starts');
 assert.match(script,/\$samplerHeld\)\{try\{\$sampler\.ReleaseMutex\(\)\|Out-Null\}catch/,
   'all sampler-mutex release attempts must remain in the PowerShell finally block');
});
test('v3 coordinator cleanup disposes both lanes after a gate-release failure',t=>{
 if(process.platform!=='win32')return t.skip('Windows PowerShell cleanup integration only');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'coordinator-cim-v3-cleanup-'));
 const cache=path.join(dir,'process-snapshot-cache.json'),disposed=path.join(dir,'lanes-disposed');
 try{
  const runtime=processSnapshot().get(process.pid),binding=processIdentityBinding(runtime);
  fs.writeFileSync(cache,JSON.stringify(schema3Cache([cachedProcessRow(binding,{ParentProcessId:runtime.ParentProcessId||1,WorkingSet64:runtime.WorkingSet64||1,PeakWorkingSet64:runtime.PeakWorkingSet64||1})])));
  let script=leases.coordinatorProcessSnapshotScript(cache,{caller:process.pid,waitMs:15_000});
  const exitStart=script.indexOf('function Exit-CimGate '),exitEnd=script.indexOf('\nfunction Get-ProcessRows',exitStart);
  assert.ok(exitStart>=0&&exitEnd>exitStart,'fixture must replace only the generated gate-release function');
  script=script.slice(0,exitStart)+"function Exit-CimGate {throw 'test injected gate release failure'}"+script.slice(exitEnd);
  const dispose='foreach($cimLane in $cimLanes){try{$cimLane.Dispose()}catch{if($null -eq $disposeError){$disposeError=$_}}}';
  assert.ok(script.includes(dispose),'fixture must observe the generated v3 lane disposal path');
  script=script.replace(dispose,dispose+`;[IO.File]::WriteAllText(${powershellQuote(disposed)},'disposed',[Text.UTF8Encoding]::new($false))`);
  const result=spawnSync(leases.trustedWindowsHelper('powershell'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',script],{
   encoding:'utf8',windowsHide:true,timeout:20_000,cwd:leases.trustedWindowsRoot(),env:leases.controllerEnvironment(),
  });
  assert.notEqual(result.status,0,'the injected release failure must remain visible to the caller');
  assert.equal(result.error?.code,undefined,'the cleanup proof must not rely on a Node watchdog kill');
  assert.ok(fs.existsSync(disposed),'both mutex lane handles must still reach their disposal path after gate release throws');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('v3 coordinator cleanup preserves an observation failure over a release failure',t=>{
 if(process.platform!=='win32')return t.skip('Windows PowerShell cleanup integration only');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'coordinator-cim-v3-primary-error-'));
 const cache=path.join(dir,'process-snapshot-cache.json');
 try{
  const runtime=processSnapshot().get(process.pid),binding=processIdentityBinding(runtime);
  fs.writeFileSync(cache,JSON.stringify(schema3Cache([cachedProcessRow(binding,{ParentProcessId:runtime.ParentProcessId||1,WorkingSet64:runtime.WorkingSet64||1,PeakWorkingSet64:runtime.PeakWorkingSet64||1})])));
  let script=leases.coordinatorProcessSnapshotScript(cache,{caller:process.pid,waitMs:15_000});
  const exitStart=script.indexOf('function Exit-CimGate '),exitEnd=script.indexOf('\nfunction Get-ProcessRows',exitStart);
  assert.ok(exitStart>=0&&exitEnd>exitStart,'fixture must replace only the generated gate-release function');
  script=script.slice(0,exitStart)+"function Exit-CimGate {throw 'test injected gate release failure'}"+script.slice(exitEnd);
  const resultLine='$result|ConvertTo-Json -Compress -Depth 6';
  assert.ok(script.includes(resultLine),'fixture must replace only the completed-observation response');
  script=script.replace(resultLine,"throw 'test primary observation failure'");
  const result=spawnSync(leases.trustedWindowsHelper('powershell'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',script],{
   encoding:'utf8',windowsHide:true,timeout:20_000,cwd:leases.trustedWindowsRoot(),env:leases.controllerEnvironment(),
  });
  assert.notEqual(result.status,0,'the injected primary observation failure must remain visible');
  assert.match(result.stderr,/test primary observation failure/i,'cleanup must retain the original observation error');
  assert.doesNotMatch(result.stderr,/test injected gate release failure/i,'a release error must not replace an already pending observation error');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
for(const killedLaneIndex of [0,1])test(`a killed v3 CIM lane ${killedLaneIndex} recovers through the generated snapshot while its peer lane remains live`,async t=>{
 if(process.platform!=='win32')return t.skip('Windows named mutex recovery only');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),`coordinator-cim-v3-abandoned-${killedLaneIndex}-`));
 const cache=path.join(dir,'process-snapshot-cache.json');
 const gateName=`Local\\CodexTuiOrchestrator.ProcessSnapshot.CimGate.v3.recovery-${killedLaneIndex}-${process.pid}-${Date.now()}-${crypto.randomUUID().slice(0,8)}`;
 const lanes=[gateName+'.0',gateName+'.1'];
 const killedReady=path.join(dir,'killed.ready'),liveReady=path.join(dir,'live.ready'),killedRelease=path.join(dir,'killed.release'),liveRelease=path.join(dir,'live.release');
 const liveLaneIndex=1-killedLaneIndex;
 let killedHolder,liveHolder;
 try{
  killedHolder=startV3MutexLaneHolder({lane:lanes[killedLaneIndex],ready:killedReady,release:killedRelease});
  await waitForPath(killedReady,`v3 lane ${killedLaneIndex} holder must acquire its mutex`);
  // Keep an open observer handle to the killed lane so Windows reports an
  // AbandonedMutexException instead of creating a brand-new named object.
  liveHolder=startV3MutexLaneHolder({lane:lanes[liveLaneIndex],ready:liveReady,release:liveRelease,observeLane:lanes[killedLaneIndex]});
  await waitForPath(liveReady,`v3 lane ${liveLaneIndex} holder must acquire its peer mutex`);
  assert.equal(killedHolder.child.kill(),true,`v3 lane ${killedLaneIndex} holder must be terminated while owning its mutex`);
  const killed=await within(killedHolder.done,5_000);
  assert.notEqual(killed,null,`killed v3 lane ${killedLaneIndex} holder must exit before recovery is tested`);
  const result=runCoordinatorSnapshotScript(cache,{caller:process.pid,waitMs:30_000,cimGateName:gateName});
  assert.equal(result.status,0,result.stderr||`an abandoned v3 lane ${killedLaneIndex} must be recoverable while lane ${liveLaneIndex} remains live`);
  assert.ok(fs.existsSync(cache),'a recovered full snapshot may publish its cache only after taking the abandoned lane');
  const response=JSON.parse(result.stdout);
  assert.equal(response.fresh,true,'recovery must complete a new full observation rather than return a stale advisory cache');
  assert.equal(response.owner.ProcessId,process.pid);
 }finally{
  await stopV3MutexLaneHolder(killedHolder,killedRelease);
  await stopV3MutexLaneHolder(liveHolder,liveRelease);
  fs.rmSync(dir,{recursive:true,force:true});
 }
});
test('two live v3 CIM lanes time out without publishing a cache',async t=>{
 if(process.platform!=='win32')return t.skip('Windows named mutex recovery only');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'coordinator-cim-v3-saturated-'));
 const cache=path.join(dir,'process-snapshot-cache.json');
 const gateName=`Local\\CodexTuiOrchestrator.ProcessSnapshot.CimGate.v3.saturated-${process.pid}-${Date.now()}-${crypto.randomUUID().slice(0,8)}`;
 const [firstLane,secondLane]=[gateName+'.0',gateName+'.1'];
 const firstReady=path.join(dir,'first.ready'),secondReady=path.join(dir,'second.ready'),firstRelease=path.join(dir,'first.release'),secondRelease=path.join(dir,'second.release');
 let first,second;
 try{
  first=startV3MutexLaneHolder({lane:firstLane,ready:firstReady,release:firstRelease});
  second=startV3MutexLaneHolder({lane:secondLane,ready:secondReady,release:secondRelease});
  await waitForPath(firstReady,'the first v3 lane must be live before the bounded wait begins');
  await waitForPath(secondReady,'the second v3 lane must be live before the bounded wait begins');
  const waitMs=2_000,startedAt=Date.now();
  const result=runCoordinatorSnapshotScript(cache,{caller:process.pid,waitMs,cimGateName:gateName});
  const elapsedMs=Date.now()-startedAt;
  assert.notEqual(result.status,0,'two live mutex lanes must reject a raw snapshot after the bounded wait');
  assert.equal(result.error?.code,undefined,'the business CIM gate timeout must not be a Node spawnSync watchdog error');
  assert.equal(result.signal,null,'the business CIM gate timeout must return from PowerShell rather than be killed by Node');
  assert.ok(elapsedMs>=waitMs-500,`two occupied lanes must wait for most of the business timeout instead of returning an immediate false timeout (${elapsedMs}ms)`);
  assert.ok(elapsedMs<waitMs+2_000,`the business CIM gate timeout must finish before the outer watchdog grace (${elapsedMs}ms)`);
  assert.match(result.stderr,/CIM gate timeout/i,'the script must report its own exhausted lane wait');
  assert.equal(fs.existsSync(cache),false,'a timed-out v3 gate must not publish an advisory cache');
 }finally{
  await stopV3MutexLaneHolder(first,firstRelease);
  await stopV3MutexLaneHolder(second,secondRelease);
  fs.rmSync(dir,{recursive:true,force:true});
 }
});
test('an absolute deadline bounds two live v3 CIM lanes without renewing waitMs',async t=>{
 if(process.platform!=='win32')return t.skip('Windows named mutex deadline integration only');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'coordinator-cim-v3-deadline-'));
 const cache=path.join(dir,'process-snapshot-cache.json');
 const gateName=`Local\\CodexTuiOrchestrator.ProcessSnapshot.CimGate.v3.deadline-${process.pid}-${Date.now()}-${crypto.randomUUID().slice(0,8)}`;
 const [firstLane,secondLane]=[gateName+'.0',gateName+'.1'];
 const firstReady=path.join(dir,'first.ready'),secondReady=path.join(dir,'second.ready'),firstRelease=path.join(dir,'first.release'),secondRelease=path.join(dir,'second.release');
 let first,second;
 try{
  first=startV3MutexLaneHolder({lane:firstLane,ready:firstReady,release:firstRelease});
  second=startV3MutexLaneHolder({lane:secondLane,ready:secondReady,release:secondRelease});
  await waitForPath(firstReady,'the first v3 deadline lane must be live before the bounded wait begins');
  await waitForPath(secondReady,'the second v3 deadline lane must be live before the bounded wait begins');
  const waitMs=20_000,deadlineWindowMs=4_000,deadlineAt=Date.now()+deadlineWindowMs,startedAt=Date.now();
  const result=runCoordinatorSnapshotScript(cache,{caller:process.pid,waitMs,deadlineAt,cimGateName:gateName});
  const elapsedMs=Date.now()-startedAt;
  assert.notEqual(result.status,0,'two live lanes must reject the supplied absolute deadline');
  assert.equal(result.error?.code,undefined,'an exhausted absolute budget must not rely on the Node watchdog');
  assert.equal(result.signal,null,'an exhausted absolute budget must return from the PowerShell script');
  assert.ok(elapsedMs>=deadlineWindowMs-500,`the gate must wait for the supplied absolute budget instead of failing immediately (${elapsedMs}ms)`);
  assert.ok(elapsedMs<waitMs/2,`the gate must not renew the full ${waitMs}ms wait after PowerShell starts (${elapsedMs}ms)`);
  assert.match(result.stderr,/CIM (?:operation|gate) timeout/i,'the script must report its own deadline expiry');
  assert.equal(fs.existsSync(cache),false,'an expired absolute deadline must not publish an advisory cache');
 }finally{
  await stopV3MutexLaneHolder(first,firstRelease);
  await stopV3MutexLaneHolder(second,secondRelease);
  fs.rmSync(dir,{recursive:true,force:true});
 }
});
test('a schema-3 cache proves a caller observed before the raw full snapshot without consuming a CIM slot',async t=>{
 if(process.platform!=='win32')return t.skip('Windows process snapshot cache integration only');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'coordinator-cache-schema3-live-'));
 const cache=path.join(dir,'process-snapshot-cache.json');
 const gateName=`Local\\CodexTuiOrchestrator.ProcessSnapshot.CimGate.v3.schema3-${process.pid}-${Date.now()}`;
 const [firstLane,secondLane]=[gateName+'.0',gateName+'.1'];
 const firstReady=path.join(dir,'gate-first.ready'),secondReady=path.join(dir,'gate-second.ready'),firstRelease=path.join(dir,'gate-first.release'),secondRelease=path.join(dir,'gate-second.release');
 let first,second;
 try{
  const runtime=processSnapshot().get(process.pid),binding=processIdentityBinding(runtime);
  fs.writeFileSync(cache,JSON.stringify(schema3Cache([cachedProcessRow(binding,{ParentProcessId:runtime.ParentProcessId||1,WorkingSet64:runtime.WorkingSet64||1,PeakWorkingSet64:runtime.PeakWorkingSet64||1})])));
  first=startV3MutexLaneHolder({lane:firstLane,ready:firstReady,release:firstRelease});
  second=startV3MutexLaneHolder({lane:secondLane,ready:secondReady,release:secondRelease});
  await waitForPath(firstReady,'the first v3 test gate lane must be live before the cache-hit probe starts');
  await waitForPath(secondReady,'the second v3 test gate lane must be live before the cache-hit probe starts');
  // Allow process startup on a busy host, but keep a finite observation window:
  // a raw fallback would remain blocked on the deliberately empty gate.
  const result=runCoordinatorSnapshotScript(cache,{caller:process.pid,waitMs:5000,cimGateName:gateName});
  assert.equal(result.status,0,result.stderr||'an eligible cache hit must not wait for a CIM slot');
  const response=JSON.parse(result.stdout);
  assert.equal(response.fresh,false,'an eligible schema-3 cache remains advisory rather than becoming a new producer');
  assert.equal(response.owner.ProcessId,process.pid);
  assert.equal(response.owner.Started,binding.Started);
  assert.equal(response.owner.commandLineSha256,binding.commandLineSha256);
  assert.equal(Object.hasOwn(response.owner,'CommandLine'),false,'the accelerated owner remains the persisted command-line binding');
 }finally{
  await stopV3MutexLaneHolder(first,firstRelease);
  await stopV3MutexLaneHolder(second,secondRelease);
  fs.rmSync(dir,{recursive:true,force:true});
 }
});
test('a valid schema-3 cache hit completes while its producer mutex is deliberately held',async t=>{
 if(process.platform!=='win32')return t.skip('Windows process snapshot cache integration only');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'coordinator-cache-readonly-hit-'));
 const ready=path.join(dir,'mutex.ready'),release=path.join(dir,'mutex.release'),cache=path.join(dir,'process-snapshot-cache.json');
 // Exercise the same opaque, whitelisted named-object shape as production.
 // A descriptive suffix would be rejected before the probe reached its
 // held-mutex assertion, masking a regression in the actual cache path.
 const mutexName=leases.coordinatorSnapshotCacheMutexName(path.join(dir,`readonly-${process.pid}-${Date.now()}`));
 let holder;
 try{
  const runtime=processSnapshot().get(process.pid),binding=processIdentityBinding(runtime);
  fs.writeFileSync(cache,JSON.stringify(schema3Cache([cachedProcessRow(binding,{ParentProcessId:runtime.ParentProcessId||1,WorkingSet64:runtime.WorkingSet64||1,PeakWorkingSet64:runtime.PeakWorkingSet64||1})])));
  const holderScript=`$ErrorActionPreference='Stop';$mutex=[Threading.Mutex]::new($false,${powershellQuote(mutexName)});$held=$false;try{$held=$mutex.WaitOne(3000);if(-not $held){throw 'cache mutex test holder timed out'};[IO.File]::WriteAllText(${powershellQuote(ready)},'ready',[Text.UTF8Encoding]::new($false));$deadline=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()+30000;while(-not [IO.File]::Exists(${powershellQuote(release)}) -and [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -lt $deadline){Start-Sleep -Milliseconds 10}}finally{if($held){$mutex.ReleaseMutex()};$mutex.Dispose()}`;
  holder=spawn(leases.trustedWindowsHelper('powershell'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',holderScript],{windowsHide:true,stdio:'ignore',cwd:leases.trustedWindowsRoot(),env:leases.controllerEnvironment()});
  const deadline=Date.now()+3000;
  while(!fs.existsSync(ready)&&Date.now()<deadline)await pause(20);
  assert.ok(fs.existsSync(ready),'test holder must own the cache mutex before the cache-hit probe starts');
  // Keep the observation budget finite but host-tolerant: this test permits
  // normal cold PowerShell/JSON startup, while an accidental mutex wait stays
  // blocked for the holder's 30-second lifetime and therefore cannot pass.
  const result=runCoordinatorSnapshotScript(cache,{caller:process.pid,waitMs:15_000,cacheMutexName:mutexName});
  assert.equal(result.status,0,result.stderr||'a fully validated cache hit must not await its producer mutex');
  const response=JSON.parse(result.stdout);
  assert.equal(response.fresh,false,'a valid read-only cache hit must remain advisory');
  assert.equal(response.owner.ProcessId,process.pid);
  assert.equal(response.owner.Started,binding.Started);
  assert.equal(response.owner.commandLineSha256,binding.commandLineSha256);
 }finally{
  try{fs.writeFileSync(release,'release');}catch{}
  if(holder){await within(new Promise(resolve=>holder.once('exit',resolve)),3_000,undefined);if(holder.exitCode===null)holder.kill();}
  fs.rmSync(dir,{recursive:true,force:true});
 }
});
test('a pre-birth caller uses a targeted proof without waiting for the cache producer mutex',async t=>{
 if(process.platform!=='win32')return t.skip('Windows process snapshot cache integration only');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'coordinator-cache-temporal-targeted-'));
 const ready=path.join(dir,'mutex.ready'),release=path.join(dir,'mutex.release'),temporalReady=path.join(dir,'temporal.ready'),targeted=path.join(dir,'targeted.marker'),full=path.join(dir,'full.marker'),published=path.join(dir,'published.marker'),cache=path.join(dir,'process-snapshot-cache.json');
 // Keep this fixture on the production cache-mutex contract as well: only
 // the hash differs per isolated fixture, never the accepted name grammar.
 const mutexName=leases.coordinatorSnapshotCacheMutexName(path.join(dir,`temporal-${process.pid}-${Date.now()}`));
 const gateName=`Local\\CodexTuiOrchestrator.ProcessSnapshot.CimGate.v3.temporal-${process.pid}-${Date.now()}`;
 const firstLane=gateName+'.0',firstReady=path.join(dir,'gate-first.ready'),firstRelease=path.join(dir,'gate-first.release');
 let holder,first,probe;
 try{
  const runtime=processSnapshot().get(process.pid),binding=processIdentityBinding(runtime);
  const row=cachedProcessRow(binding,{ParentProcessId:runtime.ParentProcessId||1,WorkingSet64:runtime.WorkingSet64||1,PeakWorkingSet64:runtime.PeakWorkingSet64||1});
  const preBirth=new Date(Date.parse(binding.Started)-1000).toISOString().replace('Z','0000Z');
  leases.atomicJson(cache,schema3Cache([row],{observedAt:preBirth}));
  const before=fs.readFileSync(cache,'utf8');
  // The probe must not wait for this cache producer mutex. Keep one v3 lane
  // occupied and leave the other available so the targeted raw query remains
  // subject to the production global gate without becoming a full snapshot.
  const holderScript=`$ErrorActionPreference='Stop';$mutex=[Threading.Mutex]::new($false,${powershellQuote(mutexName)});$held=$false;try{$held=$mutex.WaitOne(3000);if(-not $held){throw 'cache mutex test holder timed out'};[IO.File]::WriteAllText(${powershellQuote(ready)},'ready',[Text.UTF8Encoding]::new($false));$deadline=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()+30000;while(-not [IO.File]::Exists(${powershellQuote(release)}) -and [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -lt $deadline){Start-Sleep -Milliseconds 10}}finally{if($held){$mutex.ReleaseMutex()};$mutex.Dispose()}`;
  holder=spawn(leases.trustedWindowsHelper('powershell'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',holderScript],{windowsHide:true,stdio:'ignore',cwd:leases.trustedWindowsRoot(),env:leases.controllerEnvironment()});
  first=startV3MutexLaneHolder({lane:firstLane,ready:firstReady,release:firstRelease});
  const holderDeadline=Date.now()+3000;
  while(!fs.existsSync(ready)&&Date.now()<holderDeadline)await pause(20);
  assert.ok(fs.existsSync(ready),'test holder must own the cache mutex before the temporal probe starts');
  await waitForPath(firstReady,'the first v3 test gate lane must be live before the temporal probe starts');
  let script=leases.coordinatorProcessSnapshotScript(cache,{caller:process.pid,waitMs:15_000,cacheMutexName:mutexName,cimGateName:gateName});
  const marker='$needsTargetedOwnerRead=$true';
  assert.ok(script.includes(marker),'the probe fixture requires the pre-birth targeted branch');
  script=script.replace(marker,`${marker};[IO.File]::WriteAllText(${powershellQuote(temporalReady)},'ready',[Text.UTF8Encoding]::new($false))`);
  const targetFunction='function Get-ProcessRows([int]$pidValue){',fullFunction='function Get-AllProcessRows {',publishFunction='function Publish-Cache($snapshot){';
  for(const [needle,replacement,label] of [
   [targetFunction,`${targetFunction}[IO.File]::WriteAllText(${powershellQuote(targeted)},'targeted',[Text.UTF8Encoding]::new($false));`,'targeted raw query'],
   [fullFunction,`${fullFunction}[IO.File]::WriteAllText(${powershellQuote(full)},'full',[Text.UTF8Encoding]::new($false));throw 'test fixture rejected full snapshot';`,'full snapshot'],
   [publishFunction,`${publishFunction}[IO.File]::WriteAllText(${powershellQuote(published)},'published',[Text.UTF8Encoding]::new($false));throw 'test fixture rejected cache publication';`,'cache publication'],
  ]){assert.ok(script.includes(needle),`fixture requires ${label} hook`);script=script.replace(needle,replacement);}
  probe=spawn(leases.trustedWindowsHelper('powershell'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',script],{windowsHide:true,stdio:['ignore','pipe','pipe'],cwd:leases.trustedWindowsRoot(),env:leases.controllerEnvironment()});
  let stdout='',stderr='';probe.stdout.setEncoding('utf8');probe.stderr.setEncoding('utf8');probe.stdout.on('data',chunk=>{stdout+=chunk;});probe.stderr.on('data',chunk=>{stderr+=chunk;});
  const probeExit=new Promise(resolve=>probe.once('exit',(code,signal)=>resolve({code,signal})));
  const temporalDeadline=Date.now()+7000;
  while(!fs.existsSync(temporalReady)&&Date.now()<temporalDeadline)await pause(20);
  assert.ok(fs.existsSync(temporalReady),'the probe must identify the pre-birth branch before attempting any cache producer mutex');
  const exited=await within(probeExit,20_000,{code:null,signal:'timeout'});
  assert.equal(exited.code,0,stderr||'the temporal targeted proof must not await the held cache mutex');
  assert.equal(holder.exitCode,null,'the targeted proof must finish while the cache producer mutex remains held');
  assert.ok(fs.existsSync(targeted),'the pre-birth branch must execute the targeted raw owner query');
  assert.equal(fs.existsSync(full),false,'the pre-birth branch must not execute a full process snapshot');
  assert.equal(fs.existsSync(published),false,'the pre-birth branch must not publish a replacement cache');
  const response=JSON.parse(stdout);
  assert.equal(response.fresh,false,'the targeted proof must not upgrade the pre-birth cache to a full observation');
  assert.equal(response.owner.ProcessId,process.pid);
  assert.equal(response.owner.Started,binding.Started);
  assert.equal(Object.hasOwn(response.owner,'CommandLine'),true,'the targeted proof must retain a raw owner for Node-side binding validation');
  assert.equal(fs.readFileSync(cache,'utf8'),before,'the targeted proof must not rewrite the advisory full cache');
 }finally{
  try{fs.writeFileSync(release,'release');}catch{}
  if(probe){await within(new Promise(resolve=>probe.once('exit',resolve)),3_000,undefined);if(probe.exitCode===null)probe.kill();}
  if(holder){await within(new Promise(resolve=>holder.once('exit',resolve)),3_000,undefined);if(holder.exitCode===null)holder.kill();}
  await stopV3MutexLaneHolder(first,firstRelease);
  fs.rmSync(dir,{recursive:true,force:true});
 }
});test('a schema-3 same-PID stale binding falls back to one targeted raw owner read',t=>{
 if(process.platform!=='win32')return t.skip('Windows process snapshot cache integration only');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'coordinator-cache-schema3-stale-'));
 try{
  const cache=path.join(dir,'process-snapshot-cache.json'),runtime=processSnapshot().get(process.pid),binding=processIdentityBinding(runtime);
  const stale={...binding,Started:new Date(Date.parse(binding.Started)+1000).toISOString()};
  fs.writeFileSync(cache,JSON.stringify(schema3Cache([cachedProcessRow(stale,{ParentProcessId:runtime.ParentProcessId||1,WorkingSet64:runtime.WorkingSet64||1,PeakWorkingSet64:runtime.PeakWorkingSet64||1})])));
  const before=fs.readFileSync(cache,'utf8');
  const result=runCoordinatorSnapshotScript(cache,{caller:process.pid,waitMs:30_000});
  assert.equal(result.status,0,result.stderr);
  const response=JSON.parse(result.stdout);
  assert.equal(response.fresh,false,'a stale row must be revalidated rather than silently replaced by a full producer');
  assert.equal(response.owner.ProcessId,process.pid);
  assert.equal(response.owner.Started,runtime.Started,'the returned owner must come from the live OS read, not the same-PID cache row');
  assert.equal(processIdentityBinding(response.owner).commandLineSha256,binding.commandLineSha256);
  assert.equal(Object.hasOwn(response.owner,'CommandLine'),true,'the stale fallback must retain a raw live identity until Node validates it');
  assert.equal(fs.readFileSync(cache,'utf8'),before,'targeted revalidation must not rewrite the advisory full snapshot');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('a schema-3 cache observed before caller birth returns a targeted raw proof without rewriting the cache',t=>{
 if(process.platform!=='win32')return t.skip('Windows process snapshot cache integration only');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'coordinator-cache-schema3-prebirth-'));
 try{
  const cache=path.join(dir,'process-snapshot-cache.json'),runtime=processSnapshot().get(process.pid),binding=processIdentityBinding(runtime);
  const observedAt=new Date(Date.parse(binding.Started)-1000).toISOString().replace('Z','0000Z');
  fs.writeFileSync(cache,JSON.stringify(schema3Cache([cachedProcessRow(binding,{ParentProcessId:runtime.ParentProcessId||1,WorkingSet64:runtime.WorkingSet64||1,PeakWorkingSet64:runtime.PeakWorkingSet64||1})],{observedAt})));
  const before=fs.readFileSync(cache,'utf8');
  const result=runCoordinatorSnapshotScript(cache,{caller:process.pid,waitMs:30_000});
  assert.equal(result.status,0,result.stderr);
  const response=JSON.parse(result.stdout);
  assert.equal(response.fresh,false,'a pre-birth cache cannot authorize a full refresh for a later caller and must remain advisory');
  assert.equal(response.owner.Started,runtime.Started);
  assert.equal(processIdentityBinding(response.owner).commandLineSha256,binding.commandLineSha256,'the targeted raw proof must bind the live caller, not the pre-birth cache row');
  assert.equal(Object.hasOwn(response.owner,'CommandLine'),true,'the targeted proof must retain raw identity until Node validates it');
  assert.equal(fs.readFileSync(cache,'utf8'),before,'a targeted pre-birth proof must not claim that the old full cache was observed later');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('a pre-birth targeted-owner failure leaves the advisory cache and coordinator ledgers untouched',t=>{
 if(process.platform!=='win32')return t.skip('Windows process snapshot cache integration only');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'coordinator-cache-prebirth-target-failure-'));
 try{
  const cache=path.join(dir,'process-snapshot-cache.json'),leasesFile=path.join(dir,'leases.json'),ownersFile=path.join(dir,'run-owners.json');
  leases.atomicJson(cache,schema3Cache([cachedProcessRow(missingProcessIdentity)]));
  fs.writeFileSync(leasesFile,JSON.stringify([{id:'preserve-lease',keys:['dir:preserve'],owner:missingProcessIdentity,reservedAt:1}]));
  fs.writeFileSync(ownersFile,JSON.stringify({preserve:{owner:missingProcessIdentity,token:'preserve-token'}}));
  const before=new Map([cache,leasesFile,ownersFile].map(file=>[file,fs.readFileSync(file,'utf8')]));
  const result=runCoordinatorSnapshotScript(cache,{caller:missingProcessIdentity.ProcessId,waitMs:30_000});
  assert.notEqual(result.status,0,'an unavailable targeted caller must fail closed');
  assert.match(result.stderr,/Coordinator owner identity unavailable/);
  for(const [file,contents] of before)assert.equal(fs.readFileSync(file,'utf8'),contents,`targeted failure must not rewrite ${path.basename(file)}`);
  assert.deepEqual(fs.readdirSync(dir).sort(),['leases.json','process-snapshot-cache.json','run-owners.json']);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});test('a cache-hit caller proof validates outside its producer mutex and routes pre-birth callers to a targeted proof',()=>{
 const script=leases.coordinatorProcessSnapshotScript('C:\\coordinator\\process-snapshot-cache.json',{caller:1234});
 const cacheRead=script.indexOf('$cached=if($forceFresh){$null}else{Read-Cache $false}');
 const firstMutexWait=script.indexOf('$cacheHeld=$cacheMutex.WaitOne');
 const repairRead=script.indexOf('$cached=if($forceFresh){$null}else{Read-Cache $true}',firstMutexWait);
 const release=script.indexOf('$cacheMutex.ReleaseMutex()',firstMutexWait);
 const cacheHit=script.indexOf('if(-not $fresh){',cacheRead);
 const cacheProof=script.indexOf('Test-ObservedCacheOwner $cachedOwner $observedAt',cacheHit);
 const temporalMiss=script.indexOf('Test-CacheObservedBeforeCallerBirth',cacheHit);
 const temporalBranchEnd=script.indexOf('if($fresh -and $null -eq $owner)',temporalMiss);
 const temporalBranch=script.slice(temporalMiss,temporalBranchEnd);
 const targetLookup=script.indexOf('$owner=@(Get-ProcessRows $callerPid)',temporalMiss);
 const fullEnumeration=script.indexOf('$snapshot=Get-AllProcessRows',cacheRead);
 assert.ok(cacheRead>=0,'the script must first perform a complete read-only cache validation');
 assert.match(script,/\[IO\.File\]::Open\(\$cachePath,\[IO\.FileMode\]::Open,\[IO\.FileAccess\]::Read,\(\[IO\.FileShare\]::Read -bor \[IO\.FileShare\]::Delete\)\)/,
   'a lock-free cache reader must permit the producer atomic replacement instead of denying delete sharing');
 assert.ok(firstMutexWait>cacheRead,'a valid cache hit must finish its read-only validation before it can contend for the producer mutex');
 assert.ok(repairRead>firstMutexWait,'a missing or malformed cache must be re-read only after acquiring the producer mutex');
 assert.ok(fullEnumeration>repairRead,'a miss repair must retain full enumeration inside its per-cache critical section');
 assert.ok(release>fullEnumeration,'the producer must publish or retain its full snapshot before releasing the mutex');
 assert.ok(cacheHit>cacheRead,'a cache-hit caller proof must begin after its read-only validation');
 assert.ok(cacheProof>cacheHit,'a cache hit must prove its raw observation postdates the caller before reuse');
 assert.ok(temporalMiss>cacheProof,'a pre-birth observation must be distinguished from a conflicting live binding');
 assert.ok(targetLookup>temporalMiss,'a pre-birth caller must obtain a current targeted raw identity');
 assert.doesNotMatch(temporalBranch,/\$snapshot=Get-AllProcessRows/,'a pre-birth caller must not serialize a new full snapshot or rewrite the advisory cache');
 assert.doesNotMatch(temporalBranch,/\$cacheHeld=\$cacheMutex\.WaitOne/,'a pre-birth caller must not wait behind an unrelated cache producer');
 assert.match(script,/\[Threading\.WaitHandle\]::WaitAny\(\$cimLanes,\(Get-RemainingMilliseconds\)\)/,'CIM work must remain globally bounded by two v3 lanes without serializing cache reads');
 assert.doesNotMatch(script,/\[Threading\.Semaphore\]::new/,'cache tests must not retain unrecoverable semaphore permits');
 assert.match(script,/Get-CimInstance Win32_Process(?:[^\n])* -OperationTimeoutSec \$timeoutSec/,'every WMI query must receive the remaining operation deadline');
 assert.match(script,/\$cacheMutex\.ReleaseMutex\(\).*\$cacheHeld=\$false/s,'the release path must clear cache-lock ownership before final disposal');
});
test('coordinator snapshot cache survives Windows paths with spaces and Unicode',t=>{
 if(process.platform!=='win32')return t.skip('Windows PowerShell cache integration only');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'coordinator cache 中文 & #-'));
 try{assertCoordinatorSnapshotCache(dir);}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('coordinator snapshot cache survives a Windows path longer than 260 characters',t=>{
 if(process.platform!=='win32')return t.skip('Windows PowerShell cache integration only');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'coordinator-cache-long-'));let dir=root;
 try{
  while(path.join(dir,'process-snapshot-cache.json').length<=270){dir=path.join(dir,'nested-component-for-process-snapshot-cache-length');fs.mkdirSync(dir);}
  assert.ok(path.join(dir,'process-snapshot-cache.json').length>260,'fixture must exceed the legacy Windows path limit');
  assertCoordinatorSnapshotCache(dir);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('coordinator snapshot cache survives a Windows trailing-dot directory',t=>{
 if(process.platform!=='win32')return t.skip('Windows PowerShell cache integration only');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'coordinator-cache-dot-')),dir=path.join(root,'coordinator.');
 try{
  fs.mkdirSync('\\\\?\\'+dir);
  assert.deepEqual(fs.readdirSync(root),['coordinator.'],'fixture must retain its trailing dot');
  assertCoordinatorSnapshotCache(dir);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('coordinator snapshot cache accepts a local administrative UNC path when available',t=>{
 if(process.platform!=='win32')return t.skip('Windows PowerShell cache integration only');
 const local=fs.mkdtempSync(path.join(os.tmpdir(),'coordinator-cache-local-unc-')),drive=path.parse(local).root.slice(0,1).toLowerCase(),localAdminUnc=`\\\\localhost\\${drive}$${local.slice(2)}`;
 try{
  // This is local-share coverage only. The separate script test above covers
  // remote UNC construction without presenting this host share as remote SMB.
  try{fs.statSync(localAdminUnc);}catch(error){return t.skip('local administrative UNC share unavailable: '+error.message);}
  assertCoordinatorSnapshotCache(localAdminUnc);
 }finally{fs.rmSync(local,{recursive:true,force:true});}
});
test('a cache entry without the caller uses a fresh targeted owner before lock acquisition',t=>{
 if(process.platform!=='win32')return t.skip('Windows process snapshot cache integration only');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'coordinator-cache-targeted-'));
 try{
  const cache=path.join(dir,'process-snapshot-cache.json');
  const original=schema3Cache([cachedProcessRow(missingProcessIdentity)]);
  fs.writeFileSync(cache,JSON.stringify(original));
  const before=fs.readFileSync(cache,'utf8');
  let fresh,owner;
  transaction(dir,(_leases,current,_processes,observation)=>{owner=current;fresh=observation?.fresh;});
  // The transaction succeeds with a real current owner, while an advisory hit
  // leaves the caller-omitting cache untouched (a full refresh would replace it).
  assert.ok(owner&&owner.ProcessId===process.pid);
  assert.equal(fresh,false);
  assert.equal(fs.readFileSync(cache,'utf8'),before);
 }
 finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('a same-PID stale cache row cannot authorize a second run owner',t=>{
 if(process.platform!=='win32')return t.skip('Windows process snapshot cache integration only');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'coordinator-cache-stale-caller-'));
 try{
  const expected=processSnapshot().get(process.pid),expectedBinding=processIdentityBinding(expected),cache=path.join(dir,'process-snapshot-cache.json');
  const stale={...expectedBinding,Started:new Date(Date.parse(expected.Started)+1000).toISOString()};
  fs.writeFileSync(cache,JSON.stringify(schema3Cache([cachedProcessRow(stale)])));
  const first=claimRun(dir,'protected-run');
  for(const key of ['ProcessId','Started','Name','commandLineSha256'])assert.equal(first.owner[key],expectedBinding[key],`cache PID matches must use the caller live ${key}`);
  assert.equal(Object.hasOwn(first.owner,'CommandLine'),false,'a durable run owner must not contain a raw command line');
  const expired=JSON.parse(fs.readFileSync(cache,'utf8'));expired.createdAt=Date.now()-180000;fs.writeFileSync(cache,JSON.stringify(expired));
  assert.throws(()=>claimRun(dir,'protected-run'),/Run already has a live controller/,'a fresh producer must still see the live claim');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('transaction invokes its injected generic snapshot callback exactly once',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'coordinator-snapshot-count-'));
 try{
  let calls=0;
  const snapshot=()=>{calls++;return new Map([[process.pid,{ProcessId:process.pid,Started:'current',Name:process.execPath,CommandLine:process.argv.join(' ')}]]);};
  transaction(dir,()=>{},snapshot);
  assert.equal(calls,1);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('explicit coordinator refuses a symlink or junction in its path',()=>{
 fs.mkdirSync(family,{recursive:true});const root=fs.mkdtempSync(path.join(family,'coordinator-link-'));
 try{
  const workspace=path.join(root,'workspace');fs.mkdirSync(workspace);
  const real=path.join(root,'real');fs.mkdirSync(real);
  const link=path.join(root,'linked');
  try{fs.symlinkSync(real,link,'junction');}catch{try{fs.symlinkSync(real,link,'dir');}catch{return;}}
  assert.throws(()=>coordinatorDir(workspace,{ORCH_COORDINATOR_DIR:path.join(link,'pool')}),/symbolic link|junction|reparse/i);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('Windows short aliases cannot place controller or coordinator state inside a workspace',t=>{
 if(process.platform!=='win32')return t.skip('Windows 8.3 path aliases only');
 fs.mkdirSync(family,{recursive:true});const root=fs.mkdtempSync(path.join(family,'short-alias-family-'));
 try{
  const workspace=path.join(root,'long-workspace-directory-name');fs.mkdirSync(workspace);
  if(workspace.includes(' '))return t.skip('short-path fixture requires a workspace without spaces');
  const result=spawnSync('cmd.exe',['/d','/c',`for %I in (${workspace}) do @echo %~sI`],{encoding:'utf8',windowsHide:true});
  assert.equal(result.status,0,result.stderr);
  const alias=result.stdout.trim();
  if(alias.toLowerCase()===workspace.toLowerCase())return t.skip('8.3 aliases are unavailable on this volume');
  assert.equal(fs.realpathSync.native(alias).toLowerCase(),fs.realpathSync.native(workspace).toLowerCase());
  assert.throws(()=>controllerStateDir(workspace,{CODEX_HOME:alias}),/inside the initiating workspace/i);
  assert.throws(()=>controllerStateDir(workspace,{ORCH_CONTROLLER_ROOT:path.join(alias,'not-yet-created')}),/inside the initiating workspace/i);
  assert.throws(()=>coordinatorDir(workspace,{ORCH_COORDINATOR_DIR:path.join(alias,'not-yet-created')}),/inside the initiating workspace/i);
  const external=path.join(root,'external-not-yet-created');
  assert.equal(controllerStateDir(workspace,{ORCH_CONTROLLER_ROOT:external}),external);
  assert.equal(coordinatorDir(workspace,{ORCH_COORDINATOR_DIR:external}),external);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('local UNC aliases share controller identity and conflict keys with the drive path',t=>{
 if(process.platform!=='win32')return t.skip('Windows UNC aliases only');
 const workspace=path.resolve(family,'..');
 const unc='\\\\localhost\\c$'+workspace.slice(2);
 try {
  if(fs.realpathSync.native(unc).toLowerCase()===unc.toLowerCase())return t.skip('UNC alias unavailable');
  assert.equal(controllerWindowsDir(workspace),controllerWindowsDir(unc));
  assert.equal(coordinatorDir(workspace),coordinatorDir(unc));
 } catch (error) { return t.skip('UNC administrative share unavailable: '+error.message); }
});
function crossProcessWorkerSource(module,reservation) {
 return `import fs from 'node:fs';import path from 'node:path';import {reserve,release,transaction} from ${JSON.stringify(module)};
 const dir=process.argv[2],id=process.argv[3],workerDeadlineAt=Number(process.argv[4]),reserveFile=path.join(dir,id+'.reserve.json'),releaseFile=path.join(dir,id+'.release.json');
 if(!Number.isSafeInteger(workerDeadlineAt))throw new Error('test worker requires an absolute release deadline');
 const warnings=[];process.on('warning',warning=>warnings.push({name:String(warning?.name||'Warning'),code:warning?.code===undefined?null:String(warning.code),message:String(warning?.message||warning)}));const settleWarnings=()=>new Promise(resolve=>setImmediate(resolve));const coordinatorReleaseWarnings=list=>list.filter(warning=>warning.name==='CoordinatorReleaseCommitWarning'||/^ORCH_COORDINATOR_RELEASE_/.test(warning.code||''));
 let result;const reservationStarted=Date.now();
 try{result=${reservation};}
 catch(e){result={error:e.message};process.exitCode=1;}
 await settleWarnings();result={...result,reservationElapsedMs:Date.now()-reservationStarted,warnings:warnings.slice(),coordinatorReleaseWarnings:coordinatorReleaseWarnings(warnings)};
 fs.writeFileSync(reserveFile,JSON.stringify(result));
 if(result.error){fs.writeFileSync(releaseFile,JSON.stringify({attempted:false,ok:false,error:result.error,warnings:result.warnings,coordinatorReleaseWarnings:result.coordinatorReleaseWarnings}));}
 else{
  let releaseSignalReceived=false;
  while(!(releaseSignalReceived=fs.existsSync(path.join(dir,'release')))){if(Date.now()>=workerDeadlineAt)break;await new Promise(r=>setTimeout(r,50));}
  if(!releaseSignalReceived){
   const timeoutCleanup={attempted:!!result.ok,ok:true,elapsedMs:0};
   if(result.ok){const started=Date.now();try{release(dir,id,undefined,{deadlineAt:Date.now()+120_000});}catch(e){timeoutCleanup.ok=false;timeoutCleanup.error=e.message;}finally{timeoutCleanup.elapsedMs=Date.now()-started;}}
   await settleWarnings();timeoutCleanup.warnings=warnings.slice(result.warnings.length);timeoutCleanup.coordinatorReleaseWarnings=coordinatorReleaseWarnings(timeoutCleanup.warnings);
   if(timeoutCleanup.coordinatorReleaseWarnings.length){timeoutCleanup.ok=false;timeoutCleanup.error='coordinator release emitted warning(s) during worker timeout cleanup';}
   fs.writeFileSync(releaseFile,JSON.stringify({attempted:false,ok:false,error:'test worker release signal deadline exceeded',warnings:timeoutCleanup.warnings,coordinatorReleaseWarnings:timeoutCleanup.coordinatorReleaseWarnings,timeoutCleanup}));process.exitCode=1;
  }
  else{
   const releaseResult={attempted:!!result.ok,ok:true,elapsedMs:0};
   if(result.ok){const started=Date.now();try{release(dir,id);}catch(e){releaseResult.ok=false;releaseResult.error=e.message;process.exitCode=1;}finally{releaseResult.elapsedMs=Date.now()-started;}}
   await settleWarnings();releaseResult.warnings=warnings.slice(result.warnings.length);releaseResult.coordinatorReleaseWarnings=coordinatorReleaseWarnings(releaseResult.warnings);
   if(releaseResult.coordinatorReleaseWarnings.length){releaseResult.ok=false;releaseResult.error='coordinator release emitted warning(s)';process.exitCode=1;}
   fs.writeFileSync(releaseFile,JSON.stringify(releaseResult));
  }
 }`;
}for(const [parents,capacity] of [[9,8],[12,4],[40,16]])test(`${parents} independent parent processes contend for ${capacity} shared slots without lost updates`,async t=>{
 fs.mkdirSync(family,{recursive:true});const dir=fs.mkdtempSync(path.join(family,'cross-process-'));
 const module=new URL('../scripts/core/leases.mjs',import.meta.url).href;
 const worker=path.join(dir,'worker.mjs');
 const reservation=parents===40?`transaction(dir,(leases,owner,_processes,observation)=>{
 const result=leases.some(l=>l.id===id)?{ok:false,reason:'existing reservation'}:leases.length>=${capacity}?{ok:false,reason:'capacity'}:leases.some(l=>l.keys.some(k=>k==='test:'+id))?{ok:false,reason:'conflict'}:(leases.push({id,runId:id,keys:['test:'+id],owner,capacity:${capacity},reservedAt:Date.now()}),{ok:true});
 return {...result,fresh:observation?.fresh};
 })`:`reserve(dir,{id,runId:id,keys:['test:'+id]},${capacity})`;
 fs.writeFileSync(worker,crossProcessWorkerSource(module,reservation)); const workerDeadlineAt=Date.now()+390_000;
 const children=Array.from({length:parents},(_,i)=>spawn(process.execPath,[worker,dir,'run'+i,String(workerDeadlineAt)],{windowsHide:true,stdio:'ignore'}));
 const exits=children.map(c=>new Promise(resolve=>{c.once('exit',(code,signal)=>resolve({code,signal,error:null}));c.once('error',error=>resolve({code:null,signal:null,error:error?.message||String(error)}));}));
 let releaseSent=false,exitResults=null,primaryFailure=null;
 try{
  // A burst of independent Windows processes serializes CIM identity
  // snapshots behind the named mutex. The production bound is 120s, so the
  // acceptance window must cover that bound instead of failing while valid
  // contenders are still waiting in the bounded queue.
  const deadline=Date.now()+180000;
  let results;
  while(Date.now()<deadline){
   try{
     results=children.map((_,i)=>JSON.parse(fs.readFileSync(path.join(dir,'run'+i+'.reserve.json'),'utf8')));
    break;
   }catch(error){
    if(!['ENOENT','EACCES','EPERM'].includes(error?.code) && !(error instanceof SyntaxError))throw error;
    await pause(100);
   }
  }
  assert.ok(results,'bounded wait for every child result expired');
  assert.equal(results.filter(r=>r.ok).length,capacity,JSON.stringify(results));
  assert.equal(results.filter(r=>r.reason==='capacity').length,parents-capacity,JSON.stringify(results));
  assert.ok(results.every(result=>Array.isArray(result.warnings)),`reservation warning artifacts: ${JSON.stringify(results)}`);
  assert.ok(results.every(result=>Array.isArray(result.coordinatorReleaseWarnings)&&result.coordinatorReleaseWarnings.length===0),`reservation coordinator-release warnings: ${JSON.stringify(results)}`);
  t.diagnostic(`cross-process reservation stage: max=${Math.max(...results.map(result=>Number(result.reservationElapsedMs)||0))}ms, values=${results.map(result=>Number(result.reservationElapsedMs)||0).join(',')}ms`);
  if(parents===40){
   const freshCount=results.filter(r=>r.fresh===true).length;
   t.diagnostic(`full process enumerations in 40-process burst: ${freshCount}`);
   // A cache observed before a late child is deliberately refreshed once under
   // the per-cache mutex. Permit a few launch waves on constrained hosts, but
   // reject the old one-WMI-query-per-caller convoy.
   assert.ok(freshCount>=1&&freshCount<=Math.ceil(parents/4),`40-process burst must coalesce temporal refreshes, got ${freshCount}`);
  }
  const leases=JSON.parse(fs.readFileSync(path.join(dir,'leases.json'),'utf8'));
  const admittedIds=results.flatMap((result,index)=>result.ok?['run'+index]:[]).sort();
  assert.equal(leases.length,capacity,JSON.stringify(leases));
  assert.deepEqual(leases.map(lease=>lease.id).sort(),admittedIds,'the durable ledger must contain exactly the successful reservation ids');
  assert.deepEqual(leases.map(lease=>lease.runId).sort(),admittedIds,'the durable ledger must preserve the successful reservation run ids');
   fs.writeFileSync(path.join(dir,'release'),'release');releaseSent=true;
   exitResults=await within(Promise.all(exits),180_000);
   assert.ok(exitResults,'bounded wait for worker lifecycle completion expired');
   assert.deepEqual(exitResults,Array.from({length:parents},()=>({code:0,signal:null,error:null})),`worker lifecycle failures: ${JSON.stringify(exitResults)}`);
   const releaseResults=children.map((_,i)=>JSON.parse(fs.readFileSync(path.join(dir,'run'+i+'.release.json'),'utf8')));
   for(let index=0;index<parents;index++){
    assert.equal(releaseResults[index].attempted,results[index].ok===true,`release attempt must correspond to reservation result for run${index}`);
    assert.equal(releaseResults[index].ok,true,`release result failed for run${index}: ${JSON.stringify(releaseResults[index])}`);
    assert.ok(Array.isArray(releaseResults[index].warnings),`release warning artifact missing for run${index}: ${JSON.stringify(releaseResults[index])}`);
    assert.deepEqual(releaseResults[index].coordinatorReleaseWarnings,[],`coordinator release warning(s) for run${index}: ${JSON.stringify(releaseResults[index])}`);
   }
   t.diagnostic(`cross-process release stage: max=${Math.max(...releaseResults.map(result=>Number(result.elapsedMs)||0))}ms, values=${releaseResults.map(result=>Number(result.elapsedMs)||0).join(',')}ms`);
   const releasedLeases=JSON.parse(fs.readFileSync(path.join(dir,'leases.json'),'utf8'));
   assert.deepEqual(releasedLeases,[],'every admitted reservation must be durably removed after worker lifecycle completion');
  }catch(error){primaryFailure=error;throw error;}finally{
   const cleanupFailures=[];
   if(!releaseSent){try{fs.writeFileSync(path.join(dir,'release'),'release');releaseSent=true;}catch(error){cleanupFailures.push(error);}}
   if(exitResults===null){
    const cleanup=await within(Promise.all(exits),180_000);
    if(cleanup===null){
     for(const child of children)if(child.exitCode===null)child.kill();
     const terminated=await within(Promise.all(exits),30_000);
     if(terminated===null)cleanupFailures.push(new Error('test fixture worker processes did not terminate after bounded cleanup'));
    }
   }
   await pause(500);
   try{fs.rmSync(dir,{recursive:true,force:true});}catch(error){cleanupFailures.push(error);}
   if(cleanupFailures.length){
    t.diagnostic(`cross-process fixture cleanup failure(s): ${cleanupFailures.map(error=>error.message).join(' | ')}`);
    const cleanupError=new AggregateError(cleanupFailures,'cross-process fixture cleanup failed');
    if(primaryFailure)throw new AggregateError([primaryFailure,cleanupError],'cross-process lifecycle assertion failed and fixture cleanup was incomplete');
    throw cleanupError;
   }
 }
});
