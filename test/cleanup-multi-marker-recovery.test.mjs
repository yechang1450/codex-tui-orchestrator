import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runWindows,preflightResumeLedger,runDirectory} from '../scripts/core/runner.mjs';
import {controllerWindowsDir} from '../scripts/core/controller-state.mjs';
import {cleanupTransactionMarkerFile,readCleanupTransactionMarkerForRecovery} from '../scripts/core/cleanup-transaction.mjs';

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const digest=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const family=fs.mkdtempSync(path.join(os.tmpdir(),'ctui-multi-marker-test-'));
const controllerRoot=fs.mkdtempSync(path.join(family,'controller-'));
const priorControllerRoot=process.env.ORCH_CONTROLLER_ROOT;
process.env.ORCH_CONTROLLER_ROOT=controllerRoot;
after(()=>{
  if(priorControllerRoot===undefined)delete process.env.ORCH_CONTROLLER_ROOT;
  else process.env.ORCH_CONTROLLER_ROOT=priorControllerRoot;
  fs.rmSync(family,{recursive:true,force:true});
});

function deferred(){
  let resolve,reject;
  const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
  return {promise,resolve,reject};
}

function bindingFor(workspace,coordinator,sum,key){
  const entry=sum.results[key],attempt=entry?.attempts?.at(-1);
  assert.ok(entry&&attempt,'missing durable attempt for '+key);
  return {
    runId:sum.runId,blockKey:key,attempt:attempt.number,token:attempt.token,
    attemptFile:attempt.file,coordinator,
    lease:{id:entry.leaseId,instanceId:entry.leaseInstanceId},
  };
}

function readMarker(workspace,coordinator,sum,key){
  return readCleanupTransactionMarkerForRecovery({workspace,binding:bindingFor(workspace,coordinator,sum,key)});
}

function restorePendingMarkerPrefix(workspace,coordinator,sum,key){
 const binding=bindingFor(workspace,coordinator,sum,key),marker=readCleanupTransactionMarkerForRecovery({workspace,binding});
 assert.ok(marker,'fixture must create a controller marker for '+key);
 const file=cleanupTransactionMarkerFile({workspace,binding:{...binding,status:marker.status}}),raw=JSON.parse(fs.readFileSync(file,'utf8'));
 const journal=structuredClone(sum.results[key].cleanupPending);
 raw.journal=journal;raw.updatedAt=journal.updatedAt;raw.state='active';
 fs.writeFileSync(file,JSON.stringify(raw),'utf8');
 return readCleanupTransactionMarkerForRecovery({workspace,binding});
}

