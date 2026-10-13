import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runWindows,runDirectory} from '../scripts/core/runner.mjs';
import {providerFixtureToken} from './fixture-provider-tokens.mjs';

test('credential-shaped acceptance contracts are rejected before planning or copying into a run ledger',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'orch-acceptance-private-'));
  const workspace=path.join(root,'workspace'),controller=path.join(root,'controller'),runId='private-acceptance';
  fs.mkdirSync(workspace,{recursive:true});
  const acceptance=path.join(workspace,'acceptance.json'),secret='acceptance-private-value';
  fs.writeFileSync(acceptance,JSON.stringify({T001:[{type:'json',path:'evidence.json',equals:{token:secret}}]}),'utf8');
  const previous=process.env.ORCH_CONTROLLER_ROOT;process.env.ORCH_CONTROLLER_ROOT=controller;let planned=0;
  try {
    await assert.rejects(
      runWindows('ordinary task',{plan:async()=>{planned++;throw new Error('planner invoked');}},{workspace,runId,capacity:1,coordinator:path.join(controller,'coordinator'),acceptanceFile:acceptance}),
      /SENSITIVE_ACCEPTANCE_CONTRACT/,
    );
    assert.equal(planned,0);
    assert.equal(fs.existsSync(path.join(runDirectory(workspace,runId),'acceptance.json')),false);
  } finally {
    if(previous===undefined)delete process.env.ORCH_CONTROLLER_ROOT;else process.env.ORCH_CONTROLLER_ROOT=previous;
    fs.rmSync(root,{recursive:true,force:true});
  }
});

test('credential-shaped acceptance object keys are rejected before planning or copying into a run ledger',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'orch-acceptance-private-key-'));
  const workspace=path.join(root,'workspace'),controller=path.join(root,'controller'),runId='private-acceptance-key';
  fs.mkdirSync(workspace,{recursive:true});
  const acceptance=path.join(workspace,'acceptance.json'),secretKey=providerFixtureToken('openai-project');
  fs.writeFileSync(acceptance,JSON.stringify({T001:[{type:'json',path:'evidence.json',equals:{[secretKey]:'expected'}}]}),'utf8');
  const previous=process.env.ORCH_CONTROLLER_ROOT;process.env.ORCH_CONTROLLER_ROOT=controller;let planned=0;
  try {
    await assert.rejects(
      runWindows('ordinary task',{plan:async()=>{planned++;throw new Error('planner invoked');}},{workspace,runId,capacity:1,coordinator:path.join(controller,'coordinator'),acceptanceFile:acceptance}),
      /SENSITIVE_ACCEPTANCE_CONTRACT/,
    );
    assert.equal(planned,0);
    assert.equal(fs.existsSync(path.join(runDirectory(workspace,runId),'acceptance.json')),false);
  } finally {
    if(previous===undefined)delete process.env.ORCH_CONTROLLER_ROOT;else process.env.ORCH_CONTROLLER_ROOT=previous;
    fs.rmSync(root,{recursive:true,force:true});
  }
});
