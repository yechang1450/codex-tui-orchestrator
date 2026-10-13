import {testTempFamily} from './test-temp-root.mjs';
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runWindows,verifyRun,preflightResumeLedger} from '../scripts/core/runner.mjs';
import {controllerWindowsDir} from '../scripts/core/controller-state.mjs';
import {recordCheckpoint} from '../scripts/core/checkpoint.mjs';
import {cleanupTransactionMarkerFile,readCleanupTransactionMarkerForRecovery} from '../scripts/core/cleanup-transaction.mjs';

const family=testTempFamily('runner-abort');
fs.mkdirSync(family,{recursive:true});
const controllerRoot=fs.mkdtempSync(path.join(family,'abort-controller-'));
const previous=process.env.ORCH_CONTROLLER_ROOT;
process.env.ORCH_CONTROLLER_ROOT=controllerRoot;
after(()=>{if(previous===undefined)delete process.env.ORCH_CONTROLLER_ROOT;else process.env.ORCH_CONTROLLER_ROOT=previous;fs.rmSync(controllerRoot,{recursive:true,force:true});});

test('an authenticated abort before scheduling launches no windows and leaves every task cancelled',async()=>{
  const workspace=fs.mkdtempSync(path.join(family,'abort-before-schedule-'));
  let spawns=0;
  const hooks={
    plan:async()=>[{title:'one',tasks:[{prompt:'one'}]},{title:'two',tasks:[{prompt:'two'}]}],compact:value=>value,infer:()=>[],prompt:value=>value,
    launcher:(key,_prompt,suffix)=>{const dir=controllerWindowsDir(workspace),stem=key+'-'+suffix;return {lp:path.join(dir,'win-launch-'+stem+'.ps1'),pf:path.join(dir,'agent-win-'+stem+'.md'),pidf:path.join(dir,'window-'+stem+'.pid'),rf:path.join(dir,'win-'+stem+'.result.json')};},
    spawn:async()=>{spawns++;return false;},readPid:()=>0,identity:()=>null,register:()=>{},commit:()=>{},unregister:()=>{},cleanup:()=>{},close:async()=>{},waitForExit:async()=>true,
    session:async()=>null,wait:async()=>({done:false,exitCode:null}),exitCode:()=>null,
  };
  try{
    const sum=await runWindows('one; two',hooks,{workspace,runId:'abort-before-schedule',capacity:2,coordinator:path.join(controllerRoot,'coordinator-before-schedule'),
      abort:()=>({schema:1,kind:'acceptance-abort',runId:'abort-before-schedule',reason:'monitor-failed',requestedAt:Date.now()})});
    assert.equal(spawns,0);
    assert.equal(sum.success,false);
    assert.deepEqual(Object.values(sum.results).map(value=>value.status),['cancelled','cancelled']);
    assert.deepEqual(Object.values(sum.taskResults).map(value=>value.status),['cancelled','cancelled']);
    assert.equal(sum.abort?.reason,'monitor-failed');
    assert.throws(()=>verifyRun(workspace,'abort-before-schedule',undefined,{coordinator:path.join(controllerRoot,'coordinator-before-schedule')}),/aborted run cannot be verified/i);
  }finally{fs.rmSync(workspace,{recursive:true,force:true});}
});

