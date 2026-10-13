import {testTempFamily} from './test-temp-root.mjs';
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {recordCheckpoint} from '../scripts/core/checkpoint.mjs';
import {controllerWindowsDir} from '../scripts/core/controller-state.mjs';
import {createStatusPublisher} from '../scripts/core/status-events.mjs';
import {preflightResumeLedger,runDirectory,runWindows,sweepRunProcesses} from '../scripts/core/runner.mjs';

const family=testTempFamily('durable-launcher-identity-authority');
fs.mkdirSync(family,{recursive:true});
const controllerRoot=fs.mkdtempSync(path.join(family,'durable-identity-controller-'));
const oldControllerRoot=process.env.ORCH_CONTROLLER_ROOT;
process.env.ORCH_CONTROLLER_ROOT=controllerRoot;
after(()=>{
  if(oldControllerRoot===undefined)delete process.env.ORCH_CONTROLLER_ROOT;
  else process.env.ORCH_CONTROLLER_ROOT=oldControllerRoot;
  fs.rmSync(controllerRoot,{recursive:true,force:true});
});

const identityA={ProcessId:41201,Started:'2026-10-11T00:00:00.000Z',Name:'powershell.exe',commandLineSha256:'a'.repeat(64)};
const identityB={ProcessId:41202,Started:'2026-10-11T00:01:00.000Z',Name:'powershell.exe',commandLineSha256:'b'.repeat(64)};

function writeJson(file,value){
  fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(file,JSON.stringify(value),'utf8');
}
function readJson(file){return JSON.parse(fs.readFileSync(file,'utf8'));}
function removeFields(value,fields){for(const field of fields)delete value[field];return value;}
function rejected(name,calls){return ()=>{calls[name]++;throw new Error('unexpected resumed '+name);};}

