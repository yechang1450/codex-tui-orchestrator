import {testTempFamily} from './test-temp-root.mjs';
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  preflightResumeLedger,
  runDirectory,
  runWindows,
} from '../scripts/core/runner.mjs';
import {
  beginCleanupTransactionMarkerPhase,
  cleanupTransactionMarkerFile,
  readCleanupTransactionMarkerForRecovery,
  updateCleanupTransactionMarker,
  updateCleanupTransactionStatusAuthority,
} from '../scripts/core/cleanup-transaction.mjs';
import {createCleanupStatusAuthorityBinding,createStatusPublisher} from '../scripts/core/status-events.mjs';
import {controllerWindowsDir} from '../scripts/core/controller-state.mjs';
import {validateRecoverySummary} from '../scripts/core/recovery.mjs';

const family=testTempFamily('marker-recovery-crash');
fs.mkdirSync(family,{recursive:true});
const controllerRoot=fs.mkdtempSync(path.join(family,'marker-recovery-crash-controller-'));
const previousControllerRoot=process.env.ORCH_CONTROLLER_ROOT;
process.env.ORCH_CONTROLLER_ROOT=controllerRoot;
after(()=>{
  if(previousControllerRoot===undefined)delete process.env.ORCH_CONTROLLER_ROOT;
  else process.env.ORCH_CONTROLLER_ROOT=previousControllerRoot;
  fs.rmSync(controllerRoot,{recursive:true,force:true});
});

const readJson=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const writeJson=(file,value)=>fs.writeFileSync(file,JSON.stringify(value));

function treeSnapshot(root){
  const out={};
  if(!fs.existsSync(root))return out;
  const visit=dir=>{
    for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
      const file=path.join(dir,entry.name),relative=path.relative(root,file).replaceAll('\\','/');
      if(entry.isDirectory())visit(file);
      else if(entry.isFile())out[relative]=fs.readFileSync(file).toString('base64');
      else out[relative]='<non-regular>';
    }
  };
  visit(root);
  return out;
}

function noProcessFixture(workspace,{twoBlocks=false}={}){
  const request=twoBlocks?'first\nsecond':'complete once';
  const acceptance=path.join(workspace,'acceptance.json');
  const acceptanceBody=twoBlocks
    ?{T001:[{type:'json',path:'completed.json',equals:{count:1}}],T002:[{type:'json',path:'completed.json',equals:{count:2}}]}
    :{T001:[{type:'json',path:'completed.json',equals:{count:1}}]};
  writeJson(acceptance,acceptanceBody);
  const coordinator=path.join(controllerRoot,'coordinator-'+path.basename(workspace));
  fs.mkdirSync(coordinator,{recursive:true});
  let spawned=0,cleanupCalls=0;
  const artifacts={};
  let cleanupImpl=()=>{};
  const hooks={
    plan:async()=>twoBlocks?[
      {title:'first',type:'single',dependsOn:[],tasks:[{prompt:'first'}]},
      {title:'second',type:'single',dependsOn:['first'],tasks:[{prompt:'second'}]},
    ]:[{title:'cleanup crash',type:'single',tasks:[{prompt:'complete once'}]}],
    compact:value=>value,
    infer:()=>[],
    prompt:value=>value,
    launcher:(key,prompt,suffix)=>{
      const attemptFile=/开始前：& '[^']+' '[^']+' '([^']+)'/.exec(prompt)?.[1];
      assert.ok(attemptFile,'fixture launcher must receive the durable attempt file');
      const launchDir=controllerWindowsDir(workspace);
      fs.mkdirSync(launchDir,{recursive:true});
      const stem=key+'-'+suffix;
      const files={
        pidf:path.join(launchDir,'window-'+stem+'.pid'),
        lp:path.join(launchDir,'win-launch-'+stem+'.ps1'),
        pf:path.join(launchDir,'agent-win-'+stem+'.md'),
        rf:path.join(launchDir,'win-'+stem+'.result.json'),
      };
      fs.writeFileSync(files.lp,'# fixture launcher');
      fs.writeFileSync(files.pf,prompt);
      artifacts[key]={...files,attemptFile};
      return files;
    },
    spawn:async()=>{spawned++;return {noProcess:true};},
    readPid:()=>0,
    identity:()=>{throw new Error('a no-process fixture must never ask for a launcher identity');},
    session:async()=> 'fixture-session',
    wait:async()=>{throw new Error('a no-process fixture must never wait for task execution');},
    exitCode:()=>0,
    register:()=>{},
    commit:()=>{},
    unregister:()=>{},
    cleanup:(...args)=>cleanupImpl(...args),
    close:async()=>{},
    waitForExit:async()=>true,
  };
  return {
    request,acceptance,coordinator,hooks,artifacts,
    get spawned(){return spawned;},
    get cleanupCalls(){return cleanupCalls;},
    recordCleanup(){cleanupCalls++;},
    setCleanup(fn){cleanupImpl=fn;},
  };
}

