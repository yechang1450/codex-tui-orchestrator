import test from 'node:test';
import assert from 'node:assert/strict';
import {admissionKeys} from '../scripts/core/runner.mjs';
import {inferTargetKeys} from '../scripts/core/orchestrate-sdk.mjs';

test('runner keeps normalized keys and does not re-add a proven read-only command input', () => {
  const block = {
    conflictKeys: ['dir:proj-80', 'file:C:/Users/fixture-user/workspace/temp/receipt-80.json'],
    tasks: [{prompt: `执行 node "C:/Users/fixture-user/workspace/temp/cleanup-worker.mjs" --out "C:/Users/fixture-user/workspace/temp/receipt-80.json"`}]
  };
  const keys = admissionKeys(block, 'C:/Users/fixture-user/workspace', inferTargetKeys);
  assert.deepEqual(keys, [
    'dir:c:/Users/fixture-user/workspace/proj-80',
    'file:c:/Users/fixture-user/workspace/temp/receipt-80.json'
  ]);
  assert.equal(keys.includes('file:c:/Users/fixture-user/workspace/temp/cleanup-worker.mjs'), false);
});

test('runner infers keys when a raw or fallback plan supplies an empty conflict list', () => {
  const keys = admissionKeys({
    conflictKeys: [],
    tasks: [{prompt: 'write C:/Users/fixture-user/workspace/temp/shared.json'}]
  }, 'C:/Users/fixture-user/workspace', text => ['file:C:/Users/fixture-user/workspace/temp/shared.json']);
  assert.deepEqual(keys, ['file:c:/Users/fixture-user/workspace/temp/shared.json']);
});
