import {testTempFamily} from './test-temp-root.mjs';
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {register} from 'node:module';
import {spawnSync} from 'node:child_process';
import {processSnapshot} from '../scripts/core/leases.mjs';
import {controllerWindowsDir} from '../scripts/core/controller-state.mjs';
import {createHeadlessHooks} from '../scripts/core/headless-executor.mjs';
import {runHeadlessWorker as runProductionHeadlessWorker} from '../scripts/core/headless-worker.mjs';
import {buildExecArgs} from '../scripts/core/execution-mode.mjs';
import {prepareIsolatedAcceptance,startupReceiptSpec,readStartupReceipt,acceptanceAbortSpec,requestAcceptanceAbort} from '../scripts/core/isolated-acceptance.mjs';
import {providerFixtureToken} from './fixture-provider-tokens.mjs';
const family=testTempFamily('headless-executor');
const testWorker=fileURLToPath(new URL('./headless-worker-fixture.mjs',import.meta.url));
register(new URL('./headless-worker-fixture-loader.mjs',import.meta.url));
const {runHeadlessWorker:runFixtureWorker}=await import('../scripts/core/headless-worker.mjs?fixture');
fs.mkdirSync(family,{recursive:true});
const controllerRoot=fs.mkdtempSync(path.join(family,'headless-controller-'));
const oldControllerRoot=process.env.ORCH_CONTROLLER_ROOT;
process.env.ORCH_CONTROLLER_ROOT=controllerRoot;
after(()=>{if(oldControllerRoot===undefined)delete process.env.ORCH_CONTROLLER_ROOT;else process.env.ORCH_CONTROLLER_ROOT=oldControllerRoot;fs.rmSync(controllerRoot,{recursive:true,force:true});});
function fixture(source,options={}){
  fs.mkdirSync(family,{recursive:true});const workspace=fs.mkdtempSync(path.join(family,'headless-中文 '));
  const cli=path.join(workspace,'fixture.mjs');fs.writeFileSync(cli,source);
  const attemptFile=path.join(workspace,'temp','orchestrator','runs','r','attempts','B1','1','attempt.json');fs.mkdirSync(path.dirname(attemptFile),{recursive:true});
  fs.writeFileSync(attemptFile,JSON.stringify({runId:'r',token:'token',taskIds:['T001']}));
  const {prompt='真实 prompt with "quotes" and 中文',...hookOptions}=options;
  const hooks=createHeadlessHooks({cli:process.execPath,args:[cli],workspace,timeoutMs:10000,workerEntry:testWorker,...hookOptions});
  const files=hooks.launcher('B1',prompt,'r-a1',{attemptFile,runId:'r',token:'token',taskIds:['T001']});
  return {workspace,hooks,files,close:()=>fs.rmSync(workspace,{recursive:true,force:true})};
}

