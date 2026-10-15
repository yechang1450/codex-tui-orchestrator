import {testTempFamily} from './test-temp-root.mjs';
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {runDirectory,runWindows,preflightResumeLedger,sweepRunProcesses,verifyRun} from '../scripts/core/runner.mjs';
import {createHeadlessHooks} from '../scripts/core/headless-executor.mjs';
import {isProcessIdentityBinding,processSnapshot,sameProcess} from '../scripts/core/leases.mjs';
const testWorker=fileURLToPath(new URL('./headless-worker-fixture.mjs',import.meta.url));
const family=testTempFamily('headless-runner');
fs.mkdirSync(family,{recursive:true});
const controllerRoot=fs.mkdtempSync(path.join(family,'headless-controller-'));
const oldControllerRoot=process.env.ORCH_CONTROLLER_ROOT;
process.env.ORCH_CONTROLLER_ROOT=controllerRoot;
after(()=>{if(oldControllerRoot===undefined)delete process.env.ORCH_CONTROLLER_ROOT;else process.env.ORCH_CONTROLLER_ROOT=oldControllerRoot;fs.rmSync(controllerRoot,{recursive:true,force:true});});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function fixture(){
  fs.mkdirSync(family,{recursive:true});const workspace=fs.mkdtempSync(path.join(family,'headless-run-'));
  const cli=path.join(workspace,'cli.mjs'),checks=path.join(workspace,'checks.json');
  const checkpoint=new URL('../scripts/core/checkpoint.mjs',import.meta.url).href;
  fs.writeFileSync(cli,`import fs from 'node:fs';import path from 'node:path';import {recordCheckpoint} from ${JSON.stringify(checkpoint)};
let prompt='';for await(const part of process.stdin)prompt+=part;
const file=/开始前：& '[^']+' '[^']+' '([^']+)'/.exec(prompt)[1],a=JSON.parse(fs.readFileSync(file));
console.log(JSON.stringify({type:'thread.started',thread_id:'controlled-exec'}));
for(const id of a.taskIds){recordCheckpoint(file,id,'started');
if(id==='T001'){const count=fs.existsSync('count.json')?JSON.parse(fs.readFileSync('count.json')).count:0;fs.writeFileSync('count.json',JSON.stringify({count:count+1}));}
if(id==='T002'&&fs.existsSync('hold'))while(!fs.existsSync('release'))await new Promise(r=>setTimeout(r,40));
await new Promise(r=>setTimeout(r,400));fs.writeFileSync(id+'.json',JSON.stringify({done:true}));recordCheckpoint(file,id,'completed');}
console.log(JSON.stringify({type:'turn.completed'}));`);
  fs.writeFileSync(checks,JSON.stringify({T001:[{type:'json',path:'count.json',equals:{count:1}}],T002:[{type:'json',path:'T002.json',equals:{done:true}}]}));
  const options={workspace,capacity:8,executionMode:'headless',runId:'headless',coordinator:path.join(controllerRoot,'coordinator'),acceptanceFile:checks,auth:'Controlled execution',timeoutMs:120000};
  const hooks={...createHeadlessHooks({workspace,cli:process.execPath,args:[cli],timeoutMs:120000,workerEntry:testWorker}),plan:async()=>[{title:'linked',tasks:[{prompt:'执行甲'},{prompt:'执行乙'}]}],compact:p=>p,infer:()=>[],prompt:p=>p,register:()=>{},commit:()=>{},unregister:()=>{}};
  return {workspace,cli,checks,hooks,options,summary:path.join(workspace,'temp','orchestrator','runs','headless','summary.json')};
}

