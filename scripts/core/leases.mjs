import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {spawn,spawnSync} from 'node:child_process';
import {keysOverlap} from './contracts.mjs';
import os from 'node:os';
import {assertNoReparsePoints,physicallySameOrChild,physicalPathIdentity} from './runtime-context.mjs';
import {controllerStateDir} from './controller-state.mjs';

function shapeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return '数组';
  return typeof value;
}
// 损坏（解析不了/结构不符）的账本文件：先把原文件原样隔离到 <file>.corrupt-<epochMs>（保留证据 +
// 告警点名），再按 broken 约定处理 —— 默认 fail-closed 抛错（与 registry 的 loadJson 同一口径：
// 畸形状态当成空表静默放行会绕过容量/冲突闸门），但坏文件已经摘走，所以下一次事务会从干净账本
// 重新开始，绝不会因为一条毒记录把整个工作区永久锁死。
// release 路径例外（broken:'empty'）：它在 runWindows 的 finally 里跑，抛错会把"已经跑完的一轮"
// 改判成失败，所以那里必须幂等。
// 读失败（EBUSY/EPERM —— 被别的进程占着、只读、权限不足）永远原样抛出，保持 fail-closed。
function quarantine(file) {
  const target = file + '.corrupt-' + Date.now();
  try { fs.renameSync(file, target); return target; } catch { return null; }
}
function readState(file, shape, label, { broken = 'throw' } = {}) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  let value;
  try { value = JSON.parse(text.replace(/^\uFEFF/, '')); }
  catch (error) { return handle('JSON 解析失败：' + error.message); }
  if (!shape(value)) return handle('结构不符（顶层是 ' + shapeOf(value) + '）');
  return value;
  function handle(reason) {
    const moved = quarantine(file);
    const where = moved ? '原文件已隔离到 ' + moved : '隔离失败（' + file + ' 仍在原位）';
    if (broken === 'empty') {
      console.warn('[orchestrator] ' + label + ' 损坏（' + reason + '）：' + where + '；本次按空账本继续（释放必须幂等）');
      return null;
    }
    throw new Error(label + ' 损坏（' + reason + '）：' + where +
      '；畸形状态不能当成空表静默放行（那会绕过容量/冲突闸门），下一次事务会从干净账本重新开始');
  }
}

const DEFAULT_PROCESS_SNAPSHOT_TIMEOUT_MS=120000;
const MAX_PROCESS_SNAPSHOT_TIMEOUT_MS=120000;
const DEFAULT_COORDINATOR_TIMEOUT_MS=120000;
const MAX_COORDINATOR_TIMEOUT_MS=120000;
const COORDINATOR_SNAPSHOT_CACHE_TTL_MS=120000;
export const MAX_CONTROLLER_ARTIFACT_BYTES=8*1024*1024;

