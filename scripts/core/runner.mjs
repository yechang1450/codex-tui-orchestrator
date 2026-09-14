import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {CORE_VERSION,ledgerPlan,levelWaves,verifyChecks,summaryComplete,TERMINAL,canonicalKey,requestTasks,acceptanceKeyDiff,buildTodoList,todoListText} from './contracts.mjs';
import {coordinatorDir,reserve,bind,release,prepare,atomicJson,launcherIdentity,processSnapshot,sameProcess,claimRun,releaseRun} from './leases.mjs';
import {scheduleReady,recoveryTasks,taskPolicy,validateRecoverySummary,hasReconciledCheckpoint} from './recovery.mjs';
import {readCheckpoints,checkpointMatches} from './checkpoint.mjs';
import {capacityRetryPolicy,isCapacityError} from './retry-policy.mjs';
import {createStatusPublisher,buildExecutionStatus} from './status-events.mjs';
export {scheduleReady,recoveryTasks};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
export async function waitForProcessExit(expected,{timeoutMs=5000,intervalMs=100,snapshot=processSnapshot}={}) {
  if(!expected||!Number.isFinite(Number(expected.ProcessId)))return true;
  const timeout=Math.max(0,Math.min(15000,Number(timeoutMs)||0)),interval=Math.max(10,Math.min(1000,Number(intervalMs)||100));
  const deadline=Date.now()+timeout;
  while(true){
    let current;
    try{current=snapshot(Math.min(3000,Math.max(1,deadline-Date.now())));}catch{
      // Process enumeration can briefly fail while a launcher exits. Retry within
      // the same bounded window; an exhausted or continuously unreadable snapshot
      // remains unproven and must retain the lease.
      if(Date.now()>=deadline)return false;
      await pause(Math.min(interval,Math.max(1,deadline-Date.now())));continue;
    }
    if(!sameProcess(expected,current?.get(Number(expected.ProcessId))))return true;
    if(Date.now()>=deadline)return false;
    await pause(Math.min(interval,Math.max(1,deadline-Date.now())));
  }
}
async function coordinate(fn,deadline) {
  while(Date.now()<deadline){try{return fn();}catch(e){if(!/busy|initializing|abandoned/.test(e.message))throw e;await pause(200);}}
  throw new Error('Coordinator transaction timeout');
}
export function runDirectory(workspace,runId) {
  if(!/^[a-zA-Z0-9_-]{1,100}$/.test(runId||''))throw new Error('A valid --run-id is required');
  return path.join(workspace,'temp','orchestrator','runs',runId);
}
function loadChecks(file){return file?JSON.parse(fs.readFileSync(file,'utf8')):{};}
function goalDigest(sum) {
  return crypto.createHash('sha256').update(JSON.stringify({
    generation:sum.generation,runId:sum.runId,tasks:sum.tasks,blocks:sum.blocks,
    results:sum.results,taskResults:sum.taskResults,
  })).digest('hex');
}
function writeGoalMirror(dir,sum,event,status='active') {
  const todoList=buildTodoList(sum.tasks,sum.blocks,sum.taskResults);
  sum.todoList=todoList;
  atomicJson(path.join(dir,'goal.json'),{
    version:2,source:'controller-mirror',runId:sum.runId,workspace:sum.workspace,
    objective:sum.request,status,updatedAt:Date.now(),event,summaryGeneration:sum.generation,
    summaryDigest:goalDigest(sum),eventSeq:sum.eventSeq||0,executionMode:sum.executionMode||'visible',executionStatus:buildExecutionStatus(sum),tasks:todoList.map(item=>({id:item.id,status:item.status,block:item.block})),
    blocks:sum.blocks.map(block=>({key:block.key,title:block.title,status:sum.results[block.key]?.status||'pending',taskIds:block.taskIds})),
  });
}
export function refreshTaskProgress(sum){
  let changed=false;
  for(const block of sum.blocks){
    const entry=sum.results[block.key],attempt=entry?.attempts?.at(-1);
    if(!attempt||!['running','launching','awaiting-verification'].includes(entry.status))continue;
    let checkpoints;try{checkpoints=readCheckpoints(attempt.file,{...attempt,runId:sum.runId});}catch{continue;}
    for(const id of attempt.taskIds){
      const checkpoint=checkpoints[id];
      if(!checkpoint||checkpoint.state==='invalid'||sum.taskResults[id]?.status==='verified')continue;
      const status=checkpoint.state==='started'?'running':'awaiting-verification';
      if(sum.taskResults[id]?.status!==status||sum.taskResults[id]?.checkpoint?.updatedAt!==checkpoint.updatedAt){
        sum.taskResults[id]={status,checkpoint};changed=true;
      }
    }
  }
  return changed;
}
function resetUnverifiedTasks(sum,block) {
  for(const id of block.taskIds) {
    if(sum.taskResults[id]?.status!=='verified')sum.taskResults[id]={status:'pending'};
  }
}
function blockCheckpoints(entry,block,sum) {
  const out={};
  for(const a of entry?.attempts||[]) {
    try{Object.assign(out,readCheckpoints(a.file,{...a,runId:sum.runId}));}catch{for(const id of a.taskIds)out[id]={state:'invalid'};}
  }
  // Preserve read-only verification of historical protocol-1 runs.
  if(!entry?.attempts&&entry?.receiptFile) {
    try{for(const r of JSON.parse(fs.readFileSync(entry.receiptFile,'utf8')).tasks||[]){if(block.taskIds.includes(r.id))out[r.id]=r.runId===sum.runId&&r.token===entry.token&&r.status==='completed'?{state:'completed'}:{state:'invalid'};}}catch{}
  }
  for(const id of block.taskIds) {
    if(!out[id]&&sum.taskResults[id]?.checkpoint){
      const saved=sum.taskResults[id].checkpoint;
      // Protocol 2 snapshots retain the same identity as their durable attempt.
      // Identity-free checkpoints are only compatible with historical ledgers.
      const valid=sum.protocol===2?(entry?.attempts||[]).some(a=>a.taskIds.includes(id)&&checkpointMatches(saved,{...a,runId:sum.runId},id)):
        ['started','completed'].includes(saved.state)&&(['id','runId','token'].every(key=>!Object.hasOwn(saved,key))||checkpointMatches(saved,{runId:sum.runId,token:entry?.token},id));
      out[id]=valid?saved:{state:'invalid'};
    }
    if(!out[id]&&sum.taskResults[id]?.status==='verified')out[id]={state:'invalid'};
  }
  return out;
}
function blockStatus(ids,results) {
  const statuses=ids.map(id=>results[id]?.status);
  if(statuses.every(s=>s==='verified'))return 'verified';
  if(statuses.includes('needs-reconciliation'))return 'needs-reconciliation';
  if(statuses.includes('awaiting-verification'))return 'awaiting-verification';
  return 'failed';
}
export function collectVerification(sum,checks,workspace,{allowStarted=false}={}) {
  for(const b of sum.blocks) {
    const e=sum.results[b.key];if(!e?.endedAt)continue;
    if(['blocked','popup-failed','preflight-failed','cancelled'].includes(e.status)&&!e.attempts?.length)continue;
    const cps=blockCheckpoints(e,b,sum);
    for(const id of b.taskIds) {
      const cp=cps[id];if(!cp){sum.taskResults[id]={status:'failed',reason:'No durable task checkpoint'};continue;}
      if(cp.state==='invalid'){sum.taskResults[id]={status:'needs-reconciliation',reason:'Invalid checkpoint',checkpoint:cp};continue;}
      const reconciled=cp.state==='started'&&(allowStarted||hasReconciledCheckpoint(sum.taskResults[id],cp,id));
      const check=verifyChecks(taskPolicy(checks[id]).checks,workspace);
      sum.taskResults[id]=check.status==='verified'&&(cp.state==='completed'||reconciled)?{...check,checkpoint:cp,...(reconciled?{reconciled:true}:{})}:
        cp.state==='started'?{status:'needs-reconciliation',reason:check.status==='verified'?'Task has no completed checkpoint; use --verify-run for explicit reconciliation':'Task started but result is unproven',verification:check,checkpoint:cp}:{...check,checkpoint:cp};
    }
    e.status=blockStatus(b.taskIds,sum.taskResults);
  }
  return sum;
}
export function verifyRun(workspace,runId,acceptanceFile) {
  const dir=runDirectory(workspace,runId),file=path.join(dir,'summary.json'),sum=JSON.parse(fs.readFileSync(file,'utf8'));
  if(sum.runId!==runId||!sum.finishedAt)throw new Error('Run is not finalized');
  if(sum.protocol===2)validateRecoverySummary(sum);
  const claim=claimRun(sum.coordinator||coordinatorDir(workspace),'run:'+path.resolve(dir).toLowerCase());
  const checks=loadChecks(acceptanceFile||path.join(dir,'acceptance.json'));
  try{
    if(sum.tasks?.length){
      const keyDiff=acceptanceKeyDiff(checks,sum.tasks);
      if(keyDiff?.unknown.length)throw new Error('Acceptance keys do not match any task id: '+keyDiff.unknown.join(', ')+'（task ids: '+sum.tasks.map(t=>t.id).join(', ')+'）');
      if(keyDiff?.missing.length)console.warn('[orchestrator] acceptance has no checks for task(s): '+keyDiff.missing.join(', ')+'；这些任务将停在 awaiting-verification');
    }
    collectVerification(sum,checks,workspace,{allowStarted:true});sum.success=summaryComplete(sum,true);
    createStatusPublisher(dir).publish(sum,sum.success?'verify.completed':'verify.failed');
    writeGoalMirror(dir,sum,sum.success?'verify.completed':'verify.failed',sum.success?'completed':'failed');return sum.success;
  }
  finally{releaseRun(sum.coordinator||coordinatorDir(workspace),'run:'+path.resolve(dir).toLowerCase(),claim);}
}