test('an authenticated abort after an owned launcher starts closes it once and never runs parent inspection',async()=>{
  const workspace=fs.mkdtempSync(path.join(family,'abort-owned-launcher-'));
  let abort=false,live=false,spawns=0,closes=0,cleanups=0,waitSawAbort=false;
  const identity={ProcessId:9101,Name:'powershell.exe',Started:'fixture',CommandLine:'fixture'};
  const hooks={
    plan:async()=>[{title:'one',tasks:[{prompt:'one'}]}],compact:value=>value,infer:()=>[],prompt:value=>value,
    launcher:(key,_prompt,suffix)=>{const dir=controllerWindowsDir(workspace),stem=key+'-'+suffix;return {lp:path.join(dir,'win-launch-'+stem+'.ps1'),pf:path.join(dir,'agent-win-'+stem+'.md'),pidf:path.join(dir,'window-'+stem+'.pid'),rf:path.join(dir,'win-'+stem+'.result.json')};},
    spawn:async()=>{spawns++;live=true;return true;},readPid:()=>9101,identity:()=>live?identity:null,register:()=>{},commit:()=>{},unregister:()=>{},cleanup:()=>{cleanups++;},
    close:async()=>{closes++;live=false;},waitForExit:async()=>!live,
    session:async()=>{abort=true;return 'fixture';},
    wait:async(_session,_timeout,_rf,_token,_pid,shouldAbort)=>{waitSawAbort=Boolean(shouldAbort?.());return {done:false,exitCode:null,aborted:true,text:'Acceptance aborted'};},exitCode:()=>null,
  };
  try{
    const sum=await runWindows('one',hooks,{workspace,runId:'abort-owned-launcher',capacity:1,coordinator:path.join(controllerRoot,'coordinator-owned-launcher'),
      abort:()=>abort?{schema:1,kind:'acceptance-abort',runId:'abort-owned-launcher',reason:'monitor-failed',requestedAt:Date.now()}:null});
    assert.equal(spawns,1);assert.equal(closes,1);assert.equal(cleanups,1);assert.equal(waitSawAbort,true);
    assert.equal(sum.success,false);assert.equal(sum.results.B1.status,'cancelled');assert.equal(sum.results.B1.exitConfirmed,true);
    const attempt=JSON.parse(fs.readFileSync(sum.results.B1.attempts.at(-1).file,'utf8'));
    assert.equal(attempt.exitConfirmed,true,'the restart authority must retain the same authenticated exit proof before abort cleanup');
    assert.equal(attempt.exitEvidence?.token,sum.results.B1.exitEvidence?.token);
    assert.equal(sum.taskResults.T001.status,'cancelled');assert.equal(fs.existsSync(path.join(workspace,'temp','orchestrator','runs','abort-owned-launcher','verification-report.jsonl')),false);
  }finally{fs.rmSync(workspace,{recursive:true,force:true});}
});

test('an abort after spawn with no authenticated launcher retains evidence and never closes an unproven process',async()=>{
  const workspace=fs.mkdtempSync(path.join(family,'abort-unproven-launcher-'));
  let abort=false,spawns=0,closes=0,cleanups=0;
  const hooks={
    plan:async()=>[{title:'one',tasks:[{prompt:'one'}]}],compact:value=>value,infer:()=>[],prompt:value=>value,
    launcher:(key,_prompt,suffix)=>{const dir=controllerWindowsDir(workspace),stem=key+'-'+suffix;return {lp:path.join(dir,'win-launch-'+stem+'.ps1'),pf:path.join(dir,'agent-win-'+stem+'.md'),pidf:path.join(dir,'window-'+stem+'.pid'),rf:path.join(dir,'win-'+stem+'.result.json')};},
    spawn:async()=>{spawns++;abort=true;return true;},readPid:()=>9102,identity:()=>null,register:()=>{},commit:()=>{},unregister:()=>{},cleanup:()=>{cleanups++;},
    close:async()=>{closes++;},waitForExit:async()=>false,session:async()=>null,wait:async()=>({done:false,exitCode:null}),exitCode:()=>null,
  };
  try{
    const sum=await runWindows('one',hooks,{workspace,runId:'abort-unproven-launcher',capacity:1,coordinator:path.join(controllerRoot,'coordinator-unproven-launcher'),
      abort:()=>abort?{schema:1,kind:'acceptance-abort',runId:'abort-unproven-launcher',reason:'monitor-failed',requestedAt:Date.now()}:null});
    assert.equal(spawns,1);assert.equal(closes,0);assert.equal(cleanups,0);
    assert.equal(sum.success,false);assert.equal(sum.results.B1.status,'needs-reconciliation');assert.ok(sum.results.B1.exitUnprovenAt);
    assert.equal(sum.taskResults.T001.status,'needs-reconciliation');assert.equal(sum.finalSweep.retained,1);
  }finally{fs.rmSync(workspace,{recursive:true,force:true});}
});

