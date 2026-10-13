import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {testTempFamily} from './test-temp-root.mjs';
import {controllerWindowsDir} from '../scripts/core/controller-state.mjs';
import {
  beginCleanupTransactionMarkerPhase,
  cleanupTransactionMarkerFile,
  readCleanupTransactionMarkerForRecovery,
  updateCleanupTransactionMarker,
} from '../scripts/core/cleanup-transaction.mjs';
import {createVisibleExecutionHooks,readReportFromResult,waitTaskComplete} from '../scripts/core/orchestrate-sdk.mjs';
import {runWindows,verifyRun} from '../scripts/core/runner.mjs';

const family=testTempFamily('visible-rule-guard-rejection');
fs.mkdirSync(family,{recursive:true});
const controllerRoot=fs.mkdtempSync(path.join(family,'controller-'));
const oldControllerRoot=process.env.ORCH_CONTROLLER_ROOT;
process.env.ORCH_CONTROLLER_ROOT=controllerRoot;
const rejectionReason='Visible rule guard refused execution because active or unsafe Codex rules were found.';
after(()=>{
  if(oldControllerRoot===undefined)delete process.env.ORCH_CONTROLLER_ROOT;
  else process.env.ORCH_CONTROLLER_ROOT=oldControllerRoot;
  fs.rmSync(controllerRoot,{recursive:true,force:true});
});

function guardFixture(workspace,{closeAfter=1}={}){
  const identity={ProcessId:92201,Name:'powershell.exe',Started:'visible-rule-rejection',CommandLine:'fixture visible rule guard'};
  const state={live:false,spawns:0,sessions:0,closes:0,cleanups:0};
  let launcherFiles,cleanupImpl=()=>{};
  const visible=createVisibleExecutionHooks({
    spawnWindow:async(_lp,_title,pidf,_retries,token)=>{
      state.spawns++;state.live=true;fs.writeFileSync(pidf,String(identity.ProcessId),'utf8');
      fs.writeFileSync(launcherFiles.rf,JSON.stringify({
        __EXIT__:3,__DONE__:true,__LAUNCHER_PID__:identity.ProcessId,__TOKEN__:token,
        __POLICY_REJECTED__:'visible-rule-boundary',__REPORT__:'pre-existing evidence must not be accepted',
      }),'utf8');
      return true;
    },
    readPid:pidf=>Number(fs.readFileSync(pidf,'utf8')),
    sessionWait:async()=>{state.sessions++;return null;},
  });
  const hooks={
    ...visible,
    plan:async()=>[{title:'guarded',tasks:[{prompt:'write guarded evidence'}]}],
    compact:value=>value,infer:()=>[],prompt:value=>value,
    launcher:(key,prompt,suffix,meta)=>{
      const dir=controllerWindowsDir(workspace),stem=key+'-'+suffix;
      fs.mkdirSync(dir,{recursive:true});
      launcherFiles={lp:path.join(dir,'win-launch-'+stem+'.ps1'),pf:path.join(dir,'agent-win-'+stem+'.md'),pidf:path.join(dir,'window-'+stem+'.pid'),rf:path.join(dir,'win-'+stem+'.result.json')};
      fs.writeFileSync(launcherFiles.lp,`$token = '${String(meta.token).replaceAll("'","''")}'`,'utf8');
      fs.writeFileSync(launcherFiles.pf,prompt,'utf8');
      return launcherFiles;
    },
    identity:()=>state.live?identity:null,
    close:async()=>{state.closes++;if(state.closes>=closeAfter)state.live=false;},
    waitForExit:async()=>!state.live,
    register:()=>{},commit:()=>{},unregister:()=>{},
    cleanup:(...args)=>{state.cleanups++;return cleanupImpl(...args);},
  };
  return {hooks,state,files:()=>launcherFiles,setCleanup:value=>{cleanupImpl=value;}};
}

function runOptions(workspace,runId,acceptanceFile){
  return {workspace,capacity:1,runId,coordinator:path.join(controllerRoot,'coordinator'),acceptanceFile,auth:'fixture',maxAttempts:1};
}

