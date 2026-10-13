import {testTempFamily} from './test-temp-root.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import {createStatusPublisher} from '../scripts/core/status-events.mjs';

const repo=fileURLToPath(new URL('..',import.meta.url));
const explicitCli = process.env.ORCH_CLI || (process.platform === 'win32' ? String(spawnSync(`${process.env.SystemRoot || 'C:\\Windows'}\\System32\\where.exe`, ['codex.exe'], {encoding:'utf8',windowsHide:true}).stdout || '').split(/\r?\n/).map(s=>s.trim()).find(Boolean) || '' : '');
const cliEnv=explicitCli?{ORCH_CLI:explicitCli}:{};
function runFixture(t){
 const family=testTempFamily('status-entry');fs.mkdirSync(family,{recursive:true});
 const workspace=fs.mkdtempSync(path.join(family,'tasks-entry-'));
 const previousControllerRoot=process.env.ORCH_CONTROLLER_ROOT;
 const controllerRoot=fs.mkdtempSync(path.join(family,'tasks-entry-controller-'));
 process.env.ORCH_CONTROLLER_ROOT=controllerRoot;
 t.after(()=>{fs.rmSync(workspace,{recursive:true,force:true});fs.rmSync(controllerRoot,{recursive:true,force:true});if(previousControllerRoot===undefined)delete process.env.ORCH_CONTROLLER_ROOT;else process.env.ORCH_CONTROLLER_ROOT=previousControllerRoot;});
 const runs=path.join(workspace,'temp','orchestrator','runs');
 for(const [runId,prompt,mtime] of [['older','old task',1000],['newer','new task',2000]]){
  const dir=path.join(runs,runId);fs.mkdirSync(dir,{recursive:true});
  const file=path.join(dir,'summary.json');
  // Publish through the controller so readers can verify the authority
  // digest; a hand-written summary must never count as authenticated state.
  createStatusPublisher(dir).publish({runId,workspace,tasks:[{id:'T001',prompt}],blocks:[{key:'B1',title:'work',taskIds:['T001']}],results:{B1:{status:'verified',attempts:[{number:1}]}},taskResults:{T001:{status:'verified'}},success:true,finishedAt:1},'fixture.finished');
  fs.utimesSync(file,new Date(mtime*1000),new Date(mtime*1000));
 }
 return workspace;
}
test('public SDK status dispatch returns an actual read-only status, not usage',t=>{
 const file=fileURLToPath(new URL('../scripts/orchestrate-sdk.mjs',import.meta.url));
  const workspace=fs.mkdtempSync(path.join(testTempFamily('status-entry'),'status-entry-'));
  const controllerRoot=fs.mkdtempSync(path.join(testTempFamily('status-entry'),'status-entry-controller-'));
  t.after(()=>{fs.rmSync(workspace,{recursive:true,force:true});fs.rmSync(controllerRoot,{recursive:true,force:true});});
  const env={...process.env,...cliEnv,ORCH_ALLOW_UNVERIFIED_NPM:'1',ORCH_ALLOW_UNVERIFIED_CLI:'1',ORCH_AGENT:'codex',WORKSPACE_DIR:workspace,ORCH_STATE_DIR:path.join(workspace,'temp','orchestrator'),ORCH_CONTROLLER_ROOT:controllerRoot,ORCH_RUN_ID:''};
  for(const key of ['CODEX_THREAD_ID','CODEX_SESSION_ID','ORCH_ACCEPTANCE_FILE','ORCH_ISOLATED_ACCEPTANCE','ORCH_ISOLATED_ABORT_TOKEN'])delete env[key];
  const result=spawnSync(process.execPath,[file,'--status','--readonly'],{cwd:workspace,env,encoding:'utf8',windowsHide:true,timeout:20000});
 assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/=== alive agent TUI windows ===/);assert.doesNotMatch(result.stdout,/Usage:/);
});

test('tasks status selects the most recently updated run and supports JSON',t=>{
 const workspace=runFixture(t);
 const file=fileURLToPath(new URL('../scripts/status.mjs',import.meta.url));
 const result=spawnSync(process.execPath,[file,'--json','--workspace',workspace],{env:{...process.env,...cliEnv,ORCH_ALLOW_UNVERIFIED_NPM:'1',ORCH_ALLOW_UNVERIFIED_CLI:'1'},encoding:'utf8',windowsHide:true,timeout:20000});
 assert.equal(result.status,0,result.stderr);
 const state=JSON.parse(result.stdout);
 assert.equal(state.runId,'newer');
 assert.equal(state.todoList[0].prompt,'new task');
 assert.equal(state.executionStatus[0].status,'verified');
});

test('tasks status reports an empty workspace without inventing a run',t=>{
 const workspace=fs.mkdtempSync(path.join(testTempFamily('status-entry'),'tasks-empty-'));
 t.after(()=>fs.rmSync(workspace,{recursive:true,force:true}));
 const file=fileURLToPath(new URL('../scripts/status.mjs',import.meta.url));
 const result=spawnSync(process.execPath,[file,'--json','--workspace',workspace],{env:{...process.env,...cliEnv,ORCH_ALLOW_UNVERIFIED_NPM:'1',ORCH_ALLOW_UNVERIFIED_CLI:'1'},encoding:'utf8',windowsHide:true,timeout:20000});
 assert.equal(result.status,0,result.stderr);
 const state=JSON.parse(result.stdout);
 assert.equal(state.runId,null);
 assert.deepEqual(state.todoList,[]);
 assert.deepEqual(state.executionStatus,[]);
});

test('public SDK --tasks dispatch reads the selected run',t=>{
 const workspace=runFixture(t);
 const file=fileURLToPath(new URL('../scripts/orchestrate-sdk.mjs',import.meta.url));
 const result=spawnSync(process.execPath,[file,'--tasks','--run-id','older','--json'],{
  env:{...process.env,...cliEnv,ORCH_ALLOW_UNVERIFIED_NPM:'1',ORCH_ALLOW_UNVERIFIED_CLI:'1',WORKSPACE_DIR:workspace,ORCH_RUN_ID:'',ORCH_AGENT:'codex'},encoding:'utf8',windowsHide:true,timeout:120000,
 });
 assert.equal(result.status,0,result.stderr);
 const state=JSON.parse(result.stdout);
 assert.equal(state.runId,'older');
 assert.equal(state.todoList[0].prompt,'old task');
});