test('an explicit no-process spawn abort uses the bound cleanup transaction without identity or close',async()=>{
  const workspace=fs.mkdtempSync(path.join(family,'abort-no-process-'));
  let abort=false,spawns=0,identities=0,closes=0,cleanups=0;
  const runId='abort-no-process';
  const hooks={
    plan:async()=>[{title:'one',tasks:[{prompt:'one'}]}],compact:value=>value,infer:()=>[],prompt:value=>value,
    launcher:(key,_prompt,suffix)=>{const dir=controllerWindowsDir(workspace),stem=key+'-'+suffix;return {lp:path.join(dir,'win-launch-'+stem+'.ps1'),pf:path.join(dir,'agent-win-'+stem+'.md'),pidf:path.join(dir,'window-'+stem+'.pid'),rf:path.join(dir,'win-'+stem+'.result.json')};},
    spawn:async()=>{spawns++;abort=true;return {noProcess:true};},readPid:()=>0,identity:()=>{identities++;return null;},register:()=>{},commit:()=>{},unregister:()=>{},cleanup:()=>{cleanups++;},
    close:async()=>{closes++;},waitForExit:async()=>{throw new Error('no-process receipt must not wait for an identity');},session:async()=>{throw new Error('aborted no-process receipt must not discover a session');},wait:async()=>null,exitCode:()=>null,
  };
  try{
    const sum=await runWindows('one',hooks,{workspace,runId,capacity:1,coordinator:path.join(controllerRoot,'coordinator-abort-no-process'),
      abort:()=>abort?{schema:1,kind:'acceptance-abort',runId,reason:'monitor-failed',requestedAt:Date.now()}:null});
    assert.equal(spawns,1);assert.equal(identities,0);assert.equal(closes,0);assert.equal(cleanups,1);
    assert.equal(sum.results.B1.status,'cancelled');assert.equal(sum.results.B1.exitConfirmed,true);
    const attempt=JSON.parse(fs.readFileSync(sum.results.B1.attempts.at(-1).file,'utf8'));
    assert.equal(attempt.noProcessProof?.kind,'no-process');
  }finally{fs.rmSync(workspace,{recursive:true,force:true});}
});