// Windows resolves a bare executable through the caller's current directory
// and PATH.  Controller helpers must be resolved once from the system root,
// with a reparse-point check, and launched with a scrubbed environment.
export function trustedWindowsRoot() {
  if(process.platform!=='win32')throw new Error('Trusted Windows helpers require Windows');
  const configured=String(process.env.SystemRoot||'').trim();
  if(!configured||!path.win32.isAbsolute(configured))throw new Error('Trusted Windows system root is unavailable');
  const root=assertNoReparsePoints(path.win32.normalize(configured),'Windows system root');
  try{if(!fs.statSync(root).isDirectory())throw new Error('Windows system root is not a directory');}
  catch(error){throw new Error('Trusted Windows system root is unavailable: '+(error?.message||error));}
  return root;
}
const WINDOWS_HELPERS=Object.freeze({
  powershell:path.win32.join('System32','WindowsPowerShell','v1.0','powershell.exe'),
  taskkill:path.win32.join('System32','taskkill.exe'),
  tasklist:path.win32.join('System32','tasklist.exe'),
  where:path.win32.join('System32','where.exe'),
  reg:path.win32.join('System32','reg.exe'),
  chcp:path.win32.join('System32','chcp.com'),
  conhost:path.win32.join('System32','conhost.exe'),
});
export function trustedWindowsHelper(name) {
  const relative=WINDOWS_HELPERS[name];
  if(!relative)throw new Error('Unknown Windows helper: '+name);
  const root=trustedWindowsRoot(),file=path.win32.join(root,relative);
  assertNoReparsePoints(file,'Windows helper');
  let stat;try{stat=fs.statSync(file);}catch(error){throw new Error('Trusted Windows helper unavailable: '+file+' ('+(error?.message||error)+')');}
  if(!stat.isFile())throw new Error('Trusted Windows helper is not a regular file: '+file);
  return file;
}
export function controllerEnvironment(extra={}) {
  const out={};
  const allow=new Set(['ComSpec','COMSPEC','SystemRoot','WINDIR','TEMP','TMP','Path','PATH','PATHEXT','USERPROFILE','HOMEDRIVE','HOMEPATH','LOCALAPPDATA','APPDATA','PROGRAMDATA','PROGRAMFILES','PROGRAMFILES(X86)','OS','PROCESSOR_ARCHITECTURE','PROCESSOR_IDENTIFIER','NUMBER_OF_PROCESSORS','CODEX_HOME','ORCH_CONTROLLER_ROOT','LANG','LC_ALL','NO_PROXY','no_proxy']);
  for(const [key,value] of Object.entries(process.env)) {
    if(!allow.has(key)||/(KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL)/i.test(key))continue;
    if(typeof value==='string'&&value.length<=4096)out[key]=value;
  }
  return Object.assign(out,extra);
}
export function readUtf8Bounded(file,label='controller artifact',maxBytes=MAX_CONTROLLER_ARTIFACT_BYTES) {
  let fd;
  try { fd=fs.openSync(file,'r'); }
  catch(error) { if(error.code==='ENOENT')return null; throw error; }
  try {
    const stat=fs.fstatSync(fd);
    if(!Number.isSafeInteger(Number(stat.size))||Number(stat.size)>maxBytes)throw new Error(`${label} exceeds the ${maxBytes} byte safety limit: ${file}`);
    return fs.readFileSync(fd,'utf8');
  } finally { fs.closeSync(fd); }
}
function ledgerRevision(file) {
  let fd;
  try {
    assertNoReparsePoints(file,'coordinator ledger');
    fd=fs.openSync(file,'r');
    const stat=fs.fstatSync(fd);
    if(!stat.isFile()||!Number.isSafeInteger(Number(stat.size))||Number(stat.size)>MAX_CONTROLLER_ARTIFACT_BYTES)return 'unknown';
    const bytes=Buffer.allocUnsafe(MAX_CONTROLLER_ARTIFACT_BYTES+1);let count=0;
    while(count<bytes.length){const read=fs.readSync(fd,bytes,count,bytes.length-count,count);if(read===0)break;count+=read;}
    if(count>MAX_CONTROLLER_ARTIFACT_BYTES)return 'unknown';
    return crypto.createHash('sha256').update(bytes.subarray(0,count)).digest('hex');
  } catch(error) {
    if(error.code==='ENOENT')return 'absent';
    return 'unknown';
  } finally { if(fd!==undefined)fs.closeSync(fd); }
}
function validProcessIdentity(value) {
  return !!value&&typeof value==='object'&&Number.isSafeInteger(value.ProcessId)&&value.ProcessId>0&&
    typeof value.Started==='string'&&typeof value.Name==='string'&&(value.CommandLine===null||typeof value.CommandLine==='string');
}
function validLeaseRecord(value) {
  return !!value&&typeof value==='object'&&typeof value.id==='string'&&value.id.length>0&&Array.isArray(value.keys)&&
    (validProcessIdentity(value.owner)||validProcessIdentity(value.launcher));
}
function validRunOwner(value) {
  return !!value&&typeof value==='object'&&typeof value.token==='string'&&value.token.length>0&&validProcessIdentity(value.owner);
}

function coordinatorTimeoutMs() {
  const configured=Number(process.env.ORCH_COORDINATOR_TIMEOUT_MS);
  return Math.max(1000,Math.min(MAX_COORDINATOR_TIMEOUT_MS,
    Math.ceil(Number.isFinite(configured)&&configured>0?configured:DEFAULT_COORDINATOR_TIMEOUT_MS)));
}