function headlessCommandDigest(value){
  const input={cli:value.cli,args:value.args,workspace:value.workspace,runId:value.runId,token:value.token,attemptFile:value.attemptFile,timeoutMs:value.timeoutMs,
    ...(Object.hasOwn(value,'startupReceipt')?{startupReceipt:value.startupReceipt}:{}),
    ...(Object.hasOwn(value,'acceptanceAbort')?{acceptanceAbort:value.acceptanceAbort}:{})};
  return crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

async function withEnvironment(values,action){
  const before=Object.fromEntries(Object.keys(values).map(key=>[key,process.env[key]]));
  try{
    for(const [key,value] of Object.entries(values)){
      if(value===undefined)delete process.env[key];else process.env[key]=String(value);
    }
    return await action();
  }finally{
    for(const [key,value] of Object.entries(before)){
      if(value===undefined)delete process.env[key];else process.env[key]=value;
    }
  }
}
test('headless worker sends prompt over stdin and persists structured completion without a terminal launcher',async()=>{
  const f=fixture(`import fs from 'node:fs';let prompt='';for await(const b of process.stdin)prompt+=b;fs.writeFileSync('received.json',JSON.stringify({prompt,cwd:process.cwd(),args:process.argv.slice(2)}));console.log(JSON.stringify({type:'thread.started',thread_id:'thread-test'}));await new Promise(resolve=>setTimeout(resolve,2000));console.log(JSON.stringify({type:'turn.completed'}));`);
  try{
    assert.equal(await f.hooks.spawn(f.files.lp,'test',f.files.pidf,1,'token'),true);
    f.hooks.ready(f.files);
    const result=await f.hooks.wait(f.files.rf,10000,f.files.rf,'token',f.files.pidf);
    assert.equal(result.done,true);assert.equal(result.exitCode,0);assert.equal(result.threadId,'thread-test');
    const received=JSON.parse(fs.readFileSync(path.join(f.workspace,'received.json')));
    assert.deepEqual(received,{prompt:'真实 prompt with "quotes" and 中文',cwd:f.workspace,args:['-']});
    assert.equal(f.files.mode,'headless');assert.equal(path.extname(f.files.lp),'.json');
    assert.ok(f.files.lp.startsWith(controllerRoot+path.sep));
    assert.match(fs.readFileSync(f.files.stdout,'utf8'),/turn.completed/);
    const runtime=JSON.parse(fs.readFileSync(f.files.lp.replace(/\.json$/,'')+'.runtime.json','utf8'));
    assert.equal(runtime.childIdentity?.CommandLine,undefined,'the durable worker runtime must not retain a raw child command line');
    assert.match(runtime.childIdentity?.commandLineSha256||'',/^[a-f0-9]{64}$/);
  }finally{await f.hooks.close(f.hooks.readPid(f.files.pidf));await new Promise(r=>setTimeout(r,100));f.close();}
});

test('headless execution hooks honor the runner context without starting or cancelling an uncertain worker',async()=>{
 const f=fixture('setInterval(()=>{},1000);');
 const cancelled=new AbortController();cancelled.abort();
 const context={deadlineAt:Date.now()+60_000,signal:cancelled.signal,stage:'execution fixture'};
 const runtime=f.files.lp.replace(/\.json$/,'.runtime.json'),cancel=f.files.lp.replace(/\.json$/,'.cancel');
 let workerPid=0;
 try{
  await assert.rejects(
   ()=>f.hooks.spawn(f.files.lp,'context',f.files.pidf,1,'token',context),
   error=>error?.code==='ORCH_EXECUTION_HOOK_ABORTED',
  );
  assert.equal(fs.existsSync(f.files.pidf),false,'a pre-cancelled spawn must not register a worker PID');
  assert.equal(fs.existsSync(runtime),false,'a pre-cancelled spawn must not start the worker runtime');
  assert.equal(fs.existsSync(cancel),false,'a pre-cancelled spawn must not write a worker cancel marker');
  await assert.rejects(
   ()=>f.hooks.session('token',60_000,f.files.rf,()=>false,context),
   error=>error?.code==='ORCH_EXECUTION_HOOK_ABORTED',
  );

  assert.equal(await f.hooks.spawn(f.files.lp,'context',f.files.pidf,1,'token'),true);
  workerPid=f.hooks.readPid(f.files.pidf);
  assert.ok(workerPid>0,'fixture must have a live worker before exercising the wait context');
  const waitingAbort=new AbortController();
  const waiting=f.hooks.wait(f.files.rf,60_000,f.files.rf,'token',f.files.pidf,()=>false,
   {deadlineAt:Date.now()+60_000,signal:waitingAbort.signal,stage:'execution fixture'});
  await new Promise(resolve=>setTimeout(resolve,25));
  waitingAbort.abort();
  await assert.rejects(waiting,error=>error?.code==='ORCH_EXECUTION_HOOK_ABORTED');
  assert.equal(fs.existsSync(cancel),false,'deadline cancellation must not write a cancel marker for a possibly running worker');
  process.kill(workerPid,0);
 }finally{
  if(workerPid>0)await f.hooks.close(workerPid);
  await new Promise(resolve=>setTimeout(resolve,100));
  f.close();
 }
});

test('expired cleanup deadline leaves a registered headless worker uncancelled and unprobed',async()=>{
  const f=fixture('process.exit(0);');
  let workerPid=0,originalKill;
  try{
    assert.equal(await f.hooks.spawn(f.files.lp,'deadline',f.files.pidf,1,'token'),true);
    workerPid=f.hooks.readPid(f.files.pidf);
    assert.ok(workerPid>0,'fixture must register its worker before close');
    const cancel=f.files.lp.replace(/\.json$/,'.cancel');
    let probes=0;
    originalKill=process.kill;
    process.kill=()=>{probes++;const error=new Error('probe');error.code='ESRCH';throw error;};
    const closed=await f.hooks.close(workerPid,undefined,{deadlineAt:Date.now()-1});
    assert.equal(closed,false);
    assert.equal(probes,0,'expiry must avoid the exit wait/probe');
    assert.equal(fs.existsSync(cancel),false,'expiry must avoid creating the cancel artifact');
  }finally{
    if(originalKill)process.kill=originalKill;
    if(workerPid>0)await f.hooks.close(workerPid);
    await new Promise(resolve=>setTimeout(resolve,100));
    f.close();
  }
});

test('expired headless exit wait does not probe a PID',async()=>{
  const f=fixture('process.exit(0);');
  const originalKill=process.kill;
  let probes=0;
  try{
    process.kill=()=>{probes++;return true;};
    const exited=await f.hooks.waitForExit({ProcessId:123},{deadlineAt:Date.now()-1});
    assert.equal(exited,false);
    assert.equal(probes,0);
  }finally{
    process.kill=originalKill;
    f.close();
  }
});

test('headless close rejects an invalid expected binding before a process snapshot',()=>{
  const source=fs.readFileSync(fileURLToPath(new URL('../scripts/core/headless-executor.mjs',import.meta.url)),'utf8');
  const closeStart=source.indexOf('async close(pid,expected');
  const validation=source.indexOf('if(!isProcessIdentityBinding(expected))',closeStart);
  const snapshot=source.indexOf('cleanupSnapshotBefore(deadlineAt)',closeStart);
  assert.ok(validation>closeStart&&validation<snapshot,'identity authority must be rejected before observing a process');
});

test('expired cleanup deadline retains successful headless recovery artifacts',()=>{
  const f=fixture('process.exit(0);');
  try{
    const config=JSON.parse(fs.readFileSync(f.files.lp,'utf8'));
    const summary={success:true,finishedAt:Date.now(),blocks:[{key:'B1'}],results:{B1:{exitConfirmed:true,attempts:[{file:config.attemptFile}],launcherFiles:f.files}}};
    const warnings=f.hooks.cleanupCompleted(summary,{deadlineAt:Date.now()-1});
    assert.equal(warnings.length,1);
    assert.equal(warnings[0].code,'ORCH_DEADLINE_EXHAUSTED');
    assert.equal(fs.existsSync(f.files.lp),true,'the control artifact must remain for reconciliation');
    assert.equal(fs.existsSync(f.files.pf),true,'the prompt artifact must remain for reconciliation');
  }finally{f.close();}
});

test('headless cleanupCompleted retains its legacy successful cleanup without a deadline',()=>{
  const f=fixture('process.exit(0);');
  try{
    const config=JSON.parse(fs.readFileSync(f.files.lp,'utf8'));
    const summary={success:true,finishedAt:Date.now(),blocks:[{key:'B1'}],results:{B1:{exitConfirmed:true,attempts:[{file:config.attemptFile}],launcherFiles:f.files}}};
    assert.deepEqual(f.hooks.cleanupCompleted(summary),[]);
    assert.equal(fs.existsSync(f.files.lp),false);
    assert.equal(fs.existsSync(f.files.pf),false);
  }finally{f.close();}
});

test('headless wait stops on an acceptance abort without exposing controller details',async()=>{
  // This child deliberately does not read stdin, but it exits on its own so
  // abort-path cleanup never depends on signalling an unbound PID.
  const f=fixture('setTimeout(()=>process.exit(0),500);');
  let checks=0;
  try{
    await f.hooks.spawn(f.files.lp,'abort',f.files.pidf,1,'token');
    f.hooks.ready(f.files);
    const result=await f.hooks.wait(f.files.rf,250,f.files.rf,'token',f.files.pidf,()=>{
      checks++;
      return {reason:'monitor-failed',rawAbortToken:'must-not-reach-task-results'};
    });
    assert.equal(checks,1,'the wait loop must consult the controller abort signal');
    assert.deepEqual(result,{done:false,exitCode:null,text:'Acceptance aborted',aborted:true});
    assert.equal(JSON.stringify(result).includes('must-not-reach-task-results'),false);
  }finally{await f.hooks.close(f.hooks.readPid(f.files.pidf));await new Promise(r=>setTimeout(r,100));f.close();}
});

test('headless wait gives an atomic durable result a bounded grace after its worker exits',async()=>{
  const f=fixture("console.log(JSON.stringify({type:'turn.completed'}));");
  let committed;
  try{
    const exited=spawnSync(process.execPath,['-e','process.exit(0)'],{windowsHide:true});
    assert.ok(exited.pid>0,'fixture must obtain an already-exited worker PID');
    fs.writeFileSync(f.files.pidf,String(exited.pid),'utf8');
    committed=new Promise(resolve=>setTimeout(()=>{
      fs.writeFileSync(f.files.rf,JSON.stringify({runId:'r',token:'token',done:false,exitCode:null,text:'late durable result'}),'utf8');
      resolve();
    },25));
    const result=await f.hooks.wait(f.files.rf,1000,f.files.rf,'token',f.files.pidf);
    await committed;
    assert.deepEqual(result,{runId:'r',token:'token',done:false,exitCode:null,text:'late durable result'});
  }finally{await committed;f.close();}
});

test('a pre-receipt legacy headless control record remains executable after upgrade',async()=>{
  const f=fixture("console.log(JSON.stringify({type:'turn.completed'}));");
  try{
    const config=JSON.parse(fs.readFileSync(f.files.lp,'utf8'));
    delete config.startupReceipt;
    config.commandDigest=headlessCommandDigest(config);
    fs.writeFileSync(f.files.lp,JSON.stringify(config),'utf8');
    await f.hooks.spawn(f.files.lp,'legacy',f.files.pidf,1,'token');
    f.hooks.ready(f.files);
    const result=await f.hooks.wait(f.files.rf,10000,f.files.rf,'token',f.files.pidf);
    assert.equal(result.done,true,JSON.stringify(result));
  }finally{await f.hooks.close(f.hooks.readPid(f.files.pidf));await new Promise(r=>setTimeout(r,100));f.close();}
});

test('isolated headless execution writes its controller-owned startup receipt before spawning the CLI',async()=>{
  const workspace=fs.mkdtempSync(path.join(family,'headless-isolated-workspace-'));
  const isolatedRoot=path.join(controllerRoot,'isolated-'+crypto.randomUUID());
  const runId='headless-isolated-'+crypto.randomUUID().replaceAll('-','');
  const threadId='77777777-7777-4777-8777-777777777777';
  const env={...process.env,ORCH_ISOLATED_ACCEPTANCE:'1',ORCH_CONTROLLER_ROOT:isolatedRoot,CODEX_THREAD_ID:threadId,WORKSPACE_DIR:workspace,ORCH_ISOLATED_ABORT_TOKEN:crypto.randomBytes(32).toString('base64url')};
  let hooks,workerPid=0;
  try{
    await withEnvironment(env,async()=>{
      prepareIsolatedAcceptance({workspace,runId,env,initiatorContext:Object.freeze({threadId,workspace})});
      const cli=path.join(workspace,'fixture.mjs');
      fs.writeFileSync(cli,`import fs from 'node:fs';const expected=JSON.parse(fs.readFileSync('expected.json','utf8'));fs.writeFileSync('cli-observed.json',JSON.stringify({receiptExists:fs.existsSync(expected.receipt),cwd:process.cwd(),controllerRoot:process.env.ORCH_CONTROLLER_ROOT??null}));console.log(JSON.stringify({type:'turn.completed'}));`,'utf8');
      const attemptFile=path.join(workspace,'temp','orchestrator','runs',runId,'attempts','B1','1','attempt.json');
      fs.mkdirSync(path.dirname(attemptFile),{recursive:true});
      fs.writeFileSync(attemptFile,JSON.stringify({runId,token:'isolated-token',taskIds:['T001']}),'utf8');
      hooks=createHeadlessHooks({cli:process.execPath,args:[cli],workspace,timeoutMs:10000,workerEntry:testWorker});
      const files=hooks.launcher('B1','isolated prompt',runId+'-a1',{attemptFile,runId,token:'isolated-token',taskIds:['T001'],blockKey:'B1',attemptNumber:1});
      const config=JSON.parse(fs.readFileSync(files.lp,'utf8'));
      assert.ok(config.startupReceipt,'isolated controller config must bind a startup receipt');
      assert.ok(config.acceptanceAbort,'isolated controller config must bind an acceptance abort descriptor');
      assert.equal(Object.hasOwn(config.startupReceipt,'workspace'),false,'startup config must not disclose the workspace path');
      assert.equal(Object.hasOwn(config.acceptanceAbort,'token'),false,'public abort descriptor must not contain a raw capability');
      assert.equal(Object.hasOwn(config.acceptanceAbort,'abortToken'),false,'public abort descriptor must not contain a raw capability');
      assert.equal(JSON.stringify(config).includes(env.ORCH_ISOLATED_ABORT_TOKEN),false,'headless config must not serialize the abort capability');
      const original=JSON.stringify(config);
      const wrongBlock=structuredClone(config);
      wrongBlock.startupReceipt.blockKey='B2';
      wrongBlock.startupReceipt.file=path.join(isolatedRoot,'acceptance-proofs',`startup-${runId}-B2-a1.json`);
      wrongBlock.commandDigest=headlessCommandDigest(wrongBlock);
      fs.writeFileSync(files.lp,JSON.stringify(wrongBlock),'utf8');
      await assert.rejects(()=>runFixtureWorker(files.lp),/receipt block does not match control stem/i);
      const wrongAttempt=structuredClone(config);
      wrongAttempt.startupReceipt.attempt=2;
      wrongAttempt.startupReceipt.file=path.join(isolatedRoot,'acceptance-proofs',`startup-${runId}-B1-a2.json`);
      wrongAttempt.commandDigest=headlessCommandDigest(wrongAttempt);
      fs.writeFileSync(files.lp,JSON.stringify(wrongAttempt),'utf8');
      await assert.rejects(()=>runFixtureWorker(files.lp),/receipt attempt does not match the attempt ledger/i);
      const wrongAbort=structuredClone(config);
      wrongAbort.acceptanceAbort.file=path.join(isolatedRoot,'acceptance-aborts','other-run.json');
      wrongAbort.commandDigest=headlessCommandDigest(wrongAbort);
      fs.writeFileSync(files.lp,JSON.stringify(wrongAbort),'utf8');
      await assert.rejects(()=>runFixtureWorker(files.lp),/Invalid headless acceptance abort authority/i);
      fs.writeFileSync(files.lp,original,'utf8');
      fs.writeFileSync(path.join(workspace,'expected.json'),JSON.stringify({receipt:config.startupReceipt.file}),'utf8');
      await hooks.spawn(files.lp,'isolated',files.pidf,1,'isolated-token');
      workerPid=hooks.readPid(files.pidf);
      assert.ok(workerPid>0);
      assert.equal(fs.existsSync(config.startupReceipt.file),true,'worker must publish the startup receipt before readiness and CLI spawn');
      const spec=startupReceiptSpec({workspace,runId,blockKey:'B1',attempt:1,token:'isolated-token',env});
      const receipt=readStartupReceipt(spec,{launcher:{ProcessId:workerPid}});
      assert.equal(receipt.launcherPid,workerPid);
      assert.equal(receipt.workspaceIdentity,config.startupReceipt.workspaceIdentity);
      const enforced=await hooks.verifyStartup(files,{ProcessId:workerPid});
      assert.equal(enforced.launcherPid,workerPid,'the executor must enforce its own startup receipt before ready');
      hooks.ready(files);
      const result=await hooks.wait(files.rf,10000,files.rf,'isolated-token',files.pidf);
      assert.equal(result.done,true,JSON.stringify(result));
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(workspace,'cli-observed.json'),'utf8')),{receiptExists:true,cwd:workspace,controllerRoot:null},'the task CLI must not inherit the controller authority location');
      const runtime=JSON.parse(fs.readFileSync(files.lp.replace(/\.json$/,'.runtime.json'),'utf8'));
      assert.equal(runtime.startupReceipt?.workspaceIdentity,receipt.workspaceIdentity);
      assert.equal(Object.hasOwn(runtime.startupReceipt||{},'cwd'),false,'runtime projection must not retain raw working directories');
      await hooks.close(workerPid);
    });
  }finally{
    try{if(hooks&&workerPid>0)await hooks.close(workerPid);}catch{}
    for(const target of [workspace,isolatedRoot]){
      for(let attempt=0;attempt<30;attempt++){
        try{fs.rmSync(target,{recursive:true,force:true});break;}
        catch(error){if(!['EPERM','EBUSY'].includes(error?.code))throw error;await new Promise(r=>setTimeout(r,100));}
      }
    }
  }
});

