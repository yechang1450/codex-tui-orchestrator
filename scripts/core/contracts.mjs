import path from 'node:path';
import fs from 'node:fs';
import {isDeepStrictEqual} from 'node:util';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {blockCostMB as budgetBlockCostMB, DEFAULT_WINDOW_COST_MB} from './memory-budget.mjs';
import {assertNoReparsePoints} from './runtime-context.mjs';

/**
 * 动态内存预算（dynamic capacity）：
 *   - 计划阶段只确定依赖、冲突和资源边界，绝不因为内存压力改写任务块；
 *   - 执行阶段由 leases.mjs 原子预留预测成本，不够就排队，窗口结束后重新准入；
 *   - 4000 MB 是不可降低的安全底线，实际峰值样本可以把后续预测成本提高。
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

/**
 * Compatibility report for callers that used the old planner-time merge API.
 * It deliberately never merges blocks. The live runner uses admissionOk and
 * the lease queue instead; this report only answers whether the current plan
 * would fit if every wave reached its predicted peak at once.
 */
export function budgetMergePlan(input, {availableMB, floorMB = 0, windowCostMB = DEFAULT_WINDOW_COST_MB, taskCosts = {}, headroom = 1} = {}) {
  const plan = structuredClone(input || []);
  const blocks = plan.map((block, index) => ({
    ...block,
    key: String(block.key || 'B' + (index + 1)),
    memoryKey: String(block.key || 'B' + (index + 1)),
    memoryTitle: block.title || ('block' + (index + 1)),
  }));
  const alias = new Map();
  blocks.forEach((block, index) => {
    alias.set(String(block.memoryTitle), block.memoryKey);
    alias.set(String(block.memoryKey), block.memoryKey);
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
  // headroom：首轮余量系数（样本不足时 >1），把预估峰值放大后再判断放不放得下。
  const reserve = Number(headroom) > 1 ? Number(headroom) : 1;
  const projectedCost = () => Math.ceil(totalCost() * reserve);
  const fits = () => Number(floorMB) <= 0 || (Number(availableMB) - projectedCost() >= Number(floorMB));
  const requiredMB = Math.ceil(projectedPeakCostMB(blocks, costOf, block => block.memoryKey) * reserve);
  const floor = Number(floorMB) || 0;
  return {plan, merges: [], requiredMB, headroom: reserve, availableMB: Number(availableMB), floorMB: floor,
    ok: floor <= 0 || (Number(availableMB) - requiredMB > floor)};
}

export const CORE_VERSION = '1.4.1-rc.1';
export const SUCCESS = new Set(['verified']);
export const TERMINAL = new Set(['verified','failed','blocked','cancelled','awaiting-verification','preflight-failed','popup-failed','timeout','needs-reconciliation']);

// 校验 acceptance 契约 key 与 task id 的一致性：unknown key（拼错/多余）= 直接报错；task 无 check = 告警（将停在 awaiting-verification）。
export function acceptanceKeyDiff(checks,tasks) {
  if(!checks||typeof checks!=='object'||Array.isArray(checks)||!Object.keys(checks).length)return null;
  const ids=[...(new Set((tasks||[]).map(t=>t?.id).filter(Boolean)))],keys=Object.keys(checks);
  const unknown=keys.filter(k=>!ids.includes(k)),missing=ids.filter(k=>!keys.includes(k));
  return (unknown.length||missing.length)?{unknown,missing}:null;
}

// 历史兼容辅助：当前 live runner 不使用固定公式，而是按 availableMB、预测峰值和
// 4000 MB 底线动态排队。保留此函数只为旧调用方和诊断脚本提供稳定的纯函数接口。
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
// Acceptance contracts are compared by content, not by formatting: key order and
// indentation must not matter, while any real change must change the digest.
// The encoding is type-tagged and explicit about -0/Infinity because JSON itself is
// lossy there: JSON.stringify(Infinity) is "null" and JSON.stringify(-0) is "0", so a
// plain stringify would let `null` be swapped for `1e400` without changing the digest.
export function canonicalDigest(value) {
  const encode = entry => {
    if (Array.isArray(entry)) return '[' + entry.map(encode).join(',') + ']';
    if (entry && typeof entry === 'object') return '{' + Object.keys(entry).sort().map(key => JSON.stringify(key) + ':' + encode(entry[key])).join(',') + '}';
    if (entry === null) return 'null';
    return typeof entry + ':' + (typeof entry === 'number' && Object.is(entry, -0) ? '-0' : String(entry));
  };
  return crypto.createHash('sha256').update(encode(value)).digest('hex');
}
export function verifyTask(receipt, task, checks, context) {
  if(!receipt || receipt.runId!==context.runId || receipt.token!==context.token || receipt.id!==task.id || receipt.status!=='completed')return {status:'failed',reason:'Missing or mismatched task receipt'};
  return verifyChecks(checks,context.workspace);
}
// 状态/契约文件的 JSON 解析失败必须给"人读得懂"的真因：空文件与半截文件是最常见的两种崩溃形态，
// 直接点明；其余情况保留 JSON.parse 的定位信息（调用方负责补上文件名）。
export function jsonProblem(text, error) {
  const message = String((error && error.message) || error || '');
  if (!String(text).trim()) return '文件为空（0 字节）';
  if (/Unexpected end of JSON input/.test(message)) return 'JSON 不完整（可能被截断或写到一半）';
  return 'JSON 解析失败：' + message;
}
export function describeShape(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return '数组';
  if (value === undefined) return 'undefined';
  return typeof value;
}
export function verifyChecks(checks,workspace) {
  if(!Array.isArray(checks)||!checks.length)return {status:'awaiting-verification',reason:'No parent-defined acceptance checks; window report is not proof of success'};
  const evidence=[];
  try {
    for(const [index,check] of checks.entries()) {
      // 检查项本身的类型错误必须在执行前就点名，而不是让 spawnSync/path.resolve 抛 Node 内部措辞。
      if(!check||typeof check!=='object'||Array.isArray(check))throw new Error('Acceptance check #'+index+' must be an object (实测 '+describeShape(check)+')');
      const where=' (check #'+index+(check.type?'，type='+check.type:'')+')';
      if(check.type==='command') {
        if(typeof check.command!=='string'||!check.command)throw new Error('Command acceptance requires command and args'+where+'：command 必须是非空字符串（实测 '+describeShape(check.command)+'）');
        if(!Array.isArray(check.args))throw new Error('Command acceptance requires command and args'+where+'：args 必须是数组');
        const badArg=check.args.findIndex(arg=>typeof arg!=='string');
        if(badArg>=0)throw new Error('Command acceptance args must be strings'+where+'：args['+badArg+'] 是 '+describeShape(check.args[badArg]));
        if(check.timeoutMs!==undefined&&(!Number.isFinite(check.timeoutMs)||check.timeoutMs<0))throw new Error('Command acceptance timeoutMs must be a non-negative finite number'+where+'：实测 '+JSON.stringify(check.timeoutMs));
        const result=spawnSync(check.command,check.args,{cwd:workspace,encoding:'utf8',windowsHide:true,shell:false,timeout:check.timeoutMs||30000});
        if(result.error||result.status!==(check.exitCode??0))throw new Error('Acceptance command failed: '+(result.error?.message||result.status));
        if(check.stdout!==undefined&&result.stdout.trim()!==check.stdout)throw new Error('Acceptance stdout mismatch');
        evidence.push({type:'command',command:check.command,args:check.args,exitCode:result.status});continue;
      }
      if(typeof check.path!=='string'||!check.path)throw new Error('Acceptance check requires a path string'+where+'：实测 '+describeShape(check.path));
      if(check.type==='json'&&check.equals!==undefined&&(check.equals===null||typeof check.equals!=='object'||Array.isArray(check.equals)))throw new Error('JSON acceptance equals must be a JSON object'+where+'：实测 '+describeShape(check.equals));
      const file=path.resolve(workspace,check.path);
      // Windows localhost administrative shares are another spelling of the
      // same local drive. Canonicalize that spelling only for containment;
      // retain the original path for the actual read so UNC fixtures and real
      // UNC workspaces keep working without allowing remote shares through.
      const localEquivalent=value=>{
        const normalized=path.normalize(value);
        const match=/^\\\\(?:localhost|127\.0\.0\.1)\\([A-Za-z])\$(?:\\(.*))?$/i.exec(normalized);
        return match?`${match[1].toUpperCase()}:\\${match[2]||''}`:normalized;
      };
      const relative=path.relative(localEquivalent(path.resolve(workspace)),localEquivalent(file));
      if(relative==='..'||relative.startsWith(`..${path.sep}`)||path.isAbsolute(relative))throw new Error('Acceptance path escapes the initiating workspace: '+file);
      assertNoReparsePoints(file,'Acceptance path');
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
