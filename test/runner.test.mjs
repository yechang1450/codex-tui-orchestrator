import {testTempFamily} from './test-temp-root.mjs';
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {runWindows,runDirectory,verifyRun,identifyWithRetry,checkpointCommand} from '../scripts/core/runner.mjs';
import {controllerWindowsDir} from '../scripts/core/controller-state.mjs';
const family=testTempFamily('runner');
fs.mkdirSync(family,{recursive:true});
const controllerRoot=fs.mkdtempSync(path.join(family,'runner-controller-'));
const oldControllerRoot=process.env.ORCH_CONTROLLER_ROOT;
process.env.ORCH_CONTROLLER_ROOT=controllerRoot;
after(()=>{if(oldControllerRoot===undefined)delete process.env.ORCH_CONTROLLER_ROOT;else process.env.ORCH_CONTROLLER_ROOT=oldControllerRoot;fs.rmSync(controllerRoot,{recursive:true,force:true});});

test('checkpoint command preserves PowerShell-special paths and uses the current Node executable', t => {
  if (process.platform !== 'win32') return t.skip('PowerShell command contract is Windows-only');
  const root = fs.mkdtempSync(path.join(family, 'runner-checkpoint-command-'));
  const special = path.join(root, "literal $('value')-%ORCH_CHECKPOINT_TEST%! '");
  fs.mkdirSync(special, {recursive: true});
  const helper = path.join(special, 'capture.mjs');
  const capture = path.join(root, 'capture.json');
  const attemptFile = path.join(special, "attempt $('arg')-%ORCH_CHECKPOINT_TEST%! '.json");
  fs.writeFileSync(helper, "import fs from 'node:fs'; fs.writeFileSync(process.env.CAPTURE_FILE, JSON.stringify(process.argv.slice(2)));\n", 'utf8');
  const command = checkpointCommand(helper, attemptFile, 'T001', 'started');
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command', command,
  ], {encoding: 'utf8', windowsHide: true, env: {...process.env, CAPTURE_FILE: capture}});
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${command}`);
  assert.deepEqual(JSON.parse(fs.readFileSync(capture, 'utf8')), [attemptFile, 'T001', 'started']);
  assert.ok(command.startsWith(`& '${String(process.execPath).replaceAll("'", "''")}'`));
});
test('transient process-enumeration failures retry instead of failing the whole block',async()=>{
  let calls=0;
  const sleep=[];
  const identity=await identifyWithRetry(()=>{calls++;if(calls<3)throw new Error('Cannot verify process identities');return {ProcessId:42};},7,'exec-B1.pid',{pauseMs:ms=>{sleep.push(ms);return Promise.resolve();}});
  assert.equal(calls,3);
  assert.deepEqual(sleep,[300,600],'重试之间保持有界退避');
  assert.equal(identity.ProcessId,42);
  let attempts=0;
  await assert.rejects(()=>identifyWithRetry(()=>{attempts++;throw new Error('Cannot verify process identities');},7,'exec-B1.pid',{pauseMs:()=>Promise.resolve()}),/Cannot verify process identities/);
  assert.equal(attempts,3,'重试次数必须有上限，不能无限重试');
  let mismatched=0;
  assert.equal(await identifyWithRetry(()=>{mismatched++;return null;},7,'exec-B1.pid',{pauseMs:()=>Promise.resolve()}),null,'身份不匹配不是枚举故障，不重试');
  assert.equal(mismatched,1);
});
test('identity retry consumes one execution deadline and never probes after it',async()=>{
  const startedAt=10_000,deadlineAt=10_100;
  let now=startedAt,calls=0;
  const callsAt=[],pauses=[];
  await assert.rejects(() => identifyWithRetry(
      () => {
        calls++;
        callsAt.push(now);
        throw new Error('Cannot verify process identities');
      },
      7,
      'exec-B1.pid',
      {
        attempts:3,
        deadlineAt,
        now:()=>now,
        pauseMs:async ms=>{
          pauses.push(ms);
          now+=ms;
        },
      },
    ));
  assert.equal(calls,1,'a retry must not begin after its shared deadline');
  assert.ok(callsAt.every(at=>at<deadlineAt),'identity probes must occur strictly before the deadline');
  assert.ok(pauses.reduce((total,ms)=>total+ms,0)<=deadlineAt-startedAt,'retry sleep must not extend the execution deadline');
});
test('capacity retry sleep consumes the original execution deadline',async()=>{
 const workspace=fs.mkdtempSync(path.join(family,'runner-capacity-deadline-'));
 const original={
  ORCH_CAPACITY_RETRIES:process.env.ORCH_CAPACITY_RETRIES,
  ORCH_CAPACITY_RETRY_MS:process.env.ORCH_CAPACITY_RETRY_MS,
  ORCH_CAPACITY_RETRY_MAX_MS:process.env.ORCH_CAPACITY_RETRY_MAX_MS,
 };
 process.env.ORCH_CAPACITY_RETRIES='1';
 process.env.ORCH_CAPACITY_RETRY_MS='100';
 process.env.ORCH_CAPACITY_RETRY_MAX_MS='100';
 const executionDeadlineAt=Date.now()+60_000;
 let now=executionDeadlineAt-25,launches=0,live=false;
 const pauses=[];
 const identity={ProcessId:9011,Name:'powershell.exe',Started:'deadline-fixture',CommandLine:'deadline fixture'};
 const hooks={
  plan:async()=>[{title:'capacity deadline',tasks:[{prompt:'执行任务'}]}],
  compact:value=>value,infer:()=>[],prompt:value=>value,
  launcher:(key,_prompt,suffix)=>{
   launches++;
   const dir=controllerWindowsDir(workspace),stem=key+'-'+suffix;
   return {lp:path.join(dir,'win-launch-'+stem+'.ps1'),pf:path.join(dir,'agent-win-'+stem+'.md'),pidf:path.join(dir,'window-'+stem+'.pid'),rf:path.join(dir,'win-'+stem+'.result.json')};
  },
  register:()=>{},commit:()=>{},unregister:()=>{},cleanup:()=>{},
  spawn:async()=>{live=true;return true;},
  readPid:()=>identity.ProcessId,
  identity:()=>live?identity:null,
  waitForExit:async()=>true,
  close:async()=>{live=false;},
  session:async()=>true,
  wait:async()=>({done:true,verified:false,exitCode:1,retryable:'capacity',capacityError:'Selected model is at capacity',text:'Selected model is at capacity'}),
  exitCode:()=>1,
 };
 try{
  const sum=await runWindows('执行任务',hooks,{
   workspace,capacity:1,runId:'capacity-deadline',auth:'test',
   coordinator:path.join(controllerRoot,'capacity-deadline-coordinator'),
   timeoutMs:60_000,executionDeadlineAt,
   now:()=>now,
   pauseMs:async ms=>{
    pauses.push(ms);
    now+=ms;
   },
  });
  assert.equal(launches,1,'capacity retry must not create a second attempt after the original deadline');
  assert.equal(pauses.length,1,'the bounded capacity retry must use the runner pause seam once');
  assert.ok(pauses[0]<=25,'capacity retry sleep must be capped by the remaining execution budget');
  assert.ok(now>=executionDeadlineAt,'the bounded retry must consume the remaining execution budget');
  assert.equal(sum.results.B1.status,'timeout');
 }finally{
  if(original.ORCH_CAPACITY_RETRIES===undefined)delete process.env.ORCH_CAPACITY_RETRIES;else process.env.ORCH_CAPACITY_RETRIES=original.ORCH_CAPACITY_RETRIES;
  if(original.ORCH_CAPACITY_RETRY_MS===undefined)delete process.env.ORCH_CAPACITY_RETRY_MS;else process.env.ORCH_CAPACITY_RETRY_MS=original.ORCH_CAPACITY_RETRY_MS;
  if(original.ORCH_CAPACITY_RETRY_MAX_MS===undefined)delete process.env.ORCH_CAPACITY_RETRY_MAX_MS;else process.env.ORCH_CAPACITY_RETRY_MAX_MS=original.ORCH_CAPACITY_RETRY_MAX_MS;
  fs.rmSync(workspace,{recursive:true,force:true});
 }
});
test('runWindows rejects malformed capacity before creating run state',async()=>{
 const workspace=fs.mkdtempSync(path.join(family,'runner-capacity-'));
 try {
  await assert.rejects(()=>runWindows('执行任务',{}, {workspace,runId:'invalid-capacity',capacity:0}),/capacity must be a positive integer/);
  assert.equal(fs.existsSync(path.join(workspace,'temp','orchestrator','runs','invalid-capacity')),false);
 } finally { fs.rmSync(workspace,{recursive:true,force:true}); }
});
test('failed prerequisite retains both original tasks and never starts its dependent',async()=>{
 fs.mkdirSync(family,{recursive:true});const workspace=fs.mkdtempSync(path.join(family,'runner-'));
 fs.mkdirSync(path.join(workspace,'temp'),{recursive:true});
 let launches=0;const prompts=[];
 const hooks={
  plan:async()=>[{title:'A',tasks:[{prompt:'执行甲'}]},{title:'B',dependsOn:['A'],tasks:[{prompt:'执行乙'}]}],
  compact:p=>p,infer:()=>[],prompt:p=>{prompts.push(p);return p;},
  launcher:(key,_prompt,suffix)=>{launches++;const dir=controllerWindowsDir(workspace),stem=key+'-'+suffix;return{lp:path.join(dir,'win-launch-'+stem+'.ps1'),pf:path.join(dir,'agent-win-'+stem+'.md'),pidf:path.join(dir,'window-'+stem+'.pid'),rf:path.join(dir,'win-'+stem+'.result.json')};},
  register:()=>{},unregister:()=>{},cleanup:()=>{},spawn:async()=>({ok:false,noProcess:true}),readPid:()=>0,
 };
 try{
  const sum=await runWindows('执行甲；执行乙',hooks,{workspace,capacity:8,runId:'failure',auth:'test',coordinator:path.join(controllerRoot,'coordinator')});
  assert.equal(launches,2);assert.equal(sum.success,false);
  assert.match(prompts[0],/Global TodoList/);
  assert.match(prompts[0],/Current block TodoList/);
  assert.deepEqual(Object.keys(sum.taskResults),['T001','T002']);
  assert.equal(sum.taskResults.T001.status,'failed');assert.equal(sum.taskResults.T002.status,'blocked');
  const manifest=JSON.parse(fs.readFileSync(path.join(runDirectory(workspace,'failure'),'manifest.json'),'utf8'));
  assert.equal(manifest.tasks.length,2);
  assert.deepEqual(manifest.todoList.map(t=>t.id),['T001','T002']);
  const goal=JSON.parse(fs.readFileSync(path.join(runDirectory(workspace,'failure'),'goal.json'),'utf8'));
  assert.equal(goal.status,'failed');
  assert.deepEqual(goal.tasks.map(t=>t.id),['T001','T002']);
  await assert.rejects(()=>runWindows('执行甲',hooks,{workspace,capacity:8,runId:'failure'}),/already exists/);
  assert.throws(()=>verifyRun(workspace,'other-run'),/Run ledger not found/);
 }finally{await new Promise(r=>setTimeout(r,500));fs.rmSync(workspace,{recursive:true,force:true});}
});
test('one dynamic run shares one background memory sample across active windows and disposes it on exit',async()=>{
 const workspace=fs.mkdtempSync(path.join(family,'runner-memory-sampler-'));
 const originalSetInterval=globalThis.setInterval,originalClearInterval=globalThis.clearInterval,originalFreeMem=os.freemem;
 const timers=[],waiters=new Map(),live=new Set(),pids={B1:9301,B2:9302};
 const identities=new Map(Object.entries(pids).map(([key,pid])=>[pid,{ProcessId:pid,Name:'powershell.exe',Started:'memory-sampler-'+key,CommandLine:'memory sampler '+key}]));
 let sampleCalls=0,sampleSignal=null,run;
  // Windows process-identity verification is intentionally bounded by the
  // coordinator's WMI deadline. On a loaded host two valid concurrent
  // admissions can take longer than an arbitrary ten-second fixture poll;
  // keep the test finite without declaring that safe verification a failure.
  const waitFor=async(predicate,label,timeoutMs=60_000)=>{
   const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,10));}
  throw new Error(label);
 };
 try{
  os.freemem=()=>8*1024**3;
  globalThis.setInterval=(callback,delay,...args)=>{const timer={callback,delay,args,cleared:false};timers.push(timer);return timer;};
  globalThis.clearInterval=timer=>{if(timer)timer.cleared=true;};
  const hooks={
   plan:async()=>[
    {title:'memory one',dependsOn:[],conflictKeys:[],tasks:[{prompt:'one'}]},
    {title:'memory two',dependsOn:[],conflictKeys:[],tasks:[{prompt:'two'}]},
   ],
   compact:value=>value,infer:()=>[],prompt:value=>value,
   launcher:(key,_prompt,suffix)=>{const dir=controllerWindowsDir(workspace),stem=key+'-'+suffix;const files={lp:path.join(dir,'win-launch-'+stem+'.ps1'),pf:path.join(dir,'agent-win-'+stem+'.md'),pidf:path.join(dir,'window-'+stem+'.pid'),rf:path.join(dir,'win-'+stem+'.result.json')};fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(files.lp,'fixture launcher');fs.writeFileSync(files.pf,'fixture prompt');return files;},
   register:()=>{},commit:()=>{},unregister:()=>{},cleanup:()=>{},
   spawn:async(_launchScript,_title,pidFile)=>{const key=Object.keys(pids).find(candidate=>pidFile.includes(candidate));live.add(pids[key]);return true;},
   readPid:pidFile=>pids[Object.keys(pids).find(key=>pidFile.includes(key))],
   identity:pid=>live.has(pid)?identities.get(pid):null,
   close:async pid=>{live.delete(pid);},waitForExit:async()=>true,
   session:async(_token,_timeout,resultFile)=>resultFile,
   wait:async session=>new Promise(resolve=>waiters.set(session,resolve)),
   exitCode:()=>1,
   sampleProcessSnapshot:async({signal})=>{
    sampleCalls++;sampleSignal=signal;
    return new Map([
      [9301,{ProcessId:9301,ParentProcessId:0,WorkingSet64:128*1024**2}],
      [9302,{ProcessId:9302,ParentProcessId:0,WorkingSet64:256*1024**2}],
    ]);
   },
  };
  run=runWindows('one; two',hooks,{workspace,capacity:2,runId:'memory-sampler',auth:'test',maxAttempts:1,
    coordinator:path.join(controllerRoot,'memory-sampler-coordinator'),memoryBudget:{mode:'dynamic',floorMB:1000,windowCostMB:256,headroom:1}});
  await waitFor(()=>waiters.size===2,'both dynamic windows did not reach the controlled session wait');
  const memoryTimers=timers.filter(timer=>timer.delay===5_000);
  assert.equal(memoryTimers.length,1,'one run must install exactly one shared five-second memory sampler');
  memoryTimers[0].callback(...memoryTimers[0].args);
  await waitFor(()=>sampleCalls===1,'the shared memory sampler did not invoke its snapshot hook');
  assert.ok(sampleSignal instanceof AbortSignal,'the sampler hook must receive the run cancellation signal');
  for(const resolve of waiters.values())resolve({done:true,verified:false,exitCode:1,text:'fixture complete'});
  const sum=await run;run=null;
  assert.equal(sum.results.B1.peakProcessMB,128,'the first active window must receive the shared sample');
  assert.equal(sum.results.B2.peakProcessMB,256,'the second active window must receive the same shared sample');
  assert.equal(sampleSignal.aborted,true,'run cleanup must cancel any future background sampling');
  assert.equal(memoryTimers[0].cleared,true,'run cleanup must clear the shared sampler timer');
  memoryTimers[0].callback(...memoryTimers[0].args);
  await Promise.resolve();
  assert.equal(sampleCalls,1,'a disposed sampler must not start a late replacement snapshot');
 }finally{
  for(const resolve of waiters.values())resolve({done:true,verified:false,exitCode:1,text:'fixture cleanup'});
  if(run)await Promise.race([run.catch(()=>{}),new Promise(resolve=>setTimeout(resolve,15_000))]);
  globalThis.setInterval=originalSetInterval;globalThis.clearInterval=originalClearInterval;os.freemem=originalFreeMem;
  fs.rmSync(workspace,{recursive:true,force:true});
 }
});

