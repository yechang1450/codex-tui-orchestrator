import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runWindows,readOwnedLauncherExitEvidence,waitForOwnedLauncherExit,sweepRunProcesses,classifySpawnResult} from '../scripts/core/runner.mjs';
import {controllerWindowsDir,controllerHeadlessBase} from '../scripts/core/controller-state.mjs';

const family=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../temp');
fs.mkdirSync(family,{recursive:true});

test('owned launcher exit evidence binds the current token and PID',async()=>{
  const dir=fs.mkdtempSync(path.join(family,'launcher-evidence-'));
  const files={pidf:path.join(dir,'window.pid'),rf:path.join(dir,'window.result.json')};
  const attempt={token:'run-B1-a1-token'};
  try{
    fs.writeFileSync(files.pidf,'4242','utf8');
    fs.writeFileSync(files.rf,JSON.stringify({__DONE__:true,__TOKEN__:attempt.token,__LAUNCHER_PID__:4242,__EXIT__:0})+'\n__EXIT__=0','utf8');
    assert.equal(readOwnedLauncherExitEvidence(files,attempt,4242).__TOKEN__,attempt.token);
    const proved=await waitForOwnedLauncherExit(files,attempt,{readPid:()=>4242,probePid:()=>false,timeoutMs:20});
    assert.equal(proved.__TOKEN__,attempt.token);
    fs.writeFileSync(files.rf,JSON.stringify({__DONE__:true,__TOKEN__:'foreign',__LAUNCHER_PID__:4242})+'\n','utf8');
    assert.equal(readOwnedLauncherExitEvidence(files,attempt,4242),null);
    assert.equal(await waitForOwnedLauncherExit(files,attempt,{readPid:()=>4242,probePid:()=>false,timeoutMs:20}),null);
    fs.writeFileSync(files.rf,JSON.stringify({__DONE__:true,__TOKEN__:attempt.token,__LAUNCHER_PID__:4243})+'\n','utf8');
    assert.equal(readOwnedLauncherExitEvidence(files,attempt,4242),null);
    for(const forgedPid of [0,-1,4194305]){
      fs.writeFileSync(files.rf,JSON.stringify({__DONE__:true,__TOKEN__:attempt.token,__LAUNCHER_PID__:forgedPid})+'\n','utf8');
      fs.writeFileSync(files.pidf,String(forgedPid),'utf8');
      assert.equal(readOwnedLauncherExitEvidence(files,attempt,forgedPid),null);
      assert.equal(await waitForOwnedLauncherExit(files,attempt,{readPid:()=>forgedPid,probePid:()=>false,timeoutMs:20}),null);
    }
    fs.writeFileSync(files.pidf,'4242','utf8');
    fs.writeFileSync(files.rf,'not-json\n','utf8');
    assert.equal(readOwnedLauncherExitEvidence(files,attempt,4242),null);
    fs.writeFileSync(files.rf,JSON.stringify({__DONE__:true,__TOKEN__:attempt.token,__LAUNCHER_PID__:4242})+'\n','utf8');
    assert.equal(await waitForOwnedLauncherExit(files,attempt,{readPid:()=>4242,probePid:()=>true,timeoutMs:20}),null);
    assert.equal(await waitForOwnedLauncherExit(files,attempt,{readPid:()=>0,probePid:()=>false,timeoutMs:20}),null);
    assert.equal(await waitForOwnedLauncherExit(files,attempt,{readPid:()=>{throw new Error('transient pid read')},probePid:()=>false,timeoutMs:20}),null);
    assert.equal(await waitForOwnedLauncherExit(files,attempt,{readPid:()=>4242,probePid:()=>{throw new Error('transient presence probe')},timeoutMs:20}),null);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('headless exit evidence binds a formatted result to the current run, token and PID',async()=>{
  const dir=fs.mkdtempSync(path.join(family,'headless-launcher-evidence-'));
  const files={mode:'headless',pidf:path.join(dir,'exec-B1.pid'),rf:path.join(dir,'exec-B1.result.json')};
  const attempt={runId:'headless-run',token:'headless-run-B1-a1-token'};
  const write=result=>fs.writeFileSync(files.rf,JSON.stringify(result,null,2),'utf8');
  try{
    fs.writeFileSync(files.pidf,'4242','utf8');
    write({runId:attempt.runId,token:attempt.token,pid:4242,done:true,exitCode:0});
    const evidence=readOwnedLauncherExitEvidence(files,attempt,4242);
    assert.equal(evidence.__TOKEN__,attempt.token);
    assert.equal(evidence.__LAUNCHER_PID__,4242);
    assert.equal(evidence.__EXIT__,0);
    const proved=await waitForOwnedLauncherExit(files,attempt,{readPid:()=>4242,probePid:()=>false,timeoutMs:20});
    assert.equal(proved.__TOKEN__,attempt.token);
    // A failed task can still prove that this owned worker exited. Success is
    // decided by the normal task receipt checks, not by this ownership proof.
    write({runId:attempt.runId,token:attempt.token,pid:4242,done:false,exitCode:1});
    assert.equal(readOwnedLauncherExitEvidence(files,attempt,4242).__EXIT__,1);
    for(const change of [
      {runId:'foreign-run'},
      {token:'foreign-token'},
      {pid:4243},
      {done:'true'},
      {exitCode:'0'},
      {done:true,exitCode:1},
    ]){
      write({...{runId:attempt.runId,token:attempt.token,pid:4242,done:true,exitCode:0},...change});
      assert.equal(readOwnedLauncherExitEvidence(files,attempt,4242),null,JSON.stringify(change));
    }
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('final sweep records a verified headless worker exit for a later resume',async()=>{
  const workspace=fs.mkdtempSync(path.join(family,'headless-sweep-'));
  const controllerRoot=fs.mkdtempSync(path.join(family,'headless-sweep-controller-'));
  const previous=process.env.ORCH_CONTROLLER_ROOT;process.env.ORCH_CONTROLLER_ROOT=controllerRoot;
  try{
    const runId='headless-sweep',token='headless-sweep-B1-a1-token',attempt={
      runId,token,number:1,taskIds:['T001'],file:path.join(workspace,'temp','orchestrator','runs',runId,'attempts','B1','1','attempt.json')
    };
    fs.mkdirSync(path.dirname(attempt.file),{recursive:true});fs.writeFileSync(attempt.file,JSON.stringify(attempt),'utf8');
    const base=controllerHeadlessBase(workspace,attempt.file,'B1');fs.mkdirSync(path.dirname(base),{recursive:true});
    const files={mode:'headless',lp:base+'.json',pf:base+'.prompt.txt',pidf:base+'.pid',rf:base+'.result.json',stdout:base+'.stdout.jsonl',stderr:base+'.stderr.log'};
    fs.writeFileSync(files.lp,JSON.stringify({version:1,cli:process.execPath,args:[],workspace,runId,token,attemptFile:attempt.file,timeoutMs:1000,files,ready:base+'.go',cancel:base+'.cancel',runtime:base+'.runtime.json'}),'utf8');
    fs.writeFileSync(files.pidf,'4242','utf8');
    fs.writeFileSync(files.rf,JSON.stringify({runId,token,pid:4242,done:true,exitCode:0},null,2),'utf8');
    const entry={status:'verified',token,attempts:[attempt],launcherFiles:files,exitConfirmed:false};
    const summary={runId,workspace,blocks:[{key:'B1',taskIds:['T001']}],results:{B1:entry}};
    const stats=await sweepRunProcesses(summary,{identify:()=>null,probePid:()=>false,waitForExit:async()=>true,close:async()=>{throw new Error('closed worker must not be reopened');}});
    assert.deepEqual(stats,{checked:1,closed:1,failed:0,retained:0});
    assert.equal(entry.exitConfirmed,true);
    assert.deepEqual(entry.exitEvidence&&{token:entry.exitEvidence.token,pid:entry.exitEvidence.pid,exitCode:entry.exitEvidence.exitCode},{token,pid:4242,exitCode:0});
  }finally{
    if(previous===undefined)delete process.env.ORCH_CONTROLLER_ROOT;else process.env.ORCH_CONTROLLER_ROOT=previous;
    fs.rmSync(workspace,{recursive:true,force:true});fs.rmSync(controllerRoot,{recursive:true,force:true});
  }
});

test('spawn false is only cleanly absent when the adapter proves no process exists',()=>{
  assert.deepEqual(classifySpawnResult({ok:false,noProcess:true},false),{spawned:false,noProcess:true,unknown:false});
  assert.deepEqual(classifySpawnResult(false,false),{spawned:false,noProcess:false,unknown:true});
  assert.deepEqual(classifySpawnResult({ok:false,noProcess:true},true),{spawned:false,noProcess:false,unknown:true});
  assert.deepEqual(classifySpawnResult({ok:true},false),{spawned:true,noProcess:false,unknown:false});
});

test('final sweep retains an unresolved launcher lease without attempting cleanup',async()=>{
  let closes=0;
  const summary={runId:'retain-run',blocks:[{key:'B1',taskIds:['T001']}],results:{B1:{
    status:'needs-reconciliation',exitConfirmed:false,attempts:[{runId:'retain-run',token:'retain-token',taskIds:['T001'],exitUnprovenAt:Date.now()}]
  }}};
  const stats=await sweepRunProcesses(summary,{close:async()=>{closes++;}});
  assert.deepEqual(stats,{checked:1,closed:0,failed:0,retained:1});
  assert.equal(closes,0);
});

test('final sweep does not reopen a launcher with current owned exit evidence',async()=>{
  let closes=0;
  const attempt={runId:'closed-run',token:'closed-token',taskIds:['T001'],exitEvidence:{token:'closed-token',pid:4242}};
  const summary={runId:'closed-run',blocks:[{key:'B1',taskIds:['T001']}],results:{B1:{
    status:'awaiting-verification',token:'closed-token',exitConfirmed:true,attempts:[attempt]
  }}};
  const stats=await sweepRunProcesses(summary,{close:async()=>{closes++;}});
  assert.deepEqual(stats,{checked:0,closed:0,failed:0,retained:0});
  assert.equal(closes,0);
});

test('identity loss after a confirmed spawn retains the lease and artifacts',{skip:process.env.ORCH_RUN_LIVE_EXAM!=='1'},async()=>{
  const workspace=fs.mkdtempSync(path.join(family,'identity-loss-'));
  const controllerRoot=fs.mkdtempSync(path.join(family,'identity-loss-controller-'));
  const previous=process.env.ORCH_CONTROLLER_ROOT;process.env.ORCH_CONTROLLER_ROOT=controllerRoot;
  let launches=0,closes=0,cleanups=0,unregisters=0,files;
  const hooks={
    plan:async()=>[{title:'one',tasks:[{prompt:'执行任务'}]}],
    compact:p=>p,infer:()=>[],prompt:p=>p,
    launcher:(key,_prompt,suffix)=>{
      const dir=controllerWindowsDir(workspace),stem=key+'-'+suffix;
      fs.mkdirSync(dir,{recursive:true});
      files={lp:path.join(dir,'win-launch-'+stem+'.ps1'),pf:path.join(dir,'agent-win-'+stem+'.md'),pidf:path.join(dir,'window-'+stem+'.pid'),rf:path.join(dir,'win-'+stem+'.result.json')};
      fs.writeFileSync(files.lp,'$token = \'identity-loss-token\'','utf8');
      fs.writeFileSync(files.pf,'__ORCH_DONE__ identity-loss-token','utf8');
      return files;
    },
    register:()=>{},commit:()=>{},unregister:()=>{unregisters++;},cleanup:()=>{cleanups++;},
    spawn:async()=>{launches++;fs.writeFileSync(files.pidf,'4242','utf8');return true;},
    readPid:()=>4242,identity:()=>null,probePid:()=>true,close:async()=>{closes++;throw new Error('unauthenticated close')},
  };
  try{
    const sum=await runWindows('执行任务',hooks,{workspace,runId:'identity-loss',executionMode:'visible',capacity:1,maxAttempts:3,timeoutMs:4000,coordinator:path.join(controllerRoot,'coordinator')});
    assert.equal(launches,1,'unknown live launcher must not open a second window');
    assert.equal(closes,0,'unknown identity must never be sent to close');
    assert.equal(cleanups,0,'unproven exit must retain launcher artifacts');
    assert.equal(unregisters,0,'unproven exit must retain the lease');
    assert.equal(sum.results.B1.status,'needs-reconciliation');
    assert.match(sum.results.B1.reason,/identity unavailable|unproven/i);
    assert.equal(fs.existsSync(files.pidf),true);
    assert.equal(sum.success,false);
  }finally{
    if(previous===undefined)delete process.env.ORCH_CONTROLLER_ROOT;else process.env.ORCH_CONTROLLER_ROOT=previous;
    fs.rmSync(workspace,{recursive:true,force:true});fs.rmSync(controllerRoot,{recursive:true,force:true});
  }
});
