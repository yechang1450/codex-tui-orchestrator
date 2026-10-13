import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {preflightResumeLedger,runWindows,runDirectory} from '../scripts/core/runner.mjs';
import {controllerWindowsDir} from '../scripts/core/controller-state.mjs';
import {
  cleanupTransactionMarkerFile,
  readCleanupTransactionMarkerForRecovery,
} from '../scripts/core/cleanup-transaction.mjs';

test('a workspace cleanup journal without its controller marker fails closed without replaying cleanup',async()=>{
  const family=fs.mkdtempSync(path.join(os.tmpdir(),'ctui-missing-cleanup-marker-'));
  const workspace=path.join(family,'workspace');
  const controller=path.join(family,'controller');
  const runId='missing-cleanup-marker',coordinator=path.join(controller,'coordinator');
  const priorControllerRoot=process.env.ORCH_CONTROLLER_ROOT;
  process.env.ORCH_CONTROLLER_ROOT=controller;
  let spawns=0,unregisters=0,cleanups=0;
  let launcherFiles;
  const hooks={
    plan:async()=>[{title:'retained cleanup',type:'single',tasks:[{prompt:'exercise cleanup recovery'}]}],
    compact:value=>value,infer:()=>[],prompt:value=>value,
    launcher:(key,prompt,suffix)=>{
      const dir=controllerWindowsDir(workspace),stem=key+'-'+suffix;
      launcherFiles={
        lp:path.join(dir,'win-launch-'+stem+'.ps1'),
        pf:path.join(dir,'agent-win-'+stem+'.md'),
        pidf:path.join(dir,'window-'+stem+'.pid'),
        rf:path.join(dir,'win-'+stem+'.result.json'),
      };
      fs.mkdirSync(dir,{recursive:true});
      fs.writeFileSync(launcherFiles.lp,'# test launcher','utf8');
      fs.writeFileSync(launcherFiles.pf,prompt,'utf8');
      return launcherFiles;
    },
    spawn:async()=>{spawns++;return {noProcess:true};},
    readPid:()=>0,
    identity:()=>{throw new Error('no-process cleanup must not inspect a launcher identity');},
    register:()=>{},commit:()=>{},
    unregister:()=>{unregisters++;},
    cleanup:()=>{
      cleanups++;
      if(cleanups===1)throw new Error('synthetic artifact cleanup interruption');
    },
    close:async()=>{throw new Error('no-process cleanup must not close a launcher');},
    waitForExit:async()=>{throw new Error('no-process cleanup must not wait for launcher exit');},
    session:async()=>{throw new Error('no-process cleanup must not discover a session');},
    wait:async()=>{throw new Error('no-process cleanup must not wait for a session');},
    exitCode:()=>null,
  };
  try{
    const first=await runWindows('exercise cleanup recovery',hooks,{workspace,runId,capacity:1,coordinator,auth:'test',maxAttempts:1});
    const entry=first.results.B1,attempt=entry.attempts.at(-1);
    assert.equal(first.success,false);
    assert.equal(entry.status,'cleanup-pending');
    assert.deepEqual(entry.cleanupPending?.phases,{lease:'done',registry:'done',artifacts:'pending'});
    assert.equal(spawns,1);
    assert.equal(unregisters,1);
    assert.equal(cleanups,1);

    const recoveryBinding={
      runId,blockKey:'B1',attempt:attempt.number,token:attempt.token,
      attemptFile:attempt.file,coordinator,
      lease:{id:entry.leaseId,instanceId:entry.leaseInstanceId},
    };
    const marker=readCleanupTransactionMarkerForRecovery({workspace,binding:recoveryBinding});
    assert.ok(marker,'initial cleanup must have a controller-authorized marker');
    const markerFile=cleanupTransactionMarkerFile({workspace,binding:{...recoveryBinding,status:marker.status}});
    fs.unlinkSync(markerFile);
    assert.equal(readCleanupTransactionMarkerForRecovery({workspace,binding:recoveryBinding}),null,
      'the fixture must remove the controller half while retaining workspace mirrors');

    const summaryFile=path.join(runDirectory(workspace,runId),'summary.json');
    const beforeSummary=fs.readFileSync(summaryFile,'utf8');
    const beforeAttempt=fs.readFileSync(attempt.file,'utf8');
    assert.throws(()=>preflightResumeLedger(workspace,runId),/controller marker is missing.*reconcile/i,
      'read-only preflight must reject a workspace-only cleanup journal');
    await assert.rejects(
      ()=>runWindows('',hooks,{workspace,runId,capacity:1,coordinator,auth:'test',maxAttempts:1,resume:true}),
      /controller marker is missing.*reconcile/i,
      'resume must reject before it can recreate a controller marker or replay cleanup',
    );
    assert.equal(spawns,1,'resume must not launch a replacement worker');
    assert.equal(unregisters,1,'resume must not replay a completed registry cleanup phase');
    assert.equal(cleanups,1,'resume must not replay an artifact cleanup phase without the controller marker');
    assert.equal(readCleanupTransactionMarkerForRecovery({workspace,binding:recoveryBinding}),null,
      'recovery must not recreate missing controller authority from a workspace-side journal');
    assert.equal(fs.readFileSync(summaryFile,'utf8'),beforeSummary,'rejected resume must not rewrite the public ledger');
    assert.equal(fs.readFileSync(attempt.file,'utf8'),beforeAttempt,'rejected resume must not rewrite the attempt ledger');
    const persisted=JSON.parse(fs.readFileSync(summaryFile,'utf8'));
    const persistedAttempt=JSON.parse(fs.readFileSync(attempt.file,'utf8'));
    assert.ok(persisted.results.B1.cleanupPending,'public ledger must retain the unresolved cleanup transaction');
    assert.ok(persistedAttempt.cleanupPending,'attempt ledger must retain the unresolved cleanup transaction');
  }finally{
    if(priorControllerRoot===undefined)delete process.env.ORCH_CONTROLLER_ROOT;
    else process.env.ORCH_CONTROLLER_ROOT=priorControllerRoot;
    fs.rmSync(family,{recursive:true,force:true});
  }
});