test('a dynamic sampler-hook initialization failure releases the claimed run owner',async()=>{
 const workspace=fs.mkdtempSync(path.join(family,'runner-memory-sampler-init-'));
 const coordinator=fs.mkdtempSync(path.join(family,'runner-memory-sampler-init-controller-'));
 let hookReads=0;
 const hooks={};
 Object.defineProperty(hooks,'sampleProcessSnapshot',{
  get(){hookReads++;throw new Error('synthetic sampler hook getter failure');},
 });
 try{
  await assert.rejects(
   ()=>runWindows('one',hooks,{workspace,capacity:1,runId:'sampler-init-failure',auth:'test',coordinator,
    memoryBudget:{mode:'dynamic',floorMB:1000,windowCostMB:256,headroom:1}}),
   /synthetic sampler hook getter failure/,
  );
  assert.equal(hookReads,1);
  const owners=JSON.parse(fs.readFileSync(path.join(coordinator,'run-owners.json'),'utf8'));
  assert.deepEqual(owners,{},'a failed sampler initializer must not strand a run-owner claim');
 }finally{
  fs.rmSync(workspace,{recursive:true,force:true});
  fs.rmSync(coordinator,{recursive:true,force:true});
 }
});

test('an in-flight spawn hook reaches the execution deadline, receives cancellation, and retains recovery state',async()=>{
 const workspace=fs.mkdtempSync(path.join(family,'runner-hook-deadline-spawn-'));
 const coordinator=path.join(controllerRoot,'hook-deadline-spawn-coordinator');
 const executionDeadlineAt=Date.now()+60_000;
 // Lease transactions use the real absolute timestamp above.  Keep the
 // runner's logical clock just before it so this fixture isolates the external
 // hook deadline instead of timing out during Windows coordinator setup.
 const now=()=>executionDeadlineAt-180;
 let spawnContext,resolveSpawn,lateTouches=0,closes=0,unregisters=0,cleanups=0,run;
 const waitFor=async(predicate,label,timeoutMs=60_000)=>{
  const until=Date.now()+timeoutMs;
  while(Date.now()<until){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,10));}
  throw new Error(label);
 };
 try{
  const hooks={
   plan:async()=>[{title:'deadline fixture',tasks:[{prompt:'wait for execution deadline'}]}],
   compact:value=>value,infer:()=>[],prompt:value=>value,
   launcher:(key,_prompt,suffix)=>{const dir=controllerWindowsDir(workspace),stem=key+'-'+suffix;const files={lp:path.join(dir,'win-launch-'+stem+'.ps1'),pf:path.join(dir,'agent-win-'+stem+'.md'),pidf:path.join(dir,'window-'+stem+'.pid'),rf:path.join(dir,'win-'+stem+'.result.json')};fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(files.lp,'fixture launcher');fs.writeFileSync(files.pf,'fixture prompt');return files;},
   register:()=>{},commit:()=>{},
   unregister:()=>{unregisters++;},cleanup:()=>{cleanups++;},close:async()=>{closes++;},waitForExit:async()=>true,
   spawn:async(_lp,_title,_pidf,_retries,_token,context)=>new Promise(resolve=>{
    spawnContext=context;
    resolveSpawn=()=>{lateTouches++;resolve({ok:false,noProcess:true});};
   }),
   readPid:()=>0,
  };
  run=runWindows('wait for execution deadline',hooks,{workspace,capacity:1,runId:'hook-deadline-spawn',auth:'test',coordinator,
   timeoutMs:60_000,executionDeadlineAt,now,maxAttempts:1});
  await waitFor(()=>spawnContext,'spawn hook was not reached');
  const settled=await Promise.race([
   run.then(sum=>({sum})),
   new Promise(resolve=>setTimeout(()=>resolve({timedOut:true}),1_500)),
  ]);
  assert.equal(settled.timedOut,undefined,'the runner must settle without waiting for an uncooperative spawn hook');
  const sum=settled.sum;
  assert.equal(spawnContext.deadlineAt,executionDeadlineAt,'the hook must receive the shared absolute deadline');
  assert.equal(spawnContext.stage,'execution spawn');
  assert.ok(spawnContext.signal instanceof AbortSignal,'the hook must receive a cancellation signal');
  assert.equal(spawnContext.signal.aborted,true,'deadline expiry must abort the in-flight hook');
  assert.equal(sum.results.B1.status,'needs-reconciliation');
  assert.ok(sum.results.B1.exitUnprovenAt,'the retained attempt must record that launcher exit is unproven');
  assert.equal(sum.taskResults.T001.status,'needs-reconciliation');
  assert.equal(sum.finalSweep.retained,1,'the final sweep must retain an in-flight external execution hook');
  const attemptFile=sum.results.B1.attempts.at(-1).file;
  assert.ok(fs.existsSync(attemptFile),'the durable attempt must remain available for reconciliation');
  assert.ok(JSON.parse(fs.readFileSync(attemptFile,'utf8')).exitUnprovenAt,'the durable attempt must record hook uncertainty');
  assert.ok(fs.existsSync(sum.results.B1.launcherFiles.lp),'the launcher artifact must remain available for reconciliation');
  assert.ok(fs.existsSync(sum.results.B1.launcherFiles.pf),'the prompt artifact must remain available for reconciliation');
  const leases=JSON.parse(fs.readFileSync(path.join(coordinator,'leases.json'),'utf8'));
  assert.ok(leases.some(lease=>lease.id===sum.results.B1.leaseId),'the lease must remain held while the hook might still create a launcher');
  assert.equal(closes,0,'the controller must not close an externally in-flight launcher');
  assert.equal(unregisters,0,'the controller must not unregister a retained lease');
  assert.equal(cleanups,0,'the controller must not delete retained recovery files');
  resolveSpawn();
  await new Promise(resolve=>setTimeout(resolve,25));
  assert.equal(lateTouches,1,'the fixture must prove the external hook completed only after retention');
  assert.equal(sum.results.B1.status,'needs-reconciliation','a late hook result must not rewrite retained state');
  assert.equal(closes,0);assert.equal(unregisters,0);assert.equal(cleanups,0);
  run=null;
 }finally{
  resolveSpawn?.();
  if(run)await Promise.race([run.catch(()=>{}),new Promise(resolve=>setTimeout(resolve,15_000))]);
  fs.rmSync(workspace,{recursive:true,force:true});
 }
});

