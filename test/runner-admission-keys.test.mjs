import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {admissionKeys} from '../scripts/core/runner.mjs';
import {inferTargetKeys} from '../scripts/core/orchestrate-sdk.mjs';
import {publicLeaseKeys} from '../scripts/core/leases.mjs';
import {providerFixtureToken} from './fixture-provider-tokens.mjs';

const windowsFixtureWorkspace = 'C:/orchestrator-fixtures/workspace';

test('runner keeps normalized keys and does not re-add a proven read-only command input', () => {
  const block = {
    conflictKeys: ['dir:proj-80', `file:${windowsFixtureWorkspace}/temp/receipt-80.json`],
    tasks: [{prompt: `执行 node "${windowsFixtureWorkspace}/temp/cleanup-worker.mjs" --out "${windowsFixtureWorkspace}/temp/receipt-80.json"`}]
  };
  const keys = admissionKeys(block, windowsFixtureWorkspace, inferTargetKeys);
  assert.deepEqual(keys, [
    'dir:c:/orchestrator-fixtures/workspace/proj-80',
    'file:c:/orchestrator-fixtures/workspace/temp/receipt-80.json'
  ]);
  assert.equal(keys.includes('file:c:/orchestrator-fixtures/workspace/temp/cleanup-worker.mjs'), false);
});

test('runner infers keys when a raw or fallback plan supplies an empty conflict list', () => {
  const keys = admissionKeys({
    conflictKeys: [],
    tasks: [{prompt: `write ${windowsFixtureWorkspace}/temp/shared.json`}]
  }, windowsFixtureWorkspace, text => [`file:${windowsFixtureWorkspace}/temp/shared.json`]);
  assert.deepEqual(keys, ['file:c:/orchestrator-fixtures/workspace/temp/shared.json']);
});

test('runner projects sensitive admission keys with the selected physical coordinator scope',{skip:process.platform!=='win32'},()=>{
  const scope=fs.mkdtempSync(path.join(os.tmpdir(),'orch-runner-admission-scope-'));
  const secret=providerFixtureToken('openai-project');
  const raw=`file:${windowsFixtureWorkspace}/temp/${secret}/receipt.json`;
  try{
    const actual=admissionKeys({conflictKeys:[raw],tasks:[]},windowsFixtureWorkspace,()=>[],scope);
    const expected=publicLeaseKeys([raw],{scopeDir:scope,cwd:windowsFixtureWorkspace});
    assert.deepEqual(actual,expected);
    assert.equal(actual[0].includes(secret),false);
    assert.match(actual[0],/\[REDACTED\]~hmac-sha256-v1-/);
  }finally{fs.rmSync(scope,{recursive:true,force:true});}
});