test('a published isolated abort prevents headless CLI startup',async()=>{
  const workspace=fs.mkdtempSync(path.join(family,'headless-abort-before-start-'));
  const isolatedRoot=path.join(controllerRoot,'isolated-'+crypto.randomUUID());
  const runId='headless-abort-before-'+crypto.randomUUID().replaceAll('-','');
  const threadId='88888888-8888-4888-8888-888888888888';
  const abortToken=crypto.randomBytes(32).toString('base64url');
  const env={...process.env,ORCH_ISOLATED_ACCEPTANCE:'1',ORCH_CONTROLLER_ROOT:isolatedRoot,CODEX_THREAD_ID:threadId,WORKSPACE_DIR:workspace,ORCH_ISOLATED_ABORT_TOKEN:abortToken};
  try{
    await withEnvironment(env,async()=>{
      prepareIsolatedAcceptance({workspace,runId,env,initiatorContext:Object.freeze({threadId,workspace})});
      const marker=path.join(workspace,'cli-started.txt'),cli=path.join(workspace,'fixture.mjs');
      fs.writeFileSync(cli,`import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'started');setInterval(()=>{},1000);`,'utf8');
      const attemptFile=path.join(workspace,'temp','orchestrator','runs',runId,'attempts','B1','1','attempt.json');
      fs.mkdirSync(path.dirname(attemptFile),{recursive:true});
      fs.writeFileSync(attemptFile,JSON.stringify({runId,token:'isolated-token',taskIds:['T001']}),'utf8');
      const hooks=createHeadlessHooks({cli:process.execPath,args:[cli],workspace,timeoutMs:10000,workerEntry:testWorker});
      const files=hooks.launcher('B1','isolated prompt',runId+'-a1',{attemptFile,runId,token:'isolated-token',taskIds:['T001'],blockKey:'B1',attemptNumber:1});
      const abort=requestAcceptanceAbort(acceptanceAbortSpec({workspace,runId,token:abortToken,env}),{reason:'monitor-failed'});
      assert.equal(await hooks.spawn(files.lp,'isolated-abort',files.pidf,1,'isolated-token'),true);
      const workerPid=hooks.readPid(files.pidf);
      const result=await hooks.wait(files.rf,10000,files.rf,'isolated-token',files.pidf);
      assert.equal(result.done,false);
      assert.equal(result.aborted,true);
      assert.equal(result.text,'Headless execution aborted before readiness');
      assert.deepEqual(result.acceptanceAbort,{kind:'acceptance-abort',runId,reason:'monitor-failed',requestedAt:abort.requestedAt});
      assert.equal(fs.existsSync(marker),false,'the child CLI must not start after the controller publishes an abort');
      assert.equal(JSON.stringify(result).includes(abortToken),false,'durable result must not disclose the abort capability');
      assert.equal(await hooks.waitForExit({ProcessId:workerPid}),true);
    });
  }finally{fs.rmSync(workspace,{recursive:true,force:true});fs.rmSync(isolatedRoot,{recursive:true,force:true});}
});

test('a published isolated abort terminates the authenticated running headless CLI',async()=>{
  const workspace=fs.mkdtempSync(path.join(family,'headless-abort-running-'));
  const isolatedRoot=path.join(controllerRoot,'isolated-'+crypto.randomUUID());
  const runId='headless-abort-running-'+crypto.randomUUID().replaceAll('-','');
  const threadId='99999999-9999-4999-8999-999999999999';
  const abortToken=crypto.randomBytes(32).toString('base64url');
  const env={...process.env,ORCH_ISOLATED_ACCEPTANCE:'1',ORCH_CONTROLLER_ROOT:isolatedRoot,CODEX_THREAD_ID:threadId,WORKSPACE_DIR:workspace,ORCH_ISOLATED_ABORT_TOKEN:abortToken};
  let hooks,workerPid=0;
  try{
    await withEnvironment(env,async()=>{
      prepareIsolatedAcceptance({workspace,runId,env,initiatorContext:Object.freeze({threadId,workspace})});
      const marker=path.join(workspace,'cli-started.txt'),cli=path.join(workspace,'fixture.mjs');
      // This case exercises automatic termination only after the worker has
      // a durable identity binding. Drain stdin first, then wait below for
      // that binding rather than racing an otherwise unbound child startup.
      fs.writeFileSync(cli,`import fs from 'node:fs';for await(const _part of process.stdin){}fs.writeFileSync(${JSON.stringify(marker)},'started');console.log(JSON.stringify({type:'thread.started',thread_id:'isolated-abort-running'}));setInterval(()=>{},1000);`,'utf8');
      const attemptFile=path.join(workspace,'temp','orchestrator','runs',runId,'attempts','B1','1','attempt.json');
      fs.mkdirSync(path.dirname(attemptFile),{recursive:true});
      fs.writeFileSync(attemptFile,JSON.stringify({runId,token:'isolated-token',taskIds:['T001']}),'utf8');
      hooks=createHeadlessHooks({cli:process.execPath,args:[cli],workspace,timeoutMs:10000,workerEntry:testWorker});
      const files=hooks.launcher('B1','isolated prompt',runId+'-a1',{attemptFile,runId,token:'isolated-token',taskIds:['T001'],blockKey:'B1',attemptNumber:1});
      assert.equal(await hooks.spawn(files.lp,'isolated-running-abort',files.pidf,1,'isolated-token'),true);
      workerPid=hooks.readPid(files.pidf);
      hooks.ready(files);
      const runtime=files.lp.replace(/\.json$/,'.runtime.json');
      const readRuntime=()=>{try{return JSON.parse(fs.readFileSync(runtime,'utf8'));}catch{return null;}};
      const hasBoundChild=()=>!!readRuntime()?.childIdentity;
      const deadline=Date.now()+5000;
      while((!fs.existsSync(marker)||!hasBoundChild())&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,25));
      assert.equal(fs.existsSync(marker),true,'fixture CLI must have started before this abort is published');
      assert.equal(hasBoundChild(),true,'fixture must have a durable child identity before automatic termination is expected');
      const childPid=Number(readRuntime()?.childPid)||0;
      assert.ok(childPid>0,'fixture must publish its child PID with the identity binding');
      assert.doesNotThrow(()=>process.kill(childPid,0),'fixture child must still be alive before the authenticated abort');
      const abort=requestAcceptanceAbort(acceptanceAbortSpec({workspace,runId,token:abortToken,env}),{reason:'monitor-failed'});
      const result=await hooks.wait(files.rf,10000,files.rf,'isolated-token',files.pidf);
      assert.equal(result.done,false);
      assert.equal(result.aborted,true);
      assert.equal(result.text,'Headless execution aborted');
      assert.deepEqual(result.acceptanceAbort,{kind:'acceptance-abort',runId,reason:'monitor-failed',requestedAt:abort.requestedAt});
      assert.equal(result.terminationRefused,undefined,'the worker must only terminate its authenticated child');
      assert.equal(result.terminationVerified,true,'the owned child must be absent after taskkill confirms the bound identity');
      assert.equal(JSON.stringify(result).includes(abortToken),false,'durable result must not disclose the abort capability');
      assert.equal(await hooks.waitForExit({ProcessId:workerPid}),true);
    });
  }finally{
    try{if(hooks&&workerPid>0)await hooks.close(workerPid);}catch{}
    for(const target of [workspace,isolatedRoot]){
      let removed=false;
      for(let attempt=0;attempt<30&&!removed;attempt++){
        try{fs.rmSync(target,{recursive:true,force:true});removed=true;}
        catch(error){if(!['EPERM','EBUSY'].includes(error?.code))throw error;await new Promise(r=>setTimeout(r,100));}
      }
      assert.equal(removed,true,'fixture directory must be released before cleanup: '+target);
    }
  }
});