test('a retention status-event failure cannot downgrade an in-flight spawn hook',async()=>{
 const workspace=fs.mkdtempSync(path.join(family,'runner-hook-deadline-status-failure-'));
 const coordinator=path.join(controllerRoot,'hook-deadline-status-failure-coordinator');
 const executionDeadlineAt=Date.now()+60_000;
 const now=()=>executionDeadlineAt-180;
 let spawnContext,resolveSpawn,closes=0,unregisters=0,cleanups=0,waitForExitCalls=0,retainedEventFailures=0,run;
 const waitFor=async(predicate,label,timeoutMs=60_000)=>{
  const until=Date.now()+timeoutMs;
  while(Date.now()<until){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,10));}
  throw new Error(label);
 };
 try{
  const hooks={
   plan:async()=>[{title:'retained hook status failure',tasks:[{prompt:'retain the launcher after a status sink failure'}]}],
   compact:value=>value,infer:()=>[],prompt:value=>value,
   launcher:(key,_prompt,suffix)=>{const dir=controllerWindowsDir(workspace),stem=key+'-'+suffix;const files={lp:path.join(dir,'win-launch-'+stem+'.ps1'),pf:path.join(dir,'agent-win-'+stem+'.md'),pidf:path.join(dir,'window-'+stem+'.pid'),rf:path.join(dir,'win-'+stem+'.result.json')};fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(files.lp,'fixture launcher');fs.writeFileSync(files.pf,'fixture prompt');return files;},
   register:()=>{},commit:()=>{},unregister:()=>{unregisters++;},cleanup:()=>{cleanups++;},close:async()=>{closes++;},waitForExit:async()=>{waitForExitCalls++;return true;},
   spawn:async(_lp,_title,_pidf,_retries,_token,context)=>new Promise(resolve=>{spawnContext=context;resolveSpawn=resolve;}),
   readPid:()=>0,
  };
  run=runWindows('retain the launcher after a status sink failure',hooks,{workspace,capacity:1,runId:'hook-deadline-status-failure',auth:'test',coordinator,
   timeoutMs:60_000,executionDeadlineAt,now,maxAttempts:1,onEvent:event=>{
    if(event.type==='block.B1.needs-reconciliation'){retainedEventFailures++;throw new Error('synthetic retained status sink failure');}
   }});
  await waitFor(()=>spawnContext,'spawn hook was not reached');
  const settled=await Promise.race([
   run.then(sum=>({sum})),
   new Promise(resolve=>setTimeout(()=>resolve({timedOut:true}),1_500)),
  ]);
  assert.equal(settled.timedOut,undefined,'retention must not wait for an uncooperative hook after a status callback failure');
  const sum=settled.sum;
  assert.equal(sum.results.B1.status,'needs-reconciliation');
  assert.equal(sum.results.B1.exitConfirmed,false);
  assert.ok(sum.results.B1.exitUnprovenAt);
  assert.equal(sum.taskResults.T001.status,'needs-reconciliation');
  assert.deepEqual(sum.finalSweep,{checked:1,closed:0,failed:0,retained:1});
  assert.equal(sum.success,false);assert.equal(retainedEventFailures,1);assert.equal(waitForExitCalls,0);
  const durableAttempt=JSON.parse(fs.readFileSync(sum.results.B1.attempts.at(-1).file,'utf8'));
  assert.equal(durableAttempt.exitUnprovenAt,sum.results.B1.exitUnprovenAt);assert.notEqual(durableAttempt.exitConfirmed,true);
  const durableSummary=JSON.parse(fs.readFileSync(path.join(runDirectory(workspace,'hook-deadline-status-failure'),'summary.json'),'utf8'));
  assert.equal(durableSummary.results.B1.status,'needs-reconciliation');assert.equal(durableSummary.results.B1.exitUnprovenAt,sum.results.B1.exitUnprovenAt);
  const events=fs.readFileSync(path.join(runDirectory(workspace,'hook-deadline-status-failure'),'events.jsonl'),'utf8').trim().split('\n').map(JSON.parse).map(event=>event.type);
  assert.ok(events.includes('block.B1.needs-reconciliation'));
  assert.equal(events.some(type=>['block.B1.failed','block.B1.popup-failed','run.cleanup-failed'].includes(type)),false);
  const leases=JSON.parse(fs.readFileSync(path.join(coordinator,'leases.json'),'utf8'));
  assert.ok(leases.some(lease=>lease.id===sum.results.B1.leaseId));
  assert.ok(fs.existsSync(sum.results.B1.launcherFiles.lp));assert.ok(fs.existsSync(sum.results.B1.launcherFiles.pf));
  assert.equal(closes,0);assert.equal(unregisters,0);assert.equal(cleanups,0);
  resolveSpawn?.({ok:false,noProcess:true});await new Promise(resolve=>setTimeout(resolve,25));
  assert.equal(sum.results.B1.status,'needs-reconciliation');assert.equal(closes,0);assert.equal(unregisters,0);assert.equal(cleanups,0);assert.equal(waitForExitCalls,0);
  run=null;
 }finally{
  resolveSpawn?.({ok:false,noProcess:true});
  if(run)await Promise.race([run.catch(()=>{}),new Promise(resolve=>setTimeout(resolve,15_000))]);
  fs.rmSync(workspace,{recursive:true,force:true});
 }
});

