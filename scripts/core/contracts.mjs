import path from 'node:path';
import fs from 'node:fs';
import {isDeepStrictEqual} from 'node:util';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {blockCostMB as budgetBlockCostMB, DEFAULT_WINDOW_COST_MB} from './memory-budget.mjs';

/**
 * 动态内存预算（dynamic capacity）：
 *   - 先用"全部块同时运行"的预估成本判断放不放得下（available - Σcost >= floor）；
 *   - 放不下就在同一并行层里合并成本最大的两块（块内串行，峰值取 max 而非求和），循环重判；
 *   - 合并保持拓扑顺序：被合并块的依赖改指到保留块，绝不产生依赖环。
 * 返回 {plan, merges, requiredMB, availableMB, floorMB, ok}。
 */
export function planMemoryCosts(plan, {windowCostMB = DEFAULT_WINDOW_COST_MB, taskCosts = {}} = {}) {
  return (plan || []).map(block => ({key: block.key, title: block.title, costMB: budgetBlockCostMB(block, windowCostMB, taskCosts)}));
}

/** 预估峰值成本 = 同一时刻最多能并发运行的块成本之和（最宽的一层）。 */
function projectedPeakCostMB(blocks, costOf, keysOf) {
  if (!blocks.length) return 0;
  try {
    const waves = levelWaves(blocks.map((block, index) => ({key: keysOf(block, index), title: block.title || ('block' + (index + 1)), b: block, dependsOn: block.memoryDeps || block.dependsOn || []})));
    return Math.max(...waves.map(wave => wave.reduce((sum, rec) => {
      const target = blocks.find((block, index) => keysOf(block, index) === rec.key);
      return sum + (target ? costOf(target) : 0);
    }, 0)));
  } catch {
    return blocks.reduce((sum, block) => sum + costOf(block), 0);
  }
}

export function budgetMergePlan(input, {availableMB, floorMB = 0, windowCostMB = DEFAULT_WINDOW_COST_MB, taskCosts = {}} = {}) {
  const blocks = structuredClone(input || []).map((block, index) => ({
    ...block,
    taskIds: [...(block.taskIds || block.tasks?.map(task => task.id) || [])],
    conflictKeys: [...(block.conflictKeys || [])],
    memoryKey: 'K' + (index + 1),
    memoryTitle: block.title || ('block' + (index + 1)),
  }));
  const alias = new Map();
  blocks.forEach((block, index) => {
    alias.set(String(block.memoryTitle), block.memoryKey);
    alias.set(String(block.memoryKey), block.memoryKey);
    const positional = block.key || ('B' + (index + 1));
    alias.set(String(positional), block.memoryKey);
  });
  for (const block of blocks) {
    block.memoryDeps = [...new Set((block.dependsOn || [])
      .map(dep => alias.get(String(dep)))
      .filter(dep => dep && dep !== block.memoryKey))];
  }
  const costOf = block => budgetBlockCostMB(block, windowCostMB, taskCosts);
  // 预估口径 = "同一时刻最多能并发运行的块"成本之和（最宽的一层），而不是所有块之和：
  // 串行链（p1->p2->p3）天然只能跑一个块，不该被当成三块同时占内存。
  const totalCost = () => projectedPeakCostMB(blocks, costOf, block => block.memoryKey);
  const fits = () => Number(floorMB) <= 0 || (Number(availableMB) - totalCost() >= Number(floorMB));
  const merges = [];
  while (!fits() && blocks.length > 1) {
    let waves;
    try {
      waves = levelWaves(blocks.map(block => ({key: block.memoryKey, title: block.memoryTitle, b: block, dependsOn: block.memoryDeps})));
    } catch { break; }
    let best = null;
    for (const wave of waves) {
      for (let i = 0; i < wave.length; i++) {
        for (let j = i + 1; j < wave.length; j++) {
          const kept = blocks.find(block => block.memoryKey === wave[i].key);
          const merged = blocks.find(block => block.memoryKey === wave[j].key);
          if (!kept || !merged) continue;
          const sum = costOf(kept) + costOf(merged);
          // 只合并同一并行层、且成本最大的两块；成本相同时保持稳定顺序。
          if (!best || sum > best.sum) best = {kept, merged, sum};
        }
      }
    }
    if (!best) break;
    const {kept, merged} = best;
    kept.taskIds = [...kept.taskIds, ...merged.taskIds];
    kept.tasks = [...(kept.tasks || []), ...(merged.tasks || [])];
    kept.conflictKeys = [...new Set([...kept.conflictKeys, ...merged.conflictKeys])];
    kept.memoryDeps = [...new Set([...kept.memoryDeps, ...merged.memoryDeps])].filter(dep => dep !== kept.memoryKey && dep !== merged.memoryKey);
    kept.type = 'linked';
    kept.memoryMergedFrom = [...(kept.memoryMergedFrom || []), merged.memoryTitle];
    for (const block of blocks) block.memoryDeps = block.memoryDeps.map(dep => dep === merged.memoryKey ? kept.memoryKey : dep);
    blocks.splice(blocks.indexOf(merged), 1);
    merges.push({kept: kept.memoryTitle, merged: merged.memoryTitle, costMB: Math.round(best.sum), reason: 'memory-budget'});
  }
  const keyMap = new Map(blocks.map((block, index) => [block.memoryKey, 'B' + (index + 1)]));
  const plan = blocks.map((block, index) => {
    const out = {
      ...block,
      key: 'B' + (index + 1),
      dependsOn: [...new Set(block.memoryDeps.map(dep => keyMap.get(dep)).filter(Boolean))],
    };
    delete out.memoryKey; delete out.memoryTitle; delete out.memoryDeps;
    return out;
  });
  const requiredMB = projectedPeakCostMB(plan, costOf, (block, index) => block.key || ('B' + (index + 1)));
  return {plan, merges, requiredMB, availableMB: Number(availableMB), floorMB: Number(floorMB), ok: Number(floorMB) <= 0 || (Number(availableMB) - requiredMB >= Number(floorMB))};
}

