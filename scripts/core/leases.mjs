import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {spawn,spawnSync} from 'node:child_process';
import {keysOverlap} from './contracts.mjs';
import os from 'node:os';
import {assertNoReparsePoints,physicallySameOrChild} from './runtime-context.mjs';
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

export function processSnapshot(timeoutMs=15000) {
  if(process.platform!=='win32')throw new Error('Visible TUI runtime currently requires Windows');
  const waitMs=Math.max(1000,Math.min(30000,Math.ceil(timeoutMs)));
  // WorkingSet64/PeakWorkingSet64 供动态内存预算采样（进程峰值 -> 边际成本）；不改身份校验字段。
  const script=`$m=[Threading.Mutex]::new($false,'Local\\CodexTuiOrchestrator.ProcessSnapshot');$held=$false;try{try{$held=$m.WaitOne(${waitMs})}catch [Threading.AbandonedMutexException]{$held=$true};if(-not $held){throw 'Process snapshot mutex timeout'};[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$ErrorActionPreference="Stop";Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,@{n="WorkingSet64";e={[long]$_.WorkingSetSize}},@{n="PeakWorkingSet64";e={[long]$_.PeakWorkingSetSize*1024}},@{n="Started";e={$_.CreationDate.ToUniversalTime().ToString("o")}} | ConvertTo-Json -Compress}finally{if($held){$m.ReleaseMutex()};$m.Dispose()}`;
  const result=spawnSync('powershell.exe',['-NoProfile','-Command',script],
    {encoding:'utf8',windowsHide:true,timeout:Math.max(1,Math.min(15000,Math.ceil(timeoutMs)))});
  if(result.status!==0){
    // 真因必须可读：机器繁忙时 WMI/CIM 会被拖到超时（而不是"编排器坏了"），
    // 所以把子进程退出码与 stderr 首行一起回给调用方。
    const detail=String(result.stderr||'').trim().split('\n')[0].slice(0,200);
    throw new Error('Cannot verify process identities (powershell 退出码 '+
      (result.status===null?'null：超时/被中断':result.status)+(detail?'：'+detail:'')+')');
  }
  return new Map(JSON.parse(result.stdout).map(p=>[p.ProcessId,p]));
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
  assertNoReparsePoints(dir,'coordinator directory');
  fs.mkdirSync(dir,{recursive:true});
  assertNoReparsePoints(dir,'coordinator directory');
  const lock=path.join(dir,'mutex.json'),file=path.join(dir,'leases.json');
  let processes=snapshot();const owner=processes.get(process.pid);
  if(!owner)throw new Error('Coordinator owner identity unavailable');
  // A kernel mutex is released by Windows on a crash. Unlike a stale lockfile,
  // it cannot be reclaimed by two contenders or strand an empty lock forever.
  let unlock=()=>{};
  if(snapshot===processSnapshot) {
    // 票据放在系统临时目录（短路径）而不是协调器目录：协调器目录可能超过 260 字符或带尾随点，
    // Windows PowerShell 在那种路径上写不了 .ready —— 实测会白等 21 秒再以 "Coordinator mutex
    // acquisition failed" 收场，调用方拿不到真因。票据是一次性握手文件，本身也不属于运行产物。
    const ticketDir=path.join(os.tmpdir(),'codex-tui-orchestrator-locks',
      crypto.createHash('sha256').update(path.resolve(dir).toLowerCase()).digest('hex').slice(0,16));
    fs.mkdirSync(ticketDir,{recursive:true});
    const ticket=path.join(ticketDir,'lock-'+crypto.randomUUID());
    const child=spawn('powershell.exe',['-NoProfile','-File',fileURLToPath(new URL('./lease-lock.ps1',import.meta.url)),'-Directory',dir,'-Ticket',ticket,'-Owner',String(owner.ProcessId),'-Started',owner.Started],{windowsHide:true,stdio:'ignore'});
    child.on('error',()=>{});child.unref();
    const deadline=Date.now()+20000;
    while(!fs.existsSync(ticket+'.ready')&&Date.now()<deadline)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,25);
    unlock=()=>fs.writeFileSync(ticket+'.release','release');
    if(!fs.existsSync(ticket+'.ready')){
      unlock();
      const code=child.exitCode;
      throw new Error('Coordinator mutex acquisition failed (dir='+dir+'，ticket='+ticket+(code===null?'，子进程仍在等待':('，子进程退出码 '+code))+')；'+
        '常见原因：协调器目录不可写、Windows PowerShell 不可用，或同名互斥锁被其它协调器长期持有');
    }
  }
  try {processes=snapshot();let leases=readState(file,Array.isArray,'协调器租约表 '+file)||[];
    leases=leases.filter(l=>{
      // 畸形/外来条目绝不能毒死协调器：非对象直接剪掉；没有 owner 的条目按"新鲜度"兜底
      // （90s 内当作可能正在写入而保留，过后自愈剪掉），绝不在这里解引用 undefined。
      // 回归：test/lease-poison.test.mjs（修前这里是裸 TypeError，160 次并发事务实测 159 次死在这）。
      if(!l||typeof l!=='object')return false;
      if(l.launcher)return sameProcess(l.launcher,processes.get(l.launcher.ProcessId));
      if(l.pidFile){let pid=0;try{pid=Number(fs.readFileSync(l.pidFile,'utf8').replace(/^\uFEFF/,''));}catch{};const found=launcherIdentity(pid,l.pidFile,processes);if(found){l.launcher=found;return true;}}
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
    const result=fn(leases,owner,processes);atomicJson(file,leases);return result;
  }finally{unlock();}
}
export function reserve(dir,rec,capacity,snapshot,memoryAdmission) {
  return transaction(dir,(leases,owner,processes)=>{
    if(leases.some(l=>l.id===rec.id))return {ok:false,reason:'existing reservation'};
    const limit=Math.min(capacity,...leases.map(l=>l.capacity||capacity));
    if(leases.length>=limit)return {ok:false,reason:'capacity'};
    if(leases.some(l=>keysOverlap(l.keys,rec.keys)))return {ok:false,reason:'conflict'};
    if(memoryAdmission&&!memoryAdmission(leases,rec,processes))return {ok:false,reason:'memory'};
    leases.push({...rec,owner,capacity,reservedAt:Date.now()});return {ok:true};
  },snapshot);
}
export function bind(dir,id,launcher,snapshot){return transaction(dir,leases=>{const l=leases.find(l=>l.id===id);if(!l)throw new Error('Reservation expired');l.launcher=launcher;},snapshot);}
export function release(dir,id,snapshot){return transaction(dir,leases=>{const index=leases.findIndex(l=>l.id===id);if(index>=0)leases.splice(index,1);},snapshot);}

export function prepare(dir,id,pidFile){return transaction(dir,leases=>{const l=leases.find(l=>l.id===id);if(!l)throw new Error("Reservation expired");l.pidFile=pidFile;});}

export function claimRun(dir,key) {
  return transaction(dir,(_leases,owner,processes)=>{
    const file=path.join(dir,'run-owners.json');
    const owners=readState(file,value=>!!value&&typeof value==='object'&&!Array.isArray(value),'运行占用账本 '+file)||{};
    for(const [id,r] of Object.entries(owners)){
      // 条目本身被写坏（不是对象/没有 owner）时直接剪掉，绝不解引用 undefined。
      if(!r||typeof r!=='object'||!r.owner||typeof r.owner!=='object'){delete owners[id];continue;}
      if(!sameProcess(r.owner,processes.get(r.owner.ProcessId)))delete owners[id];
    }
    if(owners[key])throw new Error('Run already has a live controller');
    const claim={owner,token:crypto.randomUUID()};owners[key]=claim;atomicJson(file,owners);return claim;
  });
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
