import fs from 'node:fs';
import path from 'node:path';
import {levelWaves,verifyChecks,requestTasks,buildTodoList} from './contracts.mjs';
import {checkpointMatches} from './checkpoint.mjs';
import {assertNoReparsePoints} from './runtime-context.mjs';
import {controllerWindowsDir,controllerHeadlessBase} from './controller-state.mjs';

const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const pathInside=(root,value)=>{
 const candidate=path.isAbsolute(value)?path.resolve(value):path.resolve(root,value);
 const relative=path.relative(path.resolve(root),candidate);
 if(relative==='..'||relative.startsWith(`..${path.sep}`)||path.isAbsolute(relative))return null;
 return candidate;
};
export function runRoot(sum){return path.resolve(String(sum.workspace),'temp','orchestrator','runs',String(sum.runId));}
export function resolveAttemptFile(sum,value,label='attempt file'){
 if(typeof value!=='string'||!value||value.includes('\0'))throw new Error('Invalid recovery ledger: '+label+' must be a safe path');
 const resolved=pathInside(runRoot(sum),value);
 if(!resolved)throw new Error('Invalid recovery ledger: '+label+' escapes the run directory');
 assertNoReparsePoints(resolved,label);
 return resolved;
}
function resolveWindowFile(sum,value,label){
 if(typeof value!=='string'||!value||value.includes('\0'))throw new Error('Invalid recovery ledger: '+label+' must be a safe path');
 const resolved=pathInside(controllerWindowsDir(String(sum.workspace)),value);
 if(!resolved)throw new Error('Invalid recovery ledger: '+label+' escapes controller windows');
 assertNoReparsePoints(resolved,label);
 return resolved;
}
function resolveHeadlessFile(sum,attemptFile,key,value,label){
 if(typeof value!=='string'||!value||value.includes('\0'))throw new Error('Invalid recovery ledger: '+label+' must be a safe path');
 const base=controllerHeadlessBase(String(sum.workspace),attemptFile,key);
 const resolved=pathInside(path.dirname(base),value);
 if(!resolved)throw new Error('Invalid recovery ledger: '+label+' escapes controller headless files');
 assertNoReparsePoints(resolved,label);
 return resolved;
}
function samePath(a,b){return path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();}
function safeStem(value){return String(value).replace(/[^A-Za-z0-9_-]/g,'_');}
export function validateSavedLauncherFiles(sum,block,entry,attempt,{requireLiveFiles=false}={}){
 const files=entry?.launcherFiles;
 if(files===undefined)return;
 if(!object(files)||!attempt||attempt.runId!==sum.runId||entry.token!==attempt.token)throw new Error('Invalid recovery ledger: launcher identity is not bound to the latest attempt');
 const attemptFile=resolveAttemptFile(sum,attempt.file,'attempt file');
 const headless=files.mode==='headless'||Object.hasOwn(files,'stdout')||Object.hasOwn(files,'stderr');
 const required=headless?['lp','pf','pidf','rf','stdout','stderr']:['lp','pf','pidf','rf'];
 for(const key of required)if(typeof files[key]!=='string'||!files[key])throw new Error('Invalid recovery ledger: launcherFiles.'+key+' is missing');
 for(const [key,value] of Object.entries(files)){
  if(key==='mode')continue;
  if(typeof value!=='string'||!value)throw new Error('Invalid recovery ledger: launcherFiles.'+key+' must be a path');
  if(headless)resolveHeadlessFile(sum,attemptFile,block.key,value,'launcherFiles.'+key);
  else resolveWindowFile(sum,value,'launcherFiles.'+key);
 }
 const key=safeStem(block.key);
 if(headless){
  const base=controllerHeadlessBase(String(sum.workspace),attemptFile,key);
  const expected={lp:base+'.json',pf:base+'.prompt.txt',pidf:base+'.pid',rf:base+'.result.json',stdout:base+'.stdout.jsonl',stderr:base+'.stderr.log'};
  for(const [name,value] of Object.entries(expected))if(!samePath(files[name],value))throw new Error('Invalid recovery ledger: headless launcherFiles.'+name+' is not derived from the attempt path');
  if(requireLiveFiles){
   let config;
   try{config=JSON.parse(fs.readFileSync(files.lp,'utf8'));}
   catch(error){if(error?.code==='ENOENT')throw new Error('Invalid recovery ledger: headless launcher configuration is missing');throw new Error('Invalid recovery ledger: headless launcher configuration is unreadable');}
   if(!object(config)||config.version!==1||config.runId!==sum.runId||config.token!==attempt.token||path.resolve(String(config.workspace||''))!==path.resolve(String(sum.workspace))||!Array.isArray(config.args)||!object(config.files))throw new Error('Invalid recovery ledger: headless launcher configuration identity mismatch');
   for(const [name,value] of Object.entries(expected))if(!samePath(config.files[name],value))throw new Error('Invalid recovery ledger: headless launcher configuration path mismatch');
   for(const name of ['ready','cancel','runtime']){
    if(typeof config[name]!=='string'||!samePath(config[name],base+'.'+({ready:'go',cancel:'cancel',runtime:'runtime.json'}[name])))throw new Error('Invalid recovery ledger: headless launcher control path mismatch');
    resolveHeadlessFile(sum,attemptFile,block.key,config[name],'headless control path');
   }
  }
 }else{
  const temp=controllerWindowsDir(String(sum.workspace));
  const lp=path.basename(files.lp),match=/^win-launch-(.+)\.ps1$/i.exec(lp);
  const suffix=match?.[1];
  const launchKey=String(sum.agent||'codex')==='pi'
   ?String(block.key).replace(/[^A-Za-z0-9_-]/g,'-')
   :(safeStem(block.key)||'codex-task');
  const expectedSuffix=launchKey+'-'+String(sum.runId)+'-a'+String(attempt.number);
  if(suffix!==expectedSuffix)throw new Error('Invalid recovery ledger: visible launcher is not bound to this run attempt');
  const expected={pf:'agent-win-'+suffix+'.md',pidf:'window-'+suffix+'.pid',rf:'win-'+suffix+'.result.json'};
  if(!samePath(files.lp,path.join(temp,lp))||Object.entries(expected).some(([name,value])=>!samePath(files[name],path.join(temp,value))))throw new Error('Invalid recovery ledger: visible launcher file set is inconsistent');
  if(requireLiveFiles){
   for(const name of ['lp','pf','pidf'])if(!fs.existsSync(files[name]))throw new Error('Invalid recovery ledger: visible launcher file is missing');
   let script,prompt;
   try{script=fs.readFileSync(files.lp,'utf8');prompt=fs.readFileSync(files.pf,'utf8');}
   catch{throw new Error('Invalid recovery ledger: visible launcher files are unreadable');}
   const token=String(attempt.token).replaceAll("'","''");
   const tokenAssignment=String(sum.agent||'codex')==='pi'?`$env:ORCH_PI_TOKEN = '${token}'`:`$token = '${token}'`;
   if(!script.includes(tokenAssignment)||!prompt.includes('__ORCH_DONE__ '+attempt.token))throw new Error('Invalid recovery ledger: visible launcher ownership token mismatch');
  }
 }
}

