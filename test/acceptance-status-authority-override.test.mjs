import {testTempFamily} from './test-temp-root.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {canonicalDigest} from '../scripts/core/contracts.mjs';
import {controllerStateDir,controllerWindowsDir} from '../scripts/core/controller-state.mjs';
import {physicalPathIdentity} from '../scripts/core/runtime-context.mjs';
import {createStatusPublisher,readRunStatus} from '../scripts/core/status-events.mjs';
import {recordCheckpoint} from '../scripts/core/checkpoint.mjs';
import {runDirectory,runWindows,verifyRun} from '../scripts/core/runner.mjs';

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const family=testTempFamily('acceptance-status-authority-override');
fs.mkdirSync(family,{recursive:true});

const readJson=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const writeJson=(file,value)=>fs.writeFileSync(file,JSON.stringify(value,null,2),'utf8');
const stateKey=workspace=>crypto.createHash('sha256').update(physicalPathIdentity(workspace)).digest('hex');
const statusAuthorityFile=(workspace,runId)=>path.join(controllerStateDir(workspace),'status',stateKey(workspace),runId+'.json');
const acceptanceAuthorityFile=(workspace,runId)=>path.join(controllerStateDir(workspace),'acceptance',stateKey(workspace),runId+'.json');
const planAuthorityFile=(workspace,runId)=>path.join(controllerStateDir(workspace),'plans',stateKey(workspace),runId+'.json');

function fixture(name){
  const previous=process.env.ORCH_CONTROLLER_ROOT;
  const workspace=fs.mkdtempSync(path.join(family,name+'-'));
  const controller=fs.mkdtempSync(path.join(family,name+'-controller-'));
  process.env.ORCH_CONTROLLER_ROOT=controller;
  const runId='acceptance-override';
  const dir=runDirectory(workspace,runId);
  const coordinator=path.join(controller,'coordinator');
  const original={T001:[{type:'json',path:'evidence.json',equals:{count:1}}]};
  const replacement={T001:[{type:'json',path:'evidence.json',equals:{count:1,approved:true}}]};
  const originalDigest=canonicalDigest(original),replacementDigest=canonicalDigest(replacement);
  const summary={
    protocol:2,version:'fixture',agent:'codex',executionMode:'headless',authorization:undefined,runId,workspace,request:'write proof',capacity:1,
    coordinator,generation:1,history:[],startedAt:1,finishedAt:2,success:false,
    tasks:[{id:'T001',prompt:'write proof'}],
    plan:[{key:'B1',title:'fixture',keys:[],dependsOn:[],b:{tasks:[{sourceIds:['T001']} ]}}],
    blocks:[{key:'B1',title:'fixture',taskIds:['T001']}],
    results:{B1:{status:'failed',attempts:[]}},taskResults:{T001:{status:'failed',reason:'fixture'}},
    acceptance:{algorithm:'sha256',sha256:originalDigest,source:'fixture',boundAt:1},
  };
  fs.mkdirSync(dir,{recursive:true});
  writeJson(path.join(dir,'manifest.json'),{runId,workspace,request:summary.request,executionMode:'headless',tasks:summary.tasks,acceptance:summary.acceptance});
  writeJson(path.join(dir,'acceptance.json'),original);
  const immutablePlan={workspace,runId,request:summary.request,agent:'codex',executionMode:'headless',authorization:null,tasks:summary.tasks,blocks:summary.blocks,plan:summary.plan};
  for(const [file,value] of [
    [acceptanceAuthorityFile(workspace,runId),{version:1,workspace,runId,sha256:originalDigest}],
    [planAuthorityFile(workspace,runId),{version:1,workspace,runId,sha256:canonicalDigest(immutablePlan)}],
  ]){fs.mkdirSync(path.dirname(file),{recursive:true});writeJson(file,value);}
  createStatusPublisher(dir).publish(summary,'fixture.finalized');
  return {workspace,controller,runId,dir,coordinator,replacement,replacementDigest,close(){
    if(previous===undefined)delete process.env.ORCH_CONTROLLER_ROOT;else process.env.ORCH_CONTROLLER_ROOT=previous;
    fs.rmSync(workspace,{recursive:true,force:true});fs.rmSync(controller,{recursive:true,force:true});
  }};
}