test('two live cleanup markers remain authoritative while A repairs its attempt mirror and B resumes without replay',async()=>{
  const workspace=fs.mkdtempSync(path.join(family,'workspace-'));
  const runId='multi-marker-recovery';
  const coordinator=path.join(controllerRoot,'coordinator-multi-marker');
  const filesByBlock=new Map(),blockByLauncher=new Map();
  const spawns={B1:0,B2:0},unregisters={B1:0,B2:0},cleanups={B1:0,B2:0};
  let closes=0,sessions=0,waits=0,phase='initial';
  const b1ResumeArtifact=deferred(),allowB1ResumeArtifact=deferred();
  const keyFromLease=id=>String(id).endsWith('-B1')?'B1':String(id).endsWith('-B2')?'B2':null;
  const hooks={
    plan:async()=>[
      {title:'A',type:'single',tasks:[{prompt:'clean A'}]},
      {title:'B',type:'single',tasks:[{prompt:'clean B'}]},
    ],
    compact:value=>value,infer:()=>[],prompt:value=>value,
    launcher:(key,prompt,suffix,options)=>{
      const dir=controllerWindowsDir(workspace),stem=key+'-'+suffix;
      const files={lp:path.join(dir,'win-launch-'+stem+'.ps1'),pf:path.join(dir,'agent-win-'+stem+'.md'),pidf:path.join(dir,'window-'+stem+'.pid'),rf:path.join(dir,'win-'+stem+'.result.json')};
      fs.mkdirSync(dir,{recursive:true});
      fs.writeFileSync(files.lp,'# test launcher','utf8');
      fs.writeFileSync(files.pf,prompt,'utf8');
      filesByBlock.set(key,{...files,attemptFile:options.attemptFile});
      blockByLauncher.set(files.lp,key);
      return files;
    },
    spawn:async lp=>{
      const key=blockByLauncher.get(lp);
      assert.ok(key,'spawn did not receive a known launcher');
      spawns[key]++;
      return {noProcess:true};
    },
    readPid:()=>0,
    identity:()=>{throw new Error('a no-process receipt must not inspect a launcher identity');},
    register:()=>{},commit:()=>{},
    unregister:id=>{
      const key=keyFromLease(id);
      assert.ok(key,'unexpected lease '+id);
      unregisters[key]++;
    },
    cleanup:async launcher=>{
      const key=blockByLauncher.get(launcher.lp);
      assert.ok(key,'cleanup did not receive a known launcher');
      cleanups[key]++;
      if(phase==='initial')throw new Error('synthetic artifact cleanup retention');
      if(key==='B1'){
        b1ResumeArtifact.resolve();
        await allowB1ResumeArtifact.promise;
      }
    },
    close:async()=>{closes++;throw new Error('no-process cleanup must not close a launcher');},
    waitForExit:async()=>{throw new Error('no-process cleanup must not await a launcher');},
    session:async()=>{sessions++;throw new Error('no-process receipt must not discover a session');},
    wait:async()=>{waits++;throw new Error('no-process receipt must not wait for a session');},
    exitCode:()=>null,
  };
  let resumePromise;
  try{
    const first=await runWindows('clean A; clean B',hooks,{workspace,runId,capacity:2,coordinator,auth:'test',maxAttempts:1});
    assert.deepEqual(spawns,{B1:1,B2:1},'both independent cleanup transactions must have begun once');
    assert.deepEqual(unregisters,{B1:1,B2:1},'each transaction must complete registry cleanup before its retained artifact phase');
    assert.deepEqual(cleanups,{B1:1,B2:1});
    for(const key of ['B1','B2']){
      assert.equal(first.results[key].status,'cleanup-pending');
      assert.deepEqual(first.results[key].cleanupPending?.phases,{lease:'done',registry:'done',artifacts:'pending'});
      assert.equal(readMarker(workspace,coordinator,first,key)?.state,'active');
      assert.ok(restorePendingMarkerPrefix(workspace,coordinator,first,key),'fixture must retain the pre-effect pending marker for '+key);
    }

    const bMarkerBefore=readMarker(workspace,coordinator,first,'B2');
    const bTargetBefore=bMarkerBefore.statusAuthority.target.summarySha256;
    const aAttempt=first.results.B1.attempts.at(-1);
    const damaged=JSON.parse(fs.readFileSync(aAttempt.file,'utf8'));
    delete damaged.cleanupPending;
    fs.writeFileSync(aAttempt.file,JSON.stringify(damaged),'utf8');
    assert.equal(preflightResumeLedger(workspace,runId).cleanupPublicationRecovery,true,
      'only the controller marker may authorize A\'s missing attempt-side journal');
    assert.equal(JSON.parse(fs.readFileSync(aAttempt.file,'utf8')).cleanupPending,undefined,
      'preflight may discover the marker prefix but must not repair a workspace mirror');

    phase='resume';
    resumePromise=runWindows('',hooks,{workspace,runId,capacity:2,coordinator,auth:'test',maxAttempts:1,resume:true});
    await Promise.race([
      b1ResumeArtifact.promise,
      pause(15000).then(()=>{throw new Error('A did not reach its retained artifact phase during cleanup-only resume');}),
    ]);

    const during=JSON.parse(fs.readFileSync(path.join(runDirectory(workspace,runId),'summary.json'),'utf8'));
    const repairedA=JSON.parse(fs.readFileSync(aAttempt.file,'utf8'));
    assert.deepEqual(repairedA.cleanupPending?.phases,{lease:'done',registry:'done',artifacts:'pending'},
      'the controller marker must repair A\'s attempt mirror before its retained cleanup phase runs');
    const bMarkerDuring=readMarker(workspace,coordinator,during,'B2');
    assert.equal(bMarkerDuring?.state,'active','B must remain live while A repairs its mirror');
    assert.notEqual(bMarkerDuring.statusAuthority.target.summarySha256,bTargetBefore,
      'A\'s recovery status publication must advance B\'s marker authority instead of leaving it stale');
    assert.equal(bMarkerDuring.statusAuthority.target.summarySha256,digest(during),
      'B\'s live marker must bind the latest durable public summary before B resumes');
    assert.deepEqual(bMarkerDuring.journal.phases,{lease:'done',registry:'done',artifacts:'pending'},
      'A\'s repair must not replay or advance B\'s already completed cleanup phases');

    allowB1ResumeArtifact.resolve();
    const resumed=await resumePromise;
    resumePromise=null;
    assert.deepEqual(spawns,{B1:1,B2:1},'neither cleanup-only recovery may launch a replacement window');
    assert.equal(closes,0,'no-process receipts must never acquire a close side effect');
    assert.equal(sessions,0);assert.equal(waits,0);
    assert.deepEqual(unregisters,{B1:1,B2:1},'B must not replay its completed registry cleanup phase');
    assert.deepEqual(cleanups,{B1:2,B2:2},'each recovered transaction may retry only its retained artifact phase');
    for(const key of ['B1','B2']){
      assert.equal(resumed.results[key].attempts.length,1,'recovery must retain the original attempt for '+key);
      assert.equal(resumed.results[key].cleanupPending,undefined,'recovery must clear only the completed cleanup journal for '+key);
      assert.equal(readMarker(workspace,coordinator,resumed,key),null,'terminal publication must collect the finalized '+key+' marker');
    }
  }finally{
    allowB1ResumeArtifact.resolve();
    if(resumePromise){
      await Promise.race([resumePromise.catch(()=>{}),pause(15000)]);
    }
    fs.rmSync(workspace,{recursive:true,force:true});
  }
});