// Validate persisted structure before recovery can change state or invoke tools.
export function validateRecoverySummary(sum) {
 const fail=reason=>{throw new Error('Invalid recovery ledger: '+reason);};
 const strings=x=>Array.isArray(x)&&x.every(v=>typeof v==='string'&&v.length>0);
 const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
 const exact=(ids,value)=>object(value)&&new Set(ids).size===ids.length&&Object.keys(value).length===ids.length&&ids.every(id=>Object.hasOwn(value,id)&&object(value[id]));
 if(!object(sum)||sum.protocol!==2||typeof sum.request!=='string'||typeof sum.workspace!=='string'||!path.isAbsolute(sum.workspace)||typeof sum.runId!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(sum.runId)||!Number.isSafeInteger(sum.generation)||sum.generation<1||!Array.isArray(sum.history))fail('invalid header');
 if(sum.executionMode!==undefined&&!['headless','visible'].includes(sum.executionMode))fail('invalid execution mode');
 const tasks=requestTasks(sum.request);
 if(!tasks.length||!Array.isArray(sum.tasks)||!same(sum.tasks.map(t=>({id:t?.id,prompt:t?.prompt})),tasks))fail('original task inventory mismatch');
 if(sum.todoList!==undefined){
  const expected=buildTodoList(sum.tasks,sum.blocks,sum.taskResults);
  if(!Array.isArray(sum.todoList)||!same(sum.todoList,expected))fail('todo list status mismatch');
 }
 // Keep ledger validation deterministic. The caller enforces the current
 // system-free-memory capacity before resume; re-reading a transient OS
 // sample here would make verifyRun/recovery fail based on machine load.
 if(!Array.isArray(sum.blocks)||!sum.blocks.length||!Array.isArray(sum.plan)||sum.plan.length!==sum.blocks.length)fail('block inventory mismatch');
 const ids=tasks.map(t=>t.id),blockIds=sum.blocks.map(b=>b?.key);
 if(!strings(blockIds)||!exact(blockIds,sum.results)||!exact(ids,sum.taskResults))fail('result inventory mismatch');
 const covered=[];
 for(let i=0;i<sum.blocks.length;i++) {
  const block=sum.blocks[i],plan=sum.plan[i],entry=sum.results[block.key];
  if(!strings(block.taskIds)||!block.taskIds.length||!object(plan)||plan.key!==block.key||!strings(plan.keys)||!strings(plan.dependsOn)||!Array.isArray(plan.b?.tasks))fail('invalid block or plan');
  if(!plan.b.tasks.every(t=>strings(t?.sourceIds)&&t.sourceIds.length)||!same(plan.b.tasks.flatMap(t=>t.sourceIds),block.taskIds))fail('plan task coverage mismatch');
  covered.push(...block.taskIds);
  if(!Array.isArray(entry.attempts))fail('missing attempt inventory');
  if(!entry.attempts.length&&(entry.launcherFiles||entry.launcher||entry.token||['launching','running','verified','awaiting-verification'].includes(entry.status)))fail('launched block has no attempt inventory');
  for(const attempt of entry.attempts) {
   if(!object(attempt)||attempt.runId!==sum.runId||typeof attempt.token!=='string'||!attempt.token||typeof attempt.file!=='string'||!attempt.file||!strings(attempt.taskIds)||!attempt.taskIds.length||new Set(attempt.taskIds).size!==attempt.taskIds.length||attempt.taskIds.some(id=>!block.taskIds.includes(id)))fail('invalid attempt identity or task coverage');
   try{resolveAttemptFile(sum,attempt.file,'attempt file');}catch(error){fail(error.message.replace(/^Invalid recovery ledger:\s*/,''));}
  }
  if(entry.launcherFiles){try{validateSavedLauncherFiles(sum,block,entry,entry.attempts.at(-1),{requireLiveFiles:['launching','running','awaiting-verification'].includes(entry.status)});}catch(error){fail(error.message.replace(/^Invalid recovery ledger:\s*/,''));}}
  for(const id of block.taskIds) {
   const inspection=sum.taskResults[id]?.inspection;
   if(inspection!==undefined&&(!hasParentInspection(sum.taskResults[id],id)||inspection.runId!==sum.runId||!entry.attempts.some(a=>a.runId===inspection.runId&&a.token===inspection.token&&a.taskIds.includes(id))))fail('invalid parent inspection: '+id);
   const checkpoint=sum.taskResults[id]?.checkpoint;
   if(checkpoint!==undefined&&checkpoint?.state!=='invalid'&&!entry.attempts.some(attempt=>attempt.taskIds.includes(id)&&checkpointMatches(checkpoint,attempt,id)))fail('invalid saved task checkpoint: '+id);
  }
 }
 if(covered.length!==ids.length||new Set(covered).size!==ids.length||covered.some(id=>!ids.includes(id)))fail('incomplete or duplicate task coverage');
 try{levelWaves(structuredClone(sum.plan));}catch(error){fail(error.message);}
 return sum;
}

