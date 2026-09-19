import {test} from 'node:test';
import assert from 'node:assert/strict';
import {budgetMergePlan, planMemoryCosts} from '../scripts/core/contracts.mjs';
import {
  admissionOk, blockCostMB, budgetSettings, clampCost, observedCostMB,
  resolveBudgetMode, updateRollingCost, DEFAULT_MIN_AVAILABLE_MB, DEFAULT_WINDOW_COST_MB,
  COST_MIN_MB, COST_MAX_MB, firstRunHeadroom, DEFAULT_FIRST_RUN_HEADROOM,
} from '../scripts/core/memory-budget.mjs';

const blocks = (n, extra = {}) => Array.from({length: n}, (_, i) => ({
  type: 'independent', title: 'p' + (i + 1), dependsOn: [], conflictKeys: [],
  tasks: [{id: 'T' + (i + 1), prompt: 'task ' + (i + 1), sourceIds: ['T' + (i + 1)]}], ...extra,
}));

test('budget mode defaults to dynamic and rejects unknown values', () => {
  assert.equal(resolveBudgetMode({}), 'dynamic');
  assert.equal(resolveBudgetMode({ORCH_CAPACITY_MODE: 'FORMULA'}), 'formula');
  assert.throws(() => resolveBudgetMode({ORCH_CAPACITY_MODE: 'auto'}), /Invalid ORCH_CAPACITY_MODE/);
  const settings = budgetSettings({});
  assert.equal(settings.mode, 'dynamic');
  assert.equal(settings.floorMB, DEFAULT_MIN_AVAILABLE_MB);
  assert.equal(settings.windowCostMB, DEFAULT_WINDOW_COST_MB);
  assert.equal(budgetSettings({ORCH_MIN_AVAILABLE_MB: '0'}).floorMB, 0);
});

test('admission requires the floor to survive and can be disabled with 0', () => {
  assert.equal(admissionOk({availableMB: 1024, runningCostMB: 256, blockCostMB: 256, floorMB: 512}), true, 'exactly at the floor passes');
  assert.equal(admissionOk({availableMB: 1023, runningCostMB: 256, blockCostMB: 256, floorMB: 512}), false);
  assert.equal(admissionOk({availableMB: 10, runningCostMB: 0, blockCostMB: 256, floorMB: 0}), true, 'floor 0 disables the gate');
});

test('declared task memory raises the block cost once, not per task', () => {
  const block = {taskIds: ['T001', 'T002'], tasks: []};
  const costs = {T001: {memoryMB: 800}, T002: {memoryMB: 300}};
  assert.equal(blockCostMB(block, 256, costs), 256 + 800, 'serial tasks take the max, not the sum');
  assert.equal(blockCostMB(block, 256, {}), 256);
  const plannerShaped = {tasks: [{sourceIds: ['T001']}, {sourceIds: ['T002']}]};
  assert.equal(blockCostMB(plannerShaped, 256, costs), 1056, 'planner blocks resolve task ids through sourceIds');
});

test('the merge loop fits the whole plan inside the memory budget', () => {
  const plan = blocks(4);
  const tight = budgetMergePlan(plan, {availableMB: 1000, floorMB: 512, windowCostMB: 256});
  assert.equal(tight.ok, true);
  assert.equal(tight.requiredMB, 256, 'four equal-cost blocks merge down to one');
  assert.equal(tight.plan.length, 1);
  assert.equal(tight.merges.length, 3);
  assert.equal(tight.plan[0].taskIds.length, 4, 'no task is lost');
  const roomy = budgetMergePlan(plan, {availableMB: 5000, floorMB: 512, windowCostMB: 256});
  assert.equal(roomy.merges.length, 0);
  assert.equal(roomy.plan.length, 4);
  assert.deepEqual(planMemoryCosts(roomy.plan, {windowCostMB: 256}).map(c => c.costMB), [256, 256, 256, 256]);
});