function cleanupBinding(workspace,runId,coordinator,entry,attempt){
  return {
    runId,blockKey:'B1',attempt:attempt.number,token:attempt.token,attemptFile:attempt.file,
    coordinator,lease:{id:entry.leaseId,instanceId:entry.leaseInstanceId},
  };
}

function assertGuardFailure(sum,{reportFile}={}){
  assert.equal(sum.success,false,JSON.stringify(sum.results));
  assert.equal(sum.results.B1.policyRejected,true);
  assert.equal(sum.results.B1.status,'failed');
  assert.equal(sum.results.B1.reason,rejectionReason);
  assert.equal(sum.taskResults.T001.status,'failed');
  assert.equal(sum.taskResults.T001.reason,rejectionReason);
  assert.equal(sum.taskResults.T001.inspection,undefined,'policy rejection must skip parent acceptance inspection');
  if(reportFile)assert.equal(fs.existsSync(reportFile),false,'policy rejection must not emit a parent verification report');
}

test('a visible rule-guard rejection cannot become parent-verified from pre-existing acceptance evidence',async()=>{
  const workspace=fs.mkdtempSync(path.join(family,'workspace-'));
  const runId='visible-rule-rejection';
  const acceptance=path.join(workspace,'acceptance.json');
  const evidence=path.join(workspace,'evidence.json');
  try{
    fs.writeFileSync(evidence,JSON.stringify({approved:true}),'utf8');
    fs.writeFileSync(acceptance,JSON.stringify({T001:[{type:'json',path:'evidence.json',equals:{approved:true}}]}),'utf8');
    const fixture=guardFixture(workspace),options=runOptions(workspace,runId,acceptance);
    const sum=await runWindows('write guarded evidence',fixture.hooks,options);
    assertGuardFailure(sum,{reportFile:path.join(workspace,'temp','orchestrator','runs',runId,'verification-report.jsonl')});
    assert.equal(sum.results.B1.attempts.length,1,'policy rejection must not retry a visible launcher');
    const attempt=sum.results.B1.attempts.at(-1);
    const coordinator=options.coordinator,binding=cleanupBinding(workspace,runId,coordinator,sum.results.B1,attempt);
    assert.equal(readCleanupTransactionMarkerForRecovery({workspace,binding}),null,'policy rejection must finalize its controller cleanup marker in the same run');
    assert.equal(verifyRun(workspace,runId,acceptance,{coordinator}),false,'explicit verification must preserve the policy rejection');
  }finally{fs.rmSync(workspace,{recursive:true,force:true});}
});