test('a post-bind startup failure closes an owned launcher exactly once',async()=>{
 const workspace=fs.mkdtempSync(path.join(family,'runner-startup-close-once-'));
 const coordinator=path.join(controllerRoot,'startup-close-once-coordinator');
 const identity={ProcessId:95201,Name:'powershell.exe',Started:'startup-close-once',CommandLine:'startup close once'};
 let closes=0,hooks;const seen=new Set();
 try{
  hooks=Object.freeze({
   plan:async function(){assert.equal(this,hooks);seen.add('plan');return [{title:'startup close once',tasks:[{prompt:'do not close the same launcher twice'}]}];},
   compact:function(value){assert.equal(this,hooks);seen.add('compact');return value;},infer:function(){assert.equal(this,hooks);seen.add('infer');return [];},prompt:function(value){assert.equal(this,hooks);seen.add('prompt');return value;},
   launcher:function(key,_prompt,suffix){assert.equal(this,hooks);seen.add('launcher');const dir=controllerWindowsDir(workspace),stem=key+'-'+suffix;const files={lp:path.join(dir,'win-launch-'+stem+'.ps1'),pf:path.join(dir,'agent-win-'+stem+'.md'),pidf:path.join(dir,'window-'+stem+'.pid'),rf:path.join(dir,'win-'+stem+'.result.json')};fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(files.lp,'fixture launcher');fs.writeFileSync(files.pf,'fixture prompt');return files;},
   register:function(){assert.equal(this,hooks);seen.add('register');},commit:function(){assert.equal(this,hooks);seen.add('commit');throw new Error('synthetic post-bind startup failure');},unregister:function(){assert.equal(this,hooks);seen.add('unregister');},cleanup:function(){assert.equal(this,hooks);seen.add('cleanup');},
   spawn:async function(){assert.equal(this,hooks);seen.add('spawn');return true;},readPid:function(){assert.equal(this,hooks);seen.add('readPid');return identity.ProcessId;},identity:function(){assert.equal(this,hooks);seen.add('identity');return identity;},
   close:async function(){assert.equal(this,hooks);seen.add('close');closes++;return this.waitForExit();},waitForExit:async function(){assert.equal(this,hooks);seen.add('waitForExit');return true;},
  });
  const sum=await runWindows('do not close the same launcher twice',hooks,{workspace,capacity:1,runId:'startup-close-once',auth:'test',coordinator,maxAttempts:1});
  assert.equal(sum.results.B1.status,'failed');
  assert.equal(sum.results.B1.exitConfirmed,true);
  assert.equal(closes,1,'a closer is not required to be idempotent');
  for(const name of ['plan','compact','infer','prompt','launcher','register','spawn','readPid','identity','commit','close','waitForExit','unregister','cleanup'])assert.ok(seen.has(name),'receiver-preserving hook '+name+' must run with its adapter object');
 }finally{
  fs.rmSync(workspace,{recursive:true,force:true});
 }
});