function rewriteWorkspaceAcceptance(f,{tamperStatus=false}={}){
  const summaryFile=path.join(f.dir,'summary.json'),manifestFile=path.join(f.dir,'manifest.json');
  const summary=readJson(summaryFile),manifest=readJson(manifestFile);
  summary.acceptance={...summary.acceptance,sha256:f.replacementDigest};
  manifest.acceptance={...manifest.acceptance,sha256:f.replacementDigest};
  if(tamperStatus){
    summary.taskResults.T001={status:'verified',reason:'workspace-forged'};
    summary.todoList=summary.todoList.map(item=>item.id==='T001'?{...item,status:'verified'}:item);
  }
  writeJson(summaryFile,summary);writeJson(manifestFile,manifest);writeJson(path.join(f.dir,'acceptance.json'),f.replacement);
}

test('explicit acceptance override restores a controller-authorized status transaction when only acceptance changed',()=>{
  const f=fixture('legitimate');
  try{
    const before=readJson(statusAuthorityFile(f.workspace,f.runId));
    rewriteWorkspaceAcceptance(f);
    const observed=readJson(path.join(f.dir,'summary.json'));
    const observedSummarySha256=crypto.createHash('sha256').update(JSON.stringify(observed)).digest('hex');
    assert.throws(()=>verifyRun(f.workspace,f.runId,undefined,{coordinator:f.coordinator}),/status ledger authority mismatch/i);
    assert.equal(verifyRun(f.workspace,f.runId,undefined,{coordinator:f.coordinator,override:true}),false);
    const rebound=readJson(path.join(f.dir,'summary.json'));
    const after=readJson(statusAuthorityFile(f.workspace,f.runId));
    assert.equal(rebound.acceptance.sha256,f.replacementDigest);
    assert.ok(rebound.history.some(entry=>entry.acceptanceRebound?.to===f.replacementDigest));
    assert.ok(rebound.history.some(entry=>entry.statusAuthorityRebound?.runId===f.runId));
    assert.equal(after.version,2,'new status authority must retain the recovery binding');
    assert.equal(after.acceptanceInvariantSha256,canonicalDigest(Object.fromEntries(Object.entries(rebound).filter(([key])=>key!=='acceptance'))));
    assert.equal(after.transition?.runId,f.runId);
    assert.equal(after.transition?.fromSummarySha256,before.sha256);
    assert.equal(after.transition?.observedSummarySha256,observedSummarySha256);
    assert.equal(after.transition?.toSummarySha256,after.sha256);
    assert.equal(readRunStatus(f.workspace,f.runId).acceptance.sha256,f.replacementDigest);
  }finally{f.close();}
});

test('acceptance override refuses a status change outside the controller-authorized acceptance field',()=>{
  const f=fixture('tampered');
  try{
    const before=readJson(statusAuthorityFile(f.workspace,f.runId));
    rewriteWorkspaceAcceptance(f,{tamperStatus:true});
    assert.throws(()=>verifyRun(f.workspace,f.runId,undefined,{coordinator:f.coordinator,override:true}),/outside the acceptance binding/i);
    assert.equal(readJson(acceptanceAuthorityFile(f.workspace,f.runId)).sha256,canonicalDigest({T001:[{type:'json',path:'evidence.json',equals:{count:1}}]}),'rejected override must not rewrite controller authority');
    assert.deepEqual(readJson(statusAuthorityFile(f.workspace,f.runId)),before,'rejected override must not replace status authority');
  }finally{f.close();}
});

test('legacy status authority cannot authorize an acceptance override without an invariant binding',()=>{
  const f=fixture('legacy');
  try{
    const authorityFile=statusAuthorityFile(f.workspace,f.runId),current=readJson(authorityFile);
    writeJson(authorityFile,{version:1,runId:f.runId,workspace:f.workspace,sha256:current.sha256});
    rewriteWorkspaceAcceptance(f);
    assert.throws(()=>verifyRun(f.workspace,f.runId,undefined,{coordinator:f.coordinator,override:true}),/does not retain an acceptance recovery binding/i);
  }finally{f.close();}
});