export async function runWindows(request,hooks,options={}) {
  const workspace=path.resolve(options.workspace),capacity=options.capacity;
  const runId=options.runId||crypto.randomUUID(),dir=runDirectory(workspace,runId),summaryFile=path.join(dir,'summary.json');
  const deadline=Date.now()+(options.timeoutMs||21600000);
  // A resumed run must stay attached to the coordinator recorded in its
  // validated ledger. New runs use the Codex-specific default locator.
  let savedResume=null,savedResumeRaw;
  if(options.resume){
    savedResumeRaw=fs.readFileSync(summaryFile,'utf8');savedResume=JSON.parse(savedResumeRaw);
    if(savedResume.protocol!==2||!Array.isArray(savedResume.plan))throw new Error('This run has no recoverable task checkpoints');
    if((savedResume.agent||'codex')!==(options.agent||'codex'))throw new Error('Resume agent must match the saved run');
    if(options.executionMode&&(savedResume.executionMode||'visible')!==options.executionMode)throw new Error('Resume execution mode must match the saved run');
    if(path.resolve(savedResume.workspace)!==workspace||savedResume.runId!==runId)throw new Error('Run workspace/identity mismatch');
    validateRecoverySummary(savedResume);
    if(savedResume.coordinator!==undefined&&(typeof savedResume.coordinator!=='string'||!path.isAbsolute(savedResume.coordinator)))throw new Error('Invalid saved coordinator');
    const savedGoalFile=path.join(dir,'goal.json');
    if(fs.existsSync(savedGoalFile)){
      const savedGoal=JSON.parse(fs.readFileSync(savedGoalFile,'utf8'));
      if(savedGoal.runId!==runId||path.resolve(savedGoal.workspace||'')!==workspace)throw new Error('Run goal mirror identity mismatch');
      // The goal is only a mirror; a crash may interrupt its last replacement.
      if(savedGoal.version===2&&savedGoal.summaryDigest!==goalDigest(savedResume))console.warn('[resume] rebuilding stale goal mirror from the validated ledger');
    }
    if(savedResume.blocks.length>capacity)throw new Error('Current memory capacity is below the saved block count');
  }
  const coordinator=options.coordinator||savedResume?.coordinator||coordinatorDir(workspace);
  const runKey='run:'+dir.toLowerCase(),claim=await coordinate(()=>claimRun(coordinator,runKey),deadline);
  let sum,progressTimer,progressError;
  try {
    let checks;
    if(options.resume) {
      if(fs.readFileSync(summaryFile,'utf8')!==savedResumeRaw)throw new Error('Run changed while acquiring recovery ownership; retry resume');
      sum=savedResume;
      checks=loadChecks(options.acceptanceFile||path.join(dir,'acceptance.json'));
      sum.history.push({generation:sum.generation,finishedAt:sum.finishedAt,success:sum.success});
      sum.generation++;delete sum.finishedAt;sum.success=false;
    }else {
      if(fs.existsSync(dir))throw new Error('Run ID already exists; use --resume-run or --verify-run');
      fs.mkdirSync(dir,{recursive:true});checks=loadChecks(options.acceptanceFile);
      const inventory=requestTasks(request);
      const manifest={runId,workspace,request,executionMode:options.executionMode||'visible',tasks:inventory,todoList:buildTodoList(inventory),startedAt:Date.now()};
      atomicJson(path.join(dir,'manifest.json'),manifest);
      options.onEvent?.({...manifest,type:'plan.started',executionStatus:[]});
      const candidate=await hooks.plan(request,capacity);
      const {plan,tasks}=ledgerPlan(request,candidate,capacity,hooks.compact);
      const recs=plan.map((b,i)=>({key:`B${i+1}`,title:b.title,b,dependsOn:b.dependsOn||[],keys:[...new Set([...(b.conflictKeys||[]),...b.tasks.flatMap(t=>hooks.infer(t.prompt||''))].map(k=>canonicalKey(k,workspace)))]}));
      levelWaves(recs);
      sum={protocol:2,version:CORE_VERSION,agent:options.agent||'codex',executionMode:options.executionMode||'visible',runId,workspace,request,capacity,coordinator,generation:1,history:[],startedAt:Date.now(),tasks,plan:recs,
        blocks:recs.map(r=>({key:r.key,title:r.title,taskIds:r.b.tasks.flatMap(t=>t.sourceIds)})),results:{},taskResults:{},todoList:[]};
      for(const r of recs){sum.results[r.key]={status:'pending',attempts:[]};for(const id of sum.blocks.find(b=>b.key===r.key).taskIds)sum.taskResults[id]={status:'pending'};}
    }
    sum.owner=claim.owner;sum.coordinator=coordinator;
    const refreshTodoList=()=>{sum.todoList=buildTodoList(sum.tasks,sum.blocks,sum.taskResults);};
    refreshTodoList();
    {
      const keyDiff=acceptanceKeyDiff(checks,sum.tasks);
      if(keyDiff?.unknown.length)throw new Error('Acceptance keys do not match any task id: '+keyDiff.unknown.join(', ')+'（task ids: '+sum.tasks.map(t=>t.id).join(', ')+'）');
      if(keyDiff?.missing.length)console.warn('[orchestrator] acceptance has no checks for task(s): '+keyDiff.missing.join(', ')+'；这些任务将停在 awaiting-verification');
    }
    atomicJson(path.join(dir,'acceptance.json'),checks);
    const publisher=createStatusPublisher(dir,{onEvent:options.onEvent});
    const persist=(event='run.updated')=>{
      publisher.publish(sum,event);
      writeGoalMirror(dir,sum,event,sum.finishedAt?(sum.success?'completed':'failed'):'active');
    };
    const mark=(r,status,reason)=>{
      sum.results[r.key]={...sum.results[r.key],status,reason};
      if(!['waiting','launching','running','reserved','retrying'].includes(status))for(const id of sum.blocks.find(b=>b.key===r.key).taskIds)if(sum.taskResults[id]?.status!=='verified')sum.taskResults[id]={...sum.taskResults[id],status,reason};
      persist(`block.${r.key}.${status}`);
    };
    persist(options.resume?'run.resumed':'plan.created');
    progressTimer=setInterval(()=>{try{if(refreshTaskProgress(sum))persist('task.progress');}catch(error){progressError=error;clearInterval(progressTimer);}},250);
    console.log(`[run] runId=${runId} mode=${sum.executionMode||'visible'} blocks=${sum.blocks.length} capacity=${capacity} generation=${sum.generation} summary=${summaryFile}`);
    async function execute(r) {
      const b=sum.blocks.find(b=>b.key===r.key),tasks=b.taskIds.map(id=>sum.tasks.find(t=>t.id===id));
      const identify=(pid,pidFile)=>hooks.identity?hooks.identity(pid,pidFile):launcherIdentity(pid,pidFile);
      const waitExit=identity=>hooks.waitForExit?hooks.waitForExit(identity):waitForProcessExit(identity);
      const leaseId=crypto.createHash('sha256').update(runKey).digest('hex').slice(0,16)+'-'+r.key;
      let attemptsThisController=0;
      const limit=Math.max(1,Math.min(3,Number(options.maxAttempts||2)));
      let capacityRetries=0;
      while(Date.now()<deadline) {
        if(progressError)throw progressError;
        let e=sum.results[r.key],la=e.launcherFiles,identity;
        if(la)identity=identify(hooks.readPid(la.pidf),la.pidf);
        const adopted=identity&&(!e.launcher||sameProcess(e.launcher,identity));
        let active;
        if(adopted) {
          active=e.attempts.at(-1);console.log(`[resume] adopting live ${r.key}; no duplicate window`);
          hooks.ready?.(la);
        }else {
          const cps=blockCheckpoints(e,b,sum);
          const recovery=recoveryTasks(tasks,cps,checks,workspace,sum.taskResults);
          Object.assign(sum.taskResults,recovery.results);
          if(recovery.verified.length===tasks.length){e.status='verified';e.endedAt=Date.now();persist(`block.${r.key}.verified`);return;}
          if(recovery.uncertain.length){e.status='needs-reconciliation';e.reason='Uncertain tasks: '+recovery.uncertain.join(', ');e.endedAt=Date.now();persist(`block.${r.key}.needs-reconciliation`);return;}
          if(attemptsThisController>=limit){mark(r,'failed','Safe recovery attempt budget exhausted');return;}
          if(attemptsThisController)await pause(Math.min(2000*attemptsThisController,Math.max(0,deadline-Date.now())));
          let reserved=false;
          while(Date.now()<deadline) {
            const result=await coordinate(()=>reserve(coordinator,{id:leaseId,runId,keys:r.keys},capacity),deadline);
            if(result.ok){reserved=true;break;}
            mark(r,'waiting','Waiting for '+result.reason);await pause(1000);
          }
          if(!reserved){mark(r,'timeout','Window capacity/resource wait timed out');return;}
          attemptsThisController++;
          const number=e.attempts.length+1,token=runId+'-'+r.key+'-a'+number+'-'+crypto.randomBytes(6).toString('hex');
          const attemptFile=path.join(dir,'attempts',r.key,String(number),'attempt.json');
          active={file:attemptFile,runId,token,number,taskIds:recovery.pending,createdAt:Date.now()};
          atomicJson(attemptFile,active);e.attempts.push(active);
          const helper=fileURLToPath(new URL('./checkpoint.mjs',import.meta.url));
          const command=(id,state)=>`node "${helper}" "${attemptFile}" ${id} ${state}`;
          const todoList=buildTodoList(sum.tasks,sum.blocks,sum.taskResults);
          const body=options.auth+'\n本执行块目录为 '+workspace+'；所有工具 workdir 保持此目录，除非原始任务明确另指定。\n'+
            'Global TodoList (controller-owned; do not rewrite):\n'+todoListText(todoList)+'\n\nCurrent block TodoList ('+r.key+'):\n'+todoListText(todoList,r.key)+'\n'+
            '仅按顺序执行下列待办任务。每项开始前必须成功执行 started 命令，失败则停止该项，禁止重复执行。完成并自验后立即执行 completed 命令。每项都立即写检查点，不能等整块完成。任何项失败则停止后续任务，说明情况并退出本轮，不自行重跑整块。\n'+
            '已独立验收的任务禁止重做：'+recovery.verified.join(', ')+'\n'+
            recovery.pending.map(id=>`任务 ${id}\n开始前：${command(id,'started')}\n原始任务：${tasks.find(t=>t.id===id).prompt}\n完成自验后：${command(id,'completed')}`).join('\n\n')+
            '\n全部待办完成后，最后仅输出 __ORCH_DONE__ '+token;
          try{la=hooks.launcher(r.key,hooks.prompt(body,token),runId+'-a'+number,{attemptFile,runId,token,taskIds:recovery.pending});}
          catch(error){await coordinate(()=>release(coordinator,leaseId),deadline);throw error;}
          e={...e,status:'launching',launchFailed:false,leaseId,token,launcherFiles:la,launcher:null,endedAt:null,startedAt:Date.now(),reason:'',retryAt:null};sum.results[r.key]=e;persist(`block.${r.key}.launching`);
          try {
            hooks.register({id:leaseId,runId,title:r.title,keys:r.keys,pidFile:la.pidf,pid:0,pending:true,reservedAt:Date.now()});
            await coordinate(()=>prepare(coordinator,leaseId,la.pidf),deadline);
            // Keep the launcher retry budget owned by the runner's caller. A
            // hard-coded one-shot spawn made transient WT/provider startup
            // failures collapse an otherwise full-capacity wave into a single
            // live window, then produced incomplete receipts.
            const spawnRetries=Math.max(1,Math.min(5,Number(options.windowMaxRetry??3)||3));
            if(!await hooks.spawn(la.lp,r.title,la.pidf,spawnRetries,token))throw new Error('Execution process did not start');
            identity=identify(hooks.readPid(la.pidf),la.pidf);
            if(!identity)throw new Error('Launcher process identity mismatch');
            await coordinate(()=>bind(coordinator,leaseId,identity),deadline);hooks.commit?.(leaseId,identity.ProcessId);
            hooks.ready?.(la);
          }catch(error){e.status='popup-failed';e.reason=error.message;e.launchFailed=true;
            // Admission failed after a worker was created: signal it before releasing
            // the lease, then wait for the worker's durable result/exit. A blocked go
            // latch must never remain as an orphan or be adopted as a running block.
            try{if(identity)await hooks.close(identity.ProcessId,identity);else if(la)await hooks.close(hooks.readPid(la.pidf));}catch{}
          }
        }
        e=sum.results[r.key];e.launcher=identity||e.launcher;
        let capacityRetry = null;
        try {
          if(identity&&!e.launchFailed) {
            e.status='running';refreshTaskProgress(sum);persist(`block.${r.key}.running`);
            const session=await hooks.session('【本块唯一标识】'+active.token,Math.min(90000,Math.max(0,deadline-Date.now())),la.rf);
            const result=session?await hooks.wait(session,Math.max(0,deadline-Date.now()),la.rf,'【本块唯一标识】'+active.token,la.pidf):{done:fs.existsSync(la.rf),exitCode:hooks.exitCode(la.rf)};
            e.exitCode=result.exitCode??hooks.exitCode(la.rf);e.status=result.done?'awaiting-verification':'timeout';
            if(result.threadId)active.threadId=result.threadId;
            if(!result.done&&result.text)e.reason=result.text;
            // The worker may have flushed its final completed checkpoint just
            // before the durable result became visible. Refresh before
            // publishing the awaiting-verification transition so host readers
            // never miss that live task state.
            refreshTaskProgress(sum);
            persist(`block.${r.key}.${e.status}`);
            if (result.retryable === 'capacity' || isCapacityError(result.text)) {
              e.retryable = 'capacity';
              e.capacityError = result.capacityError || result.text || 'provider capacity';
              capacityRetry = capacityRetryPolicy(e.capacityError, capacityRetries + 1);
            }
          }
        }catch(error){e.status='failed';e.reason=error.message;}
        finally {
          if(!identity&&la)identity=identify(hooks.readPid(la.pidf),la.pidf);
          if(identity)await hooks.close(identity.ProcessId,identity);
          if(identity&&!(await waitExit(identity))){
            // Keep the lease for resume/adoption, but never leave tasks at their
            // initial pending state when a durable checkpoint is already present.
            refreshTaskProgress(sum);
            const uncertain=blockCheckpoints(e,b,sum);
            for(const id of b.taskIds)if(uncertain[id]?.state==='started')sum.taskResults[id]={status:'needs-reconciliation',reason:'Launcher exit is unproven; reconcile before retrying',checkpoint:uncertain[id]};
            e.status='failed';e.reason='Launcher still alive; lease retained';e.endedAt=Date.now();persist();return;
          }
          await coordinate(()=>release(coordinator,e.leaseId||leaseId),Date.now()+30000);
          hooks.unregister(e.leaseId||leaseId);if(la)hooks.cleanup(la);
          e.endedAt=Date.now();active.endedAt=e.endedAt;active.exitCode=e.exitCode;
          collectVerification(sum,checks,workspace);persist(`block.${r.key}.${e.status}`);
        }
        // A capacity failure happens before any task checkpoint. Reclaim the window and
        // retry after the provider's suggested/backoff delay without consuming the normal
        // safe-recovery attempt budget. Once a task started, recoveryTasks above prevents
        // this path from retrying an unproven side effect.
        const retryCheckpoints=blockCheckpoints(e,b,sum);
        const retryUnsafe=Object.values(retryCheckpoints).some(cp=>cp?.state==='started'||cp?.state==='completed');
        if (capacityRetry?.retry && !retryUnsafe) {
          capacityRetries++;
          attemptsThisController=Math.max(0,attemptsThisController-1);
          resetUnverifiedTasks(sum,b);refreshTodoList();
          e.status='waiting';e.reason=`Provider capacity; retry ${capacityRetries}/${capacityRetry.maxRetries} in ${capacityRetry.delayMs}ms`;e.retryAt=Date.now()+capacityRetry.delayMs;
          delete e.retryable;delete e.capacityError;
          persist(`block.${r.key}.capacity-retry`);
          await pause(Math.min(capacityRetry.delayMs,Math.max(0,deadline-Date.now())));
          continue;
        }
        if(e.retryable==='capacity') { mark(r,'failed','Provider capacity retry budget exhausted');return; }
        if(e.status==='verified')return;
        // Popup/launcher interruptions have no task checkpoint, so the bounded controller
        // attempt budget retries the block automatically. Only started or completed checkpoints
        // can move a task into needs-reconciliation and stop blind replay.
      }
      mark(r,'timeout','Run deadline exhausted');
    }
    await scheduleReady(sum.plan,async r=>{try{await execute(r);}catch(e){mark(r,'failed',e.message);}},key=>sum.results[key]?.status,
      (r,failed)=>mark(r,'blocked','Predecessors not verified: '+failed.join(', ')));
    for(const r of sum.plan)if(!TERMINAL.has(sum.results[r.key]?.status))mark(r,'failed','No terminal result');
    if(progressError)throw progressError;
    clearInterval(progressTimer);
    sum.finishedAt=Date.now();sum.success=summaryComplete(sum,true);persist(sum.success?'run.completed':'run.failed');
    console.log(`[run] finalized runId=${runId} success=${sum.success} summary=${summaryFile}`);return sum;
  }finally{clearInterval(progressTimer);await coordinate(()=>releaseRun(coordinator,runKey,claim),Date.now()+30000);}
}