test('a forged public-shaped abort cannot stop an isolated headless CLI',async()=>{
  const workspace=fs.mkdtempSync(path.join(family,'headless-forged-abort-'));
  const isolatedRoot=path.join(controllerRoot,'isolated-'+crypto.randomUUID());
  const runId='headless-forged-abort-'+crypto.randomUUID().replaceAll('-','');
  const threadId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const abortToken=crypto.randomBytes(32).toString('base64url');
  const env={...process.env,ORCH_ISOLATED_ACCEPTANCE:'1',ORCH_CONTROLLER_ROOT:isolatedRoot,CODEX_THREAD_ID:threadId,WORKSPACE_DIR:workspace,ORCH_ISOLATED_ABORT_TOKEN:abortToken};
  let hooks,workerPid=0;
  try{
    await withEnvironment(env,async()=>{
      prepareIsolatedAcceptance({workspace,runId,env,initiatorContext:Object.freeze({threadId,workspace})});
      const marker=path.join(workspace,'cli-started.txt'),release=path.join(workspace,'release.txt'),observed=path.join(workspace,'cli-observed.json'),cli=path.join(workspace,'fixture.mjs');
      fs.writeFileSync(cli,`import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(observed)},JSON.stringify({workerAbortToken:process.env.ORCH_HEADLESS_ABORT_TOKEN??null,isolatedAbortToken:process.env.ORCH_ISOLATED_ABORT_TOKEN??null,controllerRoot:process.env.ORCH_CONTROLLER_ROOT??null}));fs.writeFileSync(${JSON.stringify(marker)},'started');while(!fs.existsSync(${JSON.stringify(release)}))await new Promise(resolve=>setTimeout(resolve,20));console.log(JSON.stringify({type:'turn.completed'}));`,'utf8');
      const attemptFile=path.join(workspace,'temp','orchestrator','runs',runId,'attempts','B1','1','attempt.json');
      fs.mkdirSync(path.dirname(attemptFile),{recursive:true});
      fs.writeFileSync(attemptFile,JSON.stringify({runId,token:'isolated-token',taskIds:['T001']}),'utf8');
      hooks=createHeadlessHooks({cli:process.execPath,args:[cli],workspace,timeoutMs:10000,workerEntry:testWorker});
      const files=hooks.launcher('B1','isolated prompt',runId+'-a1',{attemptFile,runId,token:'isolated-token',taskIds:['T001'],blockKey:'B1',attemptNumber:1});
      const config=JSON.parse(fs.readFileSync(files.lp,'utf8'));
      assert.equal(await hooks.spawn(files.lp,'isolated-forged-abort',files.pidf,1,'isolated-token'),true);
      workerPid=hooks.readPid(files.pidf);
      hooks.ready(files);
      const deadline=Date.now()+5000;
      while(!fs.existsSync(marker)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,25));
      assert.equal(fs.existsSync(marker),true,'fixture CLI must have started before the forged record is written');
      const forged={schema:1,kind:'acceptance-abort',runId,workspaceKeySha256:config.acceptanceAbort.workspaceKeySha256,
        abortTokenSha256:config.acceptanceAbort.abortTokenSha256,reason:'monitor-failed',requestedAt:Date.now(),authTag:'0'.repeat(64)};
      fs.mkdirSync(path.dirname(config.acceptanceAbort.file),{recursive:true});
      fs.writeFileSync(config.acceptanceAbort.file,JSON.stringify(forged),{encoding:'utf8',flag:'wx'});
      await new Promise(resolve=>setTimeout(resolve,350));
      assert.equal(fs.existsSync(files.rf),false,'a public hash and fake tag must not terminate the worker');
      fs.writeFileSync(release,'continue');
      const result=await hooks.wait(files.rf,10000,files.rf,'isolated-token',files.pidf);
      assert.equal(result.done,true,JSON.stringify(result));
      assert.deepEqual(JSON.parse(fs.readFileSync(observed,'utf8')),{workerAbortToken:null,isolatedAbortToken:null,controllerRoot:null},'the task CLI must not inherit any controller abort capability');
      assert.equal(await hooks.waitForExit({ProcessId:workerPid}),true);
    });
  }finally{
    try{if(hooks&&workerPid>0)await hooks.close(workerPid);}catch{}
    for(const target of [workspace,isolatedRoot]){
      let removed=false;
      for(let attempt=0;attempt<30&&!removed;attempt++){
        try{fs.rmSync(target,{recursive:true,force:true});removed=true;}
        catch(error){if(!['EPERM','EBUSY'].includes(error?.code))throw error;await new Promise(r=>setTimeout(r,100));}
      }
      assert.equal(removed,true,'fixture directory must be released before cleanup: '+target);
    }
  }
});

test('headless execution forwards credential-free proxies to the real CLI and strips credential-bearing endpoints',async()=>{
  const keys=['HTTPS_PROXY','https_proxy','HTTP_PROXY','http_proxy','ALL_PROXY','all_proxy','NO_PROXY','no_proxy'];
  const previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  const run=async values=>{
    for(const key of keys)delete process.env[key];
    Object.assign(process.env,values);
    const f=fixture(`import fs from 'node:fs';fs.writeFileSync('proxy.json',JSON.stringify({https:process.env.HTTPS_PROXY||null,http:process.env.HTTP_PROXY||null,all:process.env.ALL_PROXY||null,no:process.env.NO_PROXY||null}));console.log(JSON.stringify({type:'turn.completed'}));`);
    try{
      await f.hooks.spawn(f.files.lp,'test',f.files.pidf,1,'token');f.hooks.ready(f.files);
      const result=await f.hooks.wait(f.files.rf,10000,f.files.rf,'token',f.files.pidf);
      assert.equal(result.done,true,JSON.stringify(result));
      return JSON.parse(fs.readFileSync(path.join(f.workspace,'proxy.json'),'utf8'));
    }finally{await f.hooks.close(f.hooks.readPid(f.files.pidf));await new Promise(r=>setTimeout(r,100));f.close();}
  };
  try{
    assert.deepEqual(await run({HTTPS_PROXY:'http://127.0.0.1:7892',HTTP_PROXY:'https://proxy.example.test:8443',ALL_PROXY:'http://127.0.0.1:7999',NO_PROXY:'localhost,.example.test,[::1]'}),{
      https:'http://127.0.0.1:7892',http:'https://proxy.example.test:8443',all:'http://127.0.0.1:7999',no:'localhost,.example.test,[::1]',
    });
    assert.deepEqual(await run({HTTPS_PROXY:'http://user:pass@127.0.0.1:7892',NO_PROXY:'localhost,user:pass@proxy.example.test'}),{
      https:null,http:null,all:null,no:null,
    });
  }finally{
    for(const key of keys){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}
  }
});

test('a busy controller checks the durable readiness PID before declaring elapsed timeout',async()=>{
  const f=fixture('console.log(JSON.stringify({type:"turn.completed"}));',{readinessTimeoutMs:100});
  try{
    const starting=f.hooks.spawn(f.files.lp,'test',f.files.pidf);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,2000);
    assert.equal(await starting,true);
    const pid=f.hooks.readPid(f.files.pidf);f.hooks.ready(f.files);
    const result=await f.hooks.wait(f.files.rf,10000,f.files.rf,'token',f.files.pidf);
    assert.equal(result.done,true);assert.equal(await f.hooks.waitForExit({ProcessId:pid}),true);
  }finally{await f.hooks.close(f.hooks.readPid(f.files.pidf));await new Promise(r=>setTimeout(r,100));f.close();}
});

test('unstructured stderr remains diagnostic and cannot authorize capacity replay',async()=>{
  const f=fixture("console.error('Selected model is at capacity; retry after 1 seconds');process.exitCode=1;");
  try{
    await f.hooks.spawn(f.files.lp,'test',f.files.pidf,1,'token');f.hooks.ready(f.files);
    const result=await f.hooks.wait(f.files.rf,10000,f.files.rf,'token',f.files.pidf);
    assert.equal(result.done,false);assert.match(result.text,/model is at capacity/);assert.equal(result.retryable,undefined);
  }finally{await f.hooks.close(f.hooks.readPid(f.files.pidf));await new Promise(r=>setTimeout(r,100));f.close();}
});

