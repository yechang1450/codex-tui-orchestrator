import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runWindows} from '../scripts/core/runner.mjs';
import {recordCheckpoint} from '../scripts/core/checkpoint.mjs';

const cases=[...([false,true].flatMap(capacityError=>[true,false].map(validReceipt=>({capacityError,validReceipt,withChecks:true})))),{capacityError:true,validReceipt:true,withChecks:false},{capacityError:false,validReceipt:false,withChecks:true,terminalFailure:true}];
for (const {capacityError,validReceipt,withChecks,terminalFailure=false} of cases) test(`execution exit preserves verification=${validReceipt}, capacityError=${capacityError}, checks=${withChecks}, terminalFailure=${terminalFailure}`, async () => {
  const family=fileURLToPath(new URL('../temp/',import.meta.url));fs.mkdirSync(family,{recursive:true});
  const workspace=fs.mkdtempSync(path.join(family,'self-close-'));
  fs.mkdirSync(path.join(workspace,'temp'),{recursive:true});
  const checks=path.join(workspace,'checks.json'),events=[];
  fs.writeFileSync(checks,JSON.stringify({T001:[{type:'json',path:'receipt.json',equals:{answer:42}}]}));
  let attempt,files,live=false;
  const hooks={
    plan:async()=>[{title:'close',tasks:[{prompt:'执行任务'}]}],compact:p=>p,infer:()=>[],prompt:p=>p,
    launcher:(_key,prompt,suffix,options)=>{attempt=options.attemptFile;return files={lp:path.join(workspace,'temp','win-launch-'+suffix+'.ps1'),pf:path.join(workspace,'temp','agent-win-'+suffix+'.md'),pidf:path.join(workspace,'temp','window-'+suffix+'.pid'),rf:path.join(workspace,'temp','win-'+suffix+'.result.json')};},
    spawn:async()=>{live=true;return true;},readPid:()=>9001,
    identity:()=>live?({ProcessId:9001,Name:'powershell.exe',Started:'fixture',CommandLine:'fixture'}):null,
    register:()=>{},commit:()=>{},unregister:()=>{},cleanup:()=>{},close:async()=>{live=false;},waitForExit:async()=>true,
    session:async()=>{
      recordCheckpoint(attempt,'T001','started');
      if(validReceipt){fs.writeFileSync(path.join(workspace,'receipt.json'),JSON.stringify({answer:42}));recordCheckpoint(attempt,'T001','completed');}
      fs.writeFileSync(files.rf+'.self-closed','closed');return capacityError||terminalFailure?'fixture-rollout':null;
    },
    wait:async()=>terminalFailure?({done:false,exitCode:1,text:'Request rejected'}):({done:true,retryable:'capacity',text:'Selected model is at capacity'}),exitCode:()=>null,
  };
  try {
    const sum=await runWindows('执行任务',hooks,{workspace,runId:'self-close',executionMode:'visible',capacity:1,acceptanceFile:withChecks?checks:undefined,coordinator:path.join(workspace,'coordinator'),onEvent:e=>events.push(e.type)});
    assert.equal(sum.success,validReceipt&&withChecks);
    assert.equal(sum.taskResults.T001.status,validReceipt?(withChecks?'verified':'awaiting-verification'):'needs-reconciliation');
    assert.ok(events.includes(terminalFailure?'block.B1.failed':'block.B1.awaiting-verification'));
    assert.ok(!events.includes('block.B1.timeout'),'a known process exit is not a run timeout');
    assert.equal(sum.results.B1.attempts.length,1);
  } finally {fs.rmSync(workspace,{recursive:true,force:true});}
});
