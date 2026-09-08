import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';

export const CORE_VERSION = '1.3.3-rc.1';
export const SUCCESS = new Set(['verified']);
export const TERMINAL = new Set(['verified','failed','blocked','cancelled','awaiting-verification','preflight-failed','popup-failed','timeout','needs-reconciliation']);

export function summaryComplete(sum, strict = true) {
  if (!sum?.runId || !Array.isArray(sum.blocks) || !Array.isArray(sum.tasks) || !sum.blocks.length || !sum.tasks.length) return false;
  const exact = (ids, obj) => ids.length === new Set(ids).size && Object.keys(obj || {}).length === ids.length && ids.every(id => Object.hasOwn(obj || {}, id));
  if (!exact(sum.blocks.map(b=>b.key),sum.results) || !exact(sum.tasks.map(t=>t.id),sum.taskResults)) return false;
  const statuses = strict ? SUCCESS : TERMINAL;
  return [...Object.values(sum.results),...Object.values(sum.taskResults)].every(r=>statuses.has(r?.status));
}

export function canonicalKey(key, cwd = process.cwd()) {
  const match = /^(file|dir):(.+)$/i.exec(String(key));
  if (!match) return String(key);
  const windows = /^[a-z]:[\\/]|^\\\\/i.test(match[2]) || process.platform === 'win32';
  const api = windows ? path.win32 : path.posix;
  let p = api.resolve(cwd, match[2]);
  try { p = fs.realpathSync.native(p); } catch {
    // Resolve existing ancestors too, so a not-yet-created file beneath a junction
    // conflicts with the same target reached through its real directory.
    let parent=p; const tail=[];
    while (api.dirname(parent)!==parent && !fs.existsSync(parent)) {tail.unshift(api.basename(parent));parent=api.dirname(parent);}
    try {p=api.join(fs.realpathSync.native(parent),...tail);} catch {}
  }
  p=p.replaceAll('\\','/').replace(/\/+$/,'');
  return match[1].toLowerCase()+':'+(windows?p.toLowerCase():p);
}
export function keysOverlap(a,b) {
  return (a||[]).some(x=>(b||[]).some(y=>{
    x=canonicalKey(x); y=canonicalKey(y);
    if(x===y)return true;
    const xm=/^(file|dir):(.*)$/.exec(x),ym=/^(file|dir):(.*)$/.exec(y);
    if(!xm||!ym)return false;
    return xm[2]===ym[2] || (xm[1]==='dir'&&ym[2].startsWith(xm[2]+'/')) || (ym[1]==='dir'&&xm[2].startsWith(ym[2]+'/'));
  }));
}

export function levelWaves(recs) {
  const aliases=new Map();
  for(const r of recs) for(const alias of [r.key,r.title,r.b?.title].filter(Boolean)) {
    if(aliases.has(alias)&&aliases.get(alias)!==r.key)throw new Error('Ambiguous block identity: '+alias);
    aliases.set(alias,r.key);
  }
  for(const r of recs) r.dependsOn=[...new Set((r.dependsOn||[]).map(d=>{
    if(!aliases.has(d))throw new Error('Unknown dependency: '+d);
    const key=aliases.get(d); if(key===r.key)throw new Error('Self dependency: '+key);return key;
  }))];
  const pending=[...recs],done=new Set(),waves=[];
  while(pending.length) {
    const ready=pending.filter(r=>r.dependsOn.every(d=>done.has(d)));
    if(!ready.length)throw new Error('Cyclic dependencies: '+pending.map(r=>r.key).join(', '));
    waves.push(ready);for(const r of ready){done.add(r.key);pending.splice(pending.indexOf(r),1);}
  }
  return waves;
}

