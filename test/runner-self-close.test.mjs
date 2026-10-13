import {testTempFamily} from './test-temp-root.mjs';
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runWindows} from '../scripts/core/runner.mjs';
import {recordCheckpoint} from '../scripts/core/checkpoint.mjs';
import {controllerWindowsDir} from '../scripts/core/controller-state.mjs';
const family=testTempFamily('runner-self-close');fs.mkdirSync(family,{recursive:true});
const controllerRoot=fs.mkdtempSync(path.join(family,'self-close-controller-'));
const oldControllerRoot=process.env.ORCH_CONTROLLER_ROOT;
process.env.ORCH_CONTROLLER_ROOT=controllerRoot;
after(()=>{if(oldControllerRoot===undefined)delete process.env.ORCH_CONTROLLER_ROOT;else process.env.ORCH_CONTROLLER_ROOT=oldControllerRoot;fs.rmSync(controllerRoot,{recursive:true,force:true});});

const cases=[...([false,true].flatMap(capacityError=>[true,false].map(validReceipt=>({capacityError,validReceipt,withChecks:true})))),{capacityError:true,validReceipt:true,withChecks:false},{capacityError:false,validReceipt:false,withChecks:true,terminalFailure:true}];
for (const {capacityError,validReceipt,withChecks,terminalFailure=false} of cases) test(`execution exit preserves verification=${validReceipt}, capacityError=${capacityError}, checks=${withChecks}, terminalFailure=${terminalFailure}`, async () => {
  const workspace=fs.mkdtempSync(path.join(family,'self-close-'));
  fs.mkdirSync(path.join(workspace,'temp'),{recursive:true});
  const checks=path.join(workspace,'checks.json'),events=[];
  fs.writeFileSync(checks,JSON.stringify({T001:[{type:'json',path:'receipt.json',equals:{answer:42}}]}));
  let attempt,files,live=false;
  const hooks={
    plan:async()=>[{title:'close',tasks:[{prompt:'执行任务'}]}],compact:p=>p,infer:()=>[],prompt:p=>p,
    launcher:(key,prompt,suffix,options)=>{attempt=options.attemptFile;const dir=controllerWindowsDir(workspace),stem=key+'-'+suffix;fs.mkdirSync(dir,{recursive:true});files={lp:path.join(dir,'win-launch-'+stem+'.ps1'),pf:path.join(dir,'agent-win-'+stem+'.md'),pidf:path.join(dir,'window-'+stem+'.pid'),rf:path.join(dir,'win-'+stem+'.result.json')};const token=String(options.token).replaceAll("'","''");fs.writeFileSync(files.lp,"$token = '"+token+"'",'utf8');fs.writeFileSync(files.pf,'__ORCH_DONE__ '+options.token,'utf8');fs.writeFileSync(files.pidf,'9001','utf8');return files;},
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
    const sum=await runWindows('执行任务',hooks,{workspace,runId:'self-close',executionMode:'visible',capacity:1,acceptanceFile:withChecks?checks:undefined,coordinator:path.join(controllerRoot,'coordinator'),onEvent:e=>events.push(e.type)});
    assert.equal(sum.success,validReceipt&&withChecks);
    assert.equal(sum.taskResults.T001.status,validReceipt?(withChecks?'verified':'awaiting-verification'):'needs-reconciliation');
    assert.ok(events.includes(!withChecks?'block.B1.awaiting-verification':validReceipt?'block.B1.verified':'block.B1.needs-reconciliation'),JSON.stringify(events));
    assert.ok(!events.includes('block.B1.timeout'),'a known process exit is not a run timeout');
    assert.equal(sum.results.B1.attempts.length,1);
  } finally {fs.rmSync(workspace,{recursive:true,force:true});}
});

test('visible launcher failure before a rollout leaves bounded attempt diagnostics',async()=>{
  const workspace=fs.mkdtempSync(path.join(family,'early-exit-'));
  let files,live=false;
  const hooks={
    plan:async()=>[{title:'early',tasks:[{prompt:'执行任务'}]}],compact:p=>p,infer:()=>[],prompt:p=>p,
    launcher:(key,_prompt,suffix)=>{
      const dir=controllerWindowsDir(workspace),stem=key+'-'+suffix;
      return files={lp:path.join(dir,'win-launch-'+stem+'.ps1'),pf:path.join(dir,'agent-win-'+stem+'.md'),pidf:path.join(dir,'window-'+stem+'.pid'),rf:path.join(dir,'win-'+stem+'.result.json')};
    },
    spawn:async()=>{live=true;return true;},readPid:()=>9002,
    identity:()=>live?({ProcessId:9002,Name:'powershell.exe',Started:'fixture',CommandLine:'fixture'}):null,
    register:()=>{},commit:()=>{},unregister:()=>{},cleanup:()=>{},close:async()=>{live=false;},waitForExit:async()=>true,
    session:async()=>{fs.mkdirSync(path.dirname(files.rf),{recursive:true});fs.writeFileSync(files.rf+'.self-closed','closed');return null;},
    exitCode:()=>1,
  };
  try{
    const sum=await runWindows('执行任务',hooks,{workspace,runId:'early-exit',executionMode:'visible',capacity:1,maxAttempts:1,coordinator:path.join(controllerRoot,'coordinator')});
    assert.equal(sum.success,false);
    assert.equal(sum.results.B1.attempts.length,1);
    const diagnostic=sum.results.B1.attempts[0].diagnostic;
    assert.deepEqual(diagnostic,{sessionFound:false,launcherFinished:true,reportCaptured:false,launcherExitCode:1,selfCloseMarkerPresent:true});
    const saved=JSON.parse(fs.readFileSync(path.join(workspace,'temp','orchestrator','runs','early-exit','summary.json'),'utf8'));
    assert.deepEqual(saved.results.B1.attempts[0].diagnostic,diagnostic);
  }finally{fs.rmSync(workspace,{recursive:true,force:true});}
});