test('headless artifacts redact JSON and quoted credential assignments without deleting ordinary diagnostics',async()=>{
  const secrets={api:'stdout-api-key-do-not-retain',password:'stderr-password-do-not-retain',access:'stdout-access-token-do-not-retain',authorization:'stderr-authorization-do-not-retain'};
  const f=fixture(`
    console.log(JSON.stringify({type:'turn.failed',api_key:${JSON.stringify(secrets.api)},password:${JSON.stringify(secrets.password)},access_token:${JSON.stringify(secrets.access)},authorization:${JSON.stringify('Bearer '+secrets.authorization)},ordinary:'stdout ordinary diagnostic'}));
    process.stderr.write(${JSON.stringify(`api_key="${secrets.api}" password='${secrets.password}' access_token="${secrets.access}" authorization="Bearer ${secrets.authorization}" ordinary=stderr ordinary diagnostic\n`)});
    process.exitCode=1;
  `);
  try{
    await f.hooks.spawn(f.files.lp,'test',f.files.pidf,1,'token');f.hooks.ready(f.files);
    const result=await f.hooks.wait(f.files.rf,10000,f.files.rf,'token',f.files.pidf);
    const stdout=fs.readFileSync(f.files.stdout,'utf8'),stderr=fs.readFileSync(f.files.stderr,'utf8');
    const parsed=JSON.parse(stdout.trim());
    assert.equal(parsed.api_key,'[REDACTED]');
    assert.equal(parsed.password,'[REDACTED]');
    assert.equal(parsed.access_token,'[REDACTED]');
    assert.equal(parsed.authorization,'[REDACTED]');
    assert.equal(parsed.ordinary,'stdout ordinary diagnostic');
    assert.match(stderr,/api_key="\[REDACTED\]" password='\[REDACTED\]' access_token="\[REDACTED\]" authorization="\[REDACTED\]"/);
    assert.match(stderr,/ordinary=stderr ordinary diagnostic/);
    assert.match(result.text,/stdout ordinary diagnostic/);
    assert.match(result.text,/stderr ordinary diagnostic/);
    const persisted=[stdout,stderr,JSON.stringify(result)].join('\n');
    for(const value of Object.values(secrets))assert.equal(persisted.includes(value),false,`durable artifacts retained ${value}`);
  }finally{await f.hooks.close(f.hooks.readPid(f.files.pidf));await new Promise(r=>setTimeout(r,100));f.close();}
});

test('headless artifacts redact vendor-prefixed credential names in prompt, JSON, and shell diagnostics',async()=>{
  const secrets={openai:providerFixtureToken('openai-named','openai-do-not-retain'),github:providerFixtureToken('github-named','github-do-not-retain'),anthropic:providerFixtureToken('anthropic','do-not-retain')};
  const f=fixture(`
    console.log(JSON.stringify({type:'turn.failed',OPENAI_API_KEY:${JSON.stringify(secrets.openai)},GITHUB_TOKEN:${JSON.stringify(secrets.github)},ANTHROPIC_API_KEY:${JSON.stringify(secrets.anthropic)},ordinary:'stdout ordinary diagnostic'}));
    process.stderr.write(${JSON.stringify(`OPENAI_API_KEY=${secrets.openai} GITHUB_TOKEN="${secrets.github}" ANTHROPIC_API_KEY='${secrets.anthropic}' ordinary=stderr ordinary diagnostic\n`)});
    process.exitCode=1;
  `,{prompt:`do the task; OPENAI_API_KEY="${secrets.openai}" and ordinary prompt instruction`});
  try{
    await f.hooks.spawn(f.files.lp,'test',f.files.pidf,1,'token');f.hooks.ready(f.files);
    const result=await f.hooks.wait(f.files.rf,10000,f.files.rf,'token',f.files.pidf);
    const prompt=fs.readFileSync(f.files.pf,'utf8'),stdout=fs.readFileSync(f.files.stdout,'utf8'),stderr=fs.readFileSync(f.files.stderr,'utf8');
    const parsed=JSON.parse(stdout.trim());
    assert.equal(parsed.OPENAI_API_KEY,'[REDACTED]');
    assert.equal(parsed.GITHUB_TOKEN,'[REDACTED]');
    assert.equal(parsed.ANTHROPIC_API_KEY,'[REDACTED]');
    assert.match(prompt,/ordinary prompt instruction/);
    assert.match(stderr,/OPENAI_API_KEY=\[REDACTED\] GITHUB_TOKEN="\[REDACTED\]" ANTHROPIC_API_KEY='\[REDACTED\]'/);
    const durable=[prompt,stdout,stderr,JSON.stringify(result)].join('\n');
    for(const value of Object.values(secrets))assert.equal(durable.includes(value),false,`durable artifacts retained ${value}`);
  }finally{await f.hooks.close(f.hooks.readPid(f.files.pidf));await new Promise(r=>setTimeout(r,100));f.close();}
});

test('a sensitive headless prompt is sealed at rest yet reaches the child CLI unchanged',async()=>{
  const secret='PRIVATE⟪headless-original-prompt⟫';
  const f=fixture(`import fs from 'node:fs';let prompt='';for await(const chunk of process.stdin)prompt+=chunk;fs.writeFileSync('received-private-prompt.txt',prompt);console.log(JSON.stringify({type:'turn.completed'}));`,{prompt:`execute exact task with OPENAI_API_KEY=${secret}`});
  try{
    assert.match(f.files.privatePrompt||'',/\.prompt\.dpapi$/,'sensitive launches need a protected prompt artifact');
    assert.equal(fs.readFileSync(f.files.pf,'utf8').includes(secret),false,'public prompt artifact retained the raw secret');
    assert.equal(fs.readFileSync(f.files.privatePrompt,'utf8').includes(secret),false,'protected prompt artifact retained plaintext');
    await f.hooks.spawn(f.files.lp,'private prompt',f.files.pidf,1,'token');f.hooks.ready(f.files);
    const result=await f.hooks.wait(f.files.rf,10000,f.files.rf,'token',f.files.pidf);
    assert.equal(result.done,true,JSON.stringify(result));
    assert.match(fs.readFileSync(path.join(f.workspace,'received-private-prompt.txt'),'utf8'),new RegExp(secret));
  }finally{await f.hooks.close(f.hooks.readPid(f.files.pidf));await new Promise(r=>setTimeout(r,100));f.close();}
});

test('AWS and database credential fields use the protected headless prompt transport',async()=>{
  const secrets={aws:'aws-secret-access-key-fixture',database:'postgresql://demo:fixture-password@db.example.invalid:5432/app'};
  const prompt=`execute exact task with AWS_SECRET_ACCESS_KEY=${secrets.aws} and DATABASE_URL=${secrets.database}`;
  const f=fixture(`import fs from 'node:fs';let received='';for await(const chunk of process.stdin)received+=chunk;fs.writeFileSync('received-infrastructure-prompt.txt',received);console.log(JSON.stringify({type:'turn.completed'}));`,{prompt});
  try{
    assert.match(f.files.privatePrompt||'',/\.prompt\.dpapi$/,'infrastructure credentials need a protected prompt artifact');
    const durable=[fs.readFileSync(f.files.pf,'utf8'),fs.readFileSync(f.files.privatePrompt,'utf8')].join('\n');
    for(const secret of Object.values(secrets))assert.equal(durable.includes(secret),false,`durable prompt artifact retained ${secret}`);
    await f.hooks.spawn(f.files.lp,'private infrastructure prompt',f.files.pidf,1,'token');f.hooks.ready(f.files);
    const result=await f.hooks.wait(f.files.rf,10000,f.files.rf,'token',f.files.pidf);
    assert.equal(result.done,true,JSON.stringify(result));
    assert.equal(fs.readFileSync(path.join(f.workspace,'received-infrastructure-prompt.txt'),'utf8'),prompt);
  }finally{await f.hooks.close(f.hooks.readPid(f.files.pidf));await new Promise(r=>setTimeout(r,100));f.close();}
});

