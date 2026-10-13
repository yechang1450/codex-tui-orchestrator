import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {controllerEnvironment,coordinatorReleaseAcknowledgementMatches,coordinatorReleaseMarkerMatches,coordinatorReleaseSignalMatches,processSnapshot,transaction,trustedWindowsHelper,trustedWindowsRoot,waitForCoordinatorReleaseAcknowledgement} from '../scripts/core/leases.mjs';
import {physicalPathIdentity} from '../scripts/core/runtime-context.mjs';

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const powershellQuote=value=>"'"+String(value).replaceAll("'","''")+"'";
const lockScript=fileURLToPath(new URL('../scripts/core/lease-lock.ps1',import.meta.url));
const leasesModuleFile=fileURLToPath(new URL('../scripts/core/leases.mjs',import.meta.url));
const ownedAttemptMarkerSuffixes=Object.freeze(['.ready','.release','.released','.ack']);
// A fresh constrained PowerShell process compiles the helper's no-follow
// directory interop before it can publish `.ready`. Keep fixture waits finite,
// but do not confuse that cold-start cost with a failed mutex handshake.
const HELPER_STARTUP_TIMEOUT_MS=15_000;
const HELPER_CLEANUP_TIMEOUT_MS=15_000;
function sha256File(file){return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');}
function replaceExactlyOnce(source,needle,replacement,label){
 const first=source.indexOf(needle),last=source.lastIndexOf(needle);
 assert.notEqual(first,-1,`${label}: mutation target disappeared from the source copy`);
 assert.equal(first,last,`${label}: mutation target must be unique in the source copy`);
 return source.slice(0,first)+replacement+source.slice(first+needle.length);
}
async function withTemporaryLeasesMutation(label,mutate,run){
 const sourceBefore=fs.readFileSync(leasesModuleFile,'utf8'),sourceHashBefore=sha256File(leasesModuleFile);
 const mutated=mutate(sourceBefore);
 assert.notEqual(mutated,sourceBefore,`${label}: temporary mutation must change only the generated source copy`);
 const copy=path.join(path.dirname(leasesModuleFile),`.lease-lock-policy-${process.pid}-${crypto.randomUUID()}.mjs`);
 fs.writeFileSync(copy,mutated,{encoding:'utf8',flag:'wx'});
 try{
  const module=await import(`${pathToFileURL(copy).href}?lease-lock-policy-mutation=${crypto.randomUUID()}`);
  return await run(module);
 }finally{
  fs.rmSync(copy,{force:true});
  assert.equal(fs.existsSync(copy),false,`${label}: generated mutation copy must be removed`);
  assert.equal(sha256File(leasesModuleFile),sourceHashBefore,`${label}: production source must remain byte-for-byte unchanged`);
 }
}
async function withTemporaryLeaseLockScript(label,mutate,run){
 const sourceBefore=fs.readFileSync(lockScript,'utf8'),sourceHashBefore=sha256File(lockScript);
 const mutated=mutate(sourceBefore);
 assert.notEqual(mutated,sourceBefore,`${label}: temporary mutation must change only the generated script copy`);
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),`ctui-lock-script-${process.pid}-`));
 const copy=path.join(dir,'lease-lock.ps1');
 fs.writeFileSync(copy,mutated,{encoding:'utf8',flag:'wx'});
 try{return await run(copy);}
 finally{
  fs.rmSync(dir,{recursive:true,force:true});
  assert.equal(sha256File(lockScript),sourceHashBefore,`${label}: production helper script must remain byte-for-byte unchanged`);
 }
}
function assertOwnedAttemptMarkers(ticket,present,context){
 for(const suffix of ownedAttemptMarkerSuffixes){
  assert.equal(fs.existsSync(ticket+suffix),present,`${context}: helper-owned ${suffix} marker must ${present?'exist before':'be absent after'} cleanup`);
 }
}
function leaseMutexName(directory){
 return 'Local\\TuiOrchestrator.Leases.'+crypto.createHash('sha256').update(String(directory).toLowerCase(),'utf8').digest('hex').toUpperCase();
}
async function waitFor(condition,{timeoutMs=HELPER_STARTUP_TIMEOUT_MS,detail='timed out waiting for condition'}={}){
 const deadline=Date.now()+timeoutMs;
 while(Date.now()<deadline){if(condition())return;await pause(10);}
 assert.fail(detail);
}
async function waitForExit(child,timeoutMs=HELPER_CLEANUP_TIMEOUT_MS){
 if(child.exitCode!==null)return child.exitCode;
 return await Promise.race([
  once(child,'exit').then(([code])=>code),
  pause(timeoutMs).then(()=>assert.fail('lease helper did not exit within its bounded cleanup window')),
 ]);
}
function spawnLeaseHelper({directory,ticket,nonce,waitMs=2000,receiptAckWaitMs=5000,receiptPublicationBarrier='',receiptCleanupBarrier='',readyDeadlineAt,script=lockScript}){
 const owner=processSnapshot().get(process.pid);
 assert.ok(owner?.Started,'the live test requires the parent process start identity');
 const args=[
  '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,
  '-Directory',directory,'-Ticket',ticket,'-Nonce',nonce,'-Owner',String(process.pid),
  '-Started',owner.Started,'-WaitMs',String(waitMs),'-ReceiptAckWaitMs',String(receiptAckWaitMs),
 ];
 if(Number.isSafeInteger(readyDeadlineAt))args.push('-ReadyDeadlineAt',String(readyDeadlineAt));
 if(receiptPublicationBarrier)args.push('-ReceiptPublicationBarrier',receiptPublicationBarrier);
 if(receiptCleanupBarrier)args.push('-ReceiptCleanupBarrier',receiptCleanupBarrier);
 return spawn(trustedWindowsHelper('powershell'),args,{windowsHide:true,stdio:'ignore',cwd:trustedWindowsRoot(),env:controllerEnvironment()});
}
function runNamedMutexContender(directory,acquired,timeoutMs=1000){
 const contender=`$ErrorActionPreference='Stop';$mutex=[Threading.Mutex]::new($false,${powershellQuote(leaseMutexName(directory))});$held=$false;try{$held=$mutex.WaitOne(${Number(timeoutMs)});if(-not $held){throw 'second contender could not acquire mutex after receipt'};[IO.File]::WriteAllText(${powershellQuote(acquired)},'acquired',[Text.UTF8Encoding]::new($false))}finally{if($held){$mutex.ReleaseMutex()};$mutex.Dispose()}`;
 return spawnSync(trustedWindowsHelper('powershell'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',contender],{encoding:'utf8',windowsHide:true,timeout:Math.max(3000,Number(timeoutMs)+2000),cwd:trustedWindowsRoot(),env:controllerEnvironment()});
}
function spawnImmediateMutexContender(directory,result,{timeoutMs=3000}={}){
 const contender=`$ErrorActionPreference='Stop';$mutex=[Threading.Mutex]::new($false,${powershellQuote(leaseMutexName(directory))});$held=$false;$deadline=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()+${Number(timeoutMs)};try{while([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -lt $deadline){$held=$mutex.WaitOne(0);if($held){[IO.File]::WriteAllText(${powershellQuote(result)},'acquired:'+[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(),[Text.UTF8Encoding]::new($false));break};Start-Sleep -Milliseconds 1};if(-not $held){[IO.File]::WriteAllText(${powershellQuote(result)},'timed-out',[Text.UTF8Encoding]::new($false));exit 3}}finally{if($held){$mutex.ReleaseMutex()};$mutex.Dispose()}`;
 return spawn(trustedWindowsHelper('powershell'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',contender],{windowsHide:true,stdio:'ignore',cwd:trustedWindowsRoot(),env:controllerEnvironment()});
}
function fixtureChildIsRunning(child){return Boolean(child)&&child.exitCode===null&&child.signalCode===null;}
async function stopFixtureChild(child){
 if(!fixtureChildIsRunning(child))return;
 child.kill();
 try{await waitForExit(child,HELPER_CLEANUP_TIMEOUT_MS);}catch(error){
  throw new Error(`fixture helper did not exit; retained fixture: ${child.spawnargs?.at(-1)??'unknown'}`,{cause:error});
 }
 if(fixtureChildIsRunning(child))throw new Error('fixture helper remained running after bounded shutdown; retained fixture');
}
async function removeFixture(dir,child){
 await stopFixtureChild(child);
 const deadline=Date.now()+1500;
 while(true){
  try{return fs.rmSync(dir,{recursive:true,force:true});}catch(error){
   if(error?.code!=='EPERM'&&error?.code!=='EBUSY')throw error;
   if(Date.now()>=deadline)throw new Error(`fixture cleanup retained ${dir} after bounded ${error.code} retries`,{cause:error});
   await pause(25);
  }
 }
}
async function renameFixtureDirectory(from,to){
 const deadline=Date.now()+1500;
 while(true){
  try{return fs.renameSync(from,to);}catch(error){
   if(error?.code!=='EPERM'&&error?.code!=='EBUSY')throw error;
   if(Date.now()>=deadline)throw new Error(`fixture directory rename remained blocked: ${from}`,{cause:error});
   await pause(25);
  }
 }
}
function assertWindowsReparsePoint(candidate){
 const probe=`$item=Get-Item -LiteralPath ${powershellQuote(candidate)} -Force;if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0){throw 'fixture is not a reparse point'}`;
 const result=spawnSync(trustedWindowsHelper('powershell'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',probe],{encoding:'utf8',windowsHide:true,cwd:trustedWindowsRoot(),env:controllerEnvironment()});
 assert.equal(result.status,0,result.stderr||'fixture must be a real Windows reparse point');
}
function createJunction(target,junction){
 fs.symlinkSync(target,junction,'junction');
 assert.equal(fs.lstatSync(junction).isSymbolicLink(),true,'fixture must create a lexical junction before the helper starts');
 assertWindowsReparsePoint(junction);
}
function directoryAcceptsDeleteShareProbe(directory){
 const probe=`Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class TuiOrchestratorDeleteShareProbe {
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,EntryPoint="CreateFileW",SetLastError=true)]
  public static extern SafeFileHandle CreateFileW(string path,uint access,uint share,IntPtr security,uint disposition,uint flags,IntPtr template);
}
'@ -ErrorAction Stop;$handle=[TuiOrchestratorDeleteShareProbe]::CreateFileW(${powershellQuote(directory)},0x00010000,0x00000007,[IntPtr]::Zero,3,0x02200000,[IntPtr]::Zero);if($handle.IsInvalid){exit 1};$handle.Dispose()`;
 const result=spawnSync(trustedWindowsHelper('powershell'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',probe],{encoding:'utf8',windowsHide:true,cwd:trustedWindowsRoot(),env:controllerEnvironment()});
 if(result.error)throw result.error;
 return result.status===0;
}
async function waitForReadyPublicationToReleaseItsParentHandle(directory,helper){
 await waitFor(()=>helper.exitCode===null&&directoryAcceptsDeleteShareProbe(directory),{detail:'the ready marker never completed publication and released its non-delete parent handle'});
 assert.equal(helper.exitCode,null,'the helper must still be alive after ready publication completes');
}
function ticketDirectoryForTransactionPhysicalDir(physicalDir){
 return path.join(os.tmpdir(),'codex-tui-orchestrator-locks',crypto.createHash('sha256').update(String(physicalDir).toLowerCase(),'utf8').digest('hex').slice(0,16));
}
function isProductionReceiptAcknowledgementLink(receipt,acknowledgement,ticketDirectory){
 const receiptPath=String(receipt),acknowledgementPath=String(acknowledgement);
 const expectedAcknowledgement=receiptPath.endsWith('.released')?receiptPath.slice(0,-'.released'.length)+'.ack':'';
 return ticketDirectory!==''&&
  path.resolve(path.dirname(receiptPath)).toLowerCase()===path.resolve(ticketDirectory).toLowerCase()&&
  /^lock-[0-9a-f-]+\.released$/i.test(path.basename(receiptPath))&&
  acknowledgementPath===expectedAcknowledgement;
}
async function waitForTicketHandshakeCleanup(ticketDirectory,{timeoutMs=8500,detail='the real helper did not clean rejected transaction markers'}={}){
 await waitFor(()=>{
  try{return !fs.existsSync(ticketDirectory)||fs.readdirSync(ticketDirectory).every(name=>!/^lock-[0-9a-f-]+\.(?:ready|release|released|ack)$/i.test(name));}
  catch{return false;}
 },{timeoutMs,detail});
}
async function runCommittedAcknowledgementLinkFault({transactionImpl=transaction,errorCode,label,expectWarning=true}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),`codex-tui-ack-${label}-`));
 const recordId=`ack-${label}-${crypto.randomUUID()}`,originalLink=fs.linkSync,originalTimeout=process.env.ORCH_COORDINATOR_TIMEOUT_MS;
 const warnings=[];
 const onWarning=warning=>{if(warning?.code==='ORCH_COORDINATOR_RELEASE_ACK_SIGNAL_FAILED')warnings.push(warning);};
 let ticketDirectory='',callbackCalls=0,linkAttempts=0,receiptPath='',acknowledgementPath='';
 try{
  process.on('warning',onWarning);
  // This only shortens the helper acquisition phase; the actual acknowledgement
  // timeout remains the production five-second protocol budget.
  process.env.ORCH_COORDINATOR_TIMEOUT_MS='10000';
  fs.linkSync=(receipt,acknowledgement,...args)=>{
   if(isProductionReceiptAcknowledgementLink(receipt,acknowledgement,ticketDirectory)){
    linkAttempts++;receiptPath=String(receipt);acknowledgementPath=String(acknowledgement);
    const error=new Error(`injected acknowledgement link fault: ${errorCode}`);error.code=errorCode;throw error;
   }
   return originalLink(receipt,acknowledgement,...args);
  };
  const result=transactionImpl(dir,(leases,owner,_processes,_observation,physicalDir)=>{
   callbackCalls++;ticketDirectory=ticketDirectoryForTransactionPhysicalDir(physicalDir);
   leases.push({id:recordId,keys:[],owner});
   return {ok:true,recordId};
  });
  if(expectWarning)await waitFor(()=>warnings.length===1,{timeoutMs:2000,detail:`${label}: committed acknowledgement fault did not emit its typed warning`});
  else await new Promise(resolve=>setImmediate(resolve));
  const persisted=JSON.parse(fs.readFileSync(path.join(dir,'leases.json'),'utf8'));
  return {result,recordId,persisted,warnings:[...warnings],callbackCalls,linkAttempts,receiptPath,acknowledgementPath};
 }finally{
  fs.linkSync=originalLink;
  if(originalTimeout===undefined)delete process.env.ORCH_COORDINATOR_TIMEOUT_MS;else process.env.ORCH_COORDINATOR_TIMEOUT_MS=originalTimeout;
  process.off('warning',onWarning);
  if(ticketDirectory){
   await waitForTicketHandshakeCleanup(ticketDirectory,{detail:`${label}: helper left acknowledgement markers after the rejected transaction handoff`});
   try{fs.rmSync(ticketDirectory,{recursive:true,force:true});}catch(error){throw new Error(`${label}: failed to remove isolated ticket directory`,{cause:error});}
  }
  await removeFixture(dir);
 }
}
function assertCommittedAcknowledgementLinkFault(scenario,errorCode){
 assert.deepEqual(scenario.result,{ok:true,recordId:scenario.recordId},`${errorCode}: committed callback result must be returned without automatic retry`);
 assert.equal(scenario.callbackCalls,1,`${errorCode}: a post-commit acknowledgement failure must not rerun the callback`);
 assert.equal(scenario.persisted.filter(lease=>lease.id===scenario.recordId).length,1,`${errorCode}: the committed ledger row must remain durable exactly once`);
 assert.equal(scenario.linkAttempts,1,`${errorCode}: the real transaction must make one acknowledgement-link attempt`);
 assert.match(path.basename(scenario.receiptPath),/^lock-[0-9a-f-]+\.released$/i,`${errorCode}: injected failure must be on the real production receipt`);
 assert.equal(scenario.acknowledgementPath,scenario.receiptPath.slice(0,-'.released'.length)+'.ack',`${errorCode}: injected failure must target the real receipt acknowledgement path`);
 assert.equal(scenario.warnings.length,1,`${errorCode}: committed acknowledgement failure must emit exactly one typed warning`);
 assert.equal(scenario.warnings[0].code,'ORCH_COORDINATOR_RELEASE_ACK_SIGNAL_FAILED',`${errorCode}: warning code must identify acknowledgement handoff failure`);
 assert.equal(scenario.warnings[0].committed,true,`${errorCode}: warning must preserve the durable-commit classification`);
 assert.match(scenario.warnings[0].message,new RegExp(`\\(${errorCode}\\)`),`${errorCode}: warning must retain the underlying link fault category`);
 assert.match(scenario.warnings[0].message,/must not be retried automatically/i,`${errorCode}: warning must forbid automatic retry after durable commit`);
}
function readJsonSynchronously(file,{timeoutMs=5000,detail='timed out waiting for monitor report'}={}){
 const deadline=Date.now()+timeoutMs,waiter=new Int32Array(new SharedArrayBuffer(4));let lastError;
 while(Date.now()<deadline){
  try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(error){lastError=error;}
  Atomics.wait(waiter,0,0,10);
 }
 throw new Error(detail,{cause:lastError});
}
function waitForFileSynchronously(file,{timeoutMs=5000,detail='timed out waiting for monitor readiness'}={}){
 const deadline=Date.now()+timeoutMs,waiter=new Int32Array(new SharedArrayBuffer(4));
 while(Date.now()<deadline){
  if(fs.existsSync(file))return;
  Atomics.wait(waiter,0,0,10);
 }
 assert.fail(detail);
}
function waitForAttemptMarkerCleanupSynchronously(ticket,{timeoutMs=4000,detail='helper did not complete acknowledged receipt cleanup'}={}){
 const deadline=Date.now()+timeoutMs,waiter=new Int32Array(new SharedArrayBuffer(4));
 while(Date.now()<deadline){
  if(ownedAttemptMarkerSuffixes.every(suffix=>!fs.existsSync(ticket+suffix)))return;
  Atomics.wait(waiter,0,0,10);
 }
 assert.fail(detail);
}
function spawnTransactionReceiptMutexMonitor({physicalDir,ticketDirectory,readyFile,reportFile,timeoutMs=5000}){
 // This is intentionally the same formula as lease-lock.ps1. The monitor is
 // external to Node's synchronous acknowledgement link, so its report can
 // establish the kernel state that existed before that link was allowed.
 const monitor=`$ErrorActionPreference='Stop';$directory=${powershellQuote(physicalDir)};$ticketDirectory=${powershellQuote(ticketDirectory)};$readyFile=${powershellQuote(readyFile)};$reportFile=${powershellQuote(reportFile)};$timeoutMs=${Number(timeoutMs)};$hash=$null;$mutex=$null;function Write-Result([hashtable]$result){$result.reportedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();$tmp=$reportFile+'.'+[Guid]::NewGuid().ToString('N')+'.tmp';[IO.File]::WriteAllText($tmp,($result|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false));[IO.File]::Move($tmp,$reportFile)}try{$hash=[Security.Cryptography.SHA256]::Create();$name='Local\\TuiOrchestrator.Leases.'+[BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($directory.ToLowerInvariant()))).Replace('-','');$mutex=[Threading.Mutex]::new($false,$name);[IO.File]::WriteAllText($readyFile,'ready',[Text.UTF8Encoding]::new($false));$deadline=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()+$timeoutMs;$receipt=$null;while([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -lt $deadline){$candidate=@(Get-ChildItem -LiteralPath $ticketDirectory -Filter '*.released' -File -Force -ErrorAction SilentlyContinue|Sort-Object Name|Select-Object -First 1);if($candidate.Count -gt 0){try{$text=[IO.File]::ReadAllText($candidate[0].FullName,[Text.UTF8Encoding]::new($false));if($text -like 'released:*'){$receipt=$candidate[0].FullName;break}}catch{}};Start-Sleep -Milliseconds 5};if($null -eq $receipt){Write-Result @{seen=$false;acquired=$false;receipt=$null;mutex=$name;reason='receipt-timeout'};exit 2};$acquired=$false;try{try{$acquired=$mutex.WaitOne(0)}catch [Threading.AbandonedMutexException]{$acquired=$true};$reason=if($acquired){'acquired'}else{'mutex-held'};Write-Result @{seen=$true;acquired=[bool]$acquired;receipt=$receipt;mutex=$name;reason=$reason}}finally{if($acquired){$mutex.ReleaseMutex()}};if(-not $acquired){exit 3}}catch{try{Write-Result @{seen=$false;acquired=$false;receipt=$null;mutex=$name;reason='monitor-error'} }catch{};exit 1}finally{if($null -ne $mutex){$mutex.Dispose()};if($null -ne $hash){$hash.Dispose()}}`;
 return spawn(trustedWindowsHelper('powershell'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',monitor],{windowsHide:true,stdio:'ignore',cwd:trustedWindowsRoot(),env:controllerEnvironment()});
}

test('cold file-identity prewarm does not monopolize the coordinator mutex',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ctui-prewarm-mutex-'));
 const ticket=path.join(dir,'ticket'),nonce='nonce-'+crypto.randomBytes(18).toString('base64url');
 const entered=path.join(dir,'prewarm-entered'),continueFile=path.join(dir,'prewarm-continue'),contenderFile=path.join(dir,'contender');
 let child;
 try{
  await withTemporaryLeaseLockScript('prewarm mutex ordering',source=>replaceExactlyOnce(
   source,
   "if($null -eq ('TuiOrchestrator.LeaseFileIdentity' -as [type])){",
   "if($null -eq ('TuiOrchestrator.LeaseFileIdentity' -as [type])){\n      [IO.File]::WriteAllText("+powershellQuote(entered)+",'entered',[Text.UTF8Encoding]::new($false))\n      while(-not [IO.File]::Exists("+powershellQuote(continueFile)+")){Start-Sleep -Milliseconds 5}",
   'prewarm mutex ordering',
  ),async script=>{
   child=spawnLeaseHelper({directory:dir,ticket,nonce,waitMs:3000,script});
   await waitFor(()=>fs.existsSync(entered),{detail:'the helper did not enter its cold identity prewarm'});
   const contender=spawnImmediateMutexContender(dir,contenderFile,{timeoutMs:750});
   assert.equal(await waitForExit(contender),0,'a contender must acquire while identity prewarm is paused');
   assert.match(fs.readFileSync(contenderFile,'utf8'),/^acquired:/,'the contender must observe an immediately available mutex during prewarm');
   fs.writeFileSync(continueFile,'continue','utf8');
   await waitFor(()=>fs.existsSync(ticket+'.ready'),{detail:'the resumed helper did not publish its ready nonce'});
   fs.writeFileSync(ticket+'.release','release:'+nonce,'utf8');
   assert.equal(await waitForExit(child),0,'the helper must finish its normal nonce-bound release path');
   assertOwnedAttemptMarkers(ticket,false,'prewarm ordering cleanup');
  });
 }finally{
  if(!fs.existsSync(continueFile))fs.writeFileSync(continueFile,'continue','utf8');
  if(child&&fixtureChildIsRunning(child)){
   try{
    await waitFor(()=>fs.existsSync(ticket+'.ready')||child.exitCode!==null,{detail:'fixture helper did not leave the prewarm barrier'});
    if(fs.existsSync(ticket+'.ready')&&!fs.existsSync(ticket+'.release'))fs.writeFileSync(ticket+'.release','release:'+nonce,'utf8');
   }finally{await stopFixtureChild(child);}
  }
  fs.rmSync(dir,{recursive:true,force:true});
 }
});

test('a ready deadline prevents a prewarmed helper from publishing a late mutex handshake',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ctui-prewarm-deadline-'));
 const ticket=path.join(dir,'ticket'),nonce='nonce-'+crypto.randomBytes(18).toString('base64url');
 const entered=path.join(dir,'prewarm-entered'),continueFile=path.join(dir,'prewarm-continue'),contenderFile=path.join(dir,'contender');
 let child;
 try{
  await withTemporaryLeaseLockScript('prewarm ready deadline',source=>replaceExactlyOnce(
   source,
   "if($null -eq ('TuiOrchestrator.LeaseFileIdentity' -as [type])){",
   "if($null -eq ('TuiOrchestrator.LeaseFileIdentity' -as [type])){\n      [IO.File]::WriteAllText("+powershellQuote(entered)+",'entered',[Text.UTF8Encoding]::new($false))\n      while(-not [IO.File]::Exists("+powershellQuote(continueFile)+")){Start-Sleep -Milliseconds 5}",
   'prewarm ready deadline',
  ),async script=>{
   const deadlineAt=Date.now()+3000;
   child=spawnLeaseHelper({directory:dir,ticket,nonce,waitMs:3000,readyDeadlineAt:deadlineAt,script});
   await waitFor(()=>fs.existsSync(entered),{detail:'the helper did not enter the controlled prewarm barrier'});
   await pause(Math.max(0,deadlineAt-Date.now()+250));
   fs.writeFileSync(continueFile,'continue','utf8');
   assert.notEqual(await waitForExit(child),0,'a helper that missed its ready deadline must not report normal completion');
   assertOwnedAttemptMarkers(ticket,false,'expired ready deadline');
   const contender=runNamedMutexContender(dir,contenderFile,1000);
   assert.equal(contender.status,0,contender.stderr||'the expired helper must not retain the mutex');
   assert.equal(fs.readFileSync(contenderFile,'utf8'),'acquired');
  });
 }finally{
  if(!fs.existsSync(continueFile))fs.writeFileSync(continueFile,'continue','utf8');
  if(child&&fixtureChildIsRunning(child))await stopFixtureChild(child);
  fs.rmSync(dir,{recursive:true,force:true});
 }
});

test('a pre-ready initialization failure preserves foreign ticket markers',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ctui-prewarm-ownership-'));
 const ticket=path.join(dir,'ticket'),nonce='nonce-'+crypto.randomBytes(18).toString('base64url');
 const foreignRelease=ticket+'.release',contenderFile=path.join(dir,'contender');
 let child;
 try{
  fs.writeFileSync(foreignRelease,'foreign-release-sentinel','utf8');
  await withTemporaryLeaseLockScript('prewarm ownership cleanup',source=>replaceExactlyOnce(
   source,
   '  if($script:fileIdentityInteropState -eq 1){return $true}',
   '  return $false',
   'prewarm ownership cleanup',
  ),async script=>{
   child=spawnLeaseHelper({directory:dir,ticket,nonce,waitMs:1000,script});
   assert.notEqual(await waitForExit(child),0,'a failed prewarm must not report normal completion');
   assert.equal(fs.readFileSync(foreignRelease,'utf8'),'foreign-release-sentinel','a helper without a ready marker must not clean a foreign ticket marker');
   for(const suffix of ['.ready','.released','.ack'])assert.equal(fs.existsSync(ticket+suffix),false,`failed prewarm must not publish ${suffix}`);
   const contender=runNamedMutexContender(dir,contenderFile,1000);
   assert.equal(contender.status,0,contender.stderr||'a failed prewarm must not retain the mutex');
   assert.equal(fs.readFileSync(contenderFile,'utf8'),'acquired');
  });
 }finally{
  if(child&&fixtureChildIsRunning(child))await stopFixtureChild(child);
  fs.rmSync(dir,{recursive:true,force:true});
 }
});

test('nonce-bound release protocol rejects a different attempt at both signal boundaries',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'codex-tui-release-protocol-'));
 const ticket=path.join(dir,'ticket'),nonce='nonce-'+Date.now().toString(36);
 try{
  fs.writeFileSync(ticket+'.release','release:'+nonce);
  assert.equal(coordinatorReleaseSignalMatches(ticket,nonce),true,'the helper may act only on this attempt\'s exact release signal');
  fs.writeFileSync(ticket+'.release','release:other-attempt');
  assert.equal(coordinatorReleaseSignalMatches(ticket,nonce),false,'a stale release signal must not release this attempt');
  fs.writeFileSync(ticket+'.released','released:'+nonce);
  fs.writeFileSync(ticket+'.ack','released:'+nonce);
  assert.equal(coordinatorReleaseAcknowledgementMatches(ticket,nonce),false,'matching text alone is not an acknowledgement: it must be the receipt hard link');
  fs.rmSync(ticket+'.ack');
  fs.linkSync(ticket+'.released',ticket+'.ack');
  assert.equal(coordinatorReleaseAcknowledgementMatches(ticket,nonce),true,'the helper may clean up only after this attempt\'s exact receipt-bound acknowledgement');
  fs.writeFileSync(ticket+'.ack','released:other-attempt');
  assert.equal(coordinatorReleaseAcknowledgementMatches(ticket,nonce),false,'a stale acknowledgement must not clean up this attempt');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('same-content acknowledgement hardlinks to a different inode are rejected even when both link counts satisfy the receipt shape',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'codex-tui-ack-decoy-inode-'));
 const ticket=path.join(dir,'ticket'),decoy=path.join(dir,'decoy'),nonce='nonce-'+crypto.randomBytes(18).toString('base64url');
 try{
  const receipt=ticket+'.released',acknowledgement=ticket+'.ack',content=`released:${nonce}`;
  // Give both candidate identities nlink >= 2. This rules out a false green
  // that only checks marker text plus link count instead of same-file identity.
  fs.writeFileSync(receipt,content,'utf8');
  fs.linkSync(receipt,path.join(dir,'receipt-companion'));
  fs.writeFileSync(decoy,content,'utf8');
  fs.linkSync(decoy,acknowledgement);
  const receiptStat=fs.statSync(receipt,{bigint:true}),acknowledgementStat=fs.statSync(acknowledgement,{bigint:true});
  assert.ok(receiptStat.nlink>=2n&&acknowledgementStat.nlink>=2n,'the decoy fixture must meet the minimum hard-link count on both candidate files');
  assert.notEqual(receiptStat.ino,acknowledgementStat.ino,'the acknowledgement must deliberately name a different same-content inode');
  assert.equal(coordinatorReleaseAcknowledgementMatches(ticket,nonce),false,'same marker text and qualifying link counts do not authorize an acknowledgement without receipt inode identity');
  await withTemporaryLeasesMutation('acknowledgement inode comparison',source=>replaceExactlyOnce(
   source,
   'receiptStat.ino===acknowledgementStat.ino&&',
   'true&&',
   'acknowledgement inode comparison',
  ),async({coordinatorReleaseAcknowledgementMatches:mutatedMatches})=>{
   assert.throws(
    ()=>assert.equal(mutatedMatches(ticket,nonce),false,'the normal decoy-inode oracle must reject a weakened identity check'),
    /normal decoy-inode oracle/,
    'the decoy-inode assertion must fail against a temporary source copy whose inode comparison is removed',
   );
  });
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('the helper refuses a precreated ready hardlink without overwriting its target', {skip: process.platform !== 'win32'}, async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'codex-tui-ready-hardlink-'));
 const ticket=path.join(dir,'ticket'),target=path.join(dir,'outside-target.txt'),nonce='nonce-'+crypto.randomBytes(18).toString('base64url');
 let helper;
 try{
  fs.writeFileSync(target,'sentinel','utf8');
  fs.linkSync(target,ticket+'.ready');
  helper=spawnLeaseHelper({directory:dir,ticket,nonce,waitMs:1000,receiptAckWaitMs:100});
  const status=await waitForExit(helper,HELPER_CLEANUP_TIMEOUT_MS);
  assert.equal(fs.readFileSync(target,'utf8'),'sentinel','exclusive ready publication must not follow or truncate a precreated hardlink target');
  assert.notEqual(status,0,'a precreated ready marker must fail closed');
 }finally{await removeFixture(dir,helper);}
});

test('the helper refuses a precreated released hardlink without overwriting its target', {skip: process.platform !== 'win32'}, async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'codex-tui-released-hardlink-'));
 const ticket=path.join(dir,'ticket'),target=path.join(dir,'outside-target.txt'),nonce='nonce-'+crypto.randomBytes(18).toString('base64url');
 let helper;
 try{
  fs.writeFileSync(target,'sentinel','utf8');
  fs.linkSync(target,ticket+'.released');
  helper=spawnLeaseHelper({directory:dir,ticket,nonce,waitMs:1000,receiptAckWaitMs:100});
  await waitFor(()=>fs.existsSync(ticket+'.ready'),{detail:'helper did not publish its ready nonce before testing released publication'});
  fs.writeFileSync(ticket+'.release',`release:${nonce}`,{flag:'wx'});
  const status=await waitForExit(helper,HELPER_CLEANUP_TIMEOUT_MS);
  assert.equal(fs.readFileSync(target,'utf8'),'sentinel','exclusive released publication must not follow or truncate a precreated hardlink target');
  assert.notEqual(status,0,'a precreated released marker must fail closed');
 }finally{await removeFixture(dir,helper);}
});

