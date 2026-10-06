import test from 'node:test';
import assert from 'node:assert/strict';
import {orderLaunchPlan, scheduleReady} from '../scripts/core/runner.mjs';

test('dynamic memory launch order starts the heaviest blocks first and keeps ties stable', () => {
  const sum = {
    blocks: [
      {key: 'B1', taskIds: ['T1']},
      {key: 'B2', taskIds: ['T2']},
      {key: 'B3', taskIds: ['T3']},
      {key: 'B4', taskIds: ['T4']},
    ],
  };
  const plan = sum.blocks.map(block => ({key: block.key, dependsOn: [], b: block}));
  const budget = {
    mode: 'dynamic',
    windowCostMB: 400,
    headroom: 1,
    taskCosts: {
      T1: {memoryMB: 100},
      T2: {memoryMB: 900},
      T3: {memoryMB: 400},
      T4: {memoryMB: 100},
    },
  };

  assert.deepEqual(orderLaunchPlan(sum, plan, budget).map(record => record.key), ['B2', 'B3', 'B1', 'B4']);
  assert.deepEqual(plan.map(record => record.key), ['B1', 'B2', 'B3', 'B4'], 'the durable plan order must remain unchanged');
});

test('non-dynamic launch order preserves the planner order', () => {
  const sum = {blocks: [{key: 'B1', taskIds: ['T1']}, {key: 'B2', taskIds: ['T2']}]} ;
  const plan = sum.blocks.map(block => ({key: block.key, dependsOn: [], b: block}));
  const budget = {mode: 'fixed', windowCostMB: 400, headroom: 1, taskCosts: {T1: {memoryMB: 1}, T2: {memoryMB: 900}}};

  assert.deepEqual(orderLaunchPlan(sum, plan, budget).map(record => record.key), ['B1', 'B2']);
});

test('memory priority never bypasses a dependency', async () => {
  const sum = {
    blocks: [
      {key: 'B1', taskIds: ['T1']},
      {key: 'B2', taskIds: ['T2']},
    ],
  };
  const plan = [
    {key: 'B1', dependsOn: [], b: sum.blocks[0]},
    {key: 'B2', dependsOn: ['B1'], b: sum.blocks[1]},
  ];
  const budget = {mode: 'dynamic', windowCostMB: 400, headroom: 1, taskCosts: {T1: {memoryMB: 100}, T2: {memoryMB: 900}}};
  const state = new Map(plan.map(record => [record.key, 'pending']));
  const started = [];

  await scheduleReady(orderLaunchPlan(sum, plan, budget), async record => {
    started.push(record.key);
    state.set(record.key, 'verified');
  }, key => state.get(key));

  assert.deepEqual(started, ['B1', 'B2']);
});