test('headless artifacts redact credentials whose quoted assignments arrive across stream chunks',async()=>{
  const secret='headless-split-credential-do-not-retain';
  const f=fixture(`
    import fs from 'node:fs';
    process.stdout.write(${JSON.stringify('{"type":"turn.failed","api_key":"headless-split-')},()=>{
      fs.writeFileSync('first-output-flushed','ready');
      setTimeout(()=>{
        process.stdout.write(${JSON.stringify('credential-do-not-retain","ordinary":"stdout chunk ordinary"}\n')});
        process.stderr.write(${JSON.stringify('password="headless-split-')});
        setTimeout(()=>{process.stderr.write(${JSON.stringify('credential-do-not-retain" ordinary=stderr chunk ordinary\n')});process.exitCode=1;},500);
      },500);
    });
  `);
  try{
    await f.hooks.spawn(f.files.lp,'test',f.files.pidf,1,'token');f.hooks.ready(f.files);
    const marker=path.join(f.workspace,'first-output-flushed'),deadline=Date.now()+5000;
    while(!fs.existsSync(marker)&&Date.now()<deadline)await new Promise(r=>setTimeout(r,25));
    assert.equal(fs.existsSync(marker),true,'fixture must flush its first stdout fragment before emitting the remainder');
    await new Promise(r=>setTimeout(r,100));
    const interim=fs.existsSync(f.files.stdout)?fs.readFileSync(f.files.stdout,'utf8'):'';
    assert.equal(interim.includes('headless-split-'),false,'a partial credential must not reach the durable stdout artifact');
    const result=await f.hooks.wait(f.files.rf,10000,f.files.rf,'token',f.files.pidf);
    const stdout=fs.readFileSync(f.files.stdout,'utf8'),stderr=fs.readFileSync(f.files.stderr,'utf8');
    assert.equal(JSON.parse(stdout.trim()).api_key,'[REDACTED]');
    assert.match(stderr,/password="\[REDACTED\]" ordinary=stderr chunk ordinary/);
    assert.match(result.text,/stdout chunk ordinary/);
    assert.match(result.text,/stderr chunk ordinary/);
    assert.equal([stdout,stderr,JSON.stringify(result)].join('\n').includes(secret),false);
  }finally{await f.hooks.close(f.hooks.readPid(f.files.pidf));await new Promise(r=>setTimeout(r,100));f.close();}
});

test('oversized unbroken JSONL event fails closed without retaining unbounded stdout',async()=>{
  // The output fault races ahead of stdin drain by design. Keep this fixture
  // unbound, then use only its own release file for post-assertion cleanup.
  const f=fixture("import fs from 'node:fs';process.stdout.write('x'.repeat(5*1024*1024));const timer=setInterval(()=>{if(fs.existsSync('oversized-fixture-release')){clearInterval(timer);process.exit(0);}},20);");
  const runtime=f.files.lp.replace(/\.json$/,'.runtime.json');
  const release=path.join(f.workspace,'oversized-fixture-release');
  let childPid=0;
  const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
  const waitForGone=async pid=>{
    const deadline=Date.now()+5000;
    while(Date.now()<deadline){if(!alive(pid))return true;await new Promise(resolve=>setTimeout(resolve,25));}
    return !alive(pid);
  };
  try{
    await f.hooks.spawn(f.files.lp,'test',f.files.pidf,1,'token');f.hooks.ready(f.files);
    const result=await f.hooks.wait(f.files.rf,15000,f.files.rf,'token',f.files.pidf);
    childPid=Number(JSON.parse(fs.readFileSync(runtime,'utf8')).childPid)||0;
    assert.equal(result.done,false);
    assert.match(result.text,/4 MiB safety limit/);
    assert.equal(result.terminationRefused,true,'the pre-binding stream fault must refuse PID termination');
    assert.equal(result.childStillRunning,true);
    assert.equal(result.exitUnproven,true);
    assert.ok(fs.statSync(f.files.stdout).size<=4*1024*1024,'durable stdout must stay within the JSONL event bound');
    assert.ok(childPid>0);
    assert.equal(alive(childPid),true,'the unbound fixture child must remain for reconciliation');
  }finally{
    try{fs.writeFileSync(release,'release');}catch{}
    if(!childPid&&fs.existsSync(runtime)){try{childPid=Number(JSON.parse(fs.readFileSync(runtime,'utf8')).childPid)||0;}catch{}}
    if(childPid>0)assert.equal(await waitForGone(childPid),true,'fixture-owned unbound child must exit after its own release');
    await f.hooks.close(f.hooks.readPid(f.files.pidf));
    let removed=false;
    for(let attempt=0;attempt<30&&!removed;attempt++){
      try{f.close();removed=true;}
      catch(error){if(!['EPERM','EBUSY'].includes(error?.code))throw error;await new Promise(resolve=>setTimeout(resolve,100));}
    }
    assert.equal(removed,true,'fixture workspace must release after its child exits');
  }
});

test('headless worker marks a typed provider capacity failure as retryable',async()=>{
  const f=fixture("console.log(JSON.stringify({type:'turn.failed',error:{message:'Selected model is at capacity'}}));process.exitCode=1;");
  try{
    await f.hooks.spawn(f.files.lp,'test',f.files.pidf,1,'token');f.hooks.ready(f.files);
    const result=await f.hooks.wait(f.files.rf,10000,f.files.rf,'token',f.files.pidf);
    assert.equal(result.done,false);assert.equal(result.retryable,'capacity');assert.match(result.capacityError,/model is at capacity/);
  }finally{await f.hooks.close(f.hooks.readPid(f.files.pidf));await new Promise(r=>setTimeout(r,100));f.close();}
});

test('initial child identity observation failure still delivers the headless prompt',async()=>{
  if(process.platform!=='win32')return;
  const f=fixture("import fs from 'node:fs';fs.writeFileSync('initial-identity-child.pid',String(process.pid));let prompt='';for await(const part of process.stdin)prompt+=part;fs.writeFileSync('received-after-identity-failure.txt',prompt);console.log(JSON.stringify({type:'turn.completed'}));");
  let childPid=0;
  try{
    f.hooks.ready(f.files);
    let snapshots=0;
    const result=await runFixtureWorker(f.files.lp,{snapshot:()=>{
      snapshots++;
      throw new Error('injected initial child identity observation failure');
    }});
    assert.equal(snapshots,1,'the worker must treat only the initial identity observation as best effort');
    assert.equal(result.done,true,JSON.stringify(result));
    assert.equal(result.exitCode,0);
    assert.equal(result.terminationRefused,undefined);
    assert.equal(fs.readFileSync(path.join(f.workspace,'received-after-identity-failure.txt'),'utf8'),'真实 prompt with "quotes" and 中文');
  }finally{
    const runtime=f.files.lp.replace(/\.json$/,'.runtime.json');
    if(fs.existsSync(runtime))childPid=Number(JSON.parse(fs.readFileSync(runtime,'utf8')).childPid)||0;
    if(!childPid){try{childPid=Number(fs.readFileSync(path.join(f.workspace,'initial-identity-child.pid'),'utf8'))||0;}catch{}}
    if(childPid>0){
      try{process.kill(childPid,'SIGTERM');}catch{}
      try{spawnSync('taskkill',['/PID',String(childPid),'/T','/F'],{windowsHide:true,stdio:'ignore'});}catch{}
    }
    let removed=false;
    for(let i=0;i<50&&!removed;i++){
      try{f.close();removed=true;}
      catch(error){if(!['EPERM','EBUSY'].includes(error?.code))throw error;await new Promise(r=>setTimeout(r,100));}
    }
    assert.equal(removed,true,'the test cleanup must wait for its own child');
  }
});

test('headless worker waits for full stdin EOF before beginning initial identity observation',async()=>{
  const f=fixture(`import fs from 'node:fs';for await(const _part of process.stdin){}fs.writeFileSync('prompt-eof-before-snapshot','yes');console.log(JSON.stringify({type:'turn.completed'}));`,{prompt:'p'.repeat(1024*1024)});
  try{
    f.hooks.ready(f.files);
    const receipt=path.join(f.workspace,'prompt-eof-before-snapshot');
    let snapshots=0,snapshotBeforeReceipt=false;
    const result=await runFixtureWorker(f.files.lp,{platform:'win32',snapshot:()=>{
      snapshots++;
      if(!fs.existsSync(receipt))snapshotBeforeReceipt=true;
      return new Map();
    }});
    assert.equal(snapshots,1);
    assert.equal(snapshotBeforeReceipt,false,'identity observation must not begin while the child is still waiting for the complete stdin EOF');
    assert.equal(fs.existsSync(receipt),true,'the child must confirm the complete stdin EOF before the snapshot');
    assert.equal(result.done,true,JSON.stringify(result));
  }finally{f.close();}
});

test('non-Windows cancellation refuses an unbound direct child handle',async()=>{
  const f=fixture("import fs from 'node:fs';fs.writeFileSync('unbound-child.pid',String(process.pid));setInterval(()=>{},1000);");
  let childPid=0;
  try{
    f.hooks.ready(f.files);
    const runtime=f.files.lp.replace(/\.json$/,'.runtime.json');
    // The injected binding makes this platform-independent: the old code will
    // accept the child as owned and kill it on Windows, while an actual
    // non-Windows host takes its direct-child kill path. The repaired worker
    // refuses either path when the requested platform lacks an identity proof.
    const snapshot=()=>{
      let pid=0;
      try{pid=Number(JSON.parse(fs.readFileSync(runtime,'utf8')).childPid)||0;}catch{}
      return pid>0?new Map([[pid,{ProcessId:pid,Started:'fixture-start',Name:'node.exe',CommandLine:'headless fixture'}]]):new Map();
    };
    const running=runFixtureWorker(f.files.lp,{platform:'linux',snapshot,unverifiedChildGraceMs:25});
    const deadline=Date.now()+10000;
    while(Date.now()<deadline&&!childPid){
      if(fs.existsSync(runtime))childPid=Number(JSON.parse(fs.readFileSync(runtime,'utf8')).childPid)||0;
      if(!childPid)await new Promise(resolve=>setTimeout(resolve,25));
    }
    assert.ok(childPid>0,'fixture must start its long-lived child before cancellation');
    fs.writeFileSync(f.files.lp.replace(/\.json$/,'.cancel'),'cancel');
    const result=await running;
    assert.equal(result.done,false);
    assert.equal(result.terminationRefused,true);
    assert.equal(result.childStillRunning,true);
    assert.equal(result.exitUnproven,true);
    assert.doesNotThrow(()=>process.kill(childPid,0),'the worker must not kill an unbound direct child handle');
  }finally{
    if(childPid>0){try{process.kill(childPid,'SIGTERM');}catch{}}
    let removed=false;
    for(let i=0;i<50&&!removed;i++){
      try{f.close();removed=true;}
      catch(error){if(!['EPERM','EBUSY'].includes(error?.code))throw error;await new Promise(resolve=>setTimeout(resolve,100));}
    }
    assert.equal(removed,true,'the test cleanup must wait for its own child');
  }
});