test('the helper refuses a ready marker through a precreated parent junction without following its target', {skip: process.platform !== 'win32'}, async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'codex-tui-ready-reparse-'));
 const directory=path.join(root,'coordinator'),targetDirectory=path.join(root,'outside-target'),ticket=path.join(directory,'ticket'),target=path.join(targetDirectory,'ticket.ready'),nonce='nonce-'+crypto.randomBytes(18).toString('base64url');
 let helper;
 try{
  fs.mkdirSync(targetDirectory);
  fs.writeFileSync(target,'sentinel','utf8');
  createJunction(targetDirectory,directory);
  helper=spawnLeaseHelper({directory,ticket,nonce,waitMs:1000,receiptAckWaitMs:100});
  const status=await waitForExit(helper,HELPER_CLEANUP_TIMEOUT_MS);
  assert.equal(fs.readFileSync(target,'utf8'),'sentinel','failed-closed ready publication must leave the external junction target untouched');
  assert.notEqual(status,0,'a precreated ready marker parent junction must fail closed');
 }finally{
  await stopFixtureChild(helper);
  assert.equal(fs.existsSync(directory),true,'failed-closed handling must leave the fixture junction itself intact');
  assert.equal(fs.lstatSync(directory).isSymbolicLink(),true,'fixture coordinator must remain a junction/reparse directory');
  assertWindowsReparsePoint(directory);
  fs.rmdirSync(directory);
  assert.equal(fs.existsSync(targetDirectory),true,'removing the fixture junction must not remove its target directory');
  await removeFixture(root);
 }
});