test('a synchronous blocking spawn hook is retained when it returns after its execution deadline',async()=>{
 const workspace=fs.mkdtempSync(path.join(family,'runner-hook-deadline-sync-spawn-'));
 const coordinator=path.join(controllerRoot,'hook-deadline-sync-spawn-coordinator');
 const executionDeadlineAt=Date.now()+60_000;
 // The injected logical clock preserves the coordinator budget.  The hook
 // itself blocks the real event loop past the wall-clock adapter deadline,
 // which is the case a timer callback alone cannot interrupt.
 const now=()=>executionDeadlineAt-120;
 let hookContext,closes=0,unregisters=0,cleanups=0;
 try{
  const hooks={
   plan:async()=>[{title:'sync deadline fixture',tasks:[{prompt:'block synchronously past the execution deadline'}]}],
   compact:value=>value,infer:()=>[],prompt:value=>value,
   launcher:(key,_prompt,suffix)=>{const dir=controllerWindowsDir(workspace),stem=key+'-'+suffix;const files={lp:path.join(dir,'win-launch-'+stem+'.ps1'),pf:path.join(dir,'agent-win-'+stem+'.md'),pidf:path.join(dir,'window-'+stem+'.pid'),rf:path.join(dir,'win-'+stem+'.result.json')};fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(files.lp,'fixture launcher');fs.writeFileSync(files.pf,'fixture prompt');return files;},
   register:()=>{},commit:()=>{},unregister:()=>{unregisters++;},cleanup:()=>{cleanups++;},close:async()=>{closes++;},waitForExit:async()=>true,
   spawn:(_lp,_title,_pidf,_retries,_token,context)=>{
    hookContext=context;
    const until=Date.now()+260;
    while(Date.now()<until){}
    return {ok:false,noProcess:true};
   },
   readPid:()=>0,
  };
  const started=Date.now();
  const sum=await runWindows('block synchronously past the execution deadline',hooks,{workspace,capacity:1,runId:'hook-deadline-sync-spawn',auth:'test',coordinator,
   timeoutMs:60_000,executionDeadlineAt,now,maxAttempts:1});
  // Coordinator receipt cleanup has its own bounded Windows round-trip.  The
  // important property is that a 120 ms hook budget does not turn into the
  // full 60-second run window after a synchronous overrun.
  assert.ok(Date.now()-started<15_000,'a blocking adapter must not make the controller wait for the full execution window');
  assert.equal(hookContext.stage,'execution spawn');
  assert.equal(hookContext.signal.aborted,true,'post-call wall-clock validation must abort a synchronous overrun');
  assert.equal(sum.results.B1.status,'needs-reconciliation');
  assert.equal(sum.results.B1.exitConfirmed,false);
  assert.ok(sum.results.B1.exitUnprovenAt);
  assert.equal(sum.taskResults.T001.status,'needs-reconciliation');
  assert.equal(sum.finalSweep.retained,1);
  assert.equal(closes,0);assert.equal(unregisters,0);assert.equal(cleanups,0);
 }finally{
  fs.rmSync(workspace,{recursive:true,force:true});
 }
});

