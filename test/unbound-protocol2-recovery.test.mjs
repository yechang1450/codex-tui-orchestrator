import {testTempFamily} from './test-temp-root.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runWindows,runDirectory,preflightResumeLedger,sweepRunProcesses,verifyRun} from '../scripts/core/runner.mjs';
import {recordCheckpoint} from '../scripts/core/checkpoint.mjs';
import {controllerWindowsDir} from '../scripts/core/controller-state.mjs';

const family=testTempFamily('unbound-protocol2-recovery');
fs.mkdirSync(family,{recursive:true});
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function writeJson(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value));}

function durableTree(root){
 const files={};
 const visit=dir=>{
  for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
   const file=path.join(dir,entry.name);
   if(entry.isDirectory())visit(file);
   else files[path.relative(root,file).replaceAll('\\','/')]=fs.readFileSync(file).toString('base64');
  }
 };
 visit(root);return files;
}

function rejectedHooks(calls){
 const fail=name=>()=>{calls[name]++;throw new Error('recovery must reject before '+name);};
 return {
  plan:fail('plan'),compact:fail('compact'),infer:fail('infer'),prompt:fail('prompt'),launcher:fail('launcher'),
  spawn:fail('spawn'),readPid:fail('readPid'),identity:fail('identity'),register:fail('register'),commit:fail('commit'),
  unregister:fail('unregister'),cleanup:fail('cleanup'),close:fail('close'),waitForExit:fail('waitForExit'),
  session:fail('session'),wait:fail('wait'),exitCode:fail('exitCode'),
 };
}

async function completedRun({workspace,runId,coordinator}){
 const acceptance=path.join(workspace,'acceptance.json');
 writeJson(acceptance,{T001:[{type:'json',path:'verified.json',equals:{ok:true}}]});
 const identity={ProcessId:9511,Started:'fixture-start',Name:'powershell.exe',CommandLine:'fixture command'};
 const attemptFile=path.join(runDirectory(workspace,runId),'attempts','B1','1','attempt.json');
 const hooks={
  plan:async()=>[{title:'one',tasks:[{prompt:'one'}]}],compact:value=>value,infer:()=>[],prompt:value=>value,
  launcher:(key,_prompt,suffix)=>{
   const dir=controllerWindowsDir(workspace),stem=key+'-'+suffix;
   fs.mkdirSync(dir,{recursive:true});
   const files={lp:path.join(dir,'win-launch-'+stem+'.ps1'),pf:path.join(dir,'agent-win-'+stem+'.md'),pidf:path.join(dir,'window-'+stem+'.pid'),rf:path.join(dir,'win-'+stem+'.result.json')};
   fs.writeFileSync(files.lp,'# fixture launcher');fs.writeFileSync(files.pf,'# fixture prompt');return files;
  },
  spawn:async(_script,_title,pidFile)=>{fs.writeFileSync(pidFile,'9511');return true;},
  readPid:()=>9511,identity:()=>identity,register:()=>{},commit:()=>{},unregister:()=>{},cleanup:()=>{},close:async()=>{},waitForExit:async()=>true,
  session:async()=> 'fixture-session',
  wait:async()=>{recordCheckpoint(attemptFile,'T001','started');recordCheckpoint(attemptFile,'T001','completed');writeJson(path.join(workspace,'verified.json'),{ok:true});return {done:true,exitCode:0};},
  exitCode:()=>0,
 };
 const sum=await runWindows('one',hooks,{workspace,runId,capacity:1,coordinator,acceptanceFile:acceptance});
 assert.equal(sum.success,true,JSON.stringify(sum));
 const entry=sum.results.B1,attempt=entry.attempts.at(-1);
 assert.equal(entry.exitConfirmed,true);
 assert.equal(attempt.exitConfirmed,true);
 assert.equal(typeof entry.leaseId,'string');
 assert.match(entry.leaseInstanceId,UUID);
 assert.match(attempt.leaseInstanceId,UUID);
 assert.ok(entry.exitEvidence?.authenticated);
 assert.ok(attempt.exitEvidence?.authenticated);
 return {summaryFile:path.join(runDirectory(workspace,runId),'summary.json'),attemptFile:attempt.file};
}