test('the helper fails closed after a marker parent is replaced by a junction without following its external target', {skip: process.platform !== 'win32'}, async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'codex-tui-released-reparse-'));
 const directory=path.join(root,'coordinator'),movedDirectory=path.join(root,'original-coordinator'),targetDirectory=path.join(root,'outside-target'),ticket=path.join(directory,'ticket'),nonce='nonce-'+crypto.randomBytes(18).toString('base64url');
 const sentinels=new Map([
  ['.ready','outside-ready'],
  ['.release',`release:${nonce}`],
  ['.released','outside-released'],
  ['.ack','outside-ack'],
 ]);
 let helper;
 try{
  fs.mkdirSync(directory);fs.mkdirSync(targetDirectory);
  helper=spawnLeaseHelper({directory,ticket,nonce,waitMs:1000,receiptAckWaitMs:100});
  await waitFor(()=>{
   try{return fs.readFileSync(ticket+'.ready','utf8').trim()===`ready:${nonce}`;}catch{return false;}
  },{detail:'helper did not finish its ready publication before testing released publication'});
  await waitForReadyPublicationToReleaseItsParentHandle(directory,helper);
  await renameFixtureDirectory(directory,movedDirectory);
  assert.equal(fs.existsSync(movedDirectory),true,'fixture must move the original coordinator before replacing its lexical path');
  assert.equal(fs.readFileSync(path.join(movedDirectory,'ticket.ready'),'utf8').trim(),`ready:${nonce}`,'the fixture must preserve the completed ready marker instead of racing its post-write verification');
  assert.equal(fs.existsSync(directory),false,'fixture must free the original coordinator path before creating the junction');
  for(const [suffix,value] of sentinels)fs.writeFileSync(path.join(targetDirectory,'ticket'+suffix),value,'utf8');
  createJunction(targetDirectory,directory);
  const status=await waitForExit(helper,HELPER_CLEANUP_TIMEOUT_MS);
  for(const [suffix,value] of sentinels){
   assert.equal(fs.readFileSync(path.join(targetDirectory,'ticket'+suffix),'utf8'),value,`failed-closed replacement handling must leave the external ${suffix} sentinel untouched`);
  }
  assert.notEqual(fs.readFileSync(path.join(targetDirectory,'ticket.released'),'utf8'),`released:${nonce}`,'a replaced marker parent must not publish a receipt to the external target');
  assert.notEqual(status,0,'a release marker parent replaced by a junction must fail closed');
 }finally{
  await stopFixtureChild(helper);
  assert.equal(fs.existsSync(directory),true,'failed-closed handling must leave the fixture junction itself intact');
  assert.equal(fs.lstatSync(directory).isSymbolicLink(),true,'fixture coordinator must remain a junction/reparse directory');
  assertWindowsReparsePoint(directory);
  fs.rmdirSync(directory);
  assert.equal(fs.existsSync(targetDirectory),true,'removing the fixture junction must not remove its target directory');
  await removeFixture(root);
 }
});