test('an execution deadline that crosses before the hook microtask starts never invokes spawn',async()=>{
 const workspace=fs.mkdtempSync(path.join(family,'runner-hook-deadline-preinvoke-'));
 const coordinator=path.join(controllerRoot,'hook-deadline-preinvoke-coordinator');
 const executionDeadlineAt=Date.now()+60_000;
 let logicalNow=executionDeadlineAt-120,calls=0,closes=0,unregisters=0,cleanups=0;
 try{
  const hooks={
   plan:async()=>[{title:'pre-invocation deadline fixture',tasks:[{prompt:'do not start an expired adapter hook'}]}],
   compact:value=>value,infer:()=>[],prompt:value=>value,
   launcher:(key,_prompt,suffix)=>{const dir=controllerWindowsDir(workspace),stem=key+'-'+suffix;const files={lp:path.join(dir,'win-launch-'+stem+'.ps1'),pf:path.join(dir,'agent-win-'+stem+'.md'),pidf:path.join(dir,'window-'+stem+'.pid'),rf:path.join(dir,'win-'+stem+'.result.json')};fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(files.lp,'fixture launcher');fs.writeFileSync(files.pf,'fixture prompt');return files;},
   register:()=>{},commit:()=>{},unregister:()=>{unregisters++;},cleanup:()=>{cleanups++;},close:async()=>{closes++;},waitForExit:async()=>true,
   get spawn(){
    // `executionHookWithDeadline` reads the callback synchronously, then
    // schedules it in a microtask.  Put a deadline transition immediately in
    // front of that microtask to prove it performs a second pre-invocation
    // check rather than starting an already-expired external operation.
    queueMicrotask(()=>{logicalNow=executionDeadlineAt;});
    return ()=>{calls++;return {ok:false,noProcess:true};};
   },
   readPid:()=>0,
  };
  const sum=await runWindows('do not start an expired adapter hook',hooks,{workspace,capacity:1,runId:'hook-deadline-preinvoke',auth:'test',coordinator,
   timeoutMs:60_000,executionDeadlineAt,now:()=>logicalNow,maxAttempts:1});
  assert.equal(calls,0,'an adapter must not be invoked after the shared deadline crossed before its microtask started');
  assert.equal(sum.results.B1.status,'needs-reconciliation');
  assert.equal(sum.results.B1.exitConfirmed,false);
  assert.equal(sum.taskResults.T001.status,'needs-reconciliation');
  assert.equal(sum.finalSweep.retained,1);
  assert.equal(closes,0);assert.equal(unregisters,0);assert.equal(cleanups,0);
 }finally{
  fs.rmSync(workspace,{recursive:true,force:true});
 }
});