function parallelFixture(){
  fs.mkdirSync(family,{recursive:true});const workspace=fs.mkdtempSync(path.join(family,'headless-parallel-'));
  const cli=path.join(workspace,'parallel-cli.mjs'),checks=path.join(workspace,'parallel-checks.json'),release=path.join(workspace,'release');
  const checkpoint=new URL('../scripts/core/checkpoint.mjs',import.meta.url).href,nonce='parallel-'+Date.now()+'-'+Math.random().toString(16).slice(2);
  fs.writeFileSync(path.join(workspace,'parallel-context.json'),JSON.stringify({workspace,nonce}));
  fs.writeFileSync(cli,`import fs from 'node:fs';import path from 'node:path';import {recordCheckpoint} from ${JSON.stringify(checkpoint)};
let prompt='';for await(const part of process.stdin)prompt+=part;
const match=/开始前：& '[^']+' '[^']+' '([^']+)' '([^']+)' 'started'/.exec(prompt);if(!match)throw new Error('Missing controller checkpoint command');
const [,attemptFile,taskId]=match,context=JSON.parse(fs.readFileSync('parallel-context.json','utf8'));
if(process.cwd()!==context.workspace)throw new Error('Worker cwd escaped the execution workspace');
console.log(JSON.stringify({type:'thread.started',thread_id:'parallel-'+taskId}));
recordCheckpoint(attemptFile,taskId,'started');
const started={taskId,cwd:process.cwd(),pid:process.pid,nonce:context.nonce,started:Date.now()};
fs.writeFileSync('started-'+taskId+'.json',JSON.stringify(started));
while(!fs.existsSync('release'))await new Promise(resolve=>setTimeout(resolve,20));
await new Promise(resolve=>setTimeout(resolve,150));
const receipt={...started,finished:Date.now()};fs.mkdirSync('receipts',{recursive:true});fs.writeFileSync(path.join('receipts',taskId+'.json'),JSON.stringify(receipt));
recordCheckpoint(attemptFile,taskId,'completed');console.log(JSON.stringify({type:'turn.completed'}));`);
  fs.writeFileSync(checks,JSON.stringify({
    T001:[{type:'json',path:path.join('receipts','T001.json'),equals:{taskId:'T001',cwd:workspace,nonce}}],
    T002:[{type:'json',path:path.join('receipts','T002.json'),equals:{taskId:'T002',cwd:workspace,nonce}}],
  }));
  const options={workspace,capacity:2,executionMode:'headless',runId:'headless-parallel',coordinator:path.join(controllerRoot,'parallel-coordinator'),acceptanceFile:checks,auth:'Controlled parallel execution',timeoutMs:120000};
  const hooks={...createHeadlessHooks({workspace,cli:process.execPath,args:[cli],timeoutMs:120000,workerEntry:testWorker}),
    plan:async()=>[
      {title:'parallel-one',dependsOn:[],conflictKeys:[],tasks:[{prompt:'并发任务甲'}]},
      {title:'parallel-two',dependsOn:[],conflictKeys:[],tasks:[{prompt:'并发任务乙'}]},
    ],compact:p=>p,infer:()=>[],prompt:p=>p,register:()=>{},commit:()=>{},unregister:()=>{}};
  return {workspace,cli,checks,release,hooks,options,nonce};
}

