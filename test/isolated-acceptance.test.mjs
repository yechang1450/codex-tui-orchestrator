import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {physicalPathIdentity} from '../scripts/core/runtime-context.mjs';
import {controllerWindowsDir} from '../scripts/core/controller-state.mjs';

const moduleUrl=new URL('../scripts/core/isolated-acceptance.mjs',import.meta.url);
async function acceptanceApi(){
  try{return await import(moduleUrl);}
  catch{return {};}
}
function fixture(name){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),`codex-orch-${name}-`));
  const workspace=fs.mkdtempSync(path.join(root,'workspace-'));
  return {root,workspace,controllerRoot:path.join(root,'controller'),runId:'isolated-acceptance-B1'};
}
function hostEnv(fixture,threadId='55555555-5555-4555-8555-555555555555'){
  return {
    ORCH_ISOLATED_ACCEPTANCE:'1',
    ORCH_CONTROLLER_ROOT:fixture.controllerRoot,
    CODEX_THREAD_ID:threadId,
    WORKSPACE_DIR:fixture.workspace,
    ORCH_ISOLATED_ABORT_TOKEN:crypto.randomBytes(32).toString('base64url'),
  };
}

test('isolated acceptance requires a full 32-byte base64url abort capability',async()=>{
  const api=await acceptanceApi();
  const weak=fixture('weak-abort-capability');
  try{
    const env={...hostEnv(weak),ORCH_ISOLATED_ABORT_TOKEN:'short-token'};
    const initiatorContext=Object.freeze({threadId:env.CODEX_THREAD_ID,workspace:weak.workspace});
    assert.throws(()=>api.prepareIsolatedAcceptance({workspace:weak.workspace,runId:weak.runId,env,initiatorContext}),/32-byte|abort token/i);
  }finally{fs.rmSync(weak.root,{recursive:true,force:true});}
  const leadingSymbol=fixture('leading-symbol-abort-capability');
  try{
    const env={...hostEnv(leadingSymbol),ORCH_ISOLATED_ABORT_TOKEN:'_'+ 'a'.repeat(42)};
    const initiatorContext=Object.freeze({threadId:env.CODEX_THREAD_ID,workspace:leadingSymbol.workspace});
    assert.doesNotThrow(()=>api.prepareIsolatedAcceptance({workspace:leadingSymbol.workspace,runId:leadingSymbol.runId,env,initiatorContext}));
  }finally{fs.rmSync(leadingSymbol.root,{recursive:true,force:true});}
});