test('production transaction rejects a caller-selected shared TEMP before it creates a ticket handshake', {skip: process.platform !== 'win32'}, async()=>{
 const root=fs.mkdtempSync(path.join(os.homedir(),`codex-tui-ticket-acl-${process.pid}-`));
 const unsafeTemp=path.join(root,'shared-temp'),directory=path.join(root,'coordinator');
 const previousTemp=process.env.TEMP,previousTmp=process.env.TMP;
 try{
  fs.mkdirSync(unsafeTemp,{recursive:true});
  const aclScript=[
   "$ErrorActionPreference='Stop'",
   '$target=[Console]::In.ReadToEnd().Trim()',
   '$acl=[IO.Directory]::GetAccessControl($target)',
   '$acl.SetAccessRuleProtection($true,$false)',
   '$current=[Security.Principal.WindowsIdentity]::GetCurrent().User',
   "$full=New-Object Security.AccessControl.FileSystemAccessRule($current,[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)",
   '$acl.SetAccessRule($full)',
   "$sharedSid=New-Object Security.Principal.SecurityIdentifier('S-1-5-11')",
   "$shared=New-Object Security.AccessControl.FileSystemAccessRule($sharedSid,[Security.AccessControl.FileSystemRights]::Modify,[Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)",
   '$acl.AddAccessRule($shared)',
   '[IO.Directory]::SetAccessControl($target,$acl)',
  ].join(';');
  const acl=spawnSync(trustedWindowsHelper('powershell'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',aclScript],{
   input:unsafeTemp,encoding:'utf8',windowsHide:true,cwd:trustedWindowsRoot(),env:controllerEnvironment(),
  });
  assert.equal(acl.status,0,acl.stderr||acl.stdout);
  process.env.TEMP=unsafeTemp;process.env.TMP=unsafeTemp;
  let callbackCalls=0;
  assert.throws(
   ()=>transaction(directory,()=>{callbackCalls++;return {ok:true};}),
   /CONTROLLER_TICKET_ROOT_UNSAFE_ACL/,
   'a ticket root inherited from caller TEMP must be private before a helper can observe its markers',
  );
  assert.equal(callbackCalls,0,'an unsafe ticket root must stop before the transaction callback');
  assert.equal(fs.existsSync(path.join(directory,'leases.json')),false,'an unsafe ticket root must not create a lease ledger');
 }finally{
  if(previousTemp===undefined)delete process.env.TEMP;else process.env.TEMP=previousTemp;
  if(previousTmp===undefined)delete process.env.TMP;else process.env.TMP=previousTmp;
  fs.rmSync(root,{recursive:true,force:true,maxRetries:3,retryDelay:100});
 }
});

