import {testTempFamily} from './test-temp-root.mjs';
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import * as runner from '../scripts/core/runner.mjs';
import {recordCheckpoint} from '../scripts/core/checkpoint.mjs';
import {controllerWindowsDir} from '../scripts/core/controller-state.mjs';
import {createStatusPublisher} from '../scripts/core/status-events.mjs';
const family=testTempFamily('runner-final-sweep');fs.mkdirSync(family,{recursive:true});
const controllerRoot=fs.mkdtempSync(path.join(family,'final-sweep-controller-'));
const oldControllerRoot=process.env.ORCH_CONTROLLER_ROOT;
process.env.ORCH_CONTROLLER_ROOT=controllerRoot;
after(()=>{if(oldControllerRoot===undefined)delete process.env.ORCH_CONTROLLER_ROOT;else process.env.ORCH_CONTROLLER_ROOT=oldControllerRoot;fs.rmSync(controllerRoot,{recursive:true,force:true});});

test('the final run sweep retries owned cleanup and queues the closed block for parent inspection',async()=>{
  const workspace=fs.mkdtempSync(path.join(family,'final-sweep-'));
  fs.mkdirSync(path.join(workspace,'temp'),{recursive:true});
  const acceptance=path.join(workspace,'checks.json');
  fs.writeFileSync(acceptance,JSON.stringify({T001:[{type:'json',path:'receipt.json',equals:{answer:42}}]}),'utf8');
  let attempt,files,live=false,closes=0,spawns=0,firstCleanupRetention;
  const identity={ProcessId:9001,Name:'powershell.exe',Started:'fixture',CommandLine:'fixture'};
  const hooks={
    plan:async()=>[{title:'one',tasks:[{prompt:'执行任务'}]}],compact:p=>p,infer:()=>[],prompt:p=>p,
    launcher:(key,_prompt,suffix,options)=>{attempt=options.attemptFile;const dir=controllerWindowsDir(workspace),stem=key+'-'+suffix;return files={lp:path.join(dir,'win-launch-'+stem+'.ps1'),pf:path.join(dir,'agent-win-'+stem+'.md'),pidf:path.join(dir,'window-'+stem+'.pid'),rf:path.join(dir,'win-'+stem+'.result.json')};},
    spawn:async()=>{spawns++;live=true;return true;},readPid:()=>9001,identity:()=>live?identity:null,
    register:()=>{},commit:()=>{},unregister:()=>{},cleanup:()=>{},close:async()=>{if(++closes===2)live=false;},waitForExit:async()=>!live,
    session:async()=>{recordCheckpoint(attempt,'T001','started');fs.writeFileSync(path.join(workspace,'receipt.json'),'{"answer":42}','utf8');recordCheckpoint(attempt,'T001','completed');return 'fixture';},
    wait:async()=>({done:true,exitCode:0}),exitCode:()=>0,
  };
  try{
    const options={workspace,runId:'final-sweep',capacity:1,acceptanceFile:acceptance,coordinator:path.join(controllerRoot,'coordinator'),authorization:{sandbox:'workspace-write',approval:'never'},onEvent:event=>{
      if(event.type==='block.B1.needs-reconciliation'&&!firstCleanupRetention){
        const liveSummary=JSON.parse(fs.readFileSync(path.join(runner.runDirectory(workspace,'final-sweep'),'summary.json'),'utf8'));
        firstCleanupRetention={entry:liveSummary.results.B1,attempt:JSON.parse(fs.readFileSync(attempt,'utf8'))};
      }
    }};
    const sum=await runner.runWindows('执行任务',hooks,options);
    assert.deepEqual(sum.authorization,options.authorization);
    await assert.rejects(runner.runWindows('',hooks,{...options,resume:true,authorization:{sandbox:'danger-full-access',approval:'never'}}),/authorization policy mismatch/i);
    assert.equal(closes,2);assert.equal(live,false);assert.equal(sum.success,true);
    assert.ok(firstCleanupRetention,'the first authenticated cleanup miss must be durably recorded before final sweep retries');
    assert.equal(firstCleanupRetention.entry.status,'needs-reconciliation');
    assert.equal(firstCleanupRetention.entry.exitConfirmed,false);
    assert.ok(firstCleanupRetention.entry.exitUnprovenAt,'the summary must retain exit uncertainty before the retry');
    assert.equal(firstCleanupRetention.attempt.exitUnprovenAt,firstCleanupRetention.entry.exitUnprovenAt,'the restart authority must retain the same uncertainty marker');
    const resolvedAttempt=JSON.parse(fs.readFileSync(attempt,'utf8'));
    assert.ok(sum.results.B1.exitUnprovenAt,'the retained marker remains as audit evidence after the permitted retry');
    assert.equal(resolvedAttempt.exitUnprovenAt,sum.results.B1.exitUnprovenAt);
    assert.equal(sum.results.B1.exitConfirmed,true);
    assert.equal(resolvedAttempt.exitConfirmed,true);
    assert.equal(sum.results.B1.exitEvidence?.token,resolvedAttempt.exitEvidence?.token);
    assert.equal(sum.results.B1.exitEvidence?.pid,resolvedAttempt.exitEvidence?.pid);
    assert.equal(sum.finalSweep.closed,1);assert.equal(sum.finalSweep.failed,0);
    assert.equal(sum.verification.maxConcurrency,1);
    const reports=fs.readFileSync(path.join(runner.runDirectory(workspace,'final-sweep'),'verification-report.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(reports.length,1);assert.equal(reports[0].status,'verified');
    const ledgerFile=path.join(runner.runDirectory(workspace,'final-sweep'),'summary.json');
    const originalLedger=fs.readFileSync(ledgerFile,'utf8');
    const unresolved=JSON.parse(originalLedger);
    unresolved.results.B1.status='needs-reconciliation';unresolved.results.B1.exitConfirmed=false;
    // The public summary is the durable state that may survive even when an
    // attempt-side atomic publication is interrupted.  Resume must respect
    // this marker alone; otherwise a late external hook could still create a
    // launcher after a restarted controller has replayed the block.
    unresolved.results.B1.exitUnprovenAt=Date.now();
    delete unresolved.results.B1.attempts.at(-1).exitUnprovenAt;
    createStatusPublisher(runner.runDirectory(workspace,'final-sweep')).publish(unresolved,'test.unresolved-launcher');
    const spawnsBeforeRetainedResume=spawns;
    await assert.rejects(runner.runWindows('',hooks,{...options,resume:true}),/Launcher exit remains unproven|reconcile.*saved run/i);
    assert.equal(spawns,spawnsBeforeRetainedResume,'a new controller must not replay a marker-retained block');
    // Rechecking task output may reconcile a started checkpoint only after
    // the owned launcher exit is independently proven.  A summary-level
    // marker is sufficient to block both the ordinary and explicit
    // acceptance-override paths; neither may rewrite a retained run.
    const retainedLedger=fs.readFileSync(ledgerFile,'utf8');
    const retainedEvents=fs.readFileSync(path.join(runner.runDirectory(workspace,'final-sweep'),'events.jsonl'),'utf8');
    const retainedGoal=fs.readFileSync(path.join(runner.runDirectory(workspace,'final-sweep'),'goal.json'),'utf8');
    assert.throws(()=>runner.verifyRun(workspace,'final-sweep',acceptance,{coordinator:options.coordinator}),/Launcher exit remains unproven|reconcile.*saved run/i);
    assert.throws(()=>runner.verifyRun(workspace,'final-sweep',acceptance,{coordinator:options.coordinator,override:true}),/Launcher exit remains unproven|reconcile.*saved run/i);
    assert.equal(fs.readFileSync(ledgerFile,'utf8'),retainedLedger,'verification must not rewrite an exit-unproven summary');
    assert.equal(fs.readFileSync(path.join(runner.runDirectory(workspace,'final-sweep'),'events.jsonl'),'utf8'),retainedEvents,'verification must not append status events for a retained launcher');
    assert.equal(fs.readFileSync(path.join(runner.runDirectory(workspace,'final-sweep'),'goal.json'),'utf8'),retainedGoal,'verification must not rewrite the local goal mirror for a retained launcher');
    // A persisted exit-unproven marker is an unresolved safety condition even
    // if a damaged/legacy summary also claims exitConfirmed.  Verification
    // must fail closed instead of treating the contradictory flag as proof.
    const contradictory=JSON.parse(retainedLedger);
    contradictory.results.B1.exitConfirmed=true;
    contradictory.results.B1.attempts.at(-1).exitConfirmed=false;
    delete contradictory.results.B1.attempts.at(-1).exitEvidence;
    createStatusPublisher(runner.runDirectory(workspace,'final-sweep')).publish(contradictory,'test.contradictory-exit-proof');
    const contradictoryLedger=fs.readFileSync(ledgerFile,'utf8');
    const contradictoryEvents=fs.readFileSync(path.join(runner.runDirectory(workspace,'final-sweep'),'events.jsonl'),'utf8');
    const contradictoryGoal=fs.readFileSync(path.join(runner.runDirectory(workspace,'final-sweep'),'goal.json'),'utf8');
    assert.throws(()=>runner.verifyRun(workspace,'final-sweep',acceptance,{coordinator:options.coordinator,override:true}),/Launcher exit remains unproven|reconcile.*verification/i);
    assert.equal(fs.readFileSync(ledgerFile,'utf8'),contradictoryLedger);
    assert.equal(fs.readFileSync(path.join(runner.runDirectory(workspace,'final-sweep'),'events.jsonl'),'utf8'),contradictoryEvents);
    assert.equal(fs.readFileSync(path.join(runner.runDirectory(workspace,'final-sweep'),'goal.json'),'utf8'),contradictoryGoal);
    createStatusPublisher(runner.runDirectory(workspace,'final-sweep')).publish(JSON.parse(originalLedger),'test.restore-authority');
    const forgedStatus=JSON.parse(originalLedger);forgedStatus.reason='workspace-forged';
    fs.writeFileSync(ledgerFile,JSON.stringify(forgedStatus),'utf8');
    await assert.rejects(runner.runWindows('',hooks,{...options,resume:true}),/status authority|authority mismatch/i);
    fs.writeFileSync(ledgerFile,originalLedger,'utf8');
    const poisoned=JSON.parse(fs.readFileSync(ledgerFile,'utf8'));
    const redirected=path.join(family,'redirected-coordinator-'+path.basename(workspace));
    poisoned.coordinator=redirected;
    fs.writeFileSync(ledgerFile,JSON.stringify(poisoned),'utf8');
    assert.throws(()=>runner.verifyRun(workspace,'final-sweep',acceptance,{coordinator:options.coordinator}),/coordinator.*mismatch|untrusted coordinator|status ledger authority/i);
    await assert.rejects(runner.runWindows('',hooks,{...options,resume:true}),/coordinator.*mismatch|untrusted coordinator|status ledger authority/i);
    assert.equal(fs.existsSync(redirected),false,'rejected coordinator must receive no files');
  }finally{fs.rmSync(workspace,{recursive:true,force:true});}
});

test('final cleanup refuses missing or mismatched run identities and never calls close',async()=>{
  let calls=0;
  const leaseId='ours-B1-lease',leaseInstanceId='11111111-1111-4111-8111-111111111111';
  const summary={runId:'ours',workspace:testTempFamily('runner-final-sweep'),blocks:[{key:'B1',taskIds:['T001']}],results:{B1:{status:'failed',launcher:{ProcessId:1},leaseId,leaseInstanceId,attempts:[{runId:'other',token:'other',taskIds:['T001'],leaseId,leaseInstanceId}]}}};
  const retained=[];
  const result=await runner.sweepRunProcesses(summary,{close:async()=>calls++,waitForExit:async()=>false,identify:()=>null,onRetained:async(_block,entry,attempt)=>retained.push({entry,attempt})});
  assert.equal(calls,0);assert.deepEqual(result,{checked:1,closed:0,failed:0,retained:1});
  assert.equal(summary.results.B1.status,'needs-reconciliation');assert.equal(summary.results.B1.exitConfirmed,false);
  assert.ok(summary.results.B1.exitUnprovenAt);assert.equal(summary.results.B1.attempts[0].exitUnprovenAt,summary.results.B1.exitUnprovenAt);
  assert.equal(retained.length,1);assert.match(summary.results.B1.reason,/could not prove launcher exit/i);
});

test('final sweep cannot accept an exited saved identity while the bound launcher is live',async()=>{
  const workspace=fs.mkdtempSync(path.join(family,'forged-sweep-'));
  try{
    const runId='identity',token='identity-B1-a1-token',dir=controllerWindowsDir(workspace),stem='B1-identity-a1';
    const leaseId='identity-B1-lease',leaseInstanceId='22222222-2222-4222-8222-222222222222';
    fs.mkdirSync(dir,{recursive:true});
    const files={lp:path.join(dir,'win-launch-'+stem+'.ps1'),pf:path.join(dir,'agent-win-'+stem+'.md'),
      pidf:path.join(dir,'window-'+stem+'.pid'),rf:path.join(dir,'win-'+stem+'.result.json')};
    fs.writeFileSync(files.lp,`$token = '${token}'`,'utf8');
    fs.writeFileSync(files.pf,'__ORCH_DONE__ '+token,'utf8');
    fs.writeFileSync(files.pidf,'9001','utf8');
    const actual={ProcessId:9001,Name:'powershell.exe',Started:'active',CommandLine:'active launcher'};
    const forged={ProcessId:9002,Name:'powershell.exe',Started:'exited',CommandLine:'other launcher'};
    const attempt={runId,token,number:1,taskIds:['T001'],leaseId,leaseInstanceId,
      file:path.join(workspace,'temp','orchestrator','runs',runId,'attempts','B1','1','attempt.json')};
    const entry={status:'failed',token,leaseId,leaseInstanceId,attempts:[attempt],launcherFiles:files,launcher:forged};
    const summary={runId,workspace,blocks:[{key:'B1',taskIds:['T001']}],results:{B1:entry}};
    let closes=0;
    const retained=[];
    const stats=await runner.sweepRunProcesses(summary,{identify:pid=>pid===9001?actual:null,
      close:async()=>{closes++;},waitForExit:async expected=>expected.ProcessId===9002,
      onRetained:async(_block,value,attemptValue)=>retained.push({value,attemptValue})});
    assert.equal(closes,0);
    assert.deepEqual(stats,{checked:1,closed:0,failed:0,retained:1});
    assert.equal(entry.status,'needs-reconciliation');assert.equal(entry.exitConfirmed,false);
    assert.ok(entry.exitUnprovenAt);assert.equal(attempt.exitUnprovenAt,entry.exitUnprovenAt);
    assert.equal(retained.length,1);assert.match(entry.reason,/could not prove launcher exit/i);
  }finally{fs.rmSync(workspace,{recursive:true,force:true});}
});

test('a retained launcher marker has no cleanup retry outside its issuing controller',async()=>{
  const token='retained-token',attempt={runId:'retained',token,number:1,taskIds:['T001'],file:path.join(family,'retained-attempt.json'),
    exitUnprovenAt:123,exitConfirmed:false};
  const entry={status:'needs-reconciliation',token,exitConfirmed:false,exitUnprovenAt:123,attempts:[attempt],
    launcherFiles:{mode:'visible',lp:path.join(family,'retained.ps1'),pf:path.join(family,'retained.md'),pidf:path.join(family,'retained.pid'),rf:path.join(family,'retained.json')}};
  const summary={runId:'retained',workspace:family,blocks:[{key:'B1',taskIds:['T001']}],results:{B1:entry}};
  let identifies=0,closes=0,waits=0,permits=0;
  const stats=await runner.sweepRunProcesses(summary,{identify:()=>{identifies++;return null;},close:async()=>{closes++;},waitForExit:async()=>{waits++;return true;},
    consumeExitRetryPermit:()=>{permits++;return false;}});
  assert.deepEqual(stats,{checked:1,closed:0,failed:0,retained:1});
  assert.deepEqual({identifies,closes,waits,permits},{identifies:0,closes:0,waits:0,permits:1});
  assert.equal(entry.exitUnprovenAt,123);assert.equal(attempt.exitUnprovenAt,123);
});

test('final sweep retains rather than fails when close or exit proof throws',async()=>{
  for(const phase of ['wait','close']){
    const workspace=fs.mkdtempSync(path.join(family,'sweep-'+phase+'-throw-'));
    try{
      const runId='sweep-'+phase,token=runId+'-B1-token',dir=controllerWindowsDir(workspace),stem='B1-'+runId+'-a1';
      const leaseId=runId+'-B1-lease',leaseInstanceId=phase==='wait'?'33333333-3333-4333-8333-333333333333':'44444444-4444-4444-8444-444444444444';
      const files={lp:path.join(dir,'win-launch-'+stem+'.ps1'),pf:path.join(dir,'agent-win-'+stem+'.md'),pidf:path.join(dir,'window-'+stem+'.pid'),rf:path.join(dir,'win-'+stem+'.result.json')};
      fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(files.lp,`$token = '${token}'`);fs.writeFileSync(files.pf,'__ORCH_DONE__ '+token);fs.writeFileSync(files.pidf,'9601');
      const identity={ProcessId:9601,Name:'powershell.exe',Started:'sweep-'+phase,commandLineSha256:'b'.repeat(64)};
      const attempt={runId,token,number:1,taskIds:['T001'],leaseId,leaseInstanceId,file:path.join(workspace,'temp','orchestrator','runs',runId,'attempts','B1','1','attempt.json')};
      const entry={status:'failed',token,leaseId,leaseInstanceId,attempts:[attempt],launcherFiles:files,launcher:identity};
      const summary={runId,workspace,agent:'codex',blocks:[{key:'B1',taskIds:['T001']}],results:{B1:entry}};
      let closes=0,failed=0,retained=0;
      const stats=await runner.sweepRunProcesses(summary,{identify:()=>identity,
        waitForExit:async()=>{if(phase==='wait')throw new Error('synthetic wait failure');return false;},
        close:async()=>{closes++;if(phase==='close')throw new Error('synthetic close failure');},
        onFailed:()=>{failed++;},onRetained:async()=>{retained++;}});
      assert.deepEqual(stats,{checked:1,closed:0,failed:0,retained:1},phase);
      assert.equal(entry.status,'needs-reconciliation');assert.equal(entry.exitConfirmed,false);assert.ok(entry.exitUnprovenAt);
      assert.equal(attempt.exitUnprovenAt,entry.exitUnprovenAt);assert.equal(failed,0);assert.equal(retained,1);
      assert.equal(closes,phase==='close'?1:0);
    }finally{fs.rmSync(workspace,{recursive:true,force:true});}
  }
});

test('final sweep spends one cleanup deadline and retains later unresolved attempts',async()=>{
  const workspace=fs.mkdtempSync(path.join(family,'final-sweep-deadline-'));
  const runId='cleanup-deadline';
  fs.mkdirSync(path.join(workspace,'temp','orchestrator','runs',runId),{recursive:true});
  const windowDir=controllerWindowsDir(workspace);
  const identity=pid=>({ProcessId:pid,Name:'powershell.exe',Started:'cleanup-deadline',commandLineSha256:'a'.repeat(64)});
  const entryFor=(key,pid)=>{
    const token=runId+'-'+key+'-token';
    const suffix=key+'-'+runId+'-a1';
    const leaseId=runId+'-'+key+'-lease',leaseInstanceId=key==='B1'?'55555555-5555-4555-8555-555555555555':'66666666-6666-4666-8666-666666666666';
    const attempt={runId,token,number:1,taskIds:[key==='B1'?'T001':'T002'],leaseId,leaseInstanceId,file:path.join(workspace,'temp','orchestrator','runs',runId,'attempts',key,'1','attempt.json')};
    return {status:'failed',token,leaseId,leaseInstanceId,attempts:[attempt],launcherFiles:{lp:path.join(windowDir,'win-launch-'+suffix+'.ps1'),pf:path.join(windowDir,'agent-win-'+suffix+'.md'),pidf:path.join(windowDir,'window-'+suffix+'.pid'),rf:path.join(windowDir,'win-'+suffix+'.result.json')},launcher:identity(pid)};
  };
  const first=entryFor('B1',9101),second=entryFor('B2',9102);
  const summary={runId,workspace,agent:'codex',blocks:[{key:'B1',taskIds:['T001']},{key:'B2',taskIds:['T002']}],results:{B1:first,B2:second}};
  const cleanupDeadlineAt=10_100;
  let now=10_000;
  const waits=[],closed=[],retained=[];
  const hookDeadline=value=>typeof value==='number'?value:value?.deadlineAt;
  try{
    const stats=await runner.sweepRunProcesses(summary,{cleanupDeadlineAt,now:()=>now,
      identify:pid=>identity(pid),
      waitForExit:async(expected,deadline)=>{
        waits.push({pid:expected.ProcessId,deadlineAt:hookDeadline(deadline)});
        const callsForPid=waits.filter(call=>call.pid===expected.ProcessId).length;
        if(expected.ProcessId===9101&&callsForPid===1)return false;
        if(expected.ProcessId===9101&&callsForPid===2)now=cleanupDeadlineAt;
        return true;
      },
      close:async(pid,_expected,deadline)=>{closed.push({pid,deadlineAt:hookDeadline(deadline)});},
      onClosed:async block=>{closed.push({block:block.key});},
      onRetained:async(block,entry,attempt,detail)=>{retained.push({block:block.key,entryAt:entry.exitUnprovenAt,attemptAt:attempt?.exitUnprovenAt,reason:detail.reason});},
    });
    assert.deepEqual({waits,closed},{
      waits:[{pid:9101,deadlineAt:cleanupDeadlineAt},{pid:9101,deadlineAt:cleanupDeadlineAt}],
      closed:[{pid:9101,deadlineAt:cleanupDeadlineAt},{block:'B1'}],
    },'cleanup hooks must receive the one shared deadline and no later launcher may start cleanup after it expires');
    assert.deepEqual(stats,{checked:2,closed:1,failed:0,retained:1});
    assert.equal(first.exitConfirmed,true);
    assert.equal(second.status,'needs-reconciliation');
    assert.equal(second.exitConfirmed,false);
    assert.ok(second.exitUnprovenAt,'the later attempt needs durable reconciliation evidence');
    assert.ok(second.launcherFiles,'the later attempt artifacts must remain available for recovery');
    assert.equal(retained.length,1,'a newly retained cleanup record must be offered to the durable caller before sweep returns');
    assert.equal(retained[0].block,'B2');
    assert.equal(retained[0].entryAt,second.exitUnprovenAt);
    assert.equal(retained[0].attemptAt,second.attempts.at(-1).exitUnprovenAt);
    assert.match(retained[0].reason,/deadline expired/i);
  }finally{fs.rmSync(workspace,{recursive:true,force:true});}
});