export const CORE_VERSION = '1.4.0-rc.1';
export const SUCCESS = new Set(['verified']);
export const TERMINAL = new Set(['verified','failed','blocked','cancelled','awaiting-verification','preflight-failed','popup-failed','timeout','needs-reconciliation']);

// 校验 acceptance 契约 key 与 task id 的一致性：unknown key（拼错/多余）= 直接报错；task 无 check = 告警（将停在 awaiting-verification）。
export function acceptanceKeyDiff(checks,tasks) {
  if(!checks||typeof checks!=='object'||Array.isArray(checks)||!Object.keys(checks).length)return null;
  const ids=[...(new Set((tasks||[]).map(t=>t?.id).filter(Boolean)))],keys=Object.keys(checks);
  const unknown=keys.filter(k=>!ids.includes(k)),missing=ids.filter(k=>!keys.includes(k));
  return (unknown.length||missing.length)?{unknown,missing}:null;
}

// 系统空闲内存（MB）→ 最大并发 TUI 窗数：每个窗口预留 1000 MB，向下取整。
// fresh 规划与 --resume-run 的恢复校验共用同一容量；不再额外设置固定窗口上限。
export function computeMaxWindows(memoryMb) {
  const mb = Number(memoryMb);
  // 每个执行块按 2 GB 预算：容量 = floor(机器内存MB / 1000) / 2 向下取整（等价于 floor(机器内存MB / 2000)）。
  // 取“机器检测到的物理内存”，不是空闲内存；16 GB 机器 -> 容量 8。
  return Number.isFinite(mb) && mb > 0 ? Math.floor(mb / 2000) : 0;
}

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
// 结构化 TodoList（主控账本中的任务清单）：所有执行块共享同一份原始任务与状态视图。
// 分块只建立 block 归属，不改写 id/prompt；恢复和重试时可从任务结果重新生成，避免窗口自行维护第二份清单。
export function buildTodoList(tasks, blocks = [], taskResults = {}) {
  const owner = new Map();
  for (const block of blocks || []) for (const id of block?.taskIds || []) owner.set(id, block.key || null);
  return (tasks || []).map(task => ({
    id: task.id,
    prompt: task.prompt,
    status: taskResults?.[task.id]?.status || 'pending',
    block: owner.get(task.id) || null,
  }));
}
export function todoListText(todoList, blockKey = '') {
  const list = Array.isArray(todoList) ? todoList : [];
  const current = blockKey ? list.filter(item => item.block === blockKey) : list;
  const lines = current.map(item => {
    const mark = item.status === 'verified' || item.status === 'completed' ? '[x]' : '[ ]';
    return `${mark} ${item.id} (${item.status}) ${item.prompt}`;
  });
  return lines.length ? lines.join('\n') : '(empty TodoList)';
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
      if(check.type==='file') {
        if(!fs.existsSync(file))throw new Error('Acceptance file missing: '+file+(String(check.path)!==file?' (check.path="'+check.path+'")':''));
        if(!fs.statSync(file).isFile())throw new Error('Not a file: '+file);if(check.sha256&&sha256(file)!==check.sha256)throw new Error('Hash mismatch: '+file);}
      else if(check.type==='json') {
        if(!fs.existsSync(file))throw new Error('Acceptance file missing: '+file+(String(check.path)!==file?' (check.path="'+check.path+'")':''));
        let value;try{value=JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){throw new Error('Acceptance JSON parse failed: '+file+': '+e.message);}
        for(const [key,expected] of Object.entries(check.equals||{})){
          if(!(key in value))throw new Error('JSON field missing: '+file+' key="'+key+'" expected='+JSON.stringify(expected));
          if(!isDeepStrictEqual(value[key],expected))throw new Error('JSON mismatch: '+file+' key="'+key+'" expected='+JSON.stringify(expected)+' actual='+JSON.stringify(value[key]));}}
      else if(check.type==='absent') {if(fs.existsSync(file))throw new Error('Unexpected path: '+file);}
      else throw new Error('Unsupported acceptance check: '+check.type);
      evidence.push({type:check.type,path:file,sha256:check.type==='absent'?undefined:sha256(file)});
    }
    return {status:'verified',evidence};
  } catch(e){return {status:'failed',reason:e.message};}
}
