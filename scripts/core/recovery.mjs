import {levelWaves,verifyChecks,requestTasks,computeMaxWindows,buildTodoList} from './contracts.mjs';
import os from 'node:os';

// Validate persisted structure before recovery can change state or invoke tools.
export function validateRecoverySummary(sum) {
 const fail=reason=>{throw new Error('Invalid recovery ledger: '+reason);};
 const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
 const strings=x=>Array.isArray(x)&&x.every(v=>typeof v==='string'&&v.length>0);
 const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
 const exact=(ids,value)=>object(value)&&new Set(ids).size===ids.length&&Object.keys(value).length===ids.length&&ids.every(id=>Object.hasOwn(value,id)&&object(value[id]));
 if(!object(sum)||sum.protocol!==2||typeof sum.request!=='string'||!Number.isSafeInteger(sum.generation)||sum.generation<1||!Array.isArray(sum.history))fail('invalid header');
 const tasks=requestTasks(sum.request);
 if(!tasks.length||!Array.isArray(sum.tasks)||!same(sum.tasks.map(t=>({id:t?.id,prompt:t?.prompt})),tasks))fail('original task inventory mismatch');
 if(sum.todoList!==undefined){
  const expected=buildTodoList(sum.tasks,sum.blocks,sum.taskResults);
  if(!Array.isArray(sum.todoList)||!same(sum.todoList,expected))fail('todo list status mismatch');
 }
 if(!Array.isArray(sum.blocks)||!sum.blocks.length||sum.blocks.length>computeMaxWindows(os.totalmem()/1024**3)||!Array.isArray(sum.plan)||sum.plan.length!==sum.blocks.length)fail('block inventory mismatch');
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
export function recoveryTasks(tasks,checkpoints,checks,workspace) {
  const result={verified:[],pending:[],uncertain:[],results:{}};
  for(const task of tasks) {
    const cp=checkpoints[task.id],policy=taskPolicy(checks[task.id]);
    if(!cp){
      result.pending.push(task.id);
      result.results[task.id]={status:'pending'};
      continue;
    }
    if(cp.state==='invalid'){result.uncertain.push(task.id);result.results[task.id]={status:'needs-reconciliation',reason:'Invalid checkpoint',checkpoint:cp};continue;}
    const verification=verifyChecks(policy.checks,workspace);
    if(verification.status==='verified'){result.verified.push(task.id);result.results[task.id]={...verification,checkpoint:cp};}
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
