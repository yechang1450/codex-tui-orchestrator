import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import * as runner from '../scripts/core/runner.mjs';
import {recordCheckpoint} from '../scripts/core/checkpoint.mjs';
import {controllerWindowsDir} from '../scripts/core/controller-state.mjs';
const family=fileURLToPath(new URL('../temp/',import.meta.url));fs.mkdirSync(family,{recursive:true});
const controllerRoot=fs.mkdtempSync(path.join(family,'final-sweep-controller-'));
const oldControllerRoot=process.env.ORCH_CONTROLLER_ROOT;
process.env.ORCH_CONTROLLER_ROOT=controllerRoot;
after(()=>{if(oldControllerRoot===undefined)delete process.env.ORCH_CONTROLLER_ROOT;else process.env.ORCH_CONTROLLER_ROOT=oldControllerRoot;fs.rmSync(controllerRoot,{recursive:true,force:true});});

test('the final run sweep retries owned cleanup and queues the closed block for parent inspection',async()=>{
  const workspace=fs.mkdtempSync(path.join(family,'final-sweep-'));
  fs.mkdirSync(path.join(workspace,'temp'),{recursive:true});
  const acceptance=path.join(workspace,'checks.json');
  fs.writeFileSync(acceptance,JSON.stringify({T001:[{type:'json',path:'receipt.json',equals:{answer:42}}]}),'utf8');
  let attempt,files,live=false,closes=0;
  const identity={ProcessId:9001,Name:'powershell.exe',Started:'fixture',CommandLine:'fixture'};
  const hooks={
    plan:async()=>[{title:'one',tasks:[{prompt:'执行任务'}]}],compact:p=>p,infer:()=>[],prompt:p=>p,
    launcher:(key,_prompt,suffix,options)=>{attempt=options.attemptFile;const dir=controllerWindowsDir(workspace),stem=key+'-'+suffix;return files={lp:path.join(dir,'win-launch-'+stem+'.ps1'),pf:path.join(dir,'agent-win-'+stem+'.md'),pidf:path.join(dir,'window-'+stem+'.pid'),rf:path.join(dir,'win-'+stem+'.result.json')};},
    spawn:async()=>{live=true;return true;},readPid:()=>9001,identity:()=>live?identity:null,
    register:()=>{},commit:()=>{},unregister:()=>{},cleanup:()=>{},close:async()=>{if(++closes===2)live=false;},waitForExit:async()=>!live,
    session:async()=>{recordCheckpoint(attempt,'T001','started');fs.writeFileSync(path.join(workspace,'receipt.json'),'{"answer":42}','utf8');recordCheckpoint(attempt,'T001','completed');return 'fixture';},
    wait:async()=>({done:true,exitCode:0}),exitCode:()=>0,
  };
  try{
    const options={workspace,runId:'final-sweep',capacity:1,acceptanceFile:acceptance,coordinator:path.join(controllerRoot,'coordinator'),authorization:{sandbox:'workspace-write',approval:'never'}};
    const sum=await runner.runWindows('执行任务',hooks,options);
    assert.deepEqual(sum.authorization,options.authorization);
    await assert.rejects(runner.runWindows('',hooks,{...options,resume:true,authorization:{sandbox:'danger-full-access',approval:'never'}}),/authorization policy mismatch/i);
    assert.equal(closes,2);assert.equal(live,false);assert.equal(sum.success,true);
    assert.equal(sum.finalSweep.closed,1);assert.equal(sum.finalSweep.failed,0);
    assert.equal(sum.verification.maxConcurrency,1);
    const reports=fs.readFileSync(path.join(runner.runDirectory(workspace,'final-sweep'),'verification-report.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(reports.length,1);assert.equal(reports[0].status,'verified');
    const ledgerFile=path.join(runner.runDirectory(workspace,'final-sweep'),'summary.json');
    const poisoned=JSON.parse(fs.readFileSync(ledgerFile,'utf8'));
    const redirected=path.join(family,'redirected-coordinator-'+path.basename(workspace));
    poisoned.coordinator=redirected;
    fs.writeFileSync(ledgerFile,JSON.stringify(poisoned),'utf8');
    assert.throws(()=>runner.verifyRun(workspace,'final-sweep',acceptance,{coordinator:options.coordinator}),/coordinator.*mismatch|untrusted coordinator/i);
    await assert.rejects(runner.runWindows('',hooks,{...options,resume:true}),/coordinator.*mismatch|untrusted coordinator/i);
    assert.equal(fs.existsSync(redirected),false,'rejected coordinator must receive no files');
  }finally{fs.rmSync(workspace,{recursive:true,force:true});}
});

test('final cleanup refuses missing or mismatched run identities and never calls close',async()=>{
  let calls=0;
  const summary={runId:'ours',workspace:path.resolve('temp'),blocks:[{key:'B1',taskIds:['T001']}],results:{B1:{status:'failed',launcher:{ProcessId:1},attempts:[{runId:'other',token:'other',taskIds:['T001']}]}}};
  const result=await runner.sweepRunProcesses(summary,{close:async()=>calls++,waitForExit:async()=>false,identify:()=>null});
  assert.equal(calls,0);assert.equal(result.failed,1);assert.match(summary.results.B1.reason,/ownership|identity/i);
});

test('final sweep cannot accept an exited saved identity while the bound launcher is live',async()=>{
  const workspace=fs.mkdtempSync(path.join(family,'forged-sweep-'));
  try{
    const runId='identity',token='identity-B1-a1-token',dir=controllerWindowsDir(workspace),stem='B1-identity-a1';
    fs.mkdirSync(dir,{recursive:true});
    const files={lp:path.join(dir,'win-launch-'+stem+'.ps1'),pf:path.join(dir,'agent-win-'+stem+'.md'),
      pidf:path.join(dir,'window-'+stem+'.pid'),rf:path.join(dir,'win-'+stem+'.result.json')};
    fs.writeFileSync(files.lp,`$token = '${token}'`,'utf8');
    fs.writeFileSync(files.pf,'__ORCH_DONE__ '+token,'utf8');
    fs.writeFileSync(files.pidf,'9001','utf8');
    const actual={ProcessId:9001,Name:'powershell.exe',Started:'active',CommandLine:'active launcher'};
    const forged={ProcessId:9002,Name:'powershell.exe',Started:'exited',CommandLine:'other launcher'};
    const attempt={runId,token,number:1,taskIds:['T001'],
      file:path.join(workspace,'temp','orchestrator','runs',runId,'attempts','B1','1','attempt.json')};
    const entry={status:'failed',token,attempts:[attempt],launcherFiles:files,launcher:forged};
    const summary={runId,workspace,blocks:[{key:'B1',taskIds:['T001']}],results:{B1:entry}};
    let closes=0;
    const stats=await runner.sweepRunProcesses(summary,{identify:pid=>pid===9001?actual:null,
      close:async()=>{closes++;},waitForExit:async expected=>expected.ProcessId===9002});
    assert.equal(closes,0);
    assert.equal(stats.failed,1);
    assert.notEqual(entry.exitConfirmed,true);
    assert.match(entry.reason,/identity|launcher/i);
  }finally{fs.rmSync(workspace,{recursive:true,force:true});}
});