test('an aborted authenticated launcher with an in-flight cleanup fence fails closed without replay',async()=>{
  const workspace=fs.mkdtempSync(path.join(family,'abort-cleanup-resume-'));
  const runId='abort-cleanup-resume',coordinator=path.join(controllerRoot,'coordinator-abort-cleanup-resume');
  let abort=false,live=false,spawns=0,closes=0,cleanups=0,sessions=0;
  const identity={ProcessId:9105,Name:'powershell.exe',Started:'fixture',CommandLine:'fixture'};
  const hooks={
    plan:async()=>[{title:'one',tasks:[{prompt:'one'}]}],compact:value=>value,infer:()=>[],prompt:value=>value,
    launcher:(key,_prompt,suffix)=>{const dir=controllerWindowsDir(workspace),stem=key+'-'+suffix;return {lp:path.join(dir,'win-launch-'+stem+'.ps1'),pf:path.join(dir,'agent-win-'+stem+'.md'),pidf:path.join(dir,'window-'+stem+'.pid'),rf:path.join(dir,'win-'+stem+'.result.json')};},
    spawn:async()=>{spawns++;live=true;return true;},readPid:()=>9105,identity:()=>live?identity:null,register:()=>{},commit:()=>{},unregister:()=>{},
    cleanup:()=>{cleanups++;if(cleanups===1)throw new Error('synthetic artifact cleanup failure');},
    close:async()=>{closes++;live=false;},waitForExit:async()=>!live,
    session:async()=>{sessions++;abort=true;return 'fixture';},wait:async()=>({done:false,exitCode:null,aborted:true}),exitCode:()=>null,
  };
  try{
    const first=await runWindows('one',hooks,{workspace,runId,capacity:1,coordinator,
      abort:()=>abort?{schema:1,kind:'acceptance-abort',runId,reason:'monitor-failed',requestedAt:Date.now()}:null});
    const entry=first.results.B1,attempt=entry.attempts.at(-1);
    assert.equal(spawns,1);assert.equal(closes,1);assert.equal(cleanups,1);assert.ok(entry.cleanupPending,'failed abort cleanup must retain a phase journal');
    assert.deepEqual(entry.cleanupPending.phases,{lease:'done',registry:'done',artifacts:'pending'});
    assert.equal(attempt.exitConfirmed,true);assert.equal(entry.exitConfirmed,true);
    const binding={runId,blockKey:'B1',attempt:attempt.number,token:attempt.token,attemptFile:path.resolve(attempt.file),coordinator:path.resolve(coordinator),lease:{id:entry.leaseId,instanceId:entry.leaseInstanceId}};
    const marker=readCleanupTransactionMarkerForRecovery({workspace,binding});
    assert.deepEqual(marker?.journal.phases,{lease:'done',registry:'done',artifacts:'inflight'});
    const summaryFile=path.join(workspace,'temp','orchestrator','runs',runId,'summary.json');
    const markerFile=cleanupTransactionMarkerFile({workspace,binding:{...binding,status:marker.status}});
    const snapshot={summary:fs.readFileSync(summaryFile,'utf8'),attempt:fs.readFileSync(attempt.file,'utf8'),marker:fs.readFileSync(markerFile,'utf8')};
    assert.throws(()=>preflightResumeLedger(workspace,runId),/may have executed.*reconciliation/i);
    await assert.rejects(()=>runWindows('',hooks,{workspace,runId,capacity:1,coordinator,resume:true,
      abort:()=>({schema:1,kind:'acceptance-abort',runId,reason:'monitor-failed',requestedAt:Date.now()})}),/may have executed.*reconciliation/i);
    assert.equal(spawns,1,'a rejected cleanup recovery must never replay the launcher');
    assert.equal(closes,1,'the authenticated process was already closed before the retained phase');
    assert.equal(sessions,1,'a rejected cleanup recovery must not discover a session');
    assert.equal(cleanups,1,'an in-flight artifact cleanup must never be replayed automatically');
    assert.equal(fs.readFileSync(summaryFile,'utf8'),snapshot.summary);
    assert.equal(fs.readFileSync(attempt.file,'utf8'),snapshot.attempt);
    assert.equal(fs.readFileSync(markerFile,'utf8'),snapshot.marker);
    assert.throws(()=>verifyRun(workspace,runId,undefined,{coordinator}),/aborted run cannot be verified/i);
  }finally{fs.rmSync(workspace,{recursive:true,force:true});}
});

