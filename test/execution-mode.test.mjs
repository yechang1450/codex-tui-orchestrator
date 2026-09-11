import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as modes from '../scripts/core/execution-mode.mjs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('execution defaults to headless while explicit window commands override caller defaults',()=>{
  assert.equal(modes.resolveExecutionMode('--run',{}),'headless');
  assert.equal(modes.resolveExecutionMode('',{}),'headless');
  assert.equal(modes.resolveExecutionMode('--run',{ORCH_EXEC_MODE:'visible'}),'visible');
  assert.equal(modes.resolveExecutionMode('--run-windows',{ORCH_EXEC_MODE:'headless'}),'visible');
  assert.equal(modes.resolveExecutionMode('--visible',{}),'visible');
  assert.equal(modes.resolveExecutionMode('--exec',{ORCH_EXEC_MODE:'visible'}),'headless');
  assert.equal(modes.resolveExecutionMode('--headless',{ORCH_EXEC_MODE:'visible'}),'headless');
});

test('doctor reports windowless execution without probing a terminal and preserves explicit visible diagnostics',()=>{
  const entry=fileURLToPath(new URL('../scripts/core/orchestrate-sdk.mjs',import.meta.url));
  for(const mode of ['headless','visible']){
    const result=spawnSync(process.execPath,[entry,'--doctor'],{encoding:'utf8',windowsHide:true,env:{...process.env,ORCH_AGENT:'codex',ORCH_EXEC_MODE:mode}});
    assert.equal(result.status,0,result.stderr);
    const start=result.stdout.indexOf('{'),doctor=JSON.parse(result.stdout.slice(start));
    assert.equal(doctor.executionMode,mode);
    if(mode==='headless'){assert.equal(doctor.terminal,null);assert.equal(doctor.args[0],'exec');assert.equal(doctor.interactiveOutput,'jsonl');}
    else assert.ok(['wt','conhost'].includes(doctor.terminal));
  }
});

test('resume retains the saved executor including legacy visible runs instead of applying a new default',()=>{
  assert.equal(modes.resolveExecutionMode('--resume-run',{},'visible'),'visible');
  assert.equal(modes.resolveExecutionMode('--resume-run',{ORCH_EXEC_MODE:'visible'},'headless'),'headless');
  assert.equal(modes.resolveExecutionMode('--resume-run',{}),'visible');
  assert.throws(()=>modes.resolveExecutionMode('--resume-run',{},'unexpected'),/execution mode/i);
  assert.throws(()=>modes.resolveExecutionMode('--run',{ORCH_EXEC_MODE:'unexpected'}),/execution mode/i);
});

test('exec argv uses structured noninteractive output and never drops restricted sandbox or approval policy',()=>{
  const args=modes.buildExecArgs(['-a','never','--sandbox','workspace-write','--cd','C:\\tasks with spaces','-c','model_reasoning_effort=xhigh','-m','configured-model']);
  assert.deepEqual(args,['exec','--sandbox','workspace-write','--cd','C:\\tasks with spaces','-c','model_reasoning_effort=xhigh','-m','configured-model','-c','approval_policy="never"','--json','--color','never','--skip-git-repo-check']);
  assert.throws(()=>modes.buildExecArgs(['-a','on-request']),/approval/i);
});