export async function scheduleReady(recs,execute,status,onBlocked=()=>{}) {
  levelWaves(recs); // Validate the whole graph before any work starts.
  const byKey=new Map(recs.map(r=>[r.key,r])),jobs=new Map();
  const start=r=>{
    if(jobs.has(r.key))return jobs.get(r.key);
    const job=Promise.resolve().then(async()=>{
      await Promise.all(r.dependsOn.map(id=>start(byKey.get(id))));
      const failed=r.dependsOn.filter(id=>status(id)!=='verified');
      if(failed.length)return onBlocked(r,failed);
      return execute(r);
    });
    jobs.set(r.key,job);return job;
  };
  await Promise.all(recs.map(start));
}

export const taskPolicy=value=>Array.isArray(value)?{checks:value,retrySafe:false}:{checks:value?.checks||[],retrySafe:value?.retrySafe===true};
export function hasReconciledCheckpoint(result,checkpoint,id) {
  return result?.status==='verified'&&result.reconciled===true&&result.checkpoint?.state==='started'&&checkpoint?.state==='started'&&checkpointMatches(result.checkpoint,checkpoint,id);
}
export function hasParentInspection(result,id) {
  const proof=result?.inspection;
  return proof?.id===id&&typeof proof.runId==='string'&&!!proof.runId&&typeof proof.token==='string'&&!!proof.token&&Number.isFinite(proof.at)&&proof.at>0;
}
export function recoveryTasks(tasks,checkpoints,checks,workspace,previousResults={}) {
  const result={verified:[],pending:[],uncertain:[],results:{}};
  for(const task of tasks) {
    const cp=checkpoints[task.id],policy=taskPolicy(checks[task.id]);
    if(!cp){
      // A persisted inspection is only a receipt from the previous controller
      // process. It is not proof that a worker exited or that the same output
      // still exists. Recompute it only in the live controller after a fresh
      // identity-bound exit confirmation; resume must reconcile or retry.
      result.pending.push(task.id);
      result.results[task.id]={status:'pending'};
      continue;
    }
    if(!['started','completed'].includes(cp.state)){result.uncertain.push(task.id);result.results[task.id]={status:'needs-reconciliation',reason:'Invalid checkpoint',checkpoint:cp};continue;}
    const verification=verifyChecks(policy.checks,workspace);
    const reconciled=hasReconciledCheckpoint(previousResults[task.id],cp,task.id);
    if(verification.status==='verified'&&(cp.state==='completed'||reconciled)){result.verified.push(task.id);result.results[task.id]={...verification,checkpoint:cp,...(reconciled?{reconciled:true}:{})};}
    else if(verification.status==='verified'){
      result.uncertain.push(task.id);result.results[task.id]={status:'needs-reconciliation',reason:'Task has no completed checkpoint; use --verify-run for explicit reconciliation',verification,checkpoint:cp};
    }
    else if(policy.retrySafe){
      // A failed recheck is not a verified receipt. Clear the old status before
      // composing the next prompt, otherwise the TodoList says "verified" while
      // the task is being retried and the new attempt can inherit an invalid
      // receipt identity.
      result.pending.push(task.id);
      result.results[task.id]={status:'pending',reason:'Prior receipt did not satisfy acceptance; safe retry declared',checkpoint:cp};
    }
    else {result.uncertain.push(task.id);result.results[task.id]={status:'needs-reconciliation',reason:'Started task has no proven result and is not declared safe to retry',verification,checkpoint:cp};}
  }
  return result;
}
