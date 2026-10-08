import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import * as leases from '../scripts/core/leases.mjs';
import {claimRun,coordinatorDir,processSnapshot,reserve,transaction} from '../scripts/core/leases.mjs';
import {controllerStateDir} from '../scripts/core/controller-state.mjs';
import {controllerWindowsDir} from '../scripts/core/controller-state.mjs';
const family=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../temp');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const missingProcessIdentity={ProcessId:987654321,Started:'2020-01-01T00:00:00.000Z',Name:'powershell.exe',CommandLine:'powershell.exe -File stale.ps1'};
function assertCoordinatorSnapshotCache(dir){
 const cache=path.join(dir,'process-snapshot-cache.json');
 let firstFresh,secondFresh;
 transaction(dir,(_leases,_owner,_processes,observation)=>{firstFresh=observation?.fresh;});
 assert.equal(firstFresh,true,'first cache observation must publish a complete snapshot');
 const first=fs.readFileSync(cache,'utf8');
 const parsed=JSON.parse(first);
 assert.equal(parsed.schema,1);
 assert.ok(Array.isArray(parsed.processes)&&parsed.processes.length>0,'published cache must be readable by Node');
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
   if(calls===1)processes.set(stale.owner.ProcessId,stale.owner);
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
  const live={ProcessId:987654321,Started:'2026-10-09T00:00:00.000Z',Name:'node.exe',CommandLine:'node controller.mjs'};
  fs.writeFileSync(path.join(dir,'run-owners.json'),JSON.stringify({same:{owner:live,token:'live-token'}}));
  let calls=0;
  const snapshot=()=>({processes:new Map([[process.pid,{ProcessId:process.pid,Started:'current',Name:process.execPath,CommandLine:process.argv.join(' ')}],[live.ProcessId,live]]),fresh:++calls>1});
  assert.throws(()=>claimRun(dir,'same',snapshot),/Run already has a live controller/);
  assert.equal(calls,2,'a positive advisory owner must be confirmed by one fresh recheck');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'run-owners.json'),'utf8')).same.token,'live-token');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
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
   if(calls===1)return {processes:new Map([[process.pid,{ProcessId:process.pid,Started:'current',Name:process.execPath,CommandLine:process.argv.join(' ')}]]),fresh:false};
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
   return {processes:new Map([[process.pid,{ProcessId:process.pid,Started:'current',Name:process.execPath,CommandLine:process.argv.join(' ')}]]),fresh:calls===2};
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
  const current=processSnapshot().get(process.pid);
  const createdAt=Date.now()-1000;
  const oldOwner={...missingProcessIdentity,ParentProcessId:1,WorkingSet64:1,PeakWorkingSet64:1};
  fs.writeFileSync(path.join(dir,'process-snapshot-cache.json'),JSON.stringify({schema:1,createdAt,processes:[{...current,ParentProcessId:current.ParentProcessId||1,WorkingSet64:current.WorkingSet64||1,PeakWorkingSet64:current.PeakWorkingSet64||1},oldOwner]}));
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
  assert.equal(repaired.schema,1);
  assert.ok(Array.isArray(repaired.processes)&&repaired.processes.length>0);
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
  const original={schema:1,createdAt:Date.now(),processes:[{...missingProcessIdentity,ParentProcessId:1,WorkingSet64:1,PeakWorkingSet64:1}]};
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
  const expected=processSnapshot().get(process.pid),cache=path.join(dir,'process-snapshot-cache.json');
  const stale={...expected,Started:new Date(Date.parse(expected.Started)+1000).toISOString()};
  fs.writeFileSync(cache,JSON.stringify({schema:1,createdAt:Date.now(),processes:[{...stale,ParentProcessId:1,WorkingSet64:1,PeakWorkingSet64:1}]}));
  const first=claimRun(dir,'protected-run');
  for(const key of ['ProcessId','Started','Name','CommandLine'])assert.equal(first.owner[key],expected[key],`cache PID matches must use the caller live ${key}`);
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
for(const [parents,capacity] of [[9,8],[12,4],[40,16]])test(`${parents} independent parent processes contend for ${capacity} shared slots without lost updates`,async t=>{
 fs.mkdirSync(family,{recursive:true});const dir=fs.mkdtempSync(path.join(family,'cross-process-'));
 const module=new URL('../scripts/core/leases.mjs',import.meta.url).href;
 const worker=path.join(dir,'worker.mjs');
 fs.writeFileSync(worker,`import fs from 'node:fs';import path from 'node:path';import {reserve,release,transaction} from ${JSON.stringify(module)};
 const dir=process.argv[2],id=process.argv[3];
 try{const result=${parents===40?`transaction(dir,(leases,owner,_processes,observation)=>{
 const result=leases.some(l=>l.id===id)?{ok:false,reason:'existing reservation'}:leases.length>=${capacity}?{ok:false,reason:'capacity'}:leases.some(l=>l.keys.some(k=>k==='test:'+id))?{ok:false,reason:'conflict'}:(leases.push({id,runId:id,keys:['test:'+id],owner,capacity:${capacity},reservedAt:Date.now()}),{ok:true});
 return {...result,fresh:observation?.fresh};
})`:`reserve(dir,{id,runId:id,keys:['test:'+id]},${capacity})`};fs.writeFileSync(path.join(dir,id+'.json'),JSON.stringify(result));
 while(!fs.existsSync(path.join(dir,'release')))await new Promise(r=>setTimeout(r,50));
 if(result.ok)release(dir,id);
 }catch(e){fs.writeFileSync(path.join(dir,id+'.json'),JSON.stringify({error:e.message}));process.exitCode=1;}`);
 const children=Array.from({length:parents},(_,i)=>spawn(process.execPath,[worker,dir,'run'+i],{windowsHide:true,stdio:'ignore'}));
 const exits=children.map(c=>new Promise(resolve=>{c.once('exit',resolve);c.once('error',()=>resolve(-1));}));
 try{
  // A burst of independent Windows processes serializes CIM identity
  // snapshots behind the named mutex. The production bound is 120s, so the
  // acceptance window must cover that bound instead of failing while valid
  // contenders are still waiting in the bounded queue.
  const deadline=Date.now()+180000;
  let results;
  while(Date.now()<deadline){
   try{
    results=children.map((_,i)=>JSON.parse(fs.readFileSync(path.join(dir,'run'+i+'.json'),'utf8')));
    break;
   }catch(error){
    if(!['ENOENT','EACCES','EPERM'].includes(error?.code) && !(error instanceof SyntaxError))throw error;
    await pause(100);
   }
  }
  assert.ok(results,'bounded wait for every child result expired');
  assert.equal(results.filter(r=>r.ok).length,capacity,JSON.stringify(results));
  assert.equal(results.filter(r=>r.reason==='capacity').length,parents-capacity,JSON.stringify(results));
  if(parents===40){const freshCount=results.filter(r=>r.fresh===true).length;t.diagnostic(`full process enumerations in 40-process burst: ${freshCount}`);assert.equal(freshCount,1,'40-process burst must share one full process enumeration');}
  const leases=JSON.parse(fs.readFileSync(path.join(dir,'leases.json'),'utf8'));
  assert.equal(new Set(leases.map(l=>l.runId)).size,capacity);
 }finally{
  fs.writeFileSync(path.join(dir,'release'),'release');
  await Promise.all(exits);
  await pause(500);
  fs.rmSync(dir,{recursive:true,force:true});
 }
});