test('headless runner concurrently executes independent blocks with exact workspace-bound receipts',async()=>{
  const f=parallelFixture();let run;
  const waitFor=async condition=>{const deadline=Date.now()+60000;while(Date.now()<deadline){try{if(condition())return;}catch{}await pause(50);}
    const summaryFile=path.join(f.workspace,'temp','orchestrator','runs',f.options.runId,'summary.json');let summary='missing';
    try{summary=fs.existsSync(summaryFile)?JSON.parse(fs.readFileSync(summaryFile,'utf8')):'missing';}catch(error){summary='unreadable: '+error.message;}
    throw new Error('Independent headless workers did not reach the concurrent barrier: '+JSON.stringify({startedFiles:fs.readdirSync(f.workspace).filter(name=>name.startsWith('started-')),statuses:summary?.results&&Object.fromEntries(Object.entries(summary.results).map(([key,value])=>[key,{status:value.status,reason:value.reason}]))}));};
  try{
    run=runWindows('并发任务甲；并发任务乙',f.hooks,f.options);
    const startedFiles=['T001','T002'].map(id=>path.join(f.workspace,'started-'+id+'.json'));
    await waitFor(()=>startedFiles.every(file=>fs.existsSync(file)));
    const starts=startedFiles.map(file=>JSON.parse(fs.readFileSync(file,'utf8'))),snapshot=processSnapshot();
    assert.notEqual(starts[0].pid,starts[1].pid,'independent blocks must have distinct live workers');
    for(const [index,start] of starts.entries()){
      assert.equal(start.taskId,'T00'+(index+1));assert.equal(start.cwd,f.workspace);assert.equal(start.nonce,f.nonce);
      assert.ok(snapshot.has(start.pid),'each worker must still be alive at the shared barrier');
    }
    assert.equal(fs.existsSync(f.release),false,'the parent must not release either worker before both arrive');
    fs.writeFileSync(f.release,'go');
    const sum=await run;run=null;
    assert.equal(sum.success,true,JSON.stringify(sum.results));
    assert.equal(sum.blocks.length,2);assert.deepEqual(sum.blocks.map(block=>block.taskIds),[['T001'],['T002']]);
    for(const [index,key] of ['B1','B2'].entries()){
      const id='T00'+(index+1),entry=sum.results[key],attempt=entry.attempts.at(-1),receipt=JSON.parse(fs.readFileSync(path.join(f.workspace,'receipts',id+'.json'),'utf8'));
      assert.equal(entry.status,'verified');assert.equal(entry.exitConfirmed,true);assert.equal(entry.exitCode,0);
      assert.equal(entry.attempts.length,1);assert.deepEqual(attempt.taskIds,[id]);assert.equal(attempt.runId,sum.runId);
      assert.equal(attempt.launcherObserved?.CommandLine,undefined,'durable attempt observations must exclude raw command lines');
      assert.match(attempt.launcherObserved?.commandLineSha256||'',/^[a-f0-9]{64}$/);
      assert.equal(isProcessIdentityBinding(attempt.launcherObserved),true,'durable attempt observations must retain the exact persistent identity schema');
      assert.ok(attempt.token);assert.ok(sameProcess(entry.launcher,attempt.launcherObserved));
      assert.equal(entry.exitEvidence.token,attempt.token);assert.equal(entry.exitEvidence.pid,entry.launcher.ProcessId);
      assert.equal(receipt.taskId,id);assert.equal(receipt.cwd,f.workspace);assert.equal(receipt.nonce,f.nonce);assert.ok(receipt.finished>receipt.started);
      assert.equal(sameProcess(entry.launcher,processSnapshot().get(entry.launcher.ProcessId)),false,'completed worker must no longer be live');
    }
  }finally{
    fs.writeFileSync(f.release,'cleanup');
    if(run)await Promise.race([run.catch(()=>{}),pause(15000)]);
    await pause(250);fs.rmSync(f.workspace,{recursive:true,force:true});
  }
});

test('headless runner keeps task progress live and returns independently verified receipts for a linked block',async()=>{
  const f=fixture(),events=[];
  try{
    const sum=await runWindows('执行甲；执行乙',f.hooks,{...f.options,onEvent:event=>events.push(structuredClone(event))});
    assert.equal(sum.success,true,JSON.stringify(sum.results));
    assert.equal(sum.executionMode,'headless');assert.equal(sum.executionStatus[0].status,'verified');
    assert.equal(sum.executionStatus[0].mode,'headless');
    assert.ok(events.some(e=>e.todoList?.[0]?.status==='running'&&e.todoList?.[1]?.status==='pending'));
    assert.ok(events.some(e=>e.todoList?.[0]?.status==='awaiting-verification'&&e.todoList?.[1]?.status==='running'));
    assert.equal(sum.results.B1.attempts.length,1);
    const owners=JSON.parse(fs.readFileSync(path.join(f.options.coordinator,'run-owners.json'),'utf8'));
    assert.deepEqual(owners,{},'a finalized run must release its controller ownership before a resume claim');
    const goalFile=path.join(path.dirname(f.summary),'goal.json');
    const goal=JSON.parse(fs.readFileSync(goalFile));goal.summaryDigest='interrupted-mirror-write';fs.writeFileSync(goalFile,JSON.stringify(goal));
    const resumed=await runWindows('',f.hooks,{...f.options,resume:true});
    assert.equal(resumed.success,true);assert.equal(resumed.results.B1.attempts.length,1);
    assert.equal(resumed.coordinator,f.options.coordinator,'resume must retain its saved coordinator instead of selecting the new default');
    assert.notEqual(JSON.parse(fs.readFileSync(goalFile)).summaryDigest,goal.summaryDigest);
  }finally{await pause(500);fs.rmSync(f.workspace,{recursive:true,force:true});}
});