test('production transaction rejects a pre-existing junction at its deterministically derived ticket directory before helper handshake', {skip: process.platform !== 'win32'}, async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'codex-tui-transaction-ticket-reparse-'));
 const directory=path.join(root,'coordinator'),targetDirectory=path.join(root,'external-ticket-target'),sentinel=path.join(targetDirectory,'external-sentinel.txt');
 let ticketDirectory='';
 try{
  fs.mkdirSync(directory);fs.mkdirSync(targetDirectory);
  fs.writeFileSync(sentinel,'external sentinel','utf8');
  const physicalDir=physicalPathIdentity(directory);
  ticketDirectory=ticketDirectoryForTransactionPhysicalDir(physicalDir);
  assert.equal(fs.existsSync(ticketDirectory),false,'the unique production ticket directory must be absent before installing this fixture');
  fs.mkdirSync(path.dirname(ticketDirectory),{recursive:true});
  createJunction(targetDirectory,ticketDirectory);
  let callbackCalls=0;
  assert.throws(
   ()=>transaction(directory,()=>{callbackCalls++;return {ok:true};}),
   /coordinator ticket directory cannot contain a symbolic link, junction, or reparse point/i,
   'the real transaction must reject the derived ticket directory before starting a helper handshake',
  );
  assert.equal(callbackCalls,0,'pre-handshake ticket-directory rejection must not invoke the transaction callback');
  assert.deepEqual(fs.readdirSync(targetDirectory).sort(),['external-sentinel.txt'],'the pre-existing ticket junction must leave the external target free of handshake markers');
  await withTemporaryLeasesMutation('ticket directory reparse guard',source=>replaceExactlyOnce(
   source,
   "assertNoReparsePoints(ticketDir,'coordinator ticket directory');",
   'void ticketDir;',
   'ticket directory reparse guard',
  ),async({transaction:mutatedTransaction})=>{
   let mutationError,mutatedCallbackCalls=0;
   try{mutatedTransaction(directory,()=>{mutatedCallbackCalls++;return {ok:true};});}catch(error){mutationError=error;}
   assert.ok(mutationError,'the generated mutant must still be stopped by the independent private-ticket-root guard');
   assert.match(mutationError.message,/CONTROLLER_TICKET_ROOT_UNSAFE_ACL/,'the mutant must proceed past the ticket-directory boundary to the private ticket-root guard');
   assert.equal(mutatedCallbackCalls,0,'the temporary mutant must not reach the transaction callback through the independent private-root guard');
   assert.throws(
    ()=>assert.match(mutationError.message,/coordinator ticket directory cannot contain a symbolic link, junction, or reparse point/i),
    /coordinator ticket directory/,
    'the normal transaction-boundary oracle must fail against a temporary source copy that removes its ticket-directory reparse check',
   );
  });
  assert.deepEqual(fs.readdirSync(targetDirectory).sort(),['external-sentinel.txt'],'the temporary source-copy mutation must also leave the external target untouched');
 }finally{
  if(ticketDirectory&&fs.existsSync(ticketDirectory)){
   assert.equal(fs.lstatSync(ticketDirectory).isSymbolicLink(),true,'the fixture ticket path must remain a junction until explicitly removed');
   assertWindowsReparsePoint(ticketDirectory);
   fs.rmdirSync(ticketDirectory);
  }
  assert.equal(fs.existsSync(targetDirectory),true,'removing the ticket junction must not remove its external target');
  await removeFixture(root);
 }
});

test('a ready timeout does not write a release marker after the helper lacks a handshake', {skip: process.platform !== 'win32'}, async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'codex-tui-ready-timeout-'));
 const held=path.join(dir,'holder-ready'),releaseHolder=path.join(dir,'release-holder');
 let holder;
 const originalTimeout=process.env.ORCH_COORDINATOR_TIMEOUT_MS,originalWrite=fs.writeFileSync,releaseWrites=[];
 try{
  const holderCommand=`$ErrorActionPreference='Stop';$mutex=[Threading.Mutex]::new($false,${powershellQuote(leaseMutexName(dir))});$locked=$false;try{$locked=$mutex.WaitOne(0);if(-not $locked){throw 'test holder could not acquire mutex'};[IO.File]::WriteAllText(${powershellQuote(held)},'held',[Text.UTF8Encoding]::new($false));$deadline=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()+120000;while(-not [IO.File]::Exists(${powershellQuote(releaseHolder)}) -and [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -lt $deadline){Start-Sleep -Milliseconds 10}}finally{if($locked){$mutex.ReleaseMutex()};$mutex.Dispose()}`;
  holder=spawn(trustedWindowsHelper('powershell'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',holderCommand],{windowsHide:true,stdio:'ignore',cwd:trustedWindowsRoot(),env:controllerEnvironment()});
  await waitFor(()=>fs.existsSync(held),{detail:'test holder did not acquire the named mutex'});
  process.env.ORCH_COORDINATOR_TIMEOUT_MS='1000';
  fs.writeFileSync=(file,...args)=>{
   if(String(file).endsWith('.release')){releaseWrites.push(String(file));const error=new Error('unexpected ready-timeout release');error.code='EACCES';throw error;}
   return originalWrite(file,...args);
  };
  assert.throws(()=>transaction(dir,()=>({ok:true})),error=>error?.code==='ORCH_COORDINATOR_MUTEX_ACQUISITION_FAILED');
  assert.deepEqual(releaseWrites,[],'without a ready nonce, Node must leave release ownership and must not create a late .release marker');
 }finally{
  fs.writeFileSync=originalWrite;
  if(originalTimeout===undefined)delete process.env.ORCH_COORDINATOR_TIMEOUT_MS;else process.env.ORCH_COORDINATOR_TIMEOUT_MS=originalTimeout;
  try{fs.writeFileSync(releaseHolder,'release');}catch{}
  if(holder?.exitCode===null){try{await waitForExit(holder,2000);}catch{holder.kill();}}
  fs.rmSync(dir,{recursive:true,force:true});
 }
});
test('the contender probe rejects a receipt visible before mutex release', {skip: process.platform !== 'win32'}, async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'codex-tui-release-before-unlock-'));
 const ticket=path.join(dir,'ticket'),acquired=path.join(dir,'second-contender-acquired');
 let holder;
 try{
  const holderCommand=`$ErrorActionPreference='Stop';$mutex=[Threading.Mutex]::new($false,${powershellQuote(leaseMutexName(dir))});$held=$false;try{$held=$mutex.WaitOne(0);if(-not $held){throw 'test holder could not acquire mutex'};[IO.File]::WriteAllText(${powershellQuote(ticket+'.released')},'released:pre-release',[Text.UTF8Encoding]::new($false));Start-Sleep -Milliseconds 1000}finally{if($held){$mutex.ReleaseMutex()};$mutex.Dispose()}`;
  holder=spawn(trustedWindowsHelper('powershell'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',holderCommand],{windowsHide:true,stdio:'ignore',cwd:trustedWindowsRoot(),env:controllerEnvironment()});
  await waitFor(()=>fs.existsSync(ticket+'.released'),{detail:'the pre-release holder did not make its receipt visible'});
  const result=runNamedMutexContender(dir,acquired,150);
  assert.equal(result.status,1,result.stderr||'a contender must reject a receipt that becomes visible before ReleaseMutex');
  assert.equal(fs.existsSync(acquired),false,'a pre-release receipt must not let the second contender acquire the mutex');
  assert.equal(await waitForExit(holder,2000),0);
 }finally{await removeFixture(dir,holder);}
});

