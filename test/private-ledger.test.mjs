import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {runWindows,runDirectory,preflightResumeLedger,publicVerificationReport} from '../scripts/core/runner.mjs';
import {controllerWindowsDir} from '../scripts/core/controller-state.mjs';
import {privateRunStateFile} from '../scripts/core/private-run-state.mjs';

function fixture(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'orch-private-ledger-'));
  const workspace=path.join(root,'workspace');fs.mkdirSync(workspace);
  const controller=path.join(root,'controller');
  const secret='PRIVATE⟪ledger-secret⟫';
  const request=`清理临时文件，同时使用 OPENAI_API_KEY=${secret}`;
  const launches=new Map();
  const hooks={
    plan:async()=>[{title:'private-task',tasks:[{prompt:request}]}],compact:plan=>plan,infer:()=>[],prompt:value=>value,
    launcher:(key,_prompt,suffix)=>{const dir=controllerWindowsDir(workspace),stem=key+'-'+suffix;fs.mkdirSync(dir,{recursive:true});const files={mode:'visible',lp:path.join(dir,'win-launch-'+stem+'.ps1'),pf:path.join(dir,'agent-win-'+stem+'.md'),pidf:path.join(dir,'window-'+stem+'.pid'),rf:path.join(dir,'win-'+stem+'.result.json')};fs.writeFileSync(files.lp,'fixture');fs.writeFileSync(files.pf,'fixture');launches.set(files.pidf,files);return files;},
    register:()=>{},commit:()=>{},unregister:()=>{},cleanup:()=>{},ready:()=>{},
    spawn:async(_lp,_title,pidf)=>{const files=launches.get(pidf);fs.writeFileSync(pidf,'424242');fs.writeFileSync(files.rf,JSON.stringify({exitCode:0}));return {ok:true,pid:424242};},
    readPid:()=>424242,identity:()=>({ProcessId:424242,Name:'powershell.exe',Started:'2026-01-01T00:00:00.000Z',CommandLine:'fixture'}),waitForExit:async()=>true,close:async()=>{},
    session:async()=>({}),wait:async()=>({done:true,exitCode:0,text:''}),exitCode:()=>0,
  };
  const runId='private-ledger-'+crypto.randomUUID().replaceAll('-','');
  return {root,workspace,controller,secret,request,hooks,runId};
}

test('sensitive task text stays live for execution but every ordinary run ledger stores only a redacted projection',async()=>{
  const f=fixture(),before=process.env.ORCH_CONTROLLER_ROOT;process.env.ORCH_CONTROLLER_ROOT=f.controller;
  try{
    const sum=await runWindows(f.request,f.hooks,{workspace:f.workspace,capacity:1,executionMode:'visible',runId:f.runId,coordinator:path.join(f.controller,'coordinator'),auth:'private-ledger',maxAttempts:1,timeoutMs:15000});
    assert.match(sum.request,new RegExp(f.secret));
    const dir=runDirectory(f.workspace,f.runId),ordinary=['manifest.json','summary.json','goal.json','events.jsonl'].map(name=>path.join(dir,name));
    for(const file of ordinary)assert.equal(fs.readFileSync(file,'utf8').includes(f.secret),false,`${path.basename(file)} retained sensitive task text`);
    const summary=JSON.parse(fs.readFileSync(path.join(dir,'summary.json'),'utf8'));
    assert.match(summary.privateRecovery?.publicSha256||'',/^[a-f0-9]{64}$/);
    const privateFile=privateRunStateFile(f.workspace,f.runId);
    assert.equal(fs.existsSync(privateFile),true);
    assert.equal(fs.readFileSync(privateFile,'utf8').includes(f.secret),false,'DPAPI state must not contain plaintext');
  }finally{if(before===undefined)delete process.env.ORCH_CONTROLLER_ROOT;else process.env.ORCH_CONTROLLER_ROOT=before;fs.rmSync(f.root,{recursive:true,force:true});}
});