test('merging keeps dependency order and never merges across parallel layers', () => {
  const plan = blocks(3);
  plan[1].dependsOn = ['p1'];
  plan[2].dependsOn = ['p2'];
  // 串行链天然只能同时跑一个块：peak = 256MB，不该被误判为超预算，也不该做无意义合并。
  const merged = budgetMergePlan(plan, {availableMB: 300, floorMB: 0, windowCostMB: 256});
  assert.equal(merged.requiredMB, 256, 'a serial chain peaks at one block');
  assert.equal(merged.merges.length, 0, 'merging across layers would not reduce the peak');
  assert.equal(merged.plan.length, 3);
  assert.deepEqual(merged.plan.map(b => b.dependsOn), [[], ['B1'], ['B2']], 'dependency order survives re-keying');
  // 依赖环必须被拒绝：规划期已由 levelWaves 保证，这里确认合并不会凭空造环。
  const cyclic = blocks(2);
  cyclic[0].dependsOn = ['p2'];
  cyclic[1].dependsOn = ['p1'];
  const safe = budgetMergePlan(cyclic, {availableMB: 100, floorMB: 512, windowCostMB: 256});
  assert.equal(safe.plan.length, 2, 'cyclic input is left untouched instead of merging blindly');
});

test('rolling cost rises at once, falls slowly, and stays clamped', () => {
  const start = {windowCostMB: 256, samples: 0};
  const up = updateRollingCost(start, {observedMB: 420});
  assert.equal(up.windowCostMB, 420, 'a worse observation raises the budget immediately');
  const down1 = updateRollingCost(up, {observedMB: 190});
  assert.equal(down1.windowCostMB, 420, 'a single cheap sample cannot lower the budget');
  const down2 = updateRollingCost({...down1, samples: 2}, {observedMB: 190});
  assert.equal(down2.windowCostMB, 338, 'after three samples the budget halves the distance');
  const floor = updateRollingCost({windowCostMB: 300, samples: 9}, {observedMB: 20});
  assert.equal(floor.windowCostMB, 278, 'downgrades move halfway towards the observed value');
  const floor2 = updateRollingCost({windowCostMB: 258, samples: 12}, {observedMB: 20});
  assert.ok(floor2.windowCostMB >= COST_MIN_MB && floor2.windowCostMB <= 258, 'and never fall below the floor');
  assert.equal(clampCost(99999), COST_MAX_MB);
  assert.equal(clampCost(1), COST_MIN_MB);
});

test('observed cost cross-checks the process peak with the available-memory drop', () => {
  assert.equal(observedCostMB({processPeakMB: 200}), 300, 'peak x 1.5');
  assert.equal(observedCostMB({processPeakMB: 200, availableDeltaMB: 700}), 700, 'the larger signal wins');
  assert.equal(observedCostMB({}), 0);
});

test('the first run keeps extra headroom until enough clean samples exist', () => {
  assert.equal(budgetSettings({}).headroom, DEFAULT_FIRST_RUN_HEADROOM);
  assert.equal(budgetSettings({ORCH_FIRST_RUN_HEADROOM: '2'}).headroom, 2);
  assert.equal(budgetSettings({ORCH_FIRST_RUN_HEADROOM: '9'}).headroom, DEFAULT_FIRST_RUN_HEADROOM, 'out of range falls back');
  assert.equal(firstRunHeadroom(0), DEFAULT_FIRST_RUN_HEADROOM);
  assert.equal(firstRunHeadroom(2), DEFAULT_FIRST_RUN_HEADROOM);
  assert.equal(firstRunHeadroom(3), 1, 'three samples retire the extra headroom');
  assert.equal(firstRunHeadroom(9, 1), 1);
  // 首轮余量确实会让规划更保守：同样的内存能放的块更少。
  const plan = blocks(5);
  const without = budgetMergePlan(plan, {availableMB: 2000, floorMB: 512, windowCostMB: 256, headroom: 1});
  const with_ = budgetMergePlan(plan, {availableMB: 2000, floorMB: 512, windowCostMB: 256, headroom: 1.25});
  assert.ok(with_.plan.length < without.plan.length || with_.requiredMB > without.requiredMB, 'headroom must tighten the plan');
  assert.equal(with_.headroom, 1.25);
});