async function durableMismatchFixture(){
  const workspace=fs.mkdtempSync(path.join(family,'durable-identity-workspace-'));
  const coordinator=path.join(controllerRoot,'coordinator-'+path.basename(workspace));
  const runId='durable-identity';
  const acceptance=path.join(workspace,'checks.json');
  writeJson(acceptance,{T001:[{type:'json',path:'receipt.json',equals:{ok:true}}]});
  let attemptFile,launcherFiles;
  const baselineHooks={
    plan:async()=>[{title:'one',tasks:[{prompt:'write receipt'}]}],compact:value=>value,infer:()=>[],prompt:value=>value,
    launcher:(key,_prompt,suffix,options)=>{
      const dir=controllerWindowsDir(workspace),stem=key+'-'+suffix;
      launcherFiles={lp:path.join(dir,'win-launch-'+stem+'.ps1'),pf:path.join(dir,'agent-win-'+stem+'.md'),pidf:path.join(dir,'window-'+stem+'.pid'),rf:path.join(dir,'win-'+stem+'.result.json')};
      fs.mkdirSync(dir,{recursive:true});
      fs.writeFileSync(launcherFiles.lp,"$token = '"+options.token+"'\n",'utf8');
      fs.writeFileSync(launcherFiles.pf,'__ORCH_DONE__ '+options.token,'utf8');
      attemptFile=options.attemptFile;
      return launcherFiles;
    },
    spawn:async(_script,_title,pidFile)=>{fs.writeFileSync(pidFile,String(identityA.ProcessId),'utf8');return true;},
    readPid:pidFile=>Number(fs.readFileSync(pidFile,'utf8')),
    identity:pid=>Number(pid)===identityA.ProcessId?identityA:null,
    register:()=>{},commit:()=>{},unregister:()=>{},cleanup:()=>{},close:async()=>{},waitForExit:async()=>true,
    session:async()=> 'baseline-session',
    wait:async()=>{
      recordCheckpoint(attemptFile,'T001','started');
      writeJson(path.join(workspace,'receipt.json'),{ok:true});
      recordCheckpoint(attemptFile,'T001','completed');
      return {done:true,exitCode:0};
    },
    exitCode:()=>0,
  };
  const baseline=await runWindows('write receipt',baselineHooks,{workspace,runId,capacity:1,coordinator,acceptanceFile:acceptance});
  assert.equal(baseline.success,true,JSON.stringify(baseline));

  const dir=runDirectory(workspace,runId),summaryFile=path.join(dir,'summary.json');
  const summary=readJson(summaryFile),entry=summary.results.B1,attempt=entry.attempts.at(-1),diskAttempt=readJson(attempt.file);
  assert.deepEqual(entry.launcher,identityA,'fixture must start from a real saved durable identity');
  assert.equal(attempt.leaseId,entry.leaseId);
  assert.equal(attempt.leaseInstanceId,entry.leaseInstanceId);
  assert.match(entry.leaseInstanceId,/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.ok(launcherFiles&&attemptFile===attempt.file);

  // Reconstruct the live controller artifacts after the completed baseline and
  // retain the old durable A identity. The PID file now points at a different
  // process binding B, which is exactly the PID reuse/foreign-process boundary.
  fs.writeFileSync(launcherFiles.lp,"$token = '"+attempt.token+"'\n",'utf8');
  fs.writeFileSync(launcherFiles.pf,'__ORCH_DONE__ '+attempt.token,'utf8');
  fs.writeFileSync(launcherFiles.pidf,String(identityB.ProcessId),'utf8');
  Object.assign(entry,{status:'running',launcher:{...identityA},exitConfirmed:false,reason:''});
  removeFields(entry,['exitEvidence','exitUnprovenAt','endedAt','cleanupPending','noProcessProof','inspectedToken','exitCode']);
  Object.assign(attempt,{launcherObserved:{...identityA},launcherPid:identityA.ProcessId,exitConfirmed:false});
  removeFields(attempt,['exitEvidence','exitUnprovenAt','cleanupPending','noProcessProof','endedAt','exitCode']);
  const persistedAttempt={...diskAttempt,launcherObserved:{...identityA},launcherPid:identityA.ProcessId,exitConfirmed:false};
  removeFields(persistedAttempt,['exitEvidence','exitUnprovenAt','cleanupPending','noProcessProof','endedAt','exitCode']);
  writeJson(attempt.file,persistedAttempt);
  summary.taskResults.T001={status:'pending'};
  summary.success=false;
  removeFields(summary,['finishedAt','finalSweep','verification']);
  // Generate a matching controller status authority for this intentionally
  // active, structurally valid protocol-2 recovery record.
  createStatusPublisher(dir).publish(summary,'test.durable-identity-mismatch');
  return {workspace,coordinator,runId,dir,summary:readJson(summaryFile),cleanup:()=>fs.rmSync(workspace,{recursive:true,force:true})};
}

test('durable launcher identity authority retains a foreign PID binding on sweep and abort resume',async()=>{
  const fixture=await durableMismatchFixture();
  try{
    const direct=structuredClone(fixture.summary);
    const directEntry=direct.results.B1,directAttempt=directEntry.attempts.at(-1);
    delete directEntry.launcher;
    assert.equal(directEntry.launcher,undefined);
    assert.deepEqual(directAttempt.launcherObserved,identityA);
    let directCloses=0,directIdentities=0,directRetained=0;
    const directStats=await sweepRunProcesses(direct,{
      identify:pid=>{directIdentities++;assert.equal(Number(pid),identityB.ProcessId);return identityB;},
      close:async()=>{directCloses++;},
      waitForExit:async()=>{throw new Error('foreign identity must not be waited on');},
      onRetained:async()=>{directRetained++;},
    });
    assert.deepEqual(directStats,{checked:1,closed:0,failed:0,retained:1});
    assert.equal(directCloses,0,'sweep must not close B when only attempt.launcherObserved authorizes A');
    assert.equal(directIdentities,1);
    assert.equal(directRetained,1);
    assert.equal(directEntry.status,'needs-reconciliation');
    assert.equal(directAttempt.exitConfirmed,false);

    assert.doesNotThrow(()=>preflightResumeLedger(fixture.workspace,fixture.runId),'the A-bound protocol-2 ledger itself is structurally recoverable');
    const calls=Object.fromEntries(['close','unregister','cleanup','spawn','session','wait','register','commit','launcher','plan','abort'].map(key=>[key,0]));
    const hooks={
      plan:rejected('plan',calls),compact:rejected('plan',calls),infer:rejected('plan',calls),prompt:rejected('plan',calls),launcher:rejected('launcher',calls),
      spawn:rejected('spawn',calls),readPid:pidFile=>Number(fs.readFileSync(pidFile,'utf8')),
      identity:pid=>{assert.equal(Number(pid),identityB.ProcessId,'the resumed PID file must resolve to B');return identityB;},
      register:rejected('register',calls),commit:rejected('commit',calls),
      close:async()=>{calls.close++;},waitForExit:async()=>{throw new Error('foreign identity must not be waited on');},
      unregister:rejected('unregister',calls),cleanup:rejected('cleanup',calls),
      session:rejected('session',calls),wait:rejected('wait',calls),exitCode:rejected('wait',calls),
    };
    const resumed=await runWindows('',hooks,{workspace:fixture.workspace,runId:fixture.runId,capacity:1,coordinator:fixture.coordinator,resume:true,
      abort:()=>{calls.abort++;return {schema:1,kind:'acceptance-abort',runId:fixture.runId,reason:'identity-mismatch',requestedAt:Date.now()};}});
    assert.equal(calls.close,0,'abort cleanup must not close foreign binding B');
    assert.equal(calls.unregister,0,'foreign binding B must retain the bound lease');
    assert.equal(calls.cleanup,0,'foreign binding B must retain launcher artifacts');
    assert.equal(calls.spawn,0);assert.equal(calls.session,0);assert.equal(calls.wait,0);
    assert.ok(calls.abort>=1,'the abort authority must be observed without bypassing identity checks');
    assert.equal(resumed.results.B1.status,'needs-reconciliation');
    assert.match(resumed.results.B1.reason,/identity does not match the durable attempt binding/i);
    assert.equal(resumed.success,false);
  }finally{fixture.cleanup();}
});

test('startup receipt cleanup refuses a close when verification leaves the current launcher identity missing or foreign',async()=>{
  // This reaches the narrow startup-receipt failure closer after a normal
  // protocol-2 resume has already authenticated durable identity A.  The
  // verifier is the last external boundary before that closer, so it models a
  // late PID/identity race: its ephemeral observation must be rechecked
  // against the unchanged durable A binding before anything can be closed.
  for(const [label,invalidate] of [
    ['missing',identity=>{delete identity.commandLineSha256;}],
    ['foreign',identity=>Object.assign(identity,identityB)],
  ]){
    const fixture=await durableMismatchFixture();
    try{
      const summary=readJson(path.join(fixture.dir,'summary.json'));
      const entry=summary.results.B1;
      fs.writeFileSync(entry.launcherFiles.pidf,String(identityA.ProcessId),'utf8');
      assert.doesNotThrow(()=>preflightResumeLedger(fixture.workspace,fixture.runId),label+' fixture must be structurally recoverable before the late observation changes');

      const calls=Object.fromEntries(['close','ready','unregister','cleanup','spawn','session','wait','register','commit','launcher','plan','verifyStartup'].map(key=>[key,0]));
      const rejectedHook=name=>()=>{calls[name]++;throw new Error('unexpected resumed '+name+' for '+label);};
      const hooks={
        plan:rejectedHook('plan'),compact:rejectedHook('plan'),infer:rejectedHook('plan'),prompt:rejectedHook('plan'),launcher:rejectedHook('launcher'),
        spawn:rejectedHook('spawn'),register:rejectedHook('register'),commit:rejectedHook('commit'),
        unregister:rejectedHook('unregister'),cleanup:rejectedHook('cleanup'),
        readPid:pidFile=>Number(fs.readFileSync(pidFile,'utf8')),
        identity:pid=>{
          assert.equal(Number(pid),identityA.ProcessId,label+' resume must begin from the authenticated A PID');
          return {...identityA};
        },
        verifyStartup:async(_files,identity)=>{
          calls.verifyStartup++;
          assert.deepEqual(identity,identityA,label+' verifier must receive the initially authenticated binding');
          invalidate(identity);
          throw new Error('ISOLATED_ACCEPTANCE_STARTUP_RECEIPT: injected '+label+' identity after verification began');
        },
        ready:rejectedHook('ready'),
        close:async()=>{calls.close++;},
        waitForExit:async()=>{throw new Error('startup receipt cleanup must not wait on an unbound launcher');},
        session:rejectedHook('session'),wait:rejectedHook('wait'),exitCode:()=>null,
      };
      const resumed=await runWindows('',hooks,{workspace:fixture.workspace,runId:fixture.runId,capacity:1,coordinator:fixture.coordinator,resume:true});
      assert.equal(calls.verifyStartup,1,label+' path must reach the startup receipt verifier');
      assert.equal(calls.close,0,label+' durable identity mismatch must not invoke the startup receipt closer');
      assert.equal(calls.ready,0,label+' startup receipt failure must not release the launcher');
      assert.equal(calls.unregister,0,label+' unbound launcher must retain its lease');
      assert.equal(calls.cleanup,0,label+' unbound launcher must retain its artifacts');
      assert.equal(calls.spawn,0);assert.equal(calls.session,0);assert.equal(calls.wait,0);
      assert.equal(resumed.results.B1.status,'needs-reconciliation');
      assert.equal(resumed.results.B1.exitConfirmed,false);
      assert.ok(resumed.results.B1.exitUnprovenAt,label+' rejection must retain explicit exit uncertainty');
    }finally{fixture.cleanup();}
  }
});