test('an abort preempts a provider-capacity retry instead of launching a second attempt',async()=>{
  const workspace=fs.mkdtempSync(path.join(family,'abort-capacity-retry-'));
  let abort=false,live=false,spawns=0,closes=0;
  const identity={ProcessId:9103,Name:'powershell.exe',Started:'fixture',CommandLine:'fixture'};
  const hooks={
    plan:async()=>[{title:'one',tasks:[{prompt:'one'}]}],compact:value=>value,infer:()=>[],prompt:value=>value,
    launcher:(key,_prompt,suffix)=>{const dir=controllerWindowsDir(workspace),stem=key+'-'+suffix;return {lp:path.join(dir,'win-launch-'+stem+'.ps1'),pf:path.join(dir,'agent-win-'+stem+'.md'),pidf:path.join(dir,'window-'+stem+'.pid'),rf:path.join(dir,'win-'+stem+'.result.json')};},
    spawn:async()=>{spawns++;live=true;return true;},readPid:()=>9103,identity:()=>live?identity:null,register:()=>{},commit:()=>{},unregister:()=>{},cleanup:()=>{},
    close:async()=>{closes++;live=false;},waitForExit:async()=>!live,session:async()=> 'fixture',
    wait:async()=>{abort=true;return {done:true,exitCode:1,retryable:'capacity',capacityError:'provider capacity'};},exitCode:()=>1,
  };
  try{
    const sum=await runWindows('one',hooks,{workspace,runId:'abort-capacity-retry',capacity:1,coordinator:path.join(controllerRoot,'coordinator-capacity-retry'),
      abort:()=>abort?{schema:1,kind:'acceptance-abort',runId:'abort-capacity-retry',reason:'monitor-failed',requestedAt:Date.now()}:null});
    assert.equal(spawns,1);assert.equal(closes,1);assert.equal(sum.results.B1.attempts.length,1);
    assert.equal(sum.results.B1.status,'cancelled');assert.equal(sum.success,false);
  }finally{fs.rmSync(workspace,{recursive:true,force:true});}
});

test('an abort published after terminal verification cannot be committed as a successful run',async()=>{
  const workspace=fs.mkdtempSync(path.join(family,'abort-terminal-verification-'));
  const acceptance=path.join(workspace,'checks.json');
  fs.writeFileSync(acceptance,JSON.stringify({T001:[{type:'json',path:'receipt.json',equals:{answer:42}}]}),'utf8');
  let attempt,files,live=false,abort=false,finalizations=0;
  const identity={ProcessId:9104,Name:'powershell.exe',Started:'fixture',CommandLine:'fixture'};
  const hooks={
    plan:async()=>[{title:'one',tasks:[{prompt:'one'}]}],compact:value=>value,infer:()=>[],prompt:value=>value,
    launcher:(key,_prompt,suffix,options)=>{attempt=options.attemptFile;const dir=controllerWindowsDir(workspace),stem=key+'-'+suffix;return files={lp:path.join(dir,'win-launch-'+stem+'.ps1'),pf:path.join(dir,'agent-win-'+stem+'.md'),pidf:path.join(dir,'window-'+stem+'.pid'),rf:path.join(dir,'win-'+stem+'.result.json')};},
    spawn:async()=>{live=true;return true;},readPid:()=>9104,identity:()=>live?identity:null,register:()=>{},commit:()=>{},unregister:()=>{},cleanup:()=>{},
    close:async()=>{live=false;},waitForExit:async()=>!live,
    session:async()=>{recordCheckpoint(attempt,'T001','started');fs.writeFileSync(path.join(workspace,'receipt.json'),JSON.stringify({answer:42}));recordCheckpoint(attempt,'T001','completed');return 'fixture';},
    wait:async()=>({done:true,exitCode:0}),exitCode:()=>0,
  };
  const runId='abort-terminal-verification';
  try{
    const sum=await runWindows('one',hooks,{workspace,runId,capacity:1,acceptanceFile:acceptance,coordinator:path.join(controllerRoot,'coordinator-terminal-verification'),
      abort:()=>abort?{schema:1,kind:'acceptance-abort',runId,reason:'monitor-failed',requestedAt:Date.now()}:null,
      finalizeAcceptance:()=>{finalizations++;return abort?{schema:1,kind:'acceptance-abort',runId,reason:'monitor-failed',requestedAt:Date.now()}:null;},
      onEvent:event=>{if(event.type==='block.B1.verified')abort=true;}});
    assert.equal(finalizations,1,'success must be committed through the terminal acceptance authority');
    assert.equal(sum.success,false,'a controller abort published during terminal verification must veto run.completed');
    assert.equal(sum.abort?.reason,'monitor-failed');
    assert.throws(()=>verifyRun(workspace,runId,undefined,{coordinator:path.join(controllerRoot,'coordinator-terminal-verification')}),/aborted run cannot be verified/i);
  }finally{fs.rmSync(workspace,{recursive:true,force:true});}
});