test('a deadline after spawn but before identity binding retains the launcher attempt',async()=>{
 const workspace=fs.mkdtempSync(path.join(family,'runner-spawn-identity-deadline-'));
 const coordinator=path.join(controllerRoot,'spawn-identity-deadline-coordinator');
 const executionDeadlineAt=Date.now()+60_000;
 let crossed=false,readCalls=0,closes=0,unregisters=0,cleanups=0;
 const now=()=>crossed?executionDeadlineAt:executionDeadlineAt-500;
 try{
  const hooks={
   plan:async()=>[{title:'spawn before identity deadline',tasks:[{prompt:'retain an unbound launcher'}]}],
   compact:value=>value,infer:()=>[],prompt:value=>value,
   launcher:(key,_prompt,suffix)=>{const dir=controllerWindowsDir(workspace),stem=key+'-'+suffix;const files={lp:path.join(dir,'win-launch-'+stem+'.ps1'),pf:path.join(dir,'agent-win-'+stem+'.md'),pidf:path.join(dir,'window-'+stem+'.pid'),rf:path.join(dir,'win-'+stem+'.result.json')};fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(files.lp,'fixture launcher');fs.writeFileSync(files.pf,'fixture prompt');return files;},
   register:()=>{},commit:()=>{},unregister:()=>{unregisters++;},cleanup:()=>{cleanups++;},close:async()=>{closes++;},waitForExit:async()=>true,
   spawn:async()=>true,
   readPid:()=>{readCalls++;if(readCalls===1)crossed=true;return 95101;},
   identity:()=>null,
  };
  const sum=await runWindows('retain an unbound launcher',hooks,{workspace,capacity:1,runId:'spawn-identity-deadline',auth:'test',coordinator,
   timeoutMs:60_000,executionDeadlineAt,now,maxAttempts:1});
  assert.ok(readCalls>=1,'the fixture must cross the deadline only after spawn produced a controller PID');
  assert.equal(sum.results.B1.status,'needs-reconciliation');
  assert.equal(sum.results.B1.exitConfirmed,false);
  assert.ok(sum.results.B1.exitUnprovenAt);
  assert.equal(sum.taskResults.T001.status,'needs-reconciliation');
  assert.equal(sum.finalSweep.retained,1);
  const attempt=sum.results.B1.attempts.at(-1);
  assert.ok(JSON.parse(fs.readFileSync(attempt.file,'utf8')).exitUnprovenAt,'the restart authority must retain the unbound launcher marker');
  assert.equal(closes,0);assert.equal(unregisters,0);assert.equal(cleanups,0);
 }finally{
  fs.rmSync(workspace,{recursive:true,force:true});
 }
});