test('an unresolved headless child result retains the lease and bypasses parent verification',async()=>{
  const workspace=fs.mkdtempSync(path.join(family,'headless-unresolved-child-'));
  const runId='headless-unresolved-child';
  const base=createHeadlessHooks({workspace,cli:process.execPath,args:[],timeoutMs:30000,workerEntry:testWorker});
  // The runner binds the launcher identity into the shared coordinator before
  // it reaches the worker result.  Use this test process's real binding so the
  // fixture exercises the unresolved-child path rather than failing admission
  // on a fabricated PID.  `close` remains a pure recorder below.
  const launcherIdentity=processSnapshot().get(process.pid);
  assert.ok(launcherIdentity,'test process must have a durable launcher identity');
  const events=[];
  let closes=0,cleanups=0,unregisters=0,waits=0,entry;
  const hooks={...base,
    plan:async()=>[{title:'unresolved child',tasks:[{prompt:'wait for explicit reconciliation'}]}],compact:value=>value,infer:()=>[],prompt:value=>value,
    register:()=>{},commit:()=>{},unregister:()=>{unregisters++;},cleanup:()=>{cleanups++;},
    spawn:async(_lp,_title,pidf)=>{fs.writeFileSync(pidf,String(launcherIdentity.ProcessId),'utf8');return true;},readPid:()=>launcherIdentity.ProcessId,identity:()=>launcherIdentity,
    verifyStartup:async()=>null,ready:()=>{},close:async()=>{closes++;},waitForExit:async()=>false,session:async()=> 'fixture',
    wait:async()=>{waits++;return {done:false,exitCode:null,text:'Headless child remains unresolved',childStillRunning:true,exitUnproven:true,terminationRefused:true};},
  };
  try{
    const sum=await runWindows('wait for explicit reconciliation',hooks,{workspace,capacity:1,executionMode:'headless',runId,
      coordinator:path.join(controllerRoot,'unresolved-child-coordinator'),auth:'Controlled execution',maxAttempts:1,timeoutMs:30000,onEvent:event=>events.push(structuredClone(event))});
    entry=sum.results.B1;
    assert.equal(sum.success,false);
    assert.equal(waits,1,'the worker result must reach the unresolved-child branch');
    assert.equal(entry.status,'needs-reconciliation',JSON.stringify({entry,taskResults:sum.taskResults,finalSweep:sum.finalSweep,events}));
    assert.equal(entry.exitConfirmed,false);
    assert.ok(entry.exitUnprovenAt,'the unresolved child must retain an exit-unproven marker');
    assert.deepEqual(entry.headlessChildState,{childStillRunning:true,exitUnproven:true,terminationRefused:true});
    assert.deepEqual(entry.attempts.at(-1).headlessChildState,entry.headlessChildState);
    assert.equal(closes,0,'the parent must not close a worker after it reports an unresolved child');
    assert.equal(cleanups,0,'the unresolved attempt files must remain for reconciliation');
    assert.equal(unregisters,0,'the capacity lease must remain for reconciliation');
    assert.equal(sum.finalSweep.retained,1);
    assert.equal(fs.existsSync(path.join(runDirectory(workspace,runId),'verification-report.jsonl')),false,'parent verification must not run while the child exit is unresolved');
    for(const file of [entry.launcherFiles.lp,entry.launcherFiles.pf,entry.launcherFiles.pidf])assert.equal(fs.existsSync(file),true,'retain '+path.basename(file));
    // A stale public boolean cannot override the independently bound child
    // reconciliation state.  `--verify-run` must reject before it changes any
    // ledger, event, or goal-mirror authority.
    const dir=runDirectory(workspace,runId),summaryFile=path.join(dir,'summary.json'),eventsFile=path.join(dir,'events.jsonl'),goalFile=path.join(dir,'goal.json');
    const forged=JSON.parse(fs.readFileSync(summaryFile,'utf8'));forged.results.B1.exitConfirmed=true;fs.writeFileSync(summaryFile,JSON.stringify(forged),'utf8');
    const forgedSummary=fs.readFileSync(summaryFile,'utf8'),eventsBefore=fs.readFileSync(eventsFile,'utf8'),goalBefore=fs.readFileSync(goalFile,'utf8');
    assert.throws(()=>verifyRun(workspace,runId,undefined,{override:true}),/Launcher exit remains unproven for B1; reconcile the saved run before verification/);
    assert.equal(fs.readFileSync(summaryFile,'utf8'),forgedSummary);
    assert.equal(fs.readFileSync(eventsFile,'utf8'),eventsBefore);
    assert.equal(fs.readFileSync(goalFile,'utf8'),goalBefore);
  }finally{
    fs.rmSync(workspace,{recursive:true,force:true});
  }
});

