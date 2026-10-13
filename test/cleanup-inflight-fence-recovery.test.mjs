import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  preflightResumeLedger,
  runDirectory,
  runWindows,
  verifyRun,
} from '../scripts/core/runner.mjs';
import {controllerWindowsDir} from '../scripts/core/controller-state.mjs';
import {readCleanupTransactionMarkerForRecovery} from '../scripts/core/cleanup-transaction.mjs';

const readJson=file=>JSON.parse(fs.readFileSync(file,'utf8'));

function treeSnapshot(root){
  const files={};
  if(!fs.existsSync(root))return files;
  const visit=directory=>{
    for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
      const file=path.join(directory,entry.name);
      const relative=path.relative(root,file).replaceAll('\\','/');
      if(entry.isDirectory())visit(file);
      else if(entry.isFile())files[relative]=fs.readFileSync(file).toString('base64');
      else files[relative]='<non-regular>';
    }
  };
  visit(root);
  return files;
}

test('an in-flight cleanup fence fails closed before cleanup, spawn, or ledger mutation can repeat',async()=>{
  const family=fs.mkdtempSync(path.join(os.tmpdir(),'ctui-inflight-fence-'));
  const workspace=path.join(family,'workspace');
  const controller=path.join(family,'controller');
  const coordinator=path.join(controller,'coordinator');
  const runId='inflight-fence';
  const acceptance=path.join(workspace,'acceptance.json');
  const previousControllerRoot=process.env.ORCH_CONTROLLER_ROOT;
  let spawned=0,unregistered=0,cleanups=0;
  process.env.ORCH_CONTROLLER_ROOT=controller;
  try{
    fs.mkdirSync(workspace,{recursive:true});
    fs.mkdirSync(coordinator,{recursive:true});
    fs.writeFileSync(acceptance,JSON.stringify({T001:[{type:'json',path:'completed.json',equals:{count:1}}]}));
    const hooks={
      plan:async()=>[{title:'inflight cleanup fence',type:'single',tasks:[{prompt:'complete once'}]}],
      compact:value=>value,
      infer:()=>[],
      prompt:value=>value,
      launcher:(key,prompt,suffix)=>{
        const directory=controllerWindowsDir(workspace),stem=key+'-'+suffix;
        const files={
          pidf:path.join(directory,'window-'+stem+'.pid'),
          lp:path.join(directory,'win-launch-'+stem+'.ps1'),
          pf:path.join(directory,'agent-win-'+stem+'.md'),
          rf:path.join(directory,'win-'+stem+'.result.json'),
        };
        fs.mkdirSync(directory,{recursive:true});
        fs.writeFileSync(files.lp,'# fixture launcher','utf8');
        fs.writeFileSync(files.pf,prompt,'utf8');
        return files;
      },
      spawn:async()=>{spawned++;return {noProcess:true};},
      readPid:()=>0,
      identity:()=>{throw new Error('no-process fixture must not inspect a launcher identity');},
      session:async()=>{throw new Error('no-process fixture must not discover a session');},
      wait:async()=>{throw new Error('no-process fixture must not wait for task execution');},
      exitCode:()=>0,
      register:()=>{},
      commit:()=>{},
      unregister:()=>{unregistered++;},
      // The runner must have durably changed the controller marker to
      // `inflight` before this external hook begins.  Throwing here models a
      // crash/failure after the fence and before the hook can prove whether it
      // changed external launcher files.
      cleanup:()=>{cleanups++;throw new Error('synthetic failure after cleanup fence');},
      close:async()=>{throw new Error('no-process fixture must not close a launcher');},
      waitForExit:async()=>{throw new Error('no-process fixture must not wait for a launcher');},
    };

    const first=await runWindows('complete once',hooks,{
      workspace,runId,capacity:1,acceptanceFile:acceptance,
      coordinator,auth:'test',maxAttempts:1,
    });
    const entry=first.results.B1,attempt=entry.attempts.at(-1);
    assert.equal(first.success,false);
    assert.equal(entry.status,'cleanup-pending');
    assert.equal(spawned,1);
    assert.equal(unregistered,1);
    assert.equal(cleanups,1);
    assert.deepEqual(entry.cleanupPending.phases,{lease:'done',registry:'done',artifacts:'pending'},
      'the workspace mirrors remain at the last proven phase');

    const binding={
      runId,blockKey:'B1',attempt:attempt.number,token:attempt.token,
      attemptFile:path.resolve(attempt.file),coordinator:path.resolve(coordinator),
      lease:entry.noProcessProof.lease,
    };
    const marker=readCleanupTransactionMarkerForRecovery({workspace,binding});
    assert.equal(marker?.state,'active');
    assert.deepEqual(marker?.journal.phases,{lease:'done',registry:'done',artifacts:'inflight'},
      'the controller marker is the durable start fence for the failed hook');
    assert.deepEqual(readJson(attempt.file).cleanupPending.phases,entry.cleanupPending.phases,
      'attempt and public mirrors must remain mutually consistent at the safe prefix');

    const ledgerDirectory=runDirectory(workspace,runId);
    const before={workspace:treeSnapshot(ledgerDirectory),controller:treeSnapshot(controller)};
    const inflightError=/phase may have executed.*reconciliation is required/i;

    assert.throws(()=>preflightResumeLedger(workspace,runId),inflightError,
      'read-only preflight must reject ambiguous in-flight cleanup');
    assert.deepEqual({workspace:treeSnapshot(ledgerDirectory),controller:treeSnapshot(controller)},before,
      'preflight must not repair or alter an ambiguous in-flight transaction');

    assert.throws(()=>verifyRun(workspace,runId,acceptance,{coordinator}),/cleanup remains pending/i,
      'verification cannot bypass the retained cleanup transaction');
    assert.deepEqual({workspace:treeSnapshot(ledgerDirectory),controller:treeSnapshot(controller)},before,
      'verification must leave retained cleanup evidence intact');

    await assert.rejects(
      ()=>runWindows('',hooks,{
        workspace,runId,capacity:1,acceptanceFile:acceptance,
        coordinator,auth:'test',maxAttempts:1,resume:true,
      }),
      inflightError,
      'resume must reject before it can repeat an external cleanup effect',
    );
    assert.equal(spawned,1,'rejected resume must not schedule a replacement launcher');
    assert.equal(unregistered,1,'rejected resume must not repeat the completed registry effect');
    assert.equal(cleanups,1,'rejected resume must not repeat the ambiguous artifact cleanup');
    assert.deepEqual({workspace:treeSnapshot(ledgerDirectory),controller:treeSnapshot(controller)},before,
      'rejected resume must preserve every workspace and controller artifact exactly');
  }finally{
    if(previousControllerRoot===undefined)delete process.env.ORCH_CONTROLLER_ROOT;
    else process.env.ORCH_CONTROLLER_ROOT=previousControllerRoot;
    fs.rmSync(family,{recursive:true,force:true});
  }
});