test('headless worker entry exits after a durable unresolved result while retaining its unbound child',async()=>{
  // A large prompt keeps the pipe write pending because this fixture never
  // reads stdin. Cancellation therefore happens before any identity capture.
  const f=fixture("import fs from 'node:fs';fs.writeFileSync('retained-child.pid',String(process.pid));setInterval(()=>{},1000);",{prompt:'p'.repeat(1024*1024)});
  let workerPid=0,childPid=0;
  const runtime=f.files.lp.replace(/\.json$/,'.runtime.json');
  const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
  const waitFor=async(predicate,timeoutMs)=>{
    const deadline=Date.now()+timeoutMs;
    while(Date.now()<deadline){if(predicate())return true;await new Promise(resolve=>setTimeout(resolve,25));}
    return predicate();
  };
  const removeFixture=async()=>{
    let removed=false;
    for(let i=0;i<50&&!removed;i++){
      try{f.close();removed=true;}
      catch(error){if(!['EPERM','EBUSY'].includes(error?.code))throw error;await new Promise(resolve=>setTimeout(resolve,100));}
    }
    assert.equal(removed,true,'the test cleanup must wait for its own child');
  };
  try{
    assert.equal(await f.hooks.spawn(f.files.lp,'retained-child',f.files.pidf,1,'token'),true);
    workerPid=f.hooks.readPid(f.files.pidf);
    f.hooks.ready(f.files);
    assert.equal(await waitFor(()=>{
      try{childPid=Number(JSON.parse(fs.readFileSync(runtime,'utf8')).childPid)||0;}catch{}
      return childPid>0;
    },10000),true,'fixture must start the child before cancellation');
    fs.writeFileSync(f.files.lp.replace(/\.json$/,'.cancel'),'cancel');
    const result=await f.hooks.wait(f.files.rf,15000,f.files.rf,'token',f.files.pidf);
    assert.equal(result.done,false);
    assert.equal(result.terminationRefused,true);
    assert.equal(result.childStillRunning,true);
    assert.equal(result.exitUnproven,true);
    assert.equal(await f.hooks.waitForExit({ProcessId:workerPid}),true,'worker entrypoint must exit after the durable result');
    assert.equal(alive(childPid),true,'entrypoint exit must leave the unbound child for reconciliation');
    for(const file of [f.files.lp,f.files.pf,f.files.pidf,f.files.rf,f.files.stdout,f.files.stderr,runtime])
      assert.equal(fs.existsSync(file),true,`reconciliation evidence must remain: ${path.basename(file)}`);
  }finally{
    if(!childPid&&fs.existsSync(runtime)){
      try{childPid=Number(JSON.parse(fs.readFileSync(runtime,'utf8')).childPid)||0;}catch{}
    }
    if(workerPid>0)await f.hooks.close(workerPid);
    if(childPid>0){
      try{process.kill(childPid,'SIGTERM');}catch{}
      await waitFor(()=>!alive(childPid),5000);
    }
    await removeFixture();
  }
});

test('snapshot failure publishes a bounded refusal instead of waiting forever',async()=>{
  if(process.platform!=='win32')return;
  const f=fixture("import fs from 'node:fs';fs.writeFileSync('child-started.txt',String(process.pid));setInterval(()=>{},1000);");
  let childPid=0;
  try{
    const config=JSON.parse(fs.readFileSync(f.files.lp,'utf8'));
    config.timeoutMs=10000;
    config.commandDigest=headlessCommandDigest(config);
    fs.writeFileSync(f.files.lp,JSON.stringify(config),'utf8');
    f.hooks.ready(f.files);
    const started=Date.now();
    let snapshots=0;
    const running=runFixtureWorker(f.files.lp,{snapshot:()=>{
      snapshots++;
      if(snapshots===1)return processSnapshot();
      throw new Error('injected snapshot failure after the child started');
    },unverifiedChildGraceMs:50});
    const runtime=f.files.lp.replace(/\.json$/,'.runtime.json'),deadline=Date.now()+10000;
    while(Date.now()<deadline&&!childPid){
      if(fs.existsSync(runtime))childPid=Number(JSON.parse(fs.readFileSync(runtime,'utf8')).childPid)||0;
      if(!childPid)await new Promise(r=>setTimeout(r,25));
    }
    assert.ok(childPid>0,'fixture must start its long-lived child before cancellation');
    fs.writeFileSync(f.files.lp.replace(/\.json$/,'.cancel'),'cancel');
    const result=await running;
    assert.ok(Date.now()-started<5000,'worker must publish a bounded result');
    assert.equal(result.done,false);
    assert.equal(result.terminationRefused,true);
    assert.equal(result.childStillRunning,true);
    assert.ok(fs.existsSync(f.files.rf));
  }finally{
    if(childPid>0){try{process.kill(childPid,'SIGTERM');}catch{}}
    let removed=false;
    for(let i=0;i<50&&!removed;i++){
      try{f.close();removed=true;}
      catch(error){if(!['EPERM','EBUSY'].includes(error?.code))throw error;await new Promise(r=>setTimeout(r,100));}
    }
    assert.equal(removed,true,'detached fixture child must release its workspace before cleanup');
  }
});

test('worker rejects controller file bindings redirected outside its derived stem',async()=>{
  const f=fixture('console.log(JSON.stringify({type:"turn.completed"}));');
  try{
    const config=JSON.parse(fs.readFileSync(f.files.lp,'utf8'));
    config.files.rf=path.join(f.workspace,'outside-result.json');
    fs.writeFileSync(f.files.lp,JSON.stringify(config),'utf8');
    await assert.rejects(()=>runFixtureWorker(f.files.lp),/Invalid headless attempt file binding: rf/);
  }finally{f.close();}
});

test('worker rejects a re-digested privileged argv before writing any child lifecycle state',async()=>{
  const f=fixture('console.log(JSON.stringify({type:"turn.completed"}));');
  try{
    const config=JSON.parse(fs.readFileSync(f.files.lp,'utf8'));
    config.args=[...buildExecArgs(['-a','never','--sandbox','read-only','--cd',f.workspace]),'--dangerously-bypass-approvals-and-sandbox'];
    config.commandDigest=headlessCommandDigest(config);
    fs.writeFileSync(f.files.lp,JSON.stringify(config),'utf8');
    f.hooks.ready(f.files);
    await assert.rejects(()=>runProductionHeadlessWorker(f.files.lp),/CHILD_AUTHORIZATION_UNAVAILABLE/);
    assert.equal(fs.existsSync(f.files.pidf),false,'privileged argv must be rejected before a PID is written');
    assert.equal(fs.existsSync(f.files.lp.replace(/\.json$/,'.runtime.json')),false,'privileged argv must be rejected before a runtime record is written');
  }finally{f.close();}
});

test('worker rejects a re-digested non-exec argv before writing any child lifecycle state',async()=>{
  const f=fixture('console.log(JSON.stringify({type:"turn.completed"}));');
  try{
    const config=JSON.parse(fs.readFileSync(f.files.lp,'utf8'));
    config.args=['--profile','elevated'];
    config.commandDigest=headlessCommandDigest(config);
    fs.writeFileSync(f.files.lp,JSON.stringify(config),'utf8');
    await assert.rejects(()=>runProductionHeadlessWorker(f.files.lp),/CHILD_AUTHORIZATION_UNAVAILABLE/);
    assert.equal(fs.existsSync(f.files.pidf),false,'non-exec argv must be rejected before a PID is written');
    assert.equal(fs.existsSync(f.files.lp.replace(/\.json$/,'.runtime.json')),false,'non-exec argv must be rejected before a runtime record is written');
  }finally{f.close();}
});

test('worker rejects a missing workspace binding before writing any child lifecycle state',async()=>{
  const f=fixture('console.log(JSON.stringify({type:"turn.completed"}));');
  try{
    const config=JSON.parse(fs.readFileSync(f.files.lp,'utf8'));
    config.args=buildExecArgs(['-a','never','--sandbox','read-only','--cd',f.workspace]);
    delete config.workspace;
    config.commandDigest=headlessCommandDigest(config);
    fs.writeFileSync(f.files.lp,JSON.stringify(config),'utf8');
    await assert.rejects(()=>runProductionHeadlessWorker(f.files.lp),/Invalid headless attempt configuration/);
    assert.equal(fs.existsSync(f.files.pidf),false,'a missing workspace binding must be rejected before a PID is written');
  }finally{f.close();}
});