test('atomic attempt and summary failures after an unresolved headless result block restart and resume',async()=>{
  const workspace=fs.mkdtempSync(path.join(family,'headless-unresolved-durable-restart-'));
  const runId='headless-unresolved-durable-restart';
  const base=createHeadlessHooks({workspace,cli:process.execPath,args:[],timeoutMs:30000,workerEntry:testWorker});
  const launcherIdentity=processSnapshot().get(process.pid);
  assert.ok(launcherIdentity,'test process must have a durable launcher identity');
  const runDir=runDirectory(workspace,runId),attemptFile=path.join(runDir,'attempts','B1','1','attempt.json'),summaryFile=path.join(runDir,'summary.json');
  let failPostResultWrites=false,resumeSpawned=0,controlledResultFile;
  const originalRename=fs.renameSync;
  const hooks={...base,
    plan:async()=>[{title:'durable unresolved child',tasks:[{prompt:'retain durable reconciliation evidence'}]}],compact:value=>value,infer:()=>[],prompt:value=>value,
    register:()=>{},commit:()=>{},unregister:()=>{},cleanup:()=>{},
    spawn:async(_lp,_title,pidf)=>{fs.writeFileSync(pidf,String(launcherIdentity.ProcessId),'utf8');return true;},readPid:()=>launcherIdentity.ProcessId,identity:()=>launcherIdentity,
    verifyStartup:async()=>null,ready:()=>{},close:async()=>{},waitForExit:async()=>false,session:async()=> 'fixture',
    wait:async(_session,_timeout,rf)=>{
      const config=JSON.parse(fs.readFileSync(rf.replace(/\.result\.json$/,'.json'),'utf8'));
      controlledResultFile=rf;
      fs.writeFileSync(rf,JSON.stringify({runId:config.runId,token:config.token,pid:launcherIdentity.ProcessId,done:false,exitCode:null,
        childStillRunning:true,exitUnproven:true,terminationRefused:true}),'utf8');
      failPostResultWrites=true;
      return {done:false,exitCode:null,text:'Headless child remains unresolved',childStillRunning:true,exitUnproven:true,terminationRefused:true};
    },
  };
  const options={workspace,capacity:1,executionMode:'headless',runId,coordinator:path.join(controllerRoot,'unresolved-durable-restart-coordinator'),
    auth:'Controlled execution',maxAttempts:1,timeoutMs:30000};
  try{
    fs.renameSync=function(source,destination){
      const target=path.resolve(String(destination));
      if(failPostResultWrites&&(target===path.resolve(attemptFile)||target===path.resolve(summaryFile))){
        const error=new Error('injected post-result atomic write failure');error.code='EIO';throw error;
      }
      return originalRename.call(this,source,destination);
    };
    await assert.rejects(()=>runWindows('retain durable reconciliation evidence',hooks,options),/injected post-result atomic write failure/);
    const marker=path.join(path.dirname(attemptFile),'headless-reconciliation.json');
    assert.equal(fs.existsSync(marker),true,'the runner must commit independent reconciliation evidence before publishing status');
    assert.throws(()=>preflightResumeLedger(workspace,runId),/reconcile|unresolved|exit.*unproven/i);
    // If the independently written journal is unavailable after the crash,
    // the controller-owned result still binds the unresolved child to this
    // exact run/attempt and must independently stop a restart.
    fs.rmSync(marker);
    assert.throws(()=>preflightResumeLedger(workspace,runId),/reconcile|unresolved|exit.*unproven/i);
    // A stale or partially persisted ledger must not be able to overwrite the
    // controller-owned result's unresolved state. The result is bound to the
    // same run/token and is therefore authoritative for this resume guard.
    const savedSummaryText=fs.readFileSync(summaryFile,'utf8');
    const staleSummary=JSON.parse(savedSummaryText);
    staleSummary.results.B1.exitConfirmed=true;
    fs.writeFileSync(summaryFile,JSON.stringify(staleSummary),'utf8');
    assert.throws(()=>preflightResumeLedger(workspace,runId),/reconcile|unresolved|exit.*unproven/i);
    fs.writeFileSync(summaryFile,savedSummaryText,'utf8');
    const result=JSON.parse(fs.readFileSync(controlledResultFile,'utf8'));
    fs.writeFileSync(controlledResultFile,JSON.stringify({...result,token:'foreign-attempt-token'}),'utf8');
    assert.throws(()=>preflightResumeLedger(workspace,runId),/Headless result identity mismatch/);
    fs.writeFileSync(controlledResultFile,JSON.stringify(result),'utf8');
    await assert.rejects(()=>runWindows('',{...hooks,spawn:async()=>{resumeSpawned++;throw new Error('resume attempted a new launcher');}},{...options,resume:true}),/reconcile|unresolved|exit.*unproven/i);
    assert.equal(resumeSpawned,0,'resume must reject before it can launch another block worker');
  }finally{
    fs.renameSync=originalRename;
    fs.rmSync(workspace,{recursive:true,force:true});
  }
});

