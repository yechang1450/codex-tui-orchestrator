import test from 'node:test';
import assert from 'node:assert/strict';
import {admissionKeys} from '../scripts/core/runner.mjs';
import {inferTargetKeys} from '../scripts/core/orchestrate-sdk.mjs';

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