test('worker accepts the read-only noninteractive argv built for Codex exec before any child starts',async()=>{
  const f=fixture('console.log(JSON.stringify({type:"turn.completed"}));');
  let timer;
  try{
    const config=JSON.parse(fs.readFileSync(f.files.lp,'utf8'));
    config.args=buildExecArgs(['-a','never','--sandbox','read-only','--cd',f.workspace]);
    config.commandDigest=headlessCommandDigest(config);
    fs.writeFileSync(f.files.lp,JSON.stringify(config),'utf8');
    timer=setTimeout(()=>fs.writeFileSync(f.files.lp.replace(/\.json$/,'.cancel'),'cancel'),100);
    const result=await runFixtureWorker(f.files.lp);
    assert.equal(result.text,'Cancelled before execution');
    assert.equal(fs.existsSync(f.files.pidf),true,'accepted exec argv must pass the worker guard before readiness');
  }finally{clearTimeout(timer);f.close();}
});

test('worker revalidates the CLI after readiness and before spawning a child',async()=>{
  const f=fixture('console.log(JSON.stringify({type:"turn.completed"}));');
  try{
    const config=JSON.parse(fs.readFileSync(f.files.lp,'utf8'));
    config.args=buildExecArgs(['-a','never','--sandbox','read-only','--cd',f.workspace]);
    config.commandDigest=headlessCommandDigest(config);
    fs.writeFileSync(f.files.lp,JSON.stringify(config),'utf8');
    f.hooks.ready(f.files);
    const result=await runProductionHeadlessWorker(f.files.lp);
    assert.equal(result.done,false);
    assert.match(result.text,/CLI_UNTRUSTED/);
    const runtime=JSON.parse(fs.readFileSync(f.files.lp.replace(/\.json$/,'.runtime.json'),'utf8'));
    assert.equal(runtime.childPid,undefined,'failed final CLI validation must run before a child is spawned');
  }finally{f.close();}
});

test('headless worker marks an account usage limit as terminal quota',async()=>{
  const f=fixture("console.log(JSON.stringify({type:'turn.failed',error:{codex_error_info:'usage_limit_exceeded',message:\"You've hit your usage limit\"}}));process.exitCode=1;");
  try{
    await f.hooks.spawn(f.files.lp,'test',f.files.pidf,1,'token');f.hooks.ready(f.files);
    const result=await f.hooks.wait(f.files.rf,10000,f.files.rf,'token',f.files.pidf);
    assert.equal(result.done,false);assert.equal(result.retryable,'quota');assert.match(result.quotaError,/usage_limit_exceeded/);
  }finally{await f.hooks.close(f.hooks.readPid(f.files.pidf));await new Promise(r=>setTimeout(r,100));f.close();}
});

test('recovered reconnect notifications do not invalidate a successful terminal event',async()=>{
  const f=fixture("console.log(JSON.stringify({type:'error',message:'Reconnecting... waiting for network (Connection failed: error sending request)'}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'recovered'}}));console.log(JSON.stringify({type:'turn.completed'}));");
  try{
    await f.hooks.spawn(f.files.lp,'test',f.files.pidf,1,'token');f.hooks.ready(f.files);
    const result=await f.hooks.wait(f.files.rf,10000,f.files.rf,'token',f.files.pidf);
    assert.equal(result.done,true);assert.equal(result.text,'recovered');assert.equal(result.retryable,undefined);
  }finally{await f.hooks.close(f.hooks.readPid(f.files.pidf));await new Promise(r=>setTimeout(r,100));f.close();}
});

test('cancelling a running hidden worker terminates its owned exec process and persists failure',async()=>{
  const f=fixture("import fs from 'node:fs';for await(const _part of process.stdin){}console.log(JSON.stringify({type:'thread.started',thread_id:'cancel-test'}));const timer=setInterval(()=>{if(fs.existsSync('cancel-fixture-release')){clearInterval(timer);process.exit(0);}},20);");
  const release=path.join(f.workspace,'cancel-fixture-release');
  try{
    await f.hooks.spawn(f.files.lp,'test',f.files.pidf,1,'token');f.hooks.ready(f.files);
    const runtime=f.files.lp.replace(/\.json$/,'.runtime.json');let childPid,childIdentity;
    const end=Date.now()+10000;
    // Wait for all three ownership facts before requesting automatic stop:
    // child PID, durable binding, and a live process.
    while(Date.now()<end&&(!childPid||!childIdentity)){
      if(fs.existsSync(runtime)){const state=JSON.parse(fs.readFileSync(runtime));childPid=state.childPid;childIdentity=state.childIdentity;}
      if(!childPid||!childIdentity)await new Promise(r=>setTimeout(r,50));
    }
    assert.ok(childPid);assert.ok(childIdentity);
    assert.doesNotThrow(()=>process.kill(childPid,0),'bound fixture child must be live before close');
    await f.hooks.close(f.hooks.readPid(f.files.pidf));
    const result=JSON.parse(fs.readFileSync(f.files.rf));assert.equal(result.done,false);assert.match(result.text,/cancelled/i);
    assert.equal(result.terminationRefused,undefined);
    assert.equal(result.terminationVerified,true);
    assert.equal(processSnapshot().has(childPid),false);
  }finally{
    try{fs.writeFileSync(release,'release');}catch{}
    await f.hooks.close(f.hooks.readPid(f.files.pidf));
    await new Promise(r=>setTimeout(r,100));
    f.close();
  }
});

test('worker-edited ready path cannot make the controller write outside its attempt',async()=>{
  const f=fixture("console.log(JSON.stringify({type:'thread.started',thread_id:'tamper-test'}));setInterval(()=>{},1000);");
  const outside=path.join(f.workspace,'outside-control.txt');
  fs.writeFileSync(outside,'untouched','utf8');
  const original=fs.readFileSync(f.files.lp,'utf8');
  try{
    const config=JSON.parse(original);
    config.ready=outside;
    fs.writeFileSync(f.files.lp,JSON.stringify(config),'utf8');
    f.hooks.ready(f.files);
    assert.equal(fs.readFileSync(outside,'utf8'),'untouched');
  }finally{
    fs.writeFileSync(f.files.lp,original,'utf8');
    f.close();
  }
});

test('worker-edited cancel path cannot make the controller write outside its attempt',async()=>{
  // This test is about derived controller paths. A short-lived child avoids
  // turning that path check into an unbound-child termination test.
  const f=fixture("console.log(JSON.stringify({type:'thread.started',thread_id:'tamper-test'}));setTimeout(()=>process.exit(0),500);");
  const outside=path.join(f.workspace,'outside-control.txt');
  fs.writeFileSync(outside,'untouched','utf8');
  const original=fs.readFileSync(f.files.lp,'utf8');
  try{
    const config=JSON.parse(original);
    await f.hooks.spawn(f.files.lp,'test',f.files.pidf);
    f.hooks.ready(f.files);
    config.cancel=outside;
    config.files.rf=path.join(f.workspace,'missing-result.json');
    fs.writeFileSync(f.files.lp,JSON.stringify(config),'utf8');
    await f.hooks.close(f.hooks.readPid(f.files.pidf));
    assert.equal(fs.readFileSync(outside,'utf8'),'untouched');
  }finally{
    fs.writeFileSync(f.files.lp,original,'utf8');
    await f.hooks.close(f.hooks.readPid(f.files.pidf));
    await new Promise(resolve=>setTimeout(resolve,100));
    f.close();
  }
});

test('a runtime journal write failure closes the owned exec before publishing a failed result',async()=>{
  const f=fixture("setInterval(()=>console.log(JSON.stringify({type:'thread.started',thread_id:'io-failure'})),100);");
  try{
    await f.hooks.spawn(f.files.lp,'test',f.files.pidf,1,'token');
    const config=JSON.parse(fs.readFileSync(f.files.lp));
    const deadline=Date.now()+10000;while(!fs.existsSync(config.runtime)&&Date.now()<deadline)await new Promise(r=>setTimeout(r,25));
    fs.unlinkSync(config.runtime);fs.mkdirSync(config.runtime);f.hooks.ready(f.files);
    const result=await f.hooks.wait(f.files.rf,10000,f.files.rf,'token',f.files.pidf);
    assert.equal(result.done,false);assert.match(result.text,/EISDIR|EPERM|EACCES/i);
    assert.equal([...processSnapshot().values()].some(p=>p.CommandLine?.includes(path.join(f.workspace,'fixture.mjs'))),false);
  }finally{await f.hooks.close(f.hooks.readPid(f.files.pidf));await new Promise(r=>setTimeout(r,100));f.close();}
});
test('failed or truncated exec streams and nonzero exit codes never produce a completed worker result',async()=>{
  for(const source of ["console.log(JSON.stringify({type:'thread.started',thread_id:'t'}));", "console.log(JSON.stringify({type:'turn.completed'}));process.exitCode=23;", "console.log(JSON.stringify({type:'turn.completed'}));console.log(JSON.stringify({type:'turn.failed',error:{message:'broken stream'}}));"]){
    const f=fixture(source);try{
      await f.hooks.spawn(f.files.lp,'test',f.files.pidf,1,'token');
      f.hooks.ready(f.files);
      const result=await f.hooks.wait(f.files.rf,10000,f.files.rf,'token',f.files.pidf);assert.equal(result.done,false);
    }finally{await f.hooks.close(f.hooks.readPid(f.files.pidf));await new Promise(r=>setTimeout(r,100));f.close();}
  }
});