test('a tagged guard result fails closed before a rollout or its report is consumed',async()=>{
  const root=fs.mkdtempSync(path.join(family,'receipt-'));
  try{
    const resultFile=path.join(root,'launcher.result.json');
    fs.writeFileSync(resultFile,JSON.stringify({
      __EXIT__:3,__DONE__:true,__TOKEN__:'guard-token',__POLICY_REJECTED__:'visible-rule-boundary',__REPORT__:'must not become success',
    }),'utf8');
    assert.equal(readReportFromResult(resultFile,'【本块唯一标识】guard-token'),'', 'a policy rejection has no usable launcher report');
    const result=await waitTaskComplete(path.join(root,'absent-rollout.jsonl'),500,resultFile,'【本块唯一标识】guard-token');
    assert.deepEqual(result,{done:false,verified:false,policyRejected:true,text:'Visible rule guard refused execution because active or unsafe Codex rules were found.',exitCode:3});
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('cleanup-only resume preserves a visible rule rejection without relaunching or inspecting',async()=>{
  const workspace=fs.mkdtempSync(path.join(family,'resume-'));
  const runId='visible-rule-rejection-resume';
  const acceptance=path.join(workspace,'acceptance.json');
  const evidence=path.join(workspace,'evidence.json');
  try{
    fs.writeFileSync(evidence,JSON.stringify({approved:true}),'utf8');
    fs.writeFileSync(acceptance,JSON.stringify({T001:[{type:'json',path:'evidence.json',equals:{approved:true}}]}),'utf8');
    const fixture=guardFixture(workspace),options=runOptions(workspace,runId,acceptance);
    fixture.setCleanup(()=>{if(fixture.state.cleanups===1)throw new Error('synthetic pre-effect cleanup interruption');});
    const first=await runWindows('write guarded evidence',fixture.hooks,options);
    const entry=first.results.B1,attempt=entry.attempts.at(-1),binding=cleanupBinding(workspace,runId,options.coordinator,entry,attempt);
    assert.equal(entry.status,'cleanup-pending');
    assert.equal(entry.policyRejected,true);
    assert.equal(entry.policyRejectionReason,rejectionReason);
    const marker=readCleanupTransactionMarkerForRecovery({workspace,binding});
    assert.ok(marker,'interrupted cleanup must retain a controller marker');
    const markerFile=cleanupTransactionMarkerFile({workspace,binding:{...binding,status:marker.status}});
    const raw=JSON.parse(fs.readFileSync(markerFile,'utf8'));
    // Model the crash boundary before the retained artifact action begins: the
    // controller journal authorizes a pending retry but never repeats a phase
    // whose side effect might already have happened.
    raw.journal=structuredClone(entry.cleanupPending);raw.updatedAt=raw.journal.updatedAt;raw.state='active';
    fs.writeFileSync(markerFile,JSON.stringify(raw),'utf8');
    const launchesBeforeResume=fixture.state.spawns,sessionsBeforeResume=fixture.state.sessions;
    const resumed=await runWindows('',fixture.hooks,{...options,resume:true});
    assert.equal(fixture.state.spawns,launchesBeforeResume,'cleanup-only recovery must not open another window');
    assert.equal(fixture.state.sessions,sessionsBeforeResume,'cleanup-only recovery must not rediscover a child session');
    assert.equal(fixture.state.cleanups,2,'only the pending artifact cleanup phase may be retried');
    assert.equal(resumed.results.B1.attempts.length,1,'recovery must retain the original visible attempt');
    assertGuardFailure(resumed,{reportFile:path.join(workspace,'temp','orchestrator','runs',runId,'verification-report.jsonl')});
    assert.equal(readCleanupTransactionMarkerForRecovery({workspace,binding}),null,'terminal rule rejection must collect its finalized marker');
    assert.equal(verifyRun(workspace,runId,acceptance,{coordinator:options.coordinator}),false,'explicit verification must still reject the saved rule refusal');
  }finally{fs.rmSync(workspace,{recursive:true,force:true});}
});

test('final sweep preserves a visible rule rejection after the first launcher close is unproven',async()=>{
  const workspace=fs.mkdtempSync(path.join(family,'final-sweep-'));
  const runId='visible-rule-rejection-final-sweep';
  const acceptance=path.join(workspace,'acceptance.json');
  const evidence=path.join(workspace,'evidence.json');
  try{
    fs.writeFileSync(evidence,JSON.stringify({approved:true}),'utf8');
    fs.writeFileSync(acceptance,JSON.stringify({T001:[{type:'json',path:'evidence.json',equals:{approved:true}}]}),'utf8');
    const fixture=guardFixture(workspace,{closeAfter:2}),options=runOptions(workspace,runId,acceptance);
    const sum=await runWindows('write guarded evidence',fixture.hooks,options);
    const attempt=sum.results.B1.attempts.at(-1),binding=cleanupBinding(workspace,runId,options.coordinator,sum.results.B1,attempt);
    assert.equal(fixture.state.spawns,1);
    assert.equal(fixture.state.closes,2,'the final sweep must be the second close attempt');
    assert.equal(sum.finalSweep.closed,1);
    assert.equal(sum.results.B1.attempts.length,1);
    assertGuardFailure(sum,{reportFile:path.join(workspace,'temp','orchestrator','runs',runId,'verification-report.jsonl')});
    assert.equal(readCleanupTransactionMarkerForRecovery({workspace,binding}),null,'final sweep must collect the policy-rejection marker');
    assert.equal(verifyRun(workspace,runId,acceptance,{coordinator:options.coordinator}),false);
  }finally{fs.rmSync(workspace,{recursive:true,force:true});}
});