test('publisher failure after an unresolved child result still retains the lease and artifacts',async()=>{
  const workspace=fs.mkdtempSync(path.join(family,'headless-unresolved-publish-failure-'));
  const runId='headless-unresolved-publish-failure';
  const base=createHeadlessHooks({workspace,cli:process.execPath,args:[],timeoutMs:30000,workerEntry:testWorker});
  const launcherIdentity=processSnapshot().get(process.pid);
  assert.ok(launcherIdentity,'test process must have a durable launcher identity');
  let closes=0,cleanups=0,unregisters=0,entry;
  const hooks={...base,
    plan:async()=>[{title:'unresolved child publish failure',tasks:[{prompt:'retain despite publisher failure'}]}],compact:value=>value,infer:()=>[],prompt:value=>value,
    register:()=>{},commit:()=>{},unregister:()=>{unregisters++;},cleanup:()=>{cleanups++;},
    spawn:async(_lp,_title,pidf)=>{fs.writeFileSync(pidf,String(launcherIdentity.ProcessId),'utf8');return true;},readPid:()=>launcherIdentity.ProcessId,identity:()=>launcherIdentity,
    verifyStartup:async()=>null,ready:()=>{},close:async()=>{closes++;},waitForExit:async()=>false,session:async()=> 'fixture',
    wait:async()=>({done:false,exitCode:null,text:'Headless child remains unresolved',childStillRunning:true,exitUnproven:true,terminationRefused:true}),
  };
  try{
    const sum=await runWindows('retain despite publisher failure',hooks,{workspace,capacity:1,executionMode:'headless',runId,
      coordinator:path.join(controllerRoot,'unresolved-publish-failure-coordinator'),auth:'Controlled execution',maxAttempts:1,timeoutMs:30000,
      onEvent:event=>{if(event.type==='block.B1.needs-reconciliation')throw new Error('injected status publisher failure');}});
    entry=sum.results.B1;
    assert.equal(sum.success,false);
    assert.equal(entry.status,'needs-reconciliation',JSON.stringify({entry,taskResults:sum.taskResults,finalSweep:sum.finalSweep}));
    assert.equal(entry.exitConfirmed,false);
    assert.ok(entry.exitUnprovenAt);
    assert.deepEqual(entry.headlessChildState,{childStillRunning:true,exitUnproven:true,terminationRefused:true});
    assert.equal(closes,0,'a publisher failure must not close the unresolved child path');
    assert.equal(cleanups,0,'a publisher failure must not remove reconciliation artifacts');
    assert.equal(unregisters,0,'a publisher failure must not release the capacity lease');
    assert.equal(sum.finalSweep.retained,1);
    assert.equal(fs.existsSync(path.join(runDirectory(workspace,runId),'verification-report.jsonl')),false,'parent verification must remain bypassed');
    for(const file of [entry.launcherFiles.lp,entry.launcherFiles.pf,entry.launcherFiles.pidf])assert.equal(fs.existsSync(file),true,'retain '+path.basename(file));
  }finally{
    fs.rmSync(workspace,{recursive:true,force:true});
  }
});