test('protocol 2 recovery rejects a launched exit-proof record without one matching UUID lease binding before any hook or durable write',async()=>{
 for(const variant of ['missing-binding','missing-instance','mismatched-instance','disk-missing-binding','disk-mismatched-instance']){
  const workspace=fs.mkdtempSync(path.join(family,'unbound-protocol2-'+variant+'-'));
  const runId='unbound-'+variant;
  const coordinator=path.join(family,'unbound-protocol2-controller-'+variant+'-'+Date.now()+'-'+Math.random().toString(16).slice(2));
  try{
   const files=await completedRun({workspace,runId,coordinator});
   const summary=JSON.parse(fs.readFileSync(files.summaryFile,'utf8'));
   const diskAttempt=JSON.parse(fs.readFileSync(files.attemptFile,'utf8'));
   const entry=summary.results.B1,attempt=entry.attempts.at(-1);
   assert.equal(attempt.file,files.attemptFile);
   if(variant==='missing-binding'){
    delete entry.leaseId;delete entry.leaseInstanceId;
    delete attempt.leaseId;delete attempt.leaseInstanceId;
    delete diskAttempt.leaseId;delete diskAttempt.leaseInstanceId;
   }else if(variant==='missing-instance'){
    delete entry.leaseInstanceId;delete attempt.leaseInstanceId;delete diskAttempt.leaseInstanceId;
   }else if(variant==='mismatched-instance'){
    const foreign='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    assert.notEqual(entry.leaseInstanceId,foreign);
    attempt.leaseInstanceId=foreign;diskAttempt.leaseInstanceId=foreign;
   }
   if(variant==='disk-missing-binding'){
    delete diskAttempt.leaseId;delete diskAttempt.leaseInstanceId;
   }else if(variant==='disk-mismatched-instance'){
    diskAttempt.leaseInstanceId='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
   }
   writeJson(files.summaryFile,summary);writeJson(files.attemptFile,diskAttempt);
   const before=durableTree(runDirectory(workspace,runId));
   const rejection=/invalid recovery ledger.*lease|lease instance.*(bound|match|invalid)|leaseInstanceId/i;

   assert.throws(()=>preflightResumeLedger(workspace,runId),rejection,variant+' preflight must refuse an unbound launched record');
   assert.deepEqual(durableTree(runDirectory(workspace,runId)),before,variant+' preflight must be read-only');
   assert.throws(()=>verifyRun(workspace,runId,undefined,{coordinator}),rejection,variant+' verification must refuse the same unbound ledger');
   assert.deepEqual(durableTree(runDirectory(workspace,runId)),before,variant+' verification must be read-only');

   const calls=Object.fromEntries(['plan','compact','infer','prompt','launcher','spawn','readPid','identity','register','commit','unregister','cleanup','close','waitForExit','session','wait','exitCode'].map(name=>[name,0]));
   await assert.rejects(
    runWindows('',rejectedHooks(calls),{workspace,runId,capacity:1,coordinator,resume:true}),
    rejection,
    variant+' resume must reject the same unbound record',
   );
   assert.deepEqual(calls,Object.fromEntries(Object.keys(calls).map(name=>[name,0])),variant+' must not call cleanup or execution hooks');
   assert.deepEqual(durableTree(runDirectory(workspace,runId)),before,variant+' resume must not mutate the rejected ledger');
  }finally{fs.rmSync(workspace,{recursive:true,force:true});fs.rmSync(coordinator,{recursive:true,force:true});}
 }
});

test('an unbound cancelled no-process-like fallback is retained for reconciliation instead of being accepted as cleanup-safe',async()=>{
 const token='unbound-abort-token';
 const identity={ProcessId:9911,Started:'fixture-start',Name:'powershell.exe',commandLineSha256:'a'.repeat(64)};
 const attempt={runId:'unbound-abort',blockKey:'B1',number:1,token,file:path.resolve(family,'unbound-abort-attempt.json'),taskIds:['T001'],leaseId:'unbound-abort-B1',
  launcherPid:identity.ProcessId,launcherObserved:{...identity},exitConfirmed:true,
  exitEvidence:{token,pid:identity.ProcessId,authenticated:true,at:1}};
 const entry={status:'cancelled',token,leaseId:'unbound-abort-B1',launcher:{...identity},exitConfirmed:true,
  exitEvidence:{token,pid:identity.ProcessId,authenticated:true,at:1},attempts:[attempt]};
 const sum={runId:'unbound-abort',blocks:[{key:'B1',taskIds:['T001']}],results:{B1:entry}};
 let closes=0,retained=0;
 const stats=await sweepRunProcesses(sum,{close:async()=>{closes++;},onRetained:async()=>{retained++;}});
 assert.equal(closes,0,'unbound identity must never be closed');
 assert.equal(stats.retained,1,'unbound fallback must be retained');
 assert.equal(retained,1,'the caller must receive a reconciliation retention callback');
 assert.equal(entry.status,'needs-reconciliation');
 assert.equal(entry.exitConfirmed,false);
});
