import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {spawn,spawnSync} from 'node:child_process';
import {keysOverlap} from './contracts.mjs';

export function processSnapshot(timeoutMs=15000) {
  if(process.platform!=='win32')throw new Error('Visible TUI runtime currently requires Windows');
  const waitMs=Math.max(1000,Math.min(30000,Math.ceil(timeoutMs)));
  const script=`$m=[Threading.Mutex]::new($false,'Local\\CodexTuiOrchestrator.ProcessSnapshot');$held=$false;try{try{$held=$m.WaitOne(${waitMs})}catch [Threading.AbandonedMutexException]{$held=$true};if(-not $held){throw 'Process snapshot mutex timeout'};[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$ErrorActionPreference="Stop";Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine,@{n="Started";e={$_.CreationDate.ToUniversalTime().ToString("o")}} | ConvertTo-Json -Compress}finally{if($held){$m.ReleaseMutex()};$m.Dispose()}`;
  const result=spawnSync('powershell.exe',['-NoProfile','-Command',script],
    {encoding:'utf8',windowsHide:true,timeout:Math.max(1,Math.min(15000,Math.ceil(timeoutMs)))});
  if(result.status!==0)throw new Error('Cannot verify process identities');
  return new Map(JSON.parse(result.stdout).map(p=>[p.ProcessId,p]));
}
export function sameProcess(expected,actual) {
  return !!expected&&!!actual&&expected.ProcessId===actual.ProcessId&&expected.Started===actual.Started&&expected.Name===actual.Name&&expected.CommandLine===actual.CommandLine;
}
export function launcherIdentity(pid,pidFile,snapshot=processSnapshot()) {
  const actual=snapshot.get(Number(pid));
  if(!pidFile)return null;
  if(path.basename(pidFile).startsWith('exec-')){
    const args=String(actual?.CommandLine||'').toLowerCase().replaceAll('/','\\');
    const contains=file=>new RegExp('(?:^|\\s)"?'+file.toLowerCase().replaceAll('/','\\').replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'"?(?=\\s|$)').test(args);
    return /^node(?:\.exe)?$/i.test(actual?.Name||'')&&contains(fileURLToPath(new URL('./headless-worker.mjs',import.meta.url)))&&contains(pidFile.replace(/\.pid$/,'.json'))?actual:null;
  }
  const script=path.join(path.dirname(pidFile),path.basename(pidFile).replace(/^window-/,'win-launch-').replace(/\.pid$/,'.ps1'));
  const args=String(actual?.CommandLine||'').toLowerCase().replaceAll('/','\\');
  if(!/^(powershell|pwsh)\.exe$/i.test(actual?.Name||'')||!args.includes(script.toLowerCase().replaceAll('/','\\')))return null;
  return actual;
}