test('a public ledger preserves the non-secret authorization contract while a credential-bearing request remains private',async()=>{
  const f=fixture(),before=process.env.ORCH_CONTROLLER_ROOT;process.env.ORCH_CONTROLLER_ROOT=f.controller;
  const authorization={sandbox:'workspace-write',approval:'never'};
  try{
    const acceptance=path.join(f.workspace,'acceptance.json');
    fs.writeFileSync(acceptance,JSON.stringify({T001:[{type:'json',path:'receipt.json',equals:{ok:true}}]}));
    f.hooks.wait=async()=>{fs.writeFileSync(path.join(f.workspace,'receipt.json'),JSON.stringify({ok:true}));return {done:true,exitCode:0,text:''};};
    await runWindows(f.request,f.hooks,{workspace:f.workspace,capacity:1,executionMode:'visible',runId:f.runId,coordinator:path.join(f.controller,'coordinator'),authorization,acceptanceFile:acceptance,maxAttempts:1,timeoutMs:15000});
    const dir=runDirectory(f.workspace,f.runId),summary=JSON.parse(fs.readFileSync(path.join(dir,'summary.json'),'utf8'));
    assert.deepEqual(summary.authorization,authorization,'the recovery authorization contract must survive the public projection');
    assert.equal(JSON.stringify(summary).includes(f.secret),false,'a provider credential must never enter the public summary');
    const preflight=preflightResumeLedger(f.workspace,f.runId);
    assert.equal(preflight.executionMode,'visible','a redacted ledger must hydrate its sealed private payload before preflight validation');
    assert.equal(JSON.stringify(preflight).includes(f.secret),false,'preflight metadata must not expose private task text');
    const resumed=await runWindows('',f.hooks,{workspace:f.workspace,capacity:1,executionMode:'visible',runId:f.runId,resume:true,coordinator:path.join(f.controller,'coordinator'),authorization,acceptanceFile:acceptance,maxAttempts:1,timeoutMs:15000});
    assert.deepEqual(resumed.authorization,authorization,'resume must authenticate the same retained authorization contract');
    const persistedAfterResume=fs.readFileSync(path.join(dir,'summary.json'),'utf8');
    assert.equal(persistedAfterResume.includes(f.secret),false,'in-memory recovery hydration must not write task text back to the public summary');
  }finally{if(before===undefined)delete process.env.ORCH_CONTROLLER_ROOT;else process.env.ORCH_CONTROLLER_ROOT=before;fs.rmSync(f.root,{recursive:true,force:true});}
});

test('a missing private snapshot prevents a redacted run from resuming with altered task text',async()=>{
  const f=fixture(),before=process.env.ORCH_CONTROLLER_ROOT;process.env.ORCH_CONTROLLER_ROOT=f.controller;
  try{
    await runWindows(f.request,f.hooks,{workspace:f.workspace,capacity:1,executionMode:'visible',runId:f.runId,coordinator:path.join(f.controller,'coordinator'),auth:'private-ledger',maxAttempts:1,timeoutMs:15000});
    fs.rmSync(privateRunStateFile(f.workspace,f.runId),{force:true});
    await assert.rejects(()=>runWindows('',f.hooks,{workspace:f.workspace,capacity:1,executionMode:'visible',runId:f.runId,resume:true,coordinator:path.join(f.controller,'coordinator'),auth:'private-ledger',maxAttempts:1,timeoutMs:5000}),/private recovery state is unreadable/);
  }finally{if(before===undefined)delete process.env.ORCH_CONTROLLER_ROOT;else process.env.ORCH_CONTROLLER_ROOT=before;fs.rmSync(f.root,{recursive:true,force:true});}
});

test('a legacy v1 private recovery marker fails closed with an upgrade/restart instruction',async()=>{
  const f=fixture(),before=process.env.ORCH_CONTROLLER_ROOT;process.env.ORCH_CONTROLLER_ROOT=f.controller;
  try{
    const dir=runDirectory(f.workspace,f.runId);fs.mkdirSync(dir,{recursive:true});
    fs.writeFileSync(path.join(dir,'summary.json'),JSON.stringify({privateRecovery:{version:1,publicSha256:'0'.repeat(64)}}));
    await assert.rejects(
      ()=>runWindows('',f.hooks,{workspace:f.workspace,capacity:1,executionMode:'visible',runId:f.runId,resume:true,coordinator:path.join(f.controller,'coordinator')}),
      /older privacy format; restart the run/,
    );
  }finally{if(before===undefined)delete process.env.ORCH_CONTROLLER_ROOT;else process.env.ORCH_CONTROLLER_ROOT=before;fs.rmSync(f.root,{recursive:true,force:true});}
});

test('verification reports redact credential-shaped acceptance diagnostics before persisting them',()=>{
  const secret='PRIVATE⟪verification-secret⟫';
  const report=publicVerificationReport({
    at:1,block:'B1',status:'needs-reconciliation',
    error:`JSON mismatch: OPENAI_API_KEY=${secret}`,
    tasks:[{id:'T001',result:{status:'needs-reconciliation',reason:`Expected GITHUB_TOKEN=${secret}`}}],
  });
  const serialized=JSON.stringify(report);
  assert.equal(serialized.includes(secret),false,'verification diagnostics must not retain credentials from failed checks');
  assert.match(serialized,/\[REDACTED\]/);
});