async function createPendingCleanup(workspace,runId,{twoBlocks=false}={}){
  const fixture=noProcessFixture(workspace,{twoBlocks});
  fixture.setCleanup(()=>{
    fixture.recordCleanup();
    throw new Error('synthetic artifact cleanup interruption');
  });
  const sum=await runWindows(fixture.request,fixture.hooks,{
    workspace,capacity:twoBlocks?2:1,runId,acceptanceFile:fixture.acceptance,
    coordinator:fixture.coordinator,auth:'test',maxAttempts:1,
  });
  const entry=sum.results.B1,attempt=entry?.attempts?.at(-1);
  assert.equal(entry?.status,'cleanup-pending',JSON.stringify(entry));
  assert.ok(attempt?.file,'fixture must retain a durable attempt record');
  assert.equal(fixture.cleanupCalls,1,'the fixture must stop after the first artifact cleanup attempt');
  return {fixture,sum,entry,attempt};
}

function markerState(workspace,runId,fixture,summary){
  const entry=summary.results.B1,attempt=entry.attempts.at(-1);
  const binding={
    runId,blockKey:'B1',attempt:attempt.number,token:attempt.token,
    attemptFile:path.resolve(attempt.file),coordinator:path.resolve(fixture.coordinator),
    lease:entry.noProcessProof.lease,
  };
  const marker=readCleanupTransactionMarkerForRecovery({workspace,binding});
  assert.ok(marker,'the controller marker must exist for a retained cleanup');
  return {entry,attempt,binding,marker,markerBinding:{...binding,status:marker.status}};
}

// Construct the valid controller boundary that exists after the transaction
// marker and workspace journals were published, but before a phase fence was
// written.  The fixture's initial hook failure intentionally leaves a real
// in-flight fence; recovery tests that exercise ordinary pending-prefix repair
// need this earlier crash boundary instead.
function restoreMarkerToPendingPrefix(workspace,state){
 const file=cleanupTransactionMarkerFile({workspace,binding:state.markerBinding});
 const raw=readJson(file),journal=structuredClone(state.entry.cleanupPending);
 raw.journal=journal;raw.updatedAt=journal.updatedAt;raw.state='active';
 writeJson(file,raw);
 return readCleanupTransactionMarkerForRecovery({workspace,binding:state.binding});
}

test('controller marker ahead of all three journals repairs before resume and never replays the completed phase',async()=>{
  const workspace=fs.mkdtempSync(path.join(family,'marker-ahead-'));
  try{
    const runId='marker-ahead';
    const {fixture,sum,attempt}=await createPendingCleanup(workspace,runId);
    const persistedSummary=readJson(path.join(runDirectory(workspace,runId),'summary.json'));
    const state=markerState(workspace,runId,fixture,persistedSummary);
    assert.ok(restoreMarkerToPendingPrefix(workspace,state));
    assert.deepEqual(state.entry.cleanupPending.phases,{lease:'done',registry:'done',artifacts:'pending'});
    assert.deepEqual(readJson(attempt.file).cleanupPending.phases,state.entry.cleanupPending.phases);

    // Simulate the exact crash boundary after the artifact side effect and
    // controller marker advance, before either workspace journal is replaced.
    fixture.setCleanup(()=>fixture.recordCleanup());
    beginCleanupTransactionMarkerPhase({workspace,binding:state.markerBinding,phase:'artifacts'});
    fixture.hooks.cleanup(state.entry.launcherFiles);
    const advanced=updateCleanupTransactionMarker({workspace,binding:state.markerBinding,phase:'artifacts'});
    assert.equal(advanced.state,'finalizing');
    assert.deepEqual(advanced.journal.phases,{lease:'done',registry:'done',artifacts:'done'});

    // Without the controller marker, the three mutually consistent journal
    // mirrors pass ordinary recovery validation. The marker is what upgrades
    // that legal prefix to its one newer controller-authorized phase.
    const markerFile=cleanupTransactionMarkerFile({workspace,binding:state.markerBinding});
    const heldMarker=markerFile+'.held-for-validator-check';
    fs.renameSync(markerFile,heldMarker);
    try{
      assert.throws(()=>preflightResumeLedger(workspace,runId),/controller marker is missing.*reconcile/i);
      assert.doesNotThrow(()=>validateRecoverySummary(readJson(path.join(runDirectory(workspace,runId),'summary.json'))));
    }finally{fs.renameSync(heldMarker,markerFile);}

    assert.equal(preflightResumeLedger(workspace,runId).cleanupPublicationRecovery,true);
    const spawnedBeforeResume=fixture.spawned,cleanupBeforeResume=fixture.cleanupCalls;
    const resumed=await runWindows('',fixture.hooks,{
      workspace,capacity:1,runId,acceptanceFile:fixture.acceptance,
      coordinator:fixture.coordinator,auth:'test',maxAttempts:1,resume:true,
    });
    assert.equal(fixture.spawned,spawnedBeforeResume,'mirror repair must finish before any ordinary launcher scheduling');
    assert.equal(fixture.cleanupCalls,cleanupBeforeResume,'the controller marker must prevent replay of the artifact phase it already recorded');
    assert.notEqual(resumed.results.B1.status,'cleanup-pending');
  }finally{fs.rmSync(workspace,{recursive:true,force:true});}
});