// Only a locator is kept in HKCU; all runtime files remain beneath the first
// initiating workspace's temp. A named mutex makes first discovery atomic.
export function coordinatorDir(workspace,env=process.env) {
  if(env.ORCH_COORDINATOR_DIR)return path.resolve(workspace,env.ORCH_COORDINATOR_DIR);
  // Codex owns an independent pool. The former generic locator was also used
  // by open-tui-orchestrator, whose sweeper can only understand its own
  // launcher identities and therefore removes valid Codex reservations.
  const fallback=path.join(workspace,'temp','orchestrator','codex-coordinator');
  if(process.platform!=='win32')return fallback;
  const quoted=fallback.replaceAll("'","''");
  const script=`$held=$false; $m=[Threading.Mutex]::new($false,'Local\\CodexTuiOrchestrator.Coordinator'); try {try{$held=$m.WaitOne(15000)}catch [Threading.AbandonedMutexException]{$held=$true}; if(-not $held){throw 'Coordinator locator busy'}; $key='HKCU:\\Software\\CodexTuiOrchestrator'; $p=(Get-ItemProperty -LiteralPath $key -Name CoordinatorRoot -ErrorAction SilentlyContinue).CoordinatorRoot; if(-not $p){$p='${quoted}'; New-Item -Path $key -Force|Out-Null; New-ItemProperty -LiteralPath $key -Name CoordinatorRoot -Value $p -PropertyType String -Force|Out-Null}; Write-Output $p}finally{if($held){$m.ReleaseMutex()};$m.Dispose()}`;
  const r=spawnSync('powershell.exe',['-NoProfile','-Command','[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); '+script],{encoding:'utf8',windowsHide:true,timeout:20000});
  if(r.status!==0||!r.stdout.trim())throw new Error('Unable to locate machine window coordinator');
  return path.resolve(r.stdout.trim());
}
export function atomicJson(file,value){
  fs.mkdirSync(path.dirname(file),{recursive:true});
  if(fs.existsSync(file)&&fs.statSync(file).isDirectory()){
    const error=new Error(`EISDIR: cannot replace directory with JSON file: ${file}`);error.code='EISDIR';throw error;
  }
  const tmp=file+'.'+process.pid+'.tmp',deadline=performance.now()+5000;
  try {
    fs.writeFileSync(tmp,JSON.stringify(value,null,2));
    while(true){
      try{fs.renameSync(tmp,file);return;}
      catch(error){
        const remaining=deadline-performance.now();
        if(process.platform!=='win32'||!['EPERM','EACCES','EBUSY'].includes(error.code)||remaining<=0)throw error;
        // A Windows reader or scanner may temporarily deny delete sharing.
        // Keep the original intact and retry only the atomic replacement.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,Math.min(50,remaining));
      }
    }
  }finally{fs.rmSync(tmp,{force:true});}
}
export function transaction(dir,fn,snapshot=processSnapshot) {
  fs.mkdirSync(dir,{recursive:true});const lock=path.join(dir,'mutex.json'),file=path.join(dir,'leases.json');
  let processes=snapshot();const owner=processes.get(process.pid);
  if(!owner)throw new Error('Coordinator owner identity unavailable');
  // A kernel mutex is released by Windows on a crash. Unlike a stale lockfile,
  // it cannot be reclaimed by two contenders or strand an empty lock forever.
  let unlock=()=>{};
  if(snapshot===processSnapshot) {
    const ticket=path.join(dir,'lock-'+crypto.randomUUID());
    const child=spawn('powershell.exe',['-NoProfile','-File',fileURLToPath(new URL('./lease-lock.ps1',import.meta.url)),'-Directory',dir,'-Ticket',ticket,'-Owner',String(owner.ProcessId),'-Started',owner.Started],{windowsHide:true,stdio:'ignore'});
    child.on('error',()=>{});child.unref();
    const deadline=Date.now()+20000;
    while(!fs.existsSync(ticket+'.ready')&&Date.now()<deadline)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,25);
    unlock=()=>fs.writeFileSync(ticket+'.release','release');
    if(!fs.existsSync(ticket+'.ready')){unlock();throw new Error('Coordinator mutex acquisition failed');}
  }
  try {processes=snapshot();let leases=[];try{leases=JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
    leases=leases.filter(l=>{
      if(l.launcher)return sameProcess(l.launcher,processes.get(l.launcher.ProcessId));
      if(l.pidFile){let pid=0;try{pid=Number(fs.readFileSync(l.pidFile,'utf8').replace(/^\uFEFF/,''));}catch{};const found=launcherIdentity(pid,l.pidFile,processes);if(found){l.launcher=found;return true;}}
      return sameProcess(l.owner,processes.get(l.owner.ProcessId))||Date.now()-(l.reservedAt||0)<90000;
    });
    const result=fn(leases,owner,processes);atomicJson(file,leases);return result;
  }finally{unlock();}
}
export function reserve(dir,rec,capacity,snapshot) {
  return transaction(dir,(leases,owner)=>{
    if(leases.some(l=>l.id===rec.id))return {ok:false,reason:'existing reservation'};
    const limit=Math.min(capacity,...leases.map(l=>l.capacity||capacity));
    if(leases.length>=limit)return {ok:false,reason:'capacity'};
    if(leases.some(l=>keysOverlap(l.keys,rec.keys)))return {ok:false,reason:'conflict'};
    leases.push({...rec,owner,capacity,reservedAt:Date.now()});return {ok:true};
  },snapshot);
}
export function bind(dir,id,launcher,snapshot){return transaction(dir,leases=>{const l=leases.find(l=>l.id===id);if(!l)throw new Error('Reservation expired');l.launcher=launcher;},snapshot);}
export function release(dir,id,snapshot){return transaction(dir,leases=>{const index=leases.findIndex(l=>l.id===id);if(index>=0)leases.splice(index,1);},snapshot);}

export function prepare(dir,id,pidFile){return transaction(dir,leases=>{const l=leases.find(l=>l.id===id);if(!l)throw new Error("Reservation expired");l.pidFile=pidFile;});}

export function claimRun(dir,key) {
  return transaction(dir,(_leases,owner,processes)=>{
    const file=path.join(dir,'run-owners.json');let owners={};
    try{owners=JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
    for(const [id,r] of Object.entries(owners))if(!sameProcess(r.owner,processes.get(r.owner.ProcessId)))delete owners[id];
    if(owners[key])throw new Error('Run already has a live controller');
    const claim={owner,token:crypto.randomUUID()};owners[key]=claim;atomicJson(file,owners);return claim;
  });
}
export function releaseRun(dir,key,claim) {
  return transaction(dir,()=>{
    const file=path.join(dir,'run-owners.json');const owners=JSON.parse(fs.readFileSync(file,'utf8'));
    if(owners[key]?.token===claim.token){delete owners[key];atomicJson(file,owners);}
  });
}
