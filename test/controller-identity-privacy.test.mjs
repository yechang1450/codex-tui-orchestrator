import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {assertPublicExecutionIdentities} from '../scripts/core/controller-state.mjs';
import {runWindows,verifyRun} from '../scripts/core/runner.mjs';
import {providerFixtureToken} from './fixture-provider-tokens.mjs';

const secret=providerFixtureToken('openai-project');
function assertPrivateIdentity(fn){
  assert.throws(fn,error=>/SENSITIVE_RUN_IDENTITY/.test(String(error?.message))&&!String(error?.message).includes(secret));
}

test('controller identity gate rejects credential-shaped workspace, run, and controller roots without echoing them',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'orch-controller-identity-'));
  const workspace=path.join(root,'workspace');fs.mkdirSync(workspace);
  try{
    assertPrivateIdentity(()=>assertPublicExecutionIdentities({workspace:path.join(root,secret),runId:'ordinary',env:{...process.env,ORCH_CONTROLLER_ROOT:path.join(root,'controller')}}));
    assertPrivateIdentity(()=>assertPublicExecutionIdentities({workspace,runId:secret,env:{...process.env,ORCH_CONTROLLER_ROOT:path.join(root,'controller')}}));
    assertPrivateIdentity(()=>assertPublicExecutionIdentities({workspace,runId:'ordinary',env:{...process.env,ORCH_CONTROLLER_ROOT:path.join(root,secret)}}));
    assertPrivateIdentity(()=>assertPublicExecutionIdentities({workspace,runId:'ordinary',env:{...process.env,CODEX_HOME:path.join(root,secret),ORCH_CONTROLLER_ROOT:''}}));
    assertPrivateIdentity(()=>assertPublicExecutionIdentities({workspace,runId:'ordinary',env:{...process.env,ORCH_CONTROLLER_ROOT:path.join(root,'controller'),ORCH_COORDINATOR_DIR:path.join(root,secret)}}));
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('runner rejects credential-shaped durable identities before planners, ledgers, or verification reads',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'orch-runner-identity-'));
  const workspace=path.join(root,'workspace'),controller=path.join(root,'controller');fs.mkdirSync(workspace);
  const hooks={plan:async()=>{throw new Error('planner must not run');}};
  const reject=async options=>{
    await assert.rejects(()=>runWindows('ordinary request',hooks,{capacity:1,...options}),error=>/SENSITIVE_RUN_IDENTITY/.test(String(error?.message))&&!String(error?.message).includes(secret));
  };
  const oldHome=process.env.CODEX_HOME,oldRoot=process.env.ORCH_CONTROLLER_ROOT;
  try{
    await reject({workspace,runId:secret,coordinator:path.join(controller,'coordinator')});
    await reject({workspace:path.join(root,secret),runId:'ordinary',coordinator:path.join(controller,'coordinator')});
    await reject({workspace,runId:'ordinary',coordinator:path.join(controller,secret)});
    process.env.CODEX_HOME=path.join(root,secret);delete process.env.ORCH_CONTROLLER_ROOT;
    await reject({workspace,runId:'ordinary'});
    assertPrivateIdentity(()=>verifyRun(workspace,secret));
    assert.equal(fs.existsSync(controller),false,'identity rejection must happen before controller state is created');
  }finally{
    if(oldHome===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=oldHome;
    if(oldRoot===undefined)delete process.env.ORCH_CONTROLLER_ROOT;else process.env.ORCH_CONTROLLER_ROOT=oldRoot;
    fs.rmSync(root,{recursive:true,force:true});
  }
});

test('CLI executes its identity gate before isolated acceptance prepares proof files',()=>{
  const file=fileURLToPath(new URL('../scripts/core/orchestrate-sdk.mjs',import.meta.url));
  const source=fs.readFileSync(file,'utf8');
  const guard=source.indexOf('assertPublicExecutionIdentities({workspace:WORKSPACE,runId:process.env.ORCH_RUN_ID,env:process.env})');
  const prepare=source.indexOf('prepareIsolatedAcceptance({workspace:WORKSPACE,runId:process.env.ORCH_RUN_ID,resume})');
  assert.ok(guard>=0&&prepare>=0&&guard<prepare,'identity validation must precede isolated acceptance proof creation');
});