test('the production transaction releases its helper mutex before its exact receipt acknowledgement link', {skip: process.platform !== 'win32'}, async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'codex-tui-transaction-receipt-order-'));
 const readyFile=path.join(dir,'receipt-monitor-ready'),reportFile=path.join(dir,'receipt-monitor-report.json');
 const originalLink=fs.linkSync,recordId='receipt-order-'+crypto.randomUUID();
 let monitor,ticketDirectory='',physicalDir='',linkObservation;
 try{
  fs.linkSync=(receipt,acknowledgement,...args)=>{
   const receiptPath=String(receipt),acknowledgementPath=String(acknowledgement);
   const expectedAcknowledgement=receiptPath.endsWith('.released')?receiptPath.slice(0,-'.released'.length)+'.ack':'';
   const belongsToThisProductionAttempt=ticketDirectory!==''&&
    path.resolve(path.dirname(receiptPath)).toLowerCase()===path.resolve(ticketDirectory).toLowerCase()&&
    /^lock-[0-9a-f-]+\.released$/i.test(path.basename(receiptPath))&&
    acknowledgementPath===expectedAcknowledgement;
   if(!linkObservation&&belongsToThisProductionAttempt){
    // Do not proceed into Node's acknowledgement link until the independently
    // running monitor has seen this exact receipt and attempted the same
    // named mutex. This hook exists only in the test process.
    const report=readJsonSynchronously(reportFile,{timeoutMs:5000,detail:'the external mutex monitor did not report before the production acknowledgement link'});
    linkObservation={receipt:receiptPath,acknowledgement:acknowledgementPath,report,reportReadBeforeLink:true,linkInvokedAt:Date.now()};
    return originalLink(receipt,acknowledgement,...args);
   }
   return originalLink(receipt,acknowledgement,...args);
  };
  const result=transaction(dir,(leases,owner,_processes,_observation,transactionPhysicalDir)=>{
   physicalDir=transactionPhysicalDir;
   ticketDirectory=ticketDirectoryForTransactionPhysicalDir(transactionPhysicalDir);
   assert.equal(fs.existsSync(ticketDirectory),true,'the production helper must create the ticket directory derived from its actual physical coordinator path');
   monitor=spawnTransactionReceiptMutexMonitor({physicalDir:transactionPhysicalDir,ticketDirectory,readyFile,reportFile});
   waitForFileSynchronously(readyFile,{detail:'the external production-path receipt monitor did not become ready while the helper held its mutex'});
   leases.push({id:recordId,keys:[],owner});
   return {ok:true};
  });
  assert.deepEqual(result,{ok:true},'the production callback must retain its ordinary committed result');
  assert.ok(physicalDir&&ticketDirectory,'the callback must receive and use the production physical directory identity');
  assert.ok(linkObservation,'the test-local link pause must observe the unique production receipt-to-acknowledgement link');
  assert.equal(linkObservation.reportReadBeforeLink,true,'the external monitor report must be read before Node proceeds with the acknowledgement link');
  assert.equal(linkObservation.report.seen,true,'the external monitor must see the actual production receipt');
  assert.equal(path.resolve(linkObservation.report.receipt).toLowerCase(),path.resolve(linkObservation.receipt).toLowerCase(),'the monitor must report the same receipt that Node acknowledges');
  assert.equal(linkObservation.report.mutex,leaseMutexName(physicalDir),'the monitor must calculate the helper-identical named mutex from the actual physical coordinator path');
  assert.equal(linkObservation.report.acquired,true,'the external monitor must acquire the helper-identical mutex before Node proceeds with the acknowledgement link');
  assert.equal(await waitForExit(monitor,2000),0,'the monitor must exit after releasing its observed mutex acquisition');
  const ticket=linkObservation.receipt.slice(0,-'.released'.length);
  await waitFor(()=>ownedAttemptMarkerSuffixes.every(suffix=>!fs.existsSync(ticket+suffix)),{timeoutMs:3000,detail:'the helper did not clean its production transaction handshake markers after the acknowledged receipt'});
  assertOwnedAttemptMarkers(ticket,false,'production transaction acknowledgement cleanup');
  const persisted=JSON.parse(fs.readFileSync(path.join(dir,'leases.json'),'utf8'));
  assert.equal(persisted.filter(lease=>lease.id===recordId).length,1,'the production transaction must durably commit exactly one ledger row while proving receipt order');
 }finally{
  fs.linkSync=originalLink;
  await stopFixtureChild(monitor);
  if(ticketDirectory){
   const deadline=Date.now()+6000;
   let leftovers=[];
   while(Date.now()<deadline){
    try{
     leftovers=fs.existsSync(ticketDirectory)?fs.readdirSync(ticketDirectory).filter(name=>/^lock-[0-9a-f-]+\.(?:ready|release|released|ack)$/i.test(name)):[];
     if(leftovers.length===0)break;
    }catch{}
    await pause(25);
   }
   assert.deepEqual(leftovers,[],'the isolated production ticket directory must contain no retained handshake markers before it is removed');
   try{fs.rmSync(ticketDirectory,{recursive:true,force:true});}catch{}
  }
  await removeFixture(dir);
 }
});

test('a production transaction accepts a successful receipt acknowledgement after normal helper cleanup', {skip: process.platform !== 'win32'}, async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'codex-tui-transaction-ack-cleanup-'));
 const originalLink=fs.linkSync,recordId='receipt-cleanup-'+crypto.randomUUID(),warnings=[];
 const onWarning=warning=>{if(warning?.code==='ORCH_COORDINATOR_RELEASE_ACK_SIGNAL_FAILED')warnings.push({code:warning.code,message:warning.message});};
 let ticketDirectory='',linkObservation;
 try{
  process.on('warning',onWarning);
  fs.linkSync=(receipt,acknowledgement,...args)=>{
   const receiptPath=String(receipt),acknowledgementPath=String(acknowledgement);
   const expectedAcknowledgement=receiptPath.endsWith('.released')?receiptPath.slice(0,-'.released'.length)+'.ack':'';
   const belongsToThisProductionAttempt=ticketDirectory!==''&&
    path.resolve(path.dirname(receiptPath)).toLowerCase()===path.resolve(ticketDirectory).toLowerCase()&&
    /^lock-[0-9a-f-]+\.released$/i.test(path.basename(receiptPath))&&
    acknowledgementPath===expectedAcknowledgement;
   if(!linkObservation&&belongsToThisProductionAttempt){
    const linked=originalLink(receipt,acknowledgement,...args);
    const ticket=receiptPath.slice(0,-'.released'.length);
    // The real helper observes the true hard-link acknowledgement and owns all
    // marker cleanup. Hold only this test-local return edge until that normal
    // cleanup has happened, then let transaction execute its post-link path.
    waitForAttemptMarkerCleanupSynchronously(ticket,{detail:'the real helper did not clean a successful production acknowledgement before post-link control resumed'});
    linkObservation={receipt:receiptPath,acknowledgement:acknowledgementPath,cleanupBeforePostLink:true};
    return linked;
   }
   return originalLink(receipt,acknowledgement,...args);
  };
  const result=transaction(dir,(leases,owner,_processes,_observation,physicalDir)=>{
   ticketDirectory=ticketDirectoryForTransactionPhysicalDir(physicalDir);
   assert.equal(fs.existsSync(ticketDirectory),true,'the default production branch must derive and create its own ticket directory');
   leases.push({id:recordId,keys:[],owner});
   return {ok:true};
  });
  assert.deepEqual(result,{ok:true},'a completed transaction must retain its committed callback result');
  assert.ok(linkObservation?.cleanupBeforePostLink,'the test must exercise a successful production hardlink followed by actual helper cleanup');
  const persisted=JSON.parse(fs.readFileSync(path.join(dir,'leases.json'),'utf8'));
  assert.equal(persisted.filter(lease=>lease.id===recordId).length,1,'the committed ledger row must remain durable when cleanup wins the post-link race');
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(warnings,[],'a successful hardlink is a completed acknowledgement and must not become a committed release warning merely because helper cleanup won the subsequent path read');
 }finally{
  fs.linkSync=originalLink;
  process.off('warning',onWarning);
  if(ticketDirectory){try{fs.rmSync(ticketDirectory,{recursive:true,force:true});}catch{}}
  await removeFixture(dir);
 }
});