export function processSnapshot(timeoutMs=Number(process.env.ORCH_PROCESS_SNAPSHOT_TIMEOUT_MS)||DEFAULT_PROCESS_SNAPSHOT_TIMEOUT_MS) {
  if(process.platform!=='win32')throw new Error('Visible TUI runtime currently requires Windows');
  // CIM enumeration is serialized by the named mutex. Under a large burst of
  // independent coordinators, the query itself is healthy but later callers
  // wait behind earlier snapshots; the old 15-second cap turned that queue
  // into false identity failures. Keep the bound finite while allowing the
  // admission path to absorb a real Windows scheduler burst.
  const waitMs=Math.max(1000,Math.min(MAX_PROCESS_SNAPSHOT_TIMEOUT_MS,Math.ceil(Number(timeoutMs)||DEFAULT_PROCESS_SNAPSHOT_TIMEOUT_MS)));
  // WorkingSet64/PeakWorkingSet64 供动态内存预算采样（进程峰值 -> 边际成本）；不改身份校验字段。
  const script=`$m=[Threading.Mutex]::new($false,'Local\\CodexTuiOrchestrator.ProcessSnapshot');$held=$false;try{try{$held=$m.WaitOne(${waitMs})}catch [Threading.AbandonedMutexException]{$held=$true};if(-not $held){throw 'Process snapshot mutex timeout'};[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$ErrorActionPreference="Stop";Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,@{n="WorkingSet64";e={[long]$_.WorkingSetSize}},@{n="PeakWorkingSet64";e={[long]$_.PeakWorkingSetSize*1024}},@{n="Started";e={$_.CreationDate.ToUniversalTime().ToString("o")}} | ConvertTo-Json -Compress}finally{if($held){$m.ReleaseMutex()};$m.Dispose()}`;
  const result=spawnSync(trustedWindowsHelper('powershell'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',script],
    {encoding:'utf8',windowsHide:true,timeout:waitMs,cwd:trustedWindowsRoot(),env:controllerEnvironment()});
  if(result.status!==0){
    // 真因必须可读：机器繁忙时 WMI/CIM 会被拖到超时（而不是"编排器坏了"），
    // 所以把子进程退出码与 stderr 首行一起回给调用方。
    const detail=String(result.stderr||'').trim().split('\n')[0].slice(0,200);
    throw new Error('Cannot verify process identities (powershell 退出码 '+
      (result.status===null?'null：超时/被中断':result.status)+(detail?'：'+detail:'')+')');
  }
  return new Map(JSON.parse(result.stdout).map(p=>[p.ProcessId,p]));
}
function coordinatorProcessSnapshot(dir,forceFresh=false) {
  if(process.platform!=='win32')throw new Error('Visible TUI runtime currently requires Windows');
  const waitMs=Math.max(1000,Math.min(MAX_PROCESS_SNAPSHOT_TIMEOUT_MS,Math.ceil(Number(process.env.ORCH_PROCESS_SNAPSHOT_TIMEOUT_MS)||DEFAULT_PROCESS_SNAPSHOT_TIMEOUT_MS)));
  const cacheFile=assertNoReparsePoints(path.join(dir,'process-snapshot-cache.json'),'coordinator process snapshot cache');
  const quote=value=>"'"+String(value).replaceAll("'","''")+"'";
  const cachePath=quote(cacheFile),maxBytes=MAX_CONTROLLER_ARTIFACT_BYTES,ttl=COORDINATOR_SNAPSHOT_CACHE_TTL_MS,caller=process.pid;
  const script=`
$ErrorActionPreference='Stop';$OutputEncoding=[Text.UTF8Encoding]::new($false);[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$cachePath=${cachePath};$maxBytes=${maxBytes};$ttlMs=${ttl};$callerPid=${caller};$waitMs=${waitMs};$forceFresh=${forceFresh?'$true':'$false'}
$m=[Threading.Mutex]::new($false,'Local\\CodexTuiOrchestrator.ProcessSnapshot');$held=$false
function Get-ProcessRows([int]$pidValue){
  @(Get-CimInstance Win32_Process -Filter "ProcessId = $pidValue" | Select-Object ProcessId,ParentProcessId,Name,CommandLine,@{n='WorkingSet64';e={[long]$_.WorkingSetSize}},@{n='PeakWorkingSet64';e={[long]$_.PeakWorkingSetSize*1024}},@{n='Started';e={$_.CreationDate.ToUniversalTime().ToString('o')}})
}
function Test-ProcessRow($row){
  if($null -eq $row){return $false};$pidValue=0
  if(-not [int]::TryParse([string]$row.ProcessId,[ref]$pidValue) -or $pidValue -lt 0){return $false}
  if($row.Started -isnot [string] -or $row.Name -isnot [string] -or ($null -ne $row.CommandLine -and $row.CommandLine -isnot [string])){return $false}
  $parent=0L;$working=0L;$peak=0L
  if(-not [long]::TryParse([string]$row.ParentProcessId,[ref]$parent) -or -not [long]::TryParse([string]$row.WorkingSet64,[ref]$working) -or -not [long]::TryParse([string]$row.PeakWorkingSet64,[ref]$peak)){return $false}
  return $true
}
function Read-Cache {
  try {
    if(-not [IO.File]::Exists($cachePath)){return $null}
    $item=Get-Item -LiteralPath $cachePath -Force
    if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.Length -le 0 -or $item.Length -gt $maxBytes){return $null}
    $stream=[IO.File]::Open($cachePath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    try{$buffer=New-Object byte[] ($maxBytes+1);$count=0;while($count -lt $buffer.Length){$read=$stream.Read($buffer,$count,$buffer.Length-$count);if($read -le 0){break};$count+=$read};if($count -gt $maxBytes){return $null};$text=[Text.UTF8Encoding]::new($false,$true).GetString($buffer,0,$count)}finally{$stream.Dispose()}
    $cache=($text | ConvertFrom-Json -ErrorAction Stop)
    $created=[long]$cache.createdAt;$age=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()-$created
    if(($cache.schema -isnot [int] -and $cache.schema -isnot [long]) -or [int]$cache.schema -ne 1 -or $age -lt 0 -or $age -gt $ttlMs -or $cache.processes -isnot [System.Array]){return $null}
    $rows=@($cache.processes);if($rows.Count -le 0){return $null}
    foreach($row in $rows){if(-not (Test-ProcessRow $row)){return $null}}
    return ,$rows
  } catch {return $null}
}
function Publish-Cache($rows){
  $payload=@{schema=1;createdAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();processes=$rows}|ConvertTo-Json -Compress -Depth 6
  $bytes=[Text.UTF8Encoding]::new($false).GetBytes($payload)
  if($bytes.Length -gt $maxBytes){throw 'Coordinator process snapshot exceeds cache safety limit.'}
  $temp=$cachePath+'.'+[Guid]::NewGuid().ToString('N')+'.tmp'
  try {
    [IO.File]::WriteAllBytes($temp,$bytes)
    if([IO.File]::Exists($cachePath)){$item=Get-Item -LiteralPath $cachePath -Force;if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'Coordinator process snapshot cache is a reparse point.'};$backup=$cachePath+'.'+[Guid]::NewGuid().ToString('N')+'.bak';[IO.File]::Replace($temp,$cachePath,$backup,$true);if([IO.File]::Exists($backup)){[IO.File]::Delete($backup)}}else{[IO.File]::Move($temp,$cachePath)}
  } finally {if([IO.File]::Exists($temp)){[IO.File]::Delete($temp)}}
}
try {
  try{$held=$m.WaitOne($waitMs)}catch [Threading.AbandonedMutexException]{$held=$true}
  if(-not $held){throw 'Process snapshot mutex timeout'}
  $rows=if($forceFresh){$null}else{Read-Cache};$fresh=$false
  if($null -eq $rows){
    $rows=@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,@{n='WorkingSet64';e={[long]$_.WorkingSetSize}},@{n='PeakWorkingSet64';e={[long]$_.PeakWorkingSetSize*1024}},@{n='Started';e={$_.CreationDate.ToUniversalTime().ToString('o')}})
    if($rows.Count -le 0){throw 'Process snapshot returned no rows.'}
    foreach($row in $rows){if(-not (Test-ProcessRow $row)){throw 'Process snapshot returned an invalid row.'}}
    Publish-Cache $rows;$fresh=$true
  }
  if(-not $fresh){
    # Cache identity may be stale across PID reuse. Always replace the current
    # caller's row with a live targeted identity before the lease mutex.
    $owner=@(Get-ProcessRows $callerPid) | Select-Object -First 1
    if($null -eq $owner){throw 'Coordinator owner identity unavailable'}
    $rows=@($rows | Where-Object { [int]$_.ProcessId -ne $callerPid })+@($owner)
  }else{
    $owner=@($rows | Where-Object { [int]$_.ProcessId -eq $callerPid }) | Select-Object -First 1
    if($null -eq $owner){$owner=@(Get-ProcessRows $callerPid) | Select-Object -First 1;if($null -eq $owner){throw 'Coordinator owner identity unavailable'};$rows=@($rows)+@($owner)}
  }
  $result=@{fresh=$fresh;processes=@($rows);owner=$owner}
  $result|ConvertTo-Json -Compress -Depth 6
} finally {if($held){$m.ReleaseMutex()};$m.Dispose()}`;
  const result=spawnSync(trustedWindowsHelper('powershell'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',script],
    {encoding:'utf8',windowsHide:true,timeout:waitMs,maxBuffer:MAX_CONTROLLER_ARTIFACT_BYTES*2,cwd:trustedWindowsRoot(),env:controllerEnvironment()});
  if(result.status!==0){
    const detail=String(result.stderr||'').trim().split('\n')[0].slice(0,200);
    throw new Error('Cannot verify process identities (powershell 退出码 '+(result.status===null?'null：超时/被中断':result.status)+(detail?'：'+detail:'')+')');
  }
  let value;try{value=JSON.parse(result.stdout);}catch(error){throw new Error('Invalid coordinator process snapshot response: '+error.message);}
  if(typeof value?.fresh!=='boolean'||!Array.isArray(value.processes)||!value.owner)throw new Error('Invalid coordinator process snapshot response');
  const processes=new Map();
  for(const item of value.processes){
    if(!item||!Number.isSafeInteger(item.ProcessId)||item.ProcessId<0||typeof item.Started!=='string'||typeof item.Name!=='string'||(item.CommandLine!==null&&typeof item.CommandLine!=='string'))throw new Error('Invalid coordinator process snapshot row');
    processes.set(item.ProcessId,item);
  }
  const owner=processes.get(process.pid);
  if(!owner||!sameProcess(owner,value.owner))throw new Error('Coordinator owner identity unavailable');
  return {processes,fresh:value.fresh};
}
function transactionObservation(dir,snapshot,forceFresh=false) {
  if(snapshot===processSnapshot)return coordinatorProcessSnapshot(dir,forceFresh);
  const value=snapshot();
  if(value instanceof Map)return {processes:value,fresh:true};
  if(value&&value.processes instanceof Map&&typeof value.fresh==='boolean')return value;
  throw new Error('Invalid process snapshot observation');
}
export function sameProcess(expected,actual) {
  return !!expected&&!!actual&&expected.ProcessId===actual.ProcessId&&expected.Started===actual.Started&&expected.Name===actual.Name&&expected.CommandLine===actual.CommandLine;
}
export function launcherIdentity(pid,pidFile,snapshot=processSnapshot()) {
  const actual=snapshot.get(Number(pid));
  if(!pidFile)return null;
  const commandHasToken=(command,file)=>{
    const normalized=String(command||'').toLowerCase().replaceAll('/','\\');
    const escaped=String(file).toLowerCase().replaceAll('/','\\').replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    return new RegExp('(?:^|[\\s"\'])'+escaped+'(?=[\\s"\']|$)').test(normalized);
  };
  if(path.basename(pidFile).startsWith('exec-')){
    const args=String(actual?.CommandLine||'').toLowerCase().replaceAll('/','\\');
    const contains=file=>new RegExp('(?:^|\\s)"?'+file.toLowerCase().replaceAll('/','\\').replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'"?(?=\\s|$)').test(args);
    return /^node(?:\.exe)?$/i.test(actual?.Name||'')&&contains(fileURLToPath(new URL('./headless-worker.mjs',import.meta.url)))&&contains(pidFile.replace(/\.pid$/,'.json'))?actual:null;
  }
  const script=path.join(path.dirname(pidFile),path.basename(pidFile).replace(/^window-/,'win-launch-').replace(/\.pid$/,'.ps1'));
  if(!/^(powershell|pwsh)\.exe$/i.test(actual?.Name||'')||!commandHasToken(actual?.CommandLine,script))return null;
  return actual;
}

export function coordinatorDir(workspace,env=process.env) {
  if(env.ORCH_COORDINATOR_DIR){
    const selected=path.resolve(workspace,env.ORCH_COORDINATOR_DIR);
    if(physicallySameOrChild(workspace,selected))throw new Error('ORCH_COORDINATOR_DIR cannot be inside the initiating workspace');
    return assertNoReparsePoints(selected,'ORCH_COORDINATOR_DIR');
  }
  return path.join(controllerStateDir(workspace,env),'codex-coordinator');
}
export function atomicJson(file,value,guard){
  const parent=assertNoReparsePoints(path.dirname(file),'atomic JSON parent');
  fs.mkdirSync(parent,{recursive:true});
  assertNoReparsePoints(parent,'atomic JSON parent');
  assertNoReparsePoints(file,'atomic JSON target');
  guard?.();
  if(fs.existsSync(file)&&fs.statSync(file).isDirectory()){
    const error=new Error(`EISDIR: cannot replace directory with JSON file: ${file}`);error.code='EISDIR';throw error;
  }
  const tmp=file+'.'+crypto.randomUUID()+'.tmp',deadline=performance.now()+5000;
  try {
    assertNoReparsePoints(tmp,'atomic JSON temporary');
    const fd=fs.openSync(tmp,'wx');
    try { fs.writeFileSync(fd,JSON.stringify(value,null,2));fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    guard?.();
    while(true){
      try{guard?.();assertNoReparsePoints(parent,'atomic JSON parent');assertNoReparsePoints(file,'atomic JSON target');fs.renameSync(tmp,file);return;}
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
export function transaction(dir,fn,snapshot=processSnapshot,{forceFresh=false}={}) {
  assertNoReparsePoints(dir,'coordinator directory');
  fs.mkdirSync(dir,{recursive:true});
  assertNoReparsePoints(dir,'coordinator directory');
  // Resolve 8.3, UNC and junction aliases after the directory exists. Every
  // contender then hashes and passes the same physical coordinator path to
  // the named mutex helper instead of maintaining separate locks for lexical
  // spellings of one leases.json.
  const physicalDir = physicalPathIdentity(dir);
  const lock=path.join(dir,'mutex.json'),file=path.join(dir,'leases.json');
  const ownersFile=path.join(dir,'run-owners.json');
  // Capture both ledger revisions before the snapshot/cache wait. The only
  // negative evidence that can prune entries comes from this call's fresh
  // producer; cache hits retain valid identities until a producer sees them.
  const initialRevisions=new Map([[file,ledgerRevision(file)],[ownersFile,ledgerRevision(ownersFile)]]);
  const {processes,fresh}=transactionObservation(physicalDir,snapshot,forceFresh),owner=processes.get(process.pid);
  if(!owner)throw new Error('Coordinator owner identity unavailable');
  // A kernel mutex is released by Windows on a crash. Unlike a stale lockfile,
  // it cannot be reclaimed by two contenders or strand an empty lock forever.
  let unlock=()=>{};
  if(snapshot===processSnapshot) {
    // 票据放在系统临时目录（短路径）而不是协调器目录：协调器目录可能超过 260 字符或带尾随点，
    // Windows PowerShell 在那种路径上写不了 .ready —— 实测会白等 21 秒再以 "Coordinator mutex
    // acquisition failed" 收场，调用方拿不到真因。票据是一次性握手文件，本身也不属于运行产物。
     const ticketDir=path.join(os.tmpdir(),'codex-tui-orchestrator-locks',
       crypto.createHash('sha256').update(physicalDir.toLowerCase()).digest('hex').slice(0,16));
    fs.mkdirSync(ticketDir,{recursive:true});
    assertNoReparsePoints(ticketDir,'coordinator ticket directory');
    const ticket=path.join(ticketDir,'lock-'+crypto.randomUUID());
    for(const suffix of ['.ready','.release']){try{fs.rmSync(ticket+suffix,{force:true});}catch(error){throw new Error('Coordinator ticket preparation failed: '+error.message);}}
    // The distributed script is intentionally unsigned. Explicitly bypass the
    // user's RemoteSigned policy for this bounded, plugin-owned helper; without
    // it Windows rejects the file before it can publish the ready handshake.
    const lockWaitMs=coordinatorTimeoutMs();
    const nonce=crypto.randomBytes(32).toString('base64url');
     const child=spawn(trustedWindowsHelper('powershell'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('./lease-lock.ps1',import.meta.url)),'-Directory',physicalDir,'-Ticket',ticket,'-Nonce',nonce,'-Owner',String(owner.ProcessId),'-Started',owner.Started,'-WaitMs',String(lockWaitMs)],{windowsHide:true,stdio:'ignore',cwd:trustedWindowsRoot(),env:controllerEnvironment()});
    child.on('error',()=>{});child.unref();
    const deadline=Date.now()+lockWaitMs;
    let ready=false;
    while(Date.now()<deadline){
      try{
        assertNoReparsePoints(ticket+'.ready','coordinator ready marker');
        const stat=fs.statSync(ticket+'.ready');
        const text=(readUtf8Bounded(ticket+'.ready','coordinator ready marker',64)||'').trim();
        // The per-attempt nonce proves freshness; filesystem mtimes have
        // coarse resolution on some Windows volumes and must not turn a valid
        // handshake into a timeout.
        ready=stat.isFile()&&text===`ready:${nonce}`;
      }catch{}
      if(ready)break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,25);
    }
    unlock=()=>{
      try{fs.writeFileSync(ticket+'.release',crypto.randomBytes(16).toString('hex'),{flag:'wx'});}
      catch(error){if(error.code!=='EEXIST')throw error;}
      // The mutex lives in the helper process.  Do not start the next
      // transaction while that process is still unwinding its finally block;
      // otherwise a fast reserve/release pair can observe the previous named
      // mutex as held and wait for the full coordinator timeout.
      const releaseDeadline=Date.now()+5000;
      while(child.exitCode===null&&Date.now()<releaseDeadline)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,25);
    };
    if(!ready){
      unlock();
      const code=child.exitCode;
      throw new Error('Coordinator mutex acquisition failed (dir='+dir+'，ticket='+ticket+(code===null?'，子进程仍在等待':('，子进程退出码 '+code))+')；'+
        '常见原因：协调器目录不可写、Windows PowerShell 不可用，或同名互斥锁被其它协调器长期持有');
    }
  }
  try {
    const observation={processes,fresh,changed(target){
      const before=initialRevisions.get(target)??'unknown',after=ledgerRevision(target);
      return before==='unknown'||after==='unknown'||before!==after;
    }};
    const leasesChanged=observation.changed(file);
    let leases=readState(file,Array.isArray,'协调器租约表 '+file)||[];
    leases=leases.filter(l=>{
      // 畸形/外来条目绝不能毒死协调器：非对象直接剪掉；没有 owner 的条目按"新鲜度"兜底
      // （90s 内当作可能正在写入而保留，过后自愈剪掉），绝不在这里解引用 undefined。
      // 回归：test/lease-poison.test.mjs（修前这里是裸 TypeError，160 次并发事务实测 159 次死在这）。
      if(!l||typeof l!=='object')return false;
      if(l.launcher&&sameProcess(l.launcher,processes.get(l.launcher.ProcessId)))return true;
      if(!fresh&&validLeaseRecord(l))return true;
      if(fresh&&leasesChanged&&validLeaseRecord(l))return true;
      if(fresh&&l.pidFile){let pid=0;try{pid=Number(fs.readFileSync(l.pidFile,'utf8').replace(/^\uFEFF/,''));}catch{};const found=launcherIdentity(pid,l.pidFile,processes);if(found){l.launcher=found;return true;}}
      if(!l.owner)return Date.now()-(l.reservedAt||0)<90000;
      return sameProcess(l.owner,processes.get(l.owner.ProcessId))||Date.now()-(l.reservedAt||0)<90000;
    });
    // 重复 id 只可能是外部写坏/被篡改（reserve 自己写不进重复项）：不收敛的话容量会被重复计数，
    // 同 id 的块会被"existing reservation"永久挡在门外。保留 reservedAt 最新的那条。
    const indexById=new Map(),unique=[];
    for(const lease of leases){
      const id=lease.id;
      if(typeof id!=='string'||!id){unique.push(lease);continue;}
      const index=indexById.get(id);
      if(index===undefined){indexById.set(id,unique.length);unique.push(lease);continue;}
      if((Number(lease.reservedAt)||0)>(Number(unique[index].reservedAt)||0))unique[index]=lease;
    }
    if(unique.length!==leases.length)console.warn('[orchestrator] 协调器租约表含重复 id（'+leases.length+' -> '+unique.length+' 条）；已收敛为最新记录，避免容量重复计数');
    leases=unique;
    const result=fn(leases,owner,processes,observation);atomicJson(file,leases);return result;
  }finally{unlock();}
}
export function reserve(dir,rec,capacity,snapshot,memoryAdmission) {
  return transaction(dir,(leases,owner,processes,observation)=>{
    if(leases.some(l=>l.id===rec.id))return {ok:false,reason:'existing reservation'};
    const limit=Math.min(capacity,...leases.map(l=>l.capacity||capacity));
    if(leases.length>=limit)return {ok:false,reason:'capacity'};
    if(leases.some(l=>keysOverlap(l.keys,rec.keys)))return {ok:false,reason:'conflict'};
    if(memoryAdmission&&!memoryAdmission(leases,rec,observation.fresh?processes:new Map()))return {ok:false,reason:'memory'};
    leases.push({...rec,owner,capacity,reservedAt:Date.now()});return {ok:true};
  },snapshot);
}
export function bind(dir,id,launcher,snapshot){return transaction(dir,leases=>{const l=leases.find(l=>l.id===id);if(!l)throw new Error('Reservation expired');l.launcher=launcher;},snapshot);}
export function release(dir,id,snapshot){return transaction(dir,leases=>{const index=leases.findIndex(l=>l.id===id);if(index>=0)leases.splice(index,1);},snapshot);}

export function prepare(dir,id,pidFile){return transaction(dir,leases=>{const l=leases.find(l=>l.id===id);if(!l)throw new Error("Reservation expired");l.pidFile=pidFile;});}

const FRESH_RUN_OWNER_RECHECK=Symbol('fresh-run-owner-recheck');
export function claimRun(dir,key,snapshot=processSnapshot) {
  const attempt=forceFresh=>transaction(dir,(_leases,owner,processes,observation)=>{
    const file=path.join(dir,'run-owners.json');
    const owners=readState(file,value=>!!value&&typeof value==='object'&&!Array.isArray(value),'运行占用账本 '+file)||{};
    const ownersChanged=observation.changed(file);
    for(const [id,r] of Object.entries(owners)){
      // 条目本身被写坏（不是对象/没有 owner）时直接剪掉，绝不解引用 undefined。
      if(!r||typeof r!=='object'||!r.owner||typeof r.owner!=='object'){delete owners[id];continue;}
      if(!sameProcess(r.owner,processes.get(r.owner.ProcessId))&&!(validRunOwner(r)&&(!observation.fresh||ownersChanged)))delete owners[id];
    }
    const incumbent=owners[key];
    if(incumbent){
      // A cache hit is advisory: a dead controller may still be listed until a
      // complete process snapshot proves otherwise. Recheck exactly once only
      // for this same-key, valid-but-negative collision. Live owners, changed
      // ledgers, and failed/indeterminate fresh observations stay fail-closed.
      const live=sameProcess(incumbent.owner,processes.get(incumbent.owner?.ProcessId));
      if(!live&&!observation.fresh&&!forceFresh&&validRunOwner(incumbent))return FRESH_RUN_OWNER_RECHECK;
      throw new Error('Run already has a live controller');
    }
    const claim={owner,token:crypto.randomUUID()};owners[key]=claim;atomicJson(file,owners);return claim;
  },snapshot,{forceFresh});
  const initial=attempt(false);
  return initial===FRESH_RUN_OWNER_RECHECK?attempt(true):initial;
}
export function releaseRun(dir,key,claim) {
  return transaction(dir,(_leases,_owner,processes)=>{
    // 释放必须幂等：runWindows 的 finally 调它，账本被删/被写坏时抛错会把"已经跑完的一轮"改判成失败。
    const file=path.join(dir,'run-owners.json');
    const owners=readState(file,value=>!!value&&typeof value==='object'&&!Array.isArray(value),'运行占用账本 '+file,{broken:'empty'})||{};
    // token 只用于区分同一进程的不同占用；任务子进程可以读到 token，
    // 所以释放还必须绑定当前进程的 PID、启动时间、名称和完整命令行。
    const current=processes.get(process.pid),entry=owners[key];
    if(!claim?.token||!sameProcess(claim.owner,current)||entry?.token!==claim.token||!sameProcess(entry.owner,current))return;
    delete owners[key];atomicJson(file,owners);
  });
}