export function requestTasks(request) {
  const text=String(request),parts=[];let start=0,quote='',depth=0;
  for(let i=0;i<text.length;i++) {
    const c=text[i];
    if(quote){if(c===quote&&text[i-1]!=='\\'&&text[i-1]!=='`')quote='';continue;}
    if(c==="'"&&/[\p{L}\p{N}]/u.test(text[i-1]||'')&&/[\p{L}\p{N}]/u.test(text[i+1]||''))continue;
    if(['"',"'",'`'].includes(c)){quote=c;continue;}
    if('([{'.includes(c)){depth++;continue;}if(')]}'.includes(c)){depth=Math.max(0,depth-1);continue;}
    const explicitNext=/^\s*(?:(?:项目|工程|project|proj)\s*[-/]?\s*\d+|(?:修复|优化|修改|更新|检查|创建)\s*\d{2,3}(?!\d))/i.test(text.slice(i+1));
    if(!depth&&(/[；;\n]/.test(c)||(/[，,。]/.test(c)&&explicitNext))){parts.push(text.slice(start,i));start=i+1;}
  }
  parts.push(text.slice(start));
  return parts.map(s=>s.trim()).filter(Boolean).map((prompt,i)=>({id:`T${String(i+1).padStart(3,'0')}`,prompt}));
}
export function bindClassifiedTasks(request,classified) {
  const tasks=requestTasks(request),byId=new Map(tasks.map(t=>[t.id,t]));
  if(!Array.isArray(classified)||classified.length!==tasks.length||new Set(classified.map(t=>t.id)).size!==tasks.length||classified.some(t=>!byId.has(t.id)))throw new Error('Classified task inventory mismatch');
  return classified.map(t=>({...t,summary:byId.get(t.id).prompt,prompt:byId.get(t.id).prompt}));
}
export function ledgerPlan(request, candidate, capacity, compact) {
  const tasks=requestTasks(request);
  if(!tasks.length)throw new Error('Empty task inventory');
  let plan=structuredClone(candidate),assigned=new Set(),valid=true;
  for(const block of plan) for(const task of block.tasks||[]) {
    task.sourceIds=tasks.filter(t=>String(task.prompt||'').includes(t.prompt)).map(t=>t.id);
    if(!task.sourceIds.length)valid=false;
    for(const id of task.sourceIds){if(assigned.has(id))valid=false;assigned.add(id);}
  }
  // A model's omission or paraphrase must never discard the original instructions.
  // Retain the entire inventory in one serial block when coverage is uncertain.
  if(!valid||assigned.size!==tasks.length) plan=[{type:'linked',title:'complete-inventory',dependsOn:[],conflictKeys:[],tasks:tasks.map(t=>({...t,title:t.id,sourceIds:[t.id]}))}];
  plan=compact(plan,capacity);
  const ids=plan.flatMap(b=>b.tasks.flatMap(t=>t.sourceIds||[]));
  if(ids.length!==tasks.length||new Set(ids).size!==tasks.length)throw new Error('Task inventory mismatch');
  levelWaves(plan.map((b,i)=>({key:`B${i+1}`,title:b.title,b,dependsOn:b.dependsOn||[]})));
  return {plan,tasks};
}

export function sha256(file) {return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');}
export function verifyTask(receipt, task, checks, context) {
  if(!receipt || receipt.runId!==context.runId || receipt.token!==context.token || receipt.id!==task.id || receipt.status!=='completed')return {status:'failed',reason:'Missing or mismatched task receipt'};
  return verifyChecks(checks,context.workspace);
}
export function verifyChecks(checks,workspace) {
  if(!Array.isArray(checks)||!checks.length)return {status:'awaiting-verification',reason:'No parent-defined acceptance checks; window report is not proof of success'};
  const evidence=[];
  try {
    for(const check of checks) {
      if(check.type==='command') {
        if(!check.command||!Array.isArray(check.args))throw new Error('Command acceptance requires command and args');
        const result=spawnSync(check.command,check.args,{cwd:workspace,encoding:'utf8',windowsHide:true,shell:false,timeout:check.timeoutMs||30000});
        if(result.error||result.status!==(check.exitCode??0))throw new Error('Acceptance command failed: '+(result.error?.message||result.status));
        if(check.stdout!==undefined&&result.stdout.trim()!==check.stdout)throw new Error('Acceptance stdout mismatch');
        evidence.push({type:'command',command:check.command,args:check.args,exitCode:result.status});continue;
      }
      const file=path.resolve(workspace,check.path);
      if(check.type==='file') {if(!fs.statSync(file).isFile())throw new Error('Not a file: '+file);if(check.sha256&&sha256(file)!==check.sha256)throw new Error('Hash mismatch: '+file);}
      else if(check.type==='json') {const value=JSON.parse(fs.readFileSync(file,'utf8'));for(const [key,expected] of Object.entries(check.equals||{})){if(JSON.stringify(value[key])!==JSON.stringify(expected))throw new Error('JSON mismatch: '+file+' '+key);}}
      else if(check.type==='absent') {if(fs.existsSync(file))throw new Error('Unexpected path: '+file);}
      else throw new Error('Unsupported acceptance check: '+check.type);
      evidence.push({type:check.type,path:file,sha256:check.type==='absent'?undefined:sha256(file)});
    }
    return {status:'verified',evidence};
  } catch(e){return {status:'failed',reason:e.message};}
}