test('a marker-only cleanup state repairs its journals before resume and cannot enter ordinary scheduling',async()=>{
  const workspace=fs.mkdtempSync(path.join(family,'marker-only-'));
  try{
    const runId='marker-only';
    const {fixture,attempt}=await createPendingCleanup(workspace,runId);
    const dir=runDirectory(workspace,runId),summaryFile=path.join(dir,'summary.json');
    const saved=readJson(summaryFile),state=markerState(workspace,runId,fixture,saved);
    assert.ok(restoreMarkerToPendingPrefix(workspace,state));

    // Simulate a controller marker that became durable before either journal
    // mirror. Re-publish this synthetic source snapshot so the marker and the
    // controller status authority remain a valid crash boundary, rather than
    // an unauthenticated workspace edit.
    delete saved.results.B1.cleanupPending;
    delete saved.results.B1.attempts.at(-1).cleanupPending;
    const disk=readJson(attempt.file);
    delete disk.cleanupPending;
    writeJson(attempt.file,disk);
    createStatusPublisher(dir).publish(saved,'test.marker-only-crash');
    const markerOnlySummary=readJson(summaryFile);
    const current=markerState(workspace,runId,fixture,markerOnlySummary);
    const statusAuthority=createCleanupStatusAuthorityBinding({
      workspace,runId,source:markerOnlySummary,target:markerOnlySummary,
    });
    updateCleanupTransactionStatusAuthority({workspace,binding:current.markerBinding,statusAuthority});

    assert.equal(markerOnlySummary.results.B1.cleanupPending,undefined);
    assert.equal(readJson(attempt.file).cleanupPending,undefined);
    const beforePreflight={workspace:treeSnapshot(dir),controller:treeSnapshot(controllerRoot)};
    assert.equal(preflightResumeLedger(workspace,runId).cleanupPublicationRecovery,true);
    assert.deepEqual({workspace:treeSnapshot(dir),controller:treeSnapshot(controllerRoot)},beforePreflight,'preflight must remain read-only for marker-only recovery');

    fixture.setCleanup(()=>fixture.recordCleanup());
    const spawnedBeforeResume=fixture.spawned;
    const resumed=await runWindows('',fixture.hooks,{
      workspace,capacity:1,runId,acceptanceFile:fixture.acceptance,
      coordinator:fixture.coordinator,auth:'test',maxAttempts:1,resume:true,
    });
    assert.equal(fixture.spawned,spawnedBeforeResume,'marker-only recovery must not launch a replacement task before repairing its journals');
    assert.equal(fixture.cleanupCalls,2,'only the single pending artifact cleanup phase may run after marker-only repair');
    assert.notEqual(resumed.results.B1.status,'cleanup-pending');
  }finally{fs.rmSync(workspace,{recursive:true,force:true});}
});

test('a marker never authorizes writes when a different block has damaged task results',async()=>{
  const workspace=fs.mkdtempSync(path.join(family,'marker-other-block-corrupt-'));
  try{
    const runId='marker-other-block-corrupt';
    const {fixture}=await createPendingCleanup(workspace,runId,{twoBlocks:true});
    const dir=runDirectory(workspace,runId),summaryFile=path.join(dir,'summary.json');
    const saved=readJson(summaryFile),state=markerState(workspace,runId,fixture,saved);
    assert.ok(restoreMarkerToPendingPrefix(workspace,state));

    // B1's marker is a legal recovery authority only for B1's cleanup
    // prefix. It cannot make a damaged, independent B2 task ledger writable.
    delete saved.taskResults.T002;
    writeJson(summaryFile,saved);
    const before={workspace:treeSnapshot(dir),controller:treeSnapshot(controllerRoot),spawned:fixture.spawned};
    assert.throws(()=>preflightResumeLedger(workspace,runId),/result inventory mismatch|todo list status mismatch/i);
    assert.deepEqual({workspace:treeSnapshot(dir),controller:treeSnapshot(controllerRoot),spawned:fixture.spawned},before,'preflight must not repair any marker mirror when another block is invalid');
    await assert.rejects(
      ()=>runWindows('',fixture.hooks,{
        workspace,capacity:2,runId,acceptanceFile:fixture.acceptance,
        coordinator:fixture.coordinator,auth:'test',maxAttempts:1,resume:true,
      }),
      /result inventory mismatch|todo list status mismatch/i,
    );
    assert.deepEqual({workspace:treeSnapshot(dir),controller:treeSnapshot(controllerRoot),spawned:fixture.spawned},before,'resume must reject the full invalid ledger before any marker repair or scheduling write');
  }finally{fs.rmSync(workspace,{recursive:true,force:true});}
});