test('the actual helper releases its mutex to an immediate contender before its receipt publication gate opens', {skip: process.platform !== 'win32'}, async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'codex-tui-release-order-'));
 const ticket=path.join(dir,'ticket'),nonce='nonce-'+crypto.randomBytes(18).toString('base64url'),publicationBarrier=path.join(dir,'allow-receipt-publication'),cleanupBarrier=path.join(dir,'allow-ack-cleanup'),acquired=path.join(dir,'immediate-contender');
 let helper,contender;
 try{
  helper=spawnLeaseHelper({directory:dir,ticket,nonce,receiptPublicationBarrier:publicationBarrier,receiptCleanupBarrier:cleanupBarrier});
  await waitFor(()=>fs.existsSync(ticket+'.ready'),{detail:'helper did not publish its ready nonce'});
  await waitFor(()=>{
   try{return fs.readFileSync(ticket+'.ready','utf8').trim()===`ready:${nonce}`;}catch{return false;}
  },{detail:'helper did not finish its exclusive ready publication'});
  contender=spawnImmediateMutexContender(dir,acquired);
  await pause(100);
  assert.equal(fs.existsSync(acquired),false,'the immediate contender must remain blocked while the actual helper owns the mutex');
  fs.writeFileSync(ticket+'.release',`release:${nonce}`,{flag:'wx'});
  await waitFor(()=>fs.existsSync(acquired),{detail:'the immediate contender did not acquire after the helper accepted release'});
  assert.match(fs.readFileSync(acquired,'utf8'),/^acquired:\d+$/,'the actual contender must report a real named-mutex acquisition');
  assert.equal(fs.existsSync(ticket+'.released'),false,'the helper must not publish its receipt while the controlled post-unlock gate remains closed');
  const transactionSource=fs.readFileSync(fileURLToPath(new URL('../scripts/core/leases.mjs',import.meta.url)),'utf8');
  assert.equal(transactionSource.includes('ReceiptPublicationBarrier'),false,'production transaction must not accept or forward the fixture-only receipt publication gate');
  fs.writeFileSync(publicationBarrier,'continue');
  assert.equal(waitForCoordinatorReleaseAcknowledgement(ticket,nonce,{timeoutMs:2000}),true,'the receipt must become visible after the real immediate contender acquired the released mutex');
  fs.linkSync(ticket+'.released',ticket+'.ack');
  assert.equal(coordinatorReleaseAcknowledgementMatches(ticket,nonce),true,'the acknowledgement must remain a bound view of the verified receipt before helper cleanup');
  fs.writeFileSync(cleanupBarrier,'continue');
  assert.equal(await waitForExit(contender),0,'the immediate contender must exit after releasing its observed mutex acquisition');
  assert.equal(await waitForExit(helper),0);
  for(const suffix of ['.ready','.release','.released','.ack'])assert.equal(fs.existsSync(ticket+suffix),false,`helper must clean ${suffix} after acknowledgement`);
 }finally{
  try{fs.writeFileSync(publicationBarrier,'continue');}catch{}
  try{fs.writeFileSync(cleanupBarrier,'continue');}catch{}
  await stopFixtureChild(contender);
  await removeFixture(dir,helper);
 }
});
test('ordinary safe-parent helper completion removes every owned attempt marker', {skip: process.platform !== 'win32'}, async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'codex-tui-ordinary-cleanup-'));
 const ticket=path.join(dir,'ticket'),nonce='nonce-'+crypto.randomBytes(18).toString('base64url'),cleanupBarrier=path.join(dir,'allow-ordinary-cleanup');
 let helper;
 try{
  helper=spawnLeaseHelper({directory:dir,ticket,nonce,waitMs:2000,receiptAckWaitMs:1000,receiptCleanupBarrier:cleanupBarrier});
  await waitFor(()=>{
   try{return fs.readFileSync(ticket+'.ready','utf8').trim()===`ready:${nonce}`;}catch{return false;}
  },{detail:'helper did not publish a ready nonce in an ordinary safe parent'});
  fs.writeFileSync(ticket+'.release',`release:${nonce}`,{flag:'wx'});
  assert.equal(waitForCoordinatorReleaseAcknowledgement(ticket,nonce,{timeoutMs:2000}),true,'the helper did not publish its post-release receipt in an ordinary safe parent');
  fs.linkSync(ticket+'.released',ticket+'.ack');
  assert.equal(coordinatorReleaseAcknowledgementMatches(ticket,nonce),true,'the ordinary safe-parent acknowledgement must be the receipt hard link');
  // The barrier preserves the completed safe-parent state long enough to
  // observe every marker that this helper owns. Removing any suffix from the
  // helper cleanup list leaves that observed marker behind and fails below.
  assertOwnedAttemptMarkers(ticket,true,'ordinary safe-parent completion before helper cleanup');
  fs.writeFileSync(cleanupBarrier,'continue');
  assert.equal(await waitForExit(helper,HELPER_CLEANUP_TIMEOUT_MS),0,'the ordinary safe-parent helper must complete after its receipt acknowledgement');
  assertOwnedAttemptMarkers(ticket,false,'ordinary safe-parent completion after helper cleanup');
 }finally{try{fs.writeFileSync(cleanupBarrier,'continue');}catch{};await removeFixture(dir,helper);}
});
test('the helper rejects a same-content ordinary acknowledgement until it becomes the receipt hardlink', {skip: process.platform !== 'win32'}, async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'codex-tui-ordinary-ack-'));
 const ticket=path.join(dir,'ticket'),nonce='nonce-'+crypto.randomBytes(18).toString('base64url'),cleanupBarrier=path.join(dir,'allow-ack-check');
 let helper;
 try{
  helper=spawnLeaseHelper({directory:dir,ticket,nonce,waitMs:2000,receiptAckWaitMs:5000,receiptCleanupBarrier:cleanupBarrier});
  await waitFor(()=>fs.existsSync(ticket+'.ready'),{detail:'helper did not publish its ready nonce'});
  fs.writeFileSync(ticket+'.release',`release:${nonce}`,{flag:'wx'});
  assert.equal(waitForCoordinatorReleaseAcknowledgement(ticket,nonce,{timeoutMs:2000}),true,'helper did not publish receipt after releasing the mutex');
  fs.writeFileSync(ticket+'.ack',`released:${nonce}`,{flag:'wx'});
  fs.writeFileSync(cleanupBarrier,'continue');
  await pause(150);
  assert.equal(helper.exitCode,null,'a regular same-content ack must not be treated as a receipt-bound acknowledgement');
  fs.rmSync(ticket+'.ack',{force:true});
  fs.linkSync(ticket+'.released',ticket+'.ack');
  assert.equal(await waitForExit(helper,2000),0,'the helper must accept the true receipt hardlink');
  for(const suffix of ['.ready','.release','.released','.ack'])assert.equal(fs.existsSync(ticket+suffix),false,`helper must clean ${suffix} after a true hardlink acknowledgement`);
 }finally{try{fs.writeFileSync(cleanupBarrier,'continue');}catch{};await removeFixture(dir,helper);}
});

test('a late valid release receipt is self-cleaned when the parent already timed out', {skip: process.platform !== 'win32'}, async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'codex-tui-release-late-'));
 const ticket=path.join(dir,'ticket'),nonce='nonce-'+crypto.randomBytes(18).toString('base64url');
 let helper;
 try{
  helper=spawnLeaseHelper({directory:dir,ticket,nonce,waitMs:1500,receiptAckWaitMs:150});
  await waitFor(()=>fs.existsSync(ticket+'.ready'),{detail:'helper did not publish its ready nonce'});
  assert.equal(waitForCoordinatorReleaseAcknowledgement(ticket,nonce,{timeoutMs:25}),false,'the simulated parent must time out before the late release signal');
  await pause(50);
  fs.writeFileSync(ticket+'.release',`release:${nonce}`,{flag:'wx'});
  assert.equal(waitForCoordinatorReleaseAcknowledgement(ticket,nonce,{timeoutMs:1000}),true,'the helper must eventually publish the late receipt after ReleaseMutex');
  // A timed-out parent does not write an ack and must not reclaim the receipt.
  assert.equal(await waitForExit(helper),0);
  assert.throws(()=>fs.linkSync(ticket+'.released',ticket+'.ack'),{code:'ENOENT'},'once helper cleanup wins, a delayed parent cannot create a fresh acknowledgement marker');
  for(const suffix of ['.ready','.release','.released','.ack'])assert.equal(fs.existsSync(ticket+suffix),false,`late helper cleanup must remove ${suffix} without Node cleanup ownership`);
 }finally{await removeFixture(dir,helper);}
});