test('outer cleanup preserves an unresolved headless-child reconciliation state',async()=>{
  const childState={childStillRunning:true,exitUnproven:true,terminationRefused:true};
  const attempt={runId:'headless-unresolved-sweep',token:'bound-attempt',taskIds:['T001']};
  const entry={status:'needs-reconciliation',exitConfirmed:false,headlessChildState:{...childState},attempts:[attempt],
    launcherFiles:{mode:'headless',lp:'unused.lp',pf:'unused.pf',pidf:'unused.pid',rf:'unused.result.json'}};
  const sum={runId:'headless-unresolved-sweep',blocks:[{key:'B1',taskIds:['T001']}],results:{B1:entry}};
  let closes=0;
  const stats=await sweepRunProcesses(sum,{close:async()=>{closes++;}});
  assert.deepEqual(stats,{checked:1,closed:0,failed:0,retained:1});
  assert.equal(entry.status,'needs-reconciliation');
  assert.equal(entry.exitConfirmed,false);
  assert.ok(entry.exitUnprovenAt,'outer cleanup must persist exit-unproven evidence');
  assert.equal(attempt.exitUnprovenAt,entry.exitUnprovenAt);
  assert.deepEqual(entry.headlessChildState,childState);
  assert.equal(closes,0,'outer cleanup must not close an unresolved child path');
});

test('a claimed launcher exit cannot bypass an unresolved headless child',async()=>{
  const childState={childStillRunning:true,exitUnproven:true,terminationRefused:true};
  const attempt={runId:'headless-forged-exit-sweep',token:'bound-attempt',taskIds:['T001']};
  let launcherArtifactReads=0;
  const launcherFiles={mode:'headless',
    get lp(){launcherArtifactReads++;return 'unused.lp';},
    get pf(){launcherArtifactReads++;return 'unused.pf';},
    get pidf(){launcherArtifactReads++;return 'unused.pid';},
    get rf(){launcherArtifactReads++;return 'unused.result.json';},
  };
  const entry={status:'needs-reconciliation',exitConfirmed:true,headlessChildState:{...childState},attempts:[attempt],launcherFiles};
  const sum={runId:'headless-forged-exit-sweep',blocks:[{key:'B1',taskIds:['T001']}],results:{B1:entry}};
  const stats=await sweepRunProcesses(sum,{close:async()=>{throw new Error('must not close a child-unresolved headless launcher');}});
  assert.deepEqual(stats,{checked:1,closed:0,failed:0,retained:1});
  assert.equal(launcherArtifactReads,0,'the child-reconciliation state must win before any launcher artifact is inspected');
  assert.equal(entry.status,'needs-reconciliation');
  assert.equal(entry.exitConfirmed,true,'the sweep must not rewrite a claimed launcher result before explicit reconciliation');
  assert.deepEqual(entry.headlessChildState,childState);
});