test('resume uses the same controller-bound acceptance override transaction before recovering verified work',async()=>{
  const previous=process.env.ORCH_CONTROLLER_ROOT;
  const workspace=fs.mkdtempSync(path.join(family,'resume-'));
  const controller=fs.mkdtempSync(path.join(family,'resume-controller-'));
  process.env.ORCH_CONTROLLER_ROOT=controller;
  const runId='resume-override',coordinator=path.join(controller,'coordinator'),checks=path.join(workspace,'checks.json');
  const original={T001:[{type:'json',path:'evidence.json',equals:{count:1}}]};
  const replacement={T001:[{type:'json',path:'evidence.json',equals:{count:1,approved:true}}]};
  writeJson(checks,original);
  let attempt,live=false;
  const identity={ProcessId:9001,Name:'powershell.exe',Started:'fixture',CommandLine:'fixture'};
  const hooks={
    plan:async()=>[{title:'fixture',tasks:[{prompt:'write proof'}]}],compact:value=>value,infer:()=>[],prompt:value=>value,
    launcher:(key,_prompt,suffix,options)=>{
      attempt=options.attemptFile;
      const dir=controllerWindowsDir(workspace),stem=key+'-'+suffix;
      return {lp:path.join(dir,'win-launch-'+stem+'.ps1'),pf:path.join(dir,'agent-win-'+stem+'.md'),pidf:path.join(dir,'window-'+stem+'.pid'),rf:path.join(dir,'win-'+stem+'.result.json')};
    },
    spawn:async()=>{live=true;return true;},readPid:()=>9001,identity:()=>live?identity:null,
    register:()=>{},commit:()=>{},unregister:()=>{},cleanup:()=>{},close:async()=>{live=false;},waitForExit:async()=>!live,
    session:async()=>{recordCheckpoint(attempt,'T001','started');writeJson(path.join(workspace,'evidence.json'),{count:1,approved:true});recordCheckpoint(attempt,'T001','completed');return 'fixture';},
    wait:async()=>({done:true,exitCode:0}),exitCode:()=>0,
  };
  const options={workspace,runId,capacity:1,executionMode:'visible',coordinator,acceptanceFile:checks,auth:'fixture'};
  try{
    const first=await runWindows('write proof',hooks,options);
    assert.equal(first.success,true);
    const dir=runDirectory(workspace,runId),before=readJson(statusAuthorityFile(workspace,runId));
    const summary=readJson(path.join(dir,'summary.json')),manifest=readJson(path.join(dir,'manifest.json'));
    const replacementDigest=canonicalDigest(replacement);
    summary.acceptance={...summary.acceptance,sha256:replacementDigest};
    manifest.acceptance={...manifest.acceptance,sha256:replacementDigest};
    writeJson(path.join(dir,'summary.json'),summary);writeJson(path.join(dir,'manifest.json'),manifest);writeJson(checks,replacement);
    const resumed=await runWindows('',hooks,{...options,resume:true,acceptanceOverride:true});
    assert.equal(resumed.success,true);
    const authority=readJson(statusAuthorityFile(workspace,runId));
    assert.equal(authority.transition?.kind,'acceptance-override');
    assert.equal(authority.transition?.fromSummarySha256,before.sha256);
    assert.equal(readRunStatus(workspace,runId).acceptance.sha256,replacementDigest);
    assert.ok(resumed.history.some(entry=>entry.statusAuthorityRebound?.acceptanceSha256===replacementDigest));
  }finally{
    if(previous===undefined)delete process.env.ORCH_CONTROLLER_ROOT;else process.env.ORCH_CONTROLLER_ROOT=previous;
    fs.rmSync(workspace,{recursive:true,force:true});fs.rmSync(controller,{recursive:true,force:true});
  }
});