test('the helper refuses a mismatched release signal and still performs bounded cleanup', {skip: process.platform !== 'win32'}, async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'codex-tui-release-mismatch-'));
 const ticket=path.join(dir,'ticket'),nonce='nonce-'+crypto.randomBytes(18).toString('base64url');
 let helper;
 try{
  helper=spawnLeaseHelper({directory:dir,ticket,nonce,waitMs:1000,receiptAckWaitMs:150});
  await waitFor(()=>fs.existsSync(ticket+'.ready'),{detail:'helper did not publish its ready nonce'});
  fs.writeFileSync(ticket+'.release','release:foreign-attempt',{flag:'wx'});
  assert.equal(waitForCoordinatorReleaseAcknowledgement(ticket,nonce,{timeoutMs:200}),false,'a foreign release signal must never authorize a receipt for this nonce');
  assert.equal(await waitForExit(helper,2000),0,'the helper must eventually release its mutex instead of waiting forever on a malformed signal');
  for(const suffix of ['.ready','.release','.released','.ack'])assert.equal(fs.existsSync(ticket+suffix),false,`bounded cleanup must remove ${suffix} after rejecting a foreign signal`);
 }finally{await removeFixture(dir,helper);}
});

test('a post-commit release signal write failure warns without turning durable work into a retryable error', {skip: process.platform !== 'win32'}, async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'codex-tui-release-write-failure-'));
 const originalWrite=fs.writeFileSync,originalTimeout=process.env.ORCH_COORDINATOR_TIMEOUT_MS;
 const warnings=[];
 const onWarning=warning=>{if(warning?.code==='ORCH_COORDINATOR_RELEASE_SIGNAL_FAILED')warnings.push(warning);};
 process.on('warning',onWarning);
 // This test injects a post-commit release-write fault; it needs a normal
 // helper handshake first, including the cold PowerShell security setup.
 process.env.ORCH_COORDINATOR_TIMEOUT_MS=String(HELPER_STARTUP_TIMEOUT_MS);
 try{
  fs.writeFileSync=(file,...args)=>{
   if(String(file).endsWith('.release')){const error=new Error('injected release write denial');error.code='EACCES';throw error;}
   return originalWrite(file,...args);
  };
  const result=transaction(dir,(leases,owner)=>{leases.push({id:'durably-committed',keys:[],owner});return {ok:true};});
  assert.deepEqual(result,{ok:true},'a committed ledger mutation must retain its ordinary result instead of inviting an automatic retry');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'leases.json'),'utf8'))[0].id,'durably-committed');
  await waitFor(()=>warnings.length===1,{timeoutMs:1500,detail:'committed release signal fault was not surfaced as a typed warning'});
  assert.match(warnings[0].message,/committed/i);
 }finally{
  fs.writeFileSync=originalWrite;
  if(originalTimeout===undefined)delete process.env.ORCH_COORDINATOR_TIMEOUT_MS;else process.env.ORCH_COORDINATOR_TIMEOUT_MS=originalTimeout;
  process.off('warning',onWarning);
  fs.rmSync(dir,{recursive:true,force:true});
 }
});

for(const errorCode of ['EACCES','EPERM','ENOENT']){
 test(`a committed transaction preserves its ledger and emits a typed acknowledgement warning for ${errorCode}`, {skip: process.platform !== 'win32'}, async()=>{
  const scenario=await runCommittedAcknowledgementLinkFault({errorCode,label:errorCode.toLowerCase()});
  assertCommittedAcknowledgementLinkFault(scenario,errorCode);
 });
}

test('mutation sensitivity: the committed acknowledgement-fault oracle detects a temporary source copy that drops its warning', {skip: process.platform !== 'win32'}, async()=>{
 await withTemporaryLeasesMutation('committed acknowledgement warning',source=>replaceExactlyOnce(
  source,
  'if(committed)committedCoordinatorReleaseWarning(outcome.error);',
  'if(committed){}',
  'committed acknowledgement warning',
 ),async({transaction:mutatedTransaction})=>{
  const scenario=await runCommittedAcknowledgementLinkFault({
   transactionImpl:mutatedTransaction,
   errorCode:'EACCES',
   label:'warning-mutation',
   expectWarning:false,
  });
  assert.throws(
   ()=>assertCommittedAcknowledgementLinkFault(scenario,'EACCES'),
   /committed acknowledgement failure must emit exactly one typed warning/,
   'the normal committed-fault oracle must fail when a generated source copy suppresses the post-commit warning',
  );
 });
});

test('a foreign acknowledgement collision is neither overwritten nor accepted before helper-owned cleanup removes it', {skip: process.platform !== 'win32'}, async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'codex-tui-release-ack-exists-'));
 const originalLink=fs.linkSync,originalTimeout=process.env.ORCH_COORDINATOR_TIMEOUT_MS;
 const warnings=[];
 const onWarning=warning=>{if(warning?.code==='ORCH_COORDINATOR_RELEASE_ACK_SIGNAL_FAILED')warnings.push(warning);};
 process.on('warning',onWarning);
 process.env.ORCH_COORDINATOR_TIMEOUT_MS='5000';
 const foreignAck=`foreign acknowledgement ${crypto.randomBytes(18).toString('base64url')}`;
 let receiptPath='',acknowledgementPath='';
 try{
  fs.linkSync=(receipt,acknowledgement,...args)=>{
   if(String(acknowledgement).endsWith('.ack')){
    receiptPath=String(receipt);
    acknowledgementPath=String(acknowledgement);
    fs.writeFileSync(acknowledgementPath,foreignAck,{encoding:'utf8',flag:'wx'});
    return originalLink(receipt,acknowledgement,...args);
   }
   return originalLink(receipt,acknowledgement,...args);
  };
  const result=transaction(dir,(leases,owner)=>{leases.push({id:'ack-race-committed',keys:[],owner});return {ok:true};});
  assert.deepEqual(result,{ok:true},'a committed ledger mutation must not be retried for acknowledgement link collisions');
  assert.ok(receiptPath&&acknowledgementPath,'the test must exercise the receipt acknowledgement path with a real marker conflict');
  assert.equal(fs.existsSync(acknowledgementPath),true,'before helper-owned bounded cleanup, Node must leave the extant foreign acknowledgement marker in place');
  assert.equal(fs.readFileSync(acknowledgementPath,'utf8'),foreignAck,'before helper-owned bounded cleanup, Node must not overwrite or replace the foreign acknowledgement marker after EEXIST');
  assert.equal(fs.statSync(acknowledgementPath).nlink,1,'before helper-owned bounded cleanup, the foreign acknowledgement must remain standalone rather than becoming the receipt hard link');
  const nonce=fs.readFileSync(receiptPath,'utf8').trim().slice('released:'.length);
  assert.equal(coordinatorReleaseAcknowledgementMatches(receiptPath.slice(0,-'.released'.length),nonce),false,'before helper-owned bounded cleanup, Node must not accept the foreign acknowledgement as receipt-bound');
  await waitFor(()=>warnings.length===1,{timeoutMs:1500,detail:'an acknowledgement link collision must remain visible as a typed release fault'});
  assert.match(warnings[0].message,/committed/i);
  await waitFor(()=>!fs.existsSync(acknowledgementPath),{timeoutMs:7000,detail:'helper-owned bounded cleanup did not later remove the rejected foreign acknowledgement marker'});
  assert.equal(fs.existsSync(acknowledgementPath),false,'later helper-owned bounded cleanup is expected to remove the rejected foreign acknowledgement marker');
 }finally{
  fs.linkSync=originalLink;
  if(originalTimeout===undefined)delete process.env.ORCH_COORDINATOR_TIMEOUT_MS;else process.env.ORCH_COORDINATOR_TIMEOUT_MS=originalTimeout;
  process.off('warning',onWarning);
  fs.rmSync(dir,{recursive:true,force:true});
 }
});
test('nonce-bound release receipt becomes observable before a child exit event can be delivered',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'codex-tui-release-ack-'));
 const ticket=path.join(dir,'ticket'),nonce='nonce-'+Date.now().toString(36);
 const child=spawn(process.execPath,['-e',`require('node:fs').writeFileSync(${JSON.stringify(ticket+'.released')},${JSON.stringify('released:'+nonce)})`],{windowsHide:true,stdio:'ignore'});
 try{
  assert.equal(waitForCoordinatorReleaseAcknowledgement(ticket,nonce,{timeoutMs:1000}),true,'the nonce-bound release receipt must become observable synchronously without child.exitCode');
  assert.equal(child.exitCode,null,'the main thread cannot rely on an exit callback while it was synchronously polling the receipt');
  await once(child,'exit');
  fs.writeFileSync(ticket+'.released','released:wrong-nonce');
  assert.equal(coordinatorReleaseMarkerMatches(ticket,nonce),false,'a receipt for another attempt must not unlock this nonce');
 }finally{
  if(child.exitCode===null)await once(child,'exit');
  fs.rmSync(dir,{recursive:true,force:true});
 }
});

test('coordinator lease lock works under RemoteSigned without a signed script', {skip: process.platform !== 'win32'}, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-tui-lease-policy-'));
  try {
    assert.equal(transaction(dir, leases => ({count: leases.length})).count, 0);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