test('isolated acceptance writes a minimal controller-owned proof for the captured host workspace',async()=>{
  const api=await acceptanceApi();
  assert.equal(typeof api.prepareIsolatedAcceptance,'function','isolated acceptance guard must be available');
  const f=fixture('proof');
  try{
    const env=hostEnv(f);
    const initiatorContext=Object.freeze({threadId:env.CODEX_THREAD_ID,workspace:f.workspace});
    const proof=api.prepareIsolatedAcceptance({workspace:f.workspace,runId:f.runId,env,initiatorContext});
    assert.equal(proof.skipSharedCleanup,true);
    assert.ok(path.relative(f.workspace,proof.file).startsWith('..'),`proof must stay outside workspace: ${proof.file}`);
    const saved=JSON.parse(fs.readFileSync(proof.file,'utf8'));
    assert.deepEqual(saved,{schema:1,runId:f.runId,threadBound:true,workspaceIdentity:physicalPathIdentity(f.workspace),abortTokenSha256:crypto.createHash('sha256').update(env.ORCH_ISOLATED_ABORT_TOKEN,'utf8').digest('hex')});
    assert.equal(Object.hasOwn(saved,'threadId'),false,'proof must not retain thread data');
    assert.equal(Object.hasOwn(saved,'workspace'),false,'proof must not retain a raw workspace path');
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('isolated acceptance abort records are controller-bound, first-write-only, and do not expose their token',async()=>{
  const api=await acceptanceApi();
  assert.equal(typeof api.acceptanceAbortSpec,'function','isolated acceptance must derive a controller-owned abort spec');
  assert.equal(typeof api.requestAcceptanceAbort,'function','isolated acceptance must publish a controller-owned abort');
  assert.equal(typeof api.readAcceptanceAbort,'function','isolated acceptance must validate a controller-owned abort');
  const f=fixture('abort');
  try{
    const env=hostEnv(f),initiatorContext=Object.freeze({threadId:env.CODEX_THREAD_ID,workspace:f.workspace});
    api.prepareIsolatedAcceptance({workspace:f.workspace,runId:f.runId,env,initiatorContext});
    const spec=api.acceptanceAbortSpec({workspace:f.workspace,runId:f.runId,token:env.ORCH_ISOLATED_ABORT_TOKEN,env});
    assert.equal(api.readAcceptanceAbort(spec),null);
    assert.ok(path.relative(f.workspace,spec.file).startsWith('..'),`abort record must stay outside workspace: ${spec.file}`);
    const first=api.requestAcceptanceAbort(spec,{reason:'monitor-failed'});
    const saved=JSON.parse(fs.readFileSync(spec.file,'utf8'));
    assert.equal(JSON.stringify(saved).includes(env.ORCH_ISOLATED_ABORT_TOKEN),false,'abort record must not retain the raw token');
    assert.equal(JSON.stringify(saved).includes(f.workspace),false,'abort record must not retain the raw workspace path');
    assert.equal(Object.hasOwn(first,'authTag'),false,'abort projections must not disclose the record authenticator');
    assert.equal(first.reason,'monitor-failed');
    assert.deepEqual(api.requestAcceptanceAbort(spec,{reason:'monitor-failed'}),first,'a second request must preserve the first durable record');
    for(const patch of [{abortTokenSha256:'foreign'},{workspaceKeySha256:'foreign'},{runId:'foreign'},{reason:'bad reason'},{requestedAt:Date.now()+120000}]){
      fs.writeFileSync(spec.file,JSON.stringify({...saved,...patch}),'utf8');
      assert.throws(()=>api.readAcceptanceAbort(spec),/abort/i,JSON.stringify(patch));
    }
    const noToken={...env};delete noToken.ORCH_ISOLATED_ABORT_TOKEN;
    const other=fixture('abort-token-required');
    try{assert.throws(()=>api.prepareIsolatedAcceptance({workspace:other.workspace,runId:other.runId,env:{...noToken,ORCH_CONTROLLER_ROOT:other.controllerRoot,WORKSPACE_DIR:other.workspace},initiatorContext:Object.freeze({threadId:noToken.CODEX_THREAD_ID,workspace:other.workspace})}),/abort token/i);}
    finally{fs.rmSync(other.root,{recursive:true,force:true});}
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('terminal records require a controller-held authenticator instead of a public hash',async()=>{
  const api=await acceptanceApi();
  const f=fixture('terminal-authenticator');
  try{
    const env=hostEnv(f),initiatorContext=Object.freeze({threadId:env.CODEX_THREAD_ID,workspace:f.workspace});
    api.prepareIsolatedAcceptance({workspace:f.workspace,runId:f.runId,env,initiatorContext});
    const spec=api.acceptanceAbortSpec({workspace:f.workspace,runId:f.runId,token:env.ORCH_ISOLATED_ABORT_TOKEN,env});
    const proof=JSON.parse(fs.readFileSync(path.join(f.controllerRoot,'acceptance-proofs',f.runId+'.json'),'utf8'));
    const workspaceKeySha256=crypto.createHash('sha256').update(physicalPathIdentity(f.workspace),'utf8').digest('hex');
    const forgedAbort={schema:1,kind:'acceptance-abort',runId:f.runId,workspaceKeySha256,abortTokenSha256:proof.abortTokenSha256,reason:'monitor-failed',requestedAt:Date.now(),authTag:'0'.repeat(64)};
    assert.equal(JSON.stringify(forgedAbort).includes(env.ORCH_ISOLATED_ABORT_TOKEN),false,'the fixture must use public data only');
    fs.mkdirSync(path.dirname(spec.file),{recursive:true});
    fs.writeFileSync(spec.file,JSON.stringify(forgedAbort),{encoding:'utf8',flag:'wx'});
    assert.throws(()=>api.readAcceptanceAbort(spec),/abort/i,'a public token hash must not authenticate an abort');
    fs.rmSync(spec.file,{force:true});
    const finalizationFile=path.join(f.controllerRoot,'acceptance-finalizations',f.runId+'.json');
    const forgedFinalization={schema:1,kind:'acceptance-finalization',runId:f.runId,workspaceKeySha256,abortTokenSha256:proof.abortTokenSha256,finalizedAt:Date.now(),authTag:'0'.repeat(64)};
    fs.mkdirSync(path.dirname(finalizationFile),{recursive:true});
    fs.writeFileSync(finalizationFile,JSON.stringify(forgedFinalization),{encoding:'utf8',flag:'wx'});
    assert.throws(()=>api.readAcceptanceFinalization(spec),/finalization/i,'a public token hash must not authenticate a success finalization');
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('terminal publication stays absent to readers until a complete authenticated record is linked',async()=>{
  const api=await acceptanceApi();
  const f=fixture('terminal-atomic-publish');
  try{
    const env=hostEnv(f),initiatorContext=Object.freeze({threadId:env.CODEX_THREAD_ID,workspace:f.workspace});
    api.prepareIsolatedAcceptance({workspace:f.workspace,runId:f.runId,env,initiatorContext});
    const spec=api.acceptanceAbortSpec({workspace:f.workspace,runId:f.runId,token:env.ORCH_ISOLATED_ABORT_TOKEN,env});
    const originalLink=fs.linkSync;
    let observed=Symbol('link was not used');
    fs.linkSync=(source,target)=>{
      if(path.resolve(String(target))===path.resolve(spec.file))observed=api.readAcceptanceAbort(spec);
      return originalLink.call(fs,source,target);
    };
    let abort;
    try{abort=api.requestAcceptanceAbort(spec,{reason:'monitor-failed'});}
    finally{fs.linkSync=originalLink;}
    assert.equal(observed,null,'readers must see no target before the atomic publish point');
    assert.equal(api.readAcceptanceAbort(spec)?.requestedAt,abort.requestedAt,'the linked target must be fully readable after publish');
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('isolated acceptance serializes a success finalization against later abort publication',async()=>{
  const api=await acceptanceApi();
  assert.equal(typeof api.finalizeAcceptanceSuccess,'function','isolated acceptance must finalize success through the controller authority');
  assert.equal(typeof api.readAcceptanceFinalization,'function','observers must be able to validate the controller finalization');
  const f=fixture('terminal-order');
  try{
    const env=hostEnv(f),initiatorContext=Object.freeze({threadId:env.CODEX_THREAD_ID,workspace:f.workspace});
    api.prepareIsolatedAcceptance({workspace:f.workspace,runId:f.runId,env,initiatorContext});
    const spec=api.acceptanceAbortSpec({workspace:f.workspace,runId:f.runId,token:env.ORCH_ISOLATED_ABORT_TOKEN,env});
    assert.equal(api.finalizeAcceptanceSuccess(spec),null,'an abort-free run must acquire the success terminal decision');
    const finalization=api.readAcceptanceFinalization(spec);
    assert.equal(finalization?.kind,'acceptance-finalization');
    assert.equal(finalization?.runId,f.runId);
    assert.equal(JSON.stringify(finalization).includes(env.ORCH_ISOLATED_ABORT_TOKEN),false,'the finalization projection must not disclose the abort capability');
    assert.equal(Object.hasOwn(finalization,'authTag'),false,'finalization projections must not disclose the record authenticator');
    assert.equal(api.requestAcceptanceAbort(spec,{reason:'monitor-failed'}),null,'a later abort cannot overturn a committed success finalization');
    assert.equal(api.readAcceptanceAbort(spec),null);
    const other=fixture('terminal-order-abort-first');
    try{
      const otherEnv=hostEnv(other),otherContext=Object.freeze({threadId:otherEnv.CODEX_THREAD_ID,workspace:other.workspace});
      api.prepareIsolatedAcceptance({workspace:other.workspace,runId:other.runId,env:otherEnv,initiatorContext:otherContext});
      const otherSpec=api.acceptanceAbortSpec({workspace:other.workspace,runId:other.runId,token:otherEnv.ORCH_ISOLATED_ABORT_TOKEN,env:otherEnv});
      const abort=api.requestAcceptanceAbort(otherSpec,{reason:'monitor-failed'});
      assert.equal(api.finalizeAcceptanceSuccess(otherSpec)?.reason,abort.reason,'an earlier abort must win the same terminal decision');
      assert.equal(api.readAcceptanceFinalization(otherSpec),null);
    }finally{fs.rmSync(other.root,{recursive:true,force:true});}
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('a committed finalization remains authoritative when terminal lock cleanup fails',async()=>{
  const api=await acceptanceApi();
  const f=fixture('terminal-lock-cleanup');
  try{
    const env=hostEnv(f),initiatorContext=Object.freeze({threadId:env.CODEX_THREAD_ID,workspace:f.workspace});
    api.prepareIsolatedAcceptance({workspace:f.workspace,runId:f.runId,env,initiatorContext});
    const spec=api.acceptanceAbortSpec({workspace:f.workspace,runId:f.runId,token:env.ORCH_ISOLATED_ABORT_TOKEN,env});
    const originalRmdir=fs.rmdirSync;
    let cleanupAttempts=0;
    fs.rmdirSync=(target,...args)=>{
      if(path.basename(String(target))===f.runId+'.lock'){
        cleanupAttempts++;
        const error=new Error('fixture terminal lock cleanup denied');
        error.code='EACCES';
        throw error;
      }
      return originalRmdir.call(fs,target,...args);
    };
    try{
      assert.equal(api.finalizeAcceptanceSuccess(spec),null,'a durable success decision must not be reversed by lock cleanup');
    }finally{fs.rmdirSync=originalRmdir;}
    assert.equal(cleanupAttempts,1,'the fixture must exercise the terminal lock cleanup path');
    assert.equal(api.readAcceptanceFinalization(spec)?.kind,'acceptance-finalization');
    assert.equal(api.requestAcceptanceAbort(spec,{reason:'monitor-failed'}),null,'a stale cleanup lock must resolve through the durable finalization rather than timing out');
    assert.equal(api.readAcceptanceAbort(spec),null);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('two controller processes cannot commit both isolated terminal records',async()=>{
  const api=await acceptanceApi();
  const f=fixture('terminal-race');
  const raceDir=path.join(f.root,'race');fs.mkdirSync(raceDir);
  const childFile=path.join(raceDir,'terminal-racer.mjs');
  fs.writeFileSync(childFile,`import fs from 'node:fs';\nconst api=await import(process.env.ORCH_ACCEPTANCE_MODULE);\nconst mode=process.argv[2],dir=process.env.ORCH_RACE_DIR;\nconst spec=api.acceptanceAbortSpec({workspace:process.env.WORKSPACE_DIR,runId:process.env.ORCH_RUN_ID,token:process.env.ORCH_ISOLATED_ABORT_TOKEN,env:process.env});\nfs.writeFileSync(new URL('ready-'+mode,process.env.ORCH_RACE_URL),'ready');\nwhile(!fs.existsSync(new URL('go',process.env.ORCH_RACE_URL)))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);\nconst result=mode==='abort'?api.requestAcceptanceAbort(spec,{reason:'monitor-failed'}):api.finalizeAcceptanceSuccess(spec);\nconsole.log(JSON.stringify(result?{kind:result.kind,reason:result.reason||null}:null));\n`,'utf8');
  const runChild=(mode,env)=>new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[childFile,mode],{env,windowsHide:true,stdio:['ignore','pipe','pipe'],shell:false});
    let stdout='',stderr='';child.stdout.on('data',value=>stdout+=value);child.stderr.on('data',value=>stderr+=value);
    child.on('error',reject);child.on('close',code=>resolve({code,stdout,stderr}));
  });
  try{
    const env=hostEnv(f),initiatorContext=Object.freeze({threadId:env.CODEX_THREAD_ID,workspace:f.workspace});
    api.prepareIsolatedAcceptance({workspace:f.workspace,runId:f.runId,env,initiatorContext});
    const childEnv={...process.env,...env,ORCH_ACCEPTANCE_MODULE:moduleUrl.href,ORCH_RACE_DIR:raceDir,ORCH_RACE_URL:new URL('file:///'+raceDir.replaceAll('\\','/')+'/').href,ORCH_RUN_ID:f.runId};
    const finalizing=runChild('finalize',childEnv),aborting=runChild('abort',childEnv);
    const deadline=Date.now()+5000;
    while((!fs.existsSync(path.join(raceDir,'ready-finalize'))||!fs.existsSync(path.join(raceDir,'ready-abort')))&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));
    assert.equal(fs.existsSync(path.join(raceDir,'ready-finalize'))&&fs.existsSync(path.join(raceDir,'ready-abort')),true,'both contenders must reach the same terminal-decision barrier');
    fs.writeFileSync(path.join(raceDir,'go'),'go','utf8');
    const [finalResult,abortResult]=await Promise.all([finalizing,aborting]);
    assert.equal(finalResult.code,0,finalResult.stderr);assert.equal(abortResult.code,0,abortResult.stderr);
    const spec=api.acceptanceAbortSpec({workspace:f.workspace,runId:f.runId,token:env.ORCH_ISOLATED_ABORT_TOKEN,env});
    const finalization=api.readAcceptanceFinalization(spec),abort=api.readAcceptanceAbort(spec);
    assert.equal(Boolean(finalization),!Boolean(abort),'exactly one terminal record must survive concurrent contenders');
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('isolated acceptance startup receipts bind the live launcher to the physical initiating workspace',async()=>{
  const api=await acceptanceApi();
  assert.equal(typeof api.startupReceiptSpec,'function','isolated acceptance must derive a controller-owned startup receipt');
  assert.equal(typeof api.readStartupReceipt,'function','isolated acceptance must validate a controller-owned startup receipt');
  const f=fixture('startup-receipt');
  try{
    const env=hostEnv(f),initiatorContext=Object.freeze({threadId:env.CODEX_THREAD_ID,workspace:f.workspace});
    api.prepareIsolatedAcceptance({workspace:f.workspace,runId:f.runId,env,initiatorContext});
    const spec=api.startupReceiptSpec({workspace:f.workspace,runId:f.runId,blockKey:'B1',attempt:1,token:'token-startup-123',env});
    assert.ok(path.relative(f.workspace,spec.file).startsWith('..'),`startup receipt must stay outside workspace: ${spec.file}`);
    assert.equal(path.basename(spec.file).includes('token-startup-123'),false,'startup receipt path must not disclose the token');
    const launcher={ProcessId:4321,Name:'powershell.exe',Started:new Date(Date.now()-1000).toISOString(),CommandLine:'launcher'};
    const record={schema:1,kind:'launcher-start',runId:f.runId,blockKey:'B1',attempt:1,tokenSha256:spec.tokenSha256,workspaceKeySha256:spec.workspaceKeySha256,launcherPid:4321,cwd:f.workspace,createdAt:Date.now()};
    fs.writeFileSync(spec.file,JSON.stringify(record),'utf8');
    const receipt=api.readStartupReceipt(spec,{launcher});
    assert.equal(receipt.workspaceIdentity,physicalPathIdentity(f.workspace));
    assert.equal(Object.hasOwn(receipt,'cwd'),false,'the report projection must not retain raw workspace paths');
    for(const patch of [{tokenSha256:'foreign'},{launcherPid:4322},{cwd:f.root},{attempt:2},{runId:'foreign'},{createdAt:Date.now()+120000},{createdAt:Date.parse(launcher.Started)-6000}]){
      fs.writeFileSync(spec.file,JSON.stringify({...record,...patch}),'utf8');
      assert.throws(()=>api.readStartupReceipt(spec,{launcher}),/startup receipt/i,JSON.stringify(patch));
    }
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('visible execution verifies the durable startup receipt before the runner can release it',()=>{
  const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
  const source=fs.readFileSync(path.join(repo,'scripts','core','orchestrate-sdk.mjs'),'utf8');
  const verifier=source.indexOf('function verifyVisibleStartupReceipt(');
  assert.ok(verifier>=0,'visible execution needs a controller-side startup receipt verifier');
  const executor=source.indexOf("const executor=executionMode==='headless'");
  assert.ok(executor>verifier,'the runner executor must be built after the visible receipt verifier');
  assert.match(source.slice(executor),/verifyStartup:\s*\(files,\s*launcher\)\s*=>\s*verifyVisibleStartupReceipt\(files,\s*launcher,\s*\{workspace:WORKSPACE,env:acceptanceEnv\}\)/,'the visible executor must supply receipt verification before runner ready');
});

test('isolated acceptance fails before writing when the immutable host binding or fresh controller root is unavailable',async()=>{
  const api=await acceptanceApi();
  assert.equal(typeof api.prepareIsolatedAcceptance,'function','isolated acceptance guard must be available');
  const f=fixture('refusal');
  try{
    const env=hostEnv(f);
    assert.throws(
      ()=>api.prepareIsolatedAcceptance({workspace:f.workspace,runId:f.runId,env,initiatorContext:Object.freeze({threadId:env.CODEX_THREAD_ID,workspace:''})}),
      /immutable initiating workspace binding missing/,
    );
    assert.equal(fs.existsSync(f.controllerRoot),false,'a failed binding must not create controller state');
    fs.mkdirSync(f.controllerRoot,{recursive:true});
    fs.writeFileSync(path.join(f.controllerRoot,'foreign.txt'),'foreign','utf8');
    assert.throws(
      ()=>api.prepareIsolatedAcceptance({workspace:f.workspace,runId:f.runId,env,initiatorContext:Object.freeze({threadId:env.CODEX_THREAD_ID,workspace:f.workspace})}),
      /fresh empty controller root/,
    );
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('isolated acceptance rejects a resume or a pre-existing workspace run before creating controller state',async()=>{
  const api=await acceptanceApi();
  assert.equal(typeof api.prepareIsolatedAcceptance,'function','isolated acceptance guard must be available');
  const f=fixture('fresh-run');
  try{
    const env=hostEnv(f);
    const initiatorContext=Object.freeze({threadId:env.CODEX_THREAD_ID,workspace:f.workspace});
    assert.throws(
      ()=>api.prepareIsolatedAcceptance({workspace:f.workspace,runId:f.runId,env,initiatorContext,resume:true}),
      /resume is forbidden/,
    );
    assert.equal(fs.existsSync(f.controllerRoot),false);
    fs.mkdirSync(path.join(f.workspace,'temp','orchestrator','runs',f.runId),{recursive:true});
    assert.throws(
      ()=>api.prepareIsolatedAcceptance({workspace:f.workspace,runId:f.runId,env,initiatorContext}),
      /fresh workspace run directory required/,
    );
    assert.equal(fs.existsSync(f.controllerRoot),false);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('isolated execution skips shared stale cleanup only after the host proof is durable',async()=>{
  const api=await acceptanceApi();
  assert.equal(typeof api.prepareExecutionLane,'function','isolated execution lane must be available');
  const f=fixture('lane');
  try{
    const env=hostEnv(f);
    const initiatorContext=Object.freeze({threadId:env.CODEX_THREAD_ID,workspace:f.workspace});
    let windows=0,transients=0;
    const lane=await api.prepareExecutionLane({workspace:f.workspace,runId:f.runId,env,initiatorContext,
      cleanWindows:async()=>{windows++;},cleanTransients:()=>{transients++;}});
    assert.equal(lane.skipSharedCleanup,true);
    assert.equal(windows,0);
    assert.equal(transients,0);
    assert.equal(fs.existsSync(lane.file),true);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('an isolated lane initialized before planning remains valid after controller-owned planning state appears',async()=>{
  const api=await acceptanceApi();
  assert.equal(typeof api.prepareIsolatedAcceptance,'function','isolated acceptance initializer must be available');
  const f=fixture('early-lane');
  try{
    const env=hostEnv(f);
    const initiatorContext=Object.freeze({threadId:env.CODEX_THREAD_ID,workspace:f.workspace});
    const acceptance=api.prepareIsolatedAcceptance({workspace:f.workspace,runId:f.runId,env,initiatorContext});
    fs.mkdirSync(path.join(f.controllerRoot,'decompose'),{recursive:true});
    fs.writeFileSync(path.join(f.controllerRoot,'decompose','planning.json'),'controller-owned planning state','utf8');
    let windows=0,transients=0;
    const lane=await api.prepareExecutionLane({workspace:f.workspace,runId:f.runId,env,initiatorContext,acceptance,
      cleanWindows:async()=>{windows++;},cleanTransients:()=>{transients++;}});
    assert.equal(lane,acceptance,'the execution phase must consume the early isolated proof instead of recreating it');
    assert.equal(windows,0);
    assert.equal(transients,0);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('isolated acceptance refuses a caller-selected coordinator directory',async()=>{
  const api=await acceptanceApi();
  assert.equal(typeof api.prepareIsolatedAcceptance,'function','isolated acceptance guard must be available');
  const f=fixture('coordinator-override');
  try{
    const env={...hostEnv(f),ORCH_COORDINATOR_DIR:path.join(f.root,'shared-coordinator')};
    const initiatorContext=Object.freeze({threadId:env.CODEX_THREAD_ID,workspace:f.workspace});
    assert.throws(
      ()=>api.prepareIsolatedAcceptance({workspace:f.workspace,runId:f.runId,env,initiatorContext}),
      /caller-selected coordinator directory is forbidden/,
    );
    assert.equal(fs.existsSync(f.controllerRoot),false);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('ordinary execution retains its stale cleanup callbacks',async()=>{
  const api=await acceptanceApi();
  assert.equal(typeof api.prepareExecutionLane,'function','isolated execution lane must be available');
  let windows=0,transients=0;
  const lane=await api.prepareExecutionLane({workspace:process.cwd(),runId:'ordinary',env:{},
    cleanWindows:async()=>{windows++;},cleanTransients:()=>{transients++;}});
  assert.deepEqual(lane,{enabled:false,skipSharedCleanup:false,file:null});
  assert.equal(windows,1);
  assert.equal(transients,1);
});

test('the execution engine routes run modes through the isolated acceptance lane',()=>{
  const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
  const source=fs.readFileSync(path.join(repo,'scripts','core','orchestrate-sdk.mjs'),'utf8');
  assert.match(source,/import\s+\{[^}]*prepareIsolatedAcceptance[^}]*prepareExecutionLane[^}]*\}\s+from\s+['"]\.\/isolated-acceptance\.mjs['"]/);
  const runBranch=source.indexOf("if (['--run-windows','--visible','--run','--exec','--headless','--resume-run'].includes(mode))");
  const initialized=source.indexOf('const executionLane=prepareIsolatedAcceptance',runBranch);
  const planning=source.indexOf('await decomposeSafely',runBranch);
  const lane=source.indexOf('await prepareExecutionLane',runBranch);
  const executor=source.indexOf('const executor=',runBranch);
  assert.ok(runBranch>=0&&initialized>runBranch&&initialized<planning,'isolated acceptance must claim its root before planning can write controller state');
  assert.ok(lane>planning&&lane<executor,'run modes must consume the isolated lane before any executor is built');
});

test('interactive isolated launchers publish their startup receipt after PID publication and before Codex can start',()=>{
  const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
  const source=fs.readFileSync(path.join(repo,'scripts','core','orchestrate-sdk.mjs'),'utf8');
  const binding=source.indexOf('startupReceiptSpec({workspace:WORKSPACE,runId:metadata.runId,blockKey:metadata.blockKey,attempt:metadata.attemptNumber,token,env:acceptanceEnv})');
  const pidPublish=source.indexOf("Move-Item -LiteralPath $pidTemp -Destination '");
  const receiptCall=source.indexOf('"Write-StartupReceipt"',pidPublish);
  const codexSetup=source.indexOf("foreach ($name in @('CODEX_APP_TOOLS_PIPE_PATH'",receiptCall);
  const scrubbed=['ORCH_ISOLATED_ABORT_TOKEN','ORCH_CONTROLLER_ROOT','ORCH_RUN_ID','ORCH_ISOLATED_ACCEPTANCE'].map(name=>source.indexOf("'"+name+"'",receiptCall));
  assert.ok(binding>=0,'isolated interactive launchers must derive a controller-owned receipt from runner metadata');
  assert.ok(pidPublish>=0&&receiptCall>pidPublish&&codexSetup>receiptCall,'receipt must be written after atomic PID publication and before any Codex launch setup');
  assert.ok(scrubbed.every(index=>index>receiptCall),'visible child launchers must remove controller-only acceptance state after publishing their startup receipt');
});

test('an acceptance observer can derive the child window registry from its explicit isolated environment',()=>{
  const f=fixture('controller-env');
  try{
    const derived=controllerWindowsDir(f.workspace,{ORCH_CONTROLLER_ROOT:f.controllerRoot});
    assert.ok(derived.startsWith(f.controllerRoot+path.sep),`registry escaped isolated controller root: ${derived}`);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});