test('a rejected isolated startup receipt blocks ready and retains the lease for reconciliation',async()=>{
  const f=fixture();let readyCalls=0,unregisterCalls=0;
  f.hooks.verifyStartup=async()=>{throw new Error('ISOLATED_ACCEPTANCE_STARTUP_RECEIPT: injected receipt mismatch');};
  const releaseReady=f.hooks.ready;
  f.hooks.ready=files=>{readyCalls++;releaseReady(files);};
  f.hooks.unregister=()=>{unregisterCalls++;};
  try{
    const sum=await runWindows('执行甲；执行乙',f.hooks,{...f.options,maxAttempts:1,timeoutMs:30000});
    const entry=sum.results.B1;
    assert.equal(readyCalls,0,'the executor must never release the worker go latch after receipt rejection');
    assert.equal(entry.status,'needs-reconciliation');
    assert.equal(entry.exitConfirmed,false);
    assert.ok(entry.exitUnprovenAt,'receipt rejection must retain recovery evidence');
    assert.equal(unregisterCalls,0,'the lease must remain until explicit reconciliation');
  }finally{
    const pid=f.hooks.readPid(path.join(controllerRoot,'missing.pid'));
    if(pid)await f.hooks.close(pid);
    await pause(250);fs.rmSync(f.workspace,{recursive:true,force:true});
  }
});
test('controller restart adopts the same hidden worker without repeating completed side effects',async()=>{
  const f=fixture();fs.writeFileSync(path.join(f.workspace,'hold'),'hold');
  const controller=path.join(f.workspace,'controller.mjs'),runner=new URL('../scripts/core/runner.mjs',import.meta.url).href,executor=new URL('../scripts/core/headless-executor.mjs',import.meta.url).href;
  fs.writeFileSync(controller,`import {runWindows} from ${JSON.stringify(runner)};import {createHeadlessHooks} from ${JSON.stringify(executor)};
// A killed controller can leave an abandoned coordinator mutex whose recovery
// is deliberately bounded but slow on a busy hosted runner; give this restart
// fixture the same headroom the recovery path needs.
const options=${JSON.stringify({...f.options,timeoutMs:300000})};
const hooks={...createHeadlessHooks({workspace:options.workspace,cli:process.execPath,args:[${JSON.stringify(f.cli)}],timeoutMs:300000,workerEntry:${JSON.stringify(testWorker)}}),plan:async()=>[{title:'linked',tasks:[{prompt:'执行甲'},{prompt:'执行乙'}]}],compact:p=>p,infer:()=>[],prompt:p=>p,register:()=>{},commit:()=>{},unregister:()=>{}};
const sum=await runWindows(process.argv[2]?'':'执行甲；执行乙',hooks,{...options,resume:!!process.argv[2]});process.exitCode=sum.success?0:1;`);
  const children=[];let first;
  const start=resume=>{const child=spawn(process.execPath,[controller,...(resume?['resume']:[])],{windowsHide:true,stdio:['ignore','pipe','pipe']});children.push(child);child.stdout.resume();child.stderr.resume();return child;};
  // Windows CIM identity snapshots can queue behind unrelated controllers on a
  // busy host. Keep the restart assertion bounded, while allowing the real
  // hidden-worker fixture to reach its durable checkpoint.
  const waitFor=async condition=>{const end=Date.now()+300000;while(Date.now()<end){try{if(condition())return;}catch{}await pause(100);}throw new Error('Controlled worker readiness timed out');};
  try{
    const parent=start(false);
    const cp=path.join(path.dirname(f.summary),'attempts','B1','1','checkpoints','T002.json');
    await waitFor(()=>fs.existsSync(cp));first=JSON.parse(fs.readFileSync(f.summary));
    const parentExit=new Promise(resolve=>parent.once('close',resolve));parent.kill();await parentExit;
    assert.ok(sameProcess(first.results.B1.launcher,processSnapshot().get(first.results.B1.launcher.ProcessId)));
    const resumed=start(true),finished=new Promise(resolve=>resumed.once('close',resolve));
    await waitFor(()=>JSON.parse(fs.readFileSync(f.summary)).generation===2);
    fs.writeFileSync(path.join(f.workspace,'release'),'go');
    assert.equal(await finished,0);
    const final=JSON.parse(fs.readFileSync(f.summary));
    assert.equal(final.success,true);assert.equal(final.results.B1.attempts.length,1);
    assert.equal(final.results.B1.exitConfirmed,true,'the resumed controller must bind the completed worker exit to its original attempt');
    assert.equal(final.results.B1.exitEvidence.token,first.results.B1.attempts[0].token);
    assert.equal(final.results.B1.launcher.ProcessId,first.results.B1.launcher.ProcessId);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.workspace,'count.json'))).count,1);
  }finally{
    fs.writeFileSync(path.join(f.workspace,'release'),'cleanup');
    for(const child of children)if(child.exitCode===null)child.kill();
    if(first){const e=first.results.B1;f.hooks.identity(e.launcher.ProcessId,e.launcherFiles.pidf);await f.hooks.close(e.launcher.ProcessId,e.launcher);}
    await pause(1000);fs.rmSync(f.workspace,{recursive:true,force:true});
  }
});

test('a failed admission commit never starts headless task execution or waits for a blocked worker',async()=>{
  const f=fixture();let waited=false;
  f.hooks.commit=()=>{throw new Error('Injected registry commit failure');};
  f.hooks.wait=async()=>{waited=true;throw new Error('Must not wait after admission failed');};
  try{
    const sum=await runWindows('执行甲；执行乙',f.hooks,{...f.options,maxAttempts:1});
    assert.equal(sum.success,false);assert.equal(waited,false);
    assert.equal(fs.existsSync(path.join(f.workspace,'count.json')),false);
    const entry=sum.results.B1;
    assert.equal(sameProcess(entry.launcher,processSnapshot().get(entry.launcher.ProcessId)),false);
  }finally{await pause(500);fs.rmSync(f.workspace,{recursive:true,force:true});}
});
