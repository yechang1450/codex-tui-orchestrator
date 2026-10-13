import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runDirectory,runWindows,preflightResumeLedger} from '../scripts/core/runner.mjs';
import {cleanupTransactionMarkerFile,readCleanupTransactionMarkerForRecovery} from '../scripts/core/cleanup-transaction.mjs';
import {controllerWindowsDir} from '../scripts/core/controller-state.mjs';

const family=fs.mkdtempSync(path.join(os.tmpdir(),'ctui-cleanup-marker-tamper-'));
const controllerRoot=path.join(family,'controller');
const priorControllerRoot=process.env.ORCH_CONTROLLER_ROOT;
process.env.ORCH_CONTROLLER_ROOT=controllerRoot;
after(()=>{
  if(priorControllerRoot===undefined)delete process.env.ORCH_CONTROLLER_ROOT;
  else process.env.ORCH_CONTROLLER_ROOT=priorControllerRoot;
  fs.rmSync(family,{recursive:true,force:true});
});

const readJson=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const writeJson=(file,value)=>fs.writeFileSync(file,JSON.stringify(value),'utf8');

function treeSnapshot(root){
  const files={};
  if(!fs.existsSync(root))return files;
  const visit=directory=>{
    for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
      const file=path.join(directory,entry.name),relative=path.relative(root,file).replaceAll('\\','/');
      if(entry.isDirectory())visit(file);
      else if(entry.isFile())files[relative]=fs.readFileSync(file).toString('base64');
      else files[relative]='<non-regular>';
    }
  };
  visit(root);
  return files;
}

function retainedCleanupFixture(workspace){
  const acceptance=path.join(workspace,'acceptance.json');
  writeJson(acceptance,{T001:[{type:'json',path:'completed.json',equals:{count:1}}]});
  const coordinator=path.join(controllerRoot,'coordinator-'+path.basename(workspace));
  fs.mkdirSync(coordinator,{recursive:true});
  let spawned=0,cleanupCalls=0;
  const hooks={
    plan:async()=>[{title:'retained cleanup',type:'single',tasks:[{prompt:'complete once'}]}],
    compact:value=>value,
    infer:()=>[],
    prompt:value=>value,
    launcher:(key,prompt,suffix)=>{
      const attemptFile=/开始前：& '[^']+' '[^']+' '([^']+)'/.exec(prompt)?.[1];
      assert.ok(attemptFile,'fixture launcher must receive the durable attempt file');
      const launchDirectory=controllerWindowsDir(workspace),stem=key+'-'+suffix;
      fs.mkdirSync(launchDirectory,{recursive:true});
      const files={
        pidf:path.join(launchDirectory,'window-'+stem+'.pid'),
        lp:path.join(launchDirectory,'win-launch-'+stem+'.ps1'),
        pf:path.join(launchDirectory,'agent-win-'+stem+'.md'),
        rf:path.join(launchDirectory,'win-'+stem+'.result.json'),
      };
      fs.writeFileSync(files.lp,'# fixture launcher','utf8');
      fs.writeFileSync(files.pf,prompt,'utf8');
      return files;
    },
    spawn:async()=>{spawned++;return {noProcess:true};},
    readPid:()=>0,
    identity:()=>{throw new Error('a no-process receipt must not inspect a launcher identity');},
    session:async()=>{throw new Error('a no-process receipt must not discover a session');},
    wait:async()=>{throw new Error('a no-process receipt must not wait for task execution');},
    exitCode:()=>0,
    register:()=>{},
    commit:()=>{},
    unregister:()=>{},
    cleanup:()=>{cleanupCalls++;throw new Error('synthetic retained artifact cleanup');},
    close:async()=>{throw new Error('a no-process receipt must not close a launcher');},
    waitForExit:async()=>{throw new Error('a no-process receipt must not await a launcher');},
  };
  return {acceptance,coordinator,hooks,get spawned(){return spawned;},get cleanupCalls(){return cleanupCalls;}};
}