test('in-flight session and wait hooks each retain their bound launcher without automatic cleanup',async()=>{
 for(const phase of ['session','wait']){
  const workspace=fs.mkdtempSync(path.join(family,'runner-hook-deadline-'+phase+'-'));
  const coordinator=path.join(controllerRoot,'hook-deadline-'+phase+'-coordinator');
  const executionDeadlineAt=Date.now()+60_000;
  const now=()=>executionDeadlineAt-180;
  const identity={ProcessId:phase==='session'?94701:94702,Name:'powershell.exe',Started:'hook-deadline-'+phase,CommandLine:'hook deadline '+phase};
  let hookContext,resolveHook,closes=0,unregisters=0,cleanups=0,waitForExitCalls=0,waitCalls=0,run;
  const waitFor=async(predicate,label,timeoutMs=60_000)=>{
   const until=Date.now()+timeoutMs;
   while(Date.now()<until){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,10));}
   throw new Error(label);
  };
  try{
   const deferred=context=>new Promise(resolve=>{hookContext=context;resolveHook=resolve;});
   const hooks={
    plan:async()=>[{title:'deadline '+phase,tasks:[{prompt:'wait for '+phase+' deadline'}]}],
    compact:value=>value,infer:()=>[],prompt:value=>value,
    launcher:(key,_prompt,suffix)=>{const dir=controllerWindowsDir(workspace),stem=key+'-'+suffix;const files={lp:path.join(dir,'win-launch-'+stem+'.ps1'),pf:path.join(dir,'agent-win-'+stem+'.md'),pidf:path.join(dir,'window-'+stem+'.pid'),rf:path.join(dir,'win-'+stem+'.result.json')};fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(files.lp,'fixture launcher');fs.writeFileSync(files.pf,'fixture prompt');return files;},
    register:()=>{},commit:()=>{},ready:()=>{},verifyStartup:async()=>{},
    unregister:()=>{unregisters++;},cleanup:()=>{cleanups++;},close:async()=>{closes++;},waitForExit:async()=>{waitForExitCalls++;return true;},
    spawn:async()=>true,readPid:()=>identity.ProcessId,identity:()=>identity,
    session:phase==='session'
      ?async(_token,_timeout,_rf,_shouldAbort,context)=>deferred(context)
      :async()=> 'session-fixture',
    wait:phase==='wait'
      ?async(_session,_timeout,_rf,_token,_pidf,_shouldAbort,context)=>{waitCalls++;return deferred(context);}
      :async()=>{waitCalls++;return {done:true,verified:false,exitCode:1,text:'unexpected wait'};},
    exitCode:()=>1,
   };
   run=runWindows('wait for '+phase+' deadline',hooks,{workspace,capacity:1,runId:'hook-deadline-'+phase,auth:'test',coordinator,
    timeoutMs:60_000,executionDeadlineAt,now,maxAttempts:1});
   await waitFor(()=>hookContext,phase+' hook was not reached');
   const settled=await Promise.race([
    run.then(sum=>({sum})),
    new Promise(resolve=>setTimeout(()=>resolve({timedOut:true}),1_500)),
   ]);
   assert.equal(settled.timedOut,undefined,phase+' hook must not hold the controller forever');
   const sum=settled.sum;
   assert.equal(hookContext.deadlineAt,executionDeadlineAt);
   assert.equal(hookContext.stage,phase==='session'?'execution session discovery':'execution session wait');
   assert.ok(hookContext.signal instanceof AbortSignal);
   assert.equal(hookContext.signal.aborted,true);
   assert.equal(sum.results.B1.status,'needs-reconciliation');
   assert.equal(sum.results.B1.exitConfirmed,false);
   assert.ok(sum.results.B1.exitUnprovenAt);
   assert.equal(sum.taskResults.T001.status,'needs-reconciliation');
   assert.equal(sum.finalSweep.retained,1);
   const attemptFile=sum.results.B1.attempts.at(-1).file;
   assert.ok(fs.existsSync(attemptFile));
   assert.ok(JSON.parse(fs.readFileSync(attemptFile,'utf8')).exitUnprovenAt);
   assert.ok(fs.existsSync(sum.results.B1.launcherFiles.lp));
   assert.ok(fs.existsSync(sum.results.B1.launcherFiles.pf));
   const leases=JSON.parse(fs.readFileSync(path.join(coordinator,'leases.json'),'utf8'));
   assert.ok(leases.some(lease=>lease.id===sum.results.B1.leaseId));
   assert.equal(closes,0);assert.equal(unregisters,0);assert.equal(cleanups,0);assert.equal(waitForExitCalls,0);
   if(phase==='session')assert.equal(waitCalls,0,'a late session result must not begin completion polling');
   resolveHook(phase==='session'?'late-session':{done:true,verified:false,exitCode:1,text:'late wait'});
   await new Promise(resolve=>setTimeout(resolve,25));
   assert.equal(sum.results.B1.status,'needs-reconciliation');
   assert.equal(closes,0);assert.equal(unregisters,0);assert.equal(cleanups,0);assert.equal(waitForExitCalls,0);
   if(phase==='session')assert.equal(waitCalls,0);
   run=null;
  }finally{
   resolveHook?.(phase==='session'?'fixture-session':{done:true,verified:false,exitCode:1,text:'fixture cleanup'});
   if(run)await Promise.race([run.catch(()=>{}),new Promise(resolve=>setTimeout(resolve,15_000))]);
   fs.rmSync(workspace,{recursive:true,force:true});
  }
 }
});