async function createTamperedRecoveryState({mutate}){
  const workspace=fs.mkdtempSync(path.join(family,'workspace-'));
  const runId='cleanup-marker-tamper-'+path.basename(workspace);
  const fixture=retainedCleanupFixture(workspace);
  const first=await runWindows('complete once',fixture.hooks,{
    workspace,runId,capacity:1,acceptanceFile:fixture.acceptance,
    coordinator:fixture.coordinator,auth:'test',maxAttempts:1,
  });
  const entry=first.results.B1,attempt=entry?.attempts?.at(-1);
  assert.equal(entry?.status,'cleanup-pending','fixture must retain the artifact phase');
  assert.equal(fixture.cleanupCalls,1,'fixture must stop after the first artifact cleanup attempt');
  assert.ok(attempt?.file,'fixture must persist its attempt record');
  const binding={
    runId,blockKey:'B1',attempt:attempt.number,token:attempt.token,
    attemptFile:path.resolve(attempt.file),coordinator:path.resolve(fixture.coordinator),
    lease:entry.noProcessProof.lease,
  };
  const marker=readCleanupTransactionMarkerForRecovery({workspace,binding});
  assert.ok(marker,'fixture must create a controller cleanup marker');
  const markerFile=cleanupTransactionMarkerFile({workspace,binding:{...binding,status:marker.status}});
  const raw=readJson(markerFile);
  mutate(raw);
  writeJson(markerFile,raw);
  return {workspace,runId,fixture,cleanup:()=>fs.rmSync(workspace,{recursive:true,force:true})};
}

async function assertTamperRejected({mutate,expected}){
  const state=await createTamperedRecoveryState({mutate});
  try{
    const before={
      workspace:treeSnapshot(runDirectory(state.workspace,state.runId)),
      controller:treeSnapshot(controllerRoot),
      spawned:state.fixture.spawned,
      cleanupCalls:state.fixture.cleanupCalls,
    };
    assert.throws(()=>preflightResumeLedger(state.workspace,state.runId),expected,
      'read-only preflight must reject the forged controller marker');
    assert.deepEqual({
      workspace:treeSnapshot(runDirectory(state.workspace,state.runId)),
      controller:treeSnapshot(controllerRoot),
      spawned:state.fixture.spawned,
      cleanupCalls:state.fixture.cleanupCalls,
    },before,'preflight must leave every durable artifact untouched');

    await assert.rejects(
      ()=>runWindows('',state.fixture.hooks,{
        workspace:state.workspace,runId:state.runId,capacity:1,
        acceptanceFile:state.fixture.acceptance,coordinator:state.fixture.coordinator,
        auth:'test',maxAttempts:1,resume:true,
      }),
      expected,
      'resume must reject before a forged marker can authorize writes or scheduling',
    );
    assert.deepEqual({
      workspace:treeSnapshot(runDirectory(state.workspace,state.runId)),
      controller:treeSnapshot(controllerRoot),
      spawned:state.fixture.spawned,
      cleanupCalls:state.fixture.cleanupCalls,
    },before,'rejected resume must not write, spawn, or repeat cleanup');
  }finally{state.cleanup();}
}

test('recovery rejects semantic and proof tampering in a persisted cleanup controller marker before writes or spawn',async t=>{
  await t.test('a forged target semantic digest cannot authorize a marker recovery projection',async()=>{
    await assertTamperRejected({
      mutate:marker=>{marker.status.targetSemanticSha256='f'.repeat(64);},
      expected:/target semantics do not match its workspace recovery target/i,
    });
  });

  await t.test('a valid-looking but mismatched no-process proof cannot authorize recovery',async()=>{
    await assertTamperRejected({
      mutate:marker=>{
        const original=marker.proof.recordedAt;
        const replacement=marker.journal.recordedAt===original
          ?marker.journal.recordedAt-1
          :marker.journal.recordedAt;
        assert.ok(replacement>0&&replacement!==original,'fixture must produce a distinct valid proof timestamp');
        marker.proof.recordedAt=replacement;
      },
      expected:/no-process proof differs from controller marker/i,
    });
  });
});
