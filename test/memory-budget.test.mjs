import {test} from 'node:test';
import assert from 'node:assert/strict';
import {planMemoryCosts, levelWaves} from '../scripts/core/contracts.mjs';
import {admissionOk, blockCostMB, budgetSettings, clampCost, observedCostMB, resolveBudgetMode, updateRollingCost, DEFAULT_MIN_AVAILABLE_MB, DEFAULT_WINDOW_COST_MB, COST_MIN_MB, COST_MAX_MB, firstRunHeadroom, DEFAULT_FIRST_RUN_HEADROOM} from '../scripts/core/memory-budget.mjs';

test('dynamic memory admission is the only mode and keeps a 4000 MB reserve',()=>{
  assert.equal(resolveBudgetMode({}),'dynamic');
  assert.throws(()=>resolveBudgetMode({ORCH_CAPACITY_MODE:'formula'}),/expected dynamic/);
  const settings=budgetSettings({});
  assert.equal(settings.mode,'dynamic');assert.equal(settings.floorMB,DEFAULT_MIN_AVAILABLE_MB);assert.equal(settings.windowCostMB,DEFAULT_WINDOW_COST_MB);
  assert.equal(budgetSettings({ORCH_MIN_AVAILABLE_MB:'0'}).floorMB,DEFAULT_MIN_AVAILABLE_MB);
  assert.equal(budgetSettings({ORCH_MIN_AVAILABLE_MB:'512'}).floorMB,DEFAULT_MIN_AVAILABLE_MB);
});

test('admission requires predicted peak to stay strictly below available minus reserve',()=>{
  assert.equal(admissionOk({availableMB:4500,runningCostMB:0,blockCostMB:500,floorMB:4000}),false);
  assert.equal(admissionOk({availableMB:4501,runningCostMB:0,blockCostMB:500,floorMB:4000}),true);
  assert.equal(admissionOk({availableMB:5000,runningCostMB:500,blockCostMB:500,floorMB:4000}),false);
  assert.equal(admissionOk({availableMB:10,runningCostMB:0,blockCostMB:256,floorMB:0}),false);
  assert.equal(admissionOk({availableMB:5000,runningCostMB:0,blockCostMB:NaN,floorMB:4000}),false);
});

test('declared task memory raises the block estimate once, not per serial task',()=>{
  const block={taskIds:['T001','T002'],tasks:[]},costs={T001:{memoryMB:800},T002:{memoryMB:300}};
  assert.equal(blockCostMB(block,256,costs),1056);
  assert.deepEqual(planMemoryCosts([{key:'B1',title:'one',taskIds:['T001']}],{windowCostMB:256,taskCosts:costs}),[{key:'B1',title:'one',costMB:1056}]);
});

test('rolling cost raises immediately, lowers slowly, and never truncates observed peaks',()=>{
  const start={windowCostMB:256,samples:0},up=updateRollingCost(start,{observedMB:420});
  assert.equal(up.windowCostMB,420);assert.equal(updateRollingCost(up,{observedMB:190}).windowCostMB,420);
  assert.equal(updateRollingCost({...up,samples:2},{observedMB:190}).windowCostMB,338);
  assert.equal(observedCostMB({processPeakMB:2000}),3000);assert.equal(clampCost(99999),99999);assert.ok(COST_MAX_MB>99999);assert.equal(clampCost(1),COST_MIN_MB);
});

test('process peak and available-memory drop use the larger evidence source',()=>{assert.equal(observedCostMB({processPeakMB:200}),300);assert.equal(observedCostMB({processPeakMB:200,availableDeltaMB:700}),700);assert.equal(observedCostMB({}),0);});

test('first-run headroom is finite and retires after clean samples',()=>{assert.equal(budgetSettings({}).headroom,DEFAULT_FIRST_RUN_HEADROOM);assert.equal(firstRunHeadroom(0),DEFAULT_FIRST_RUN_HEADROOM);assert.equal(firstRunHeadroom(3),1);});

test('dependency waves remain serial while independent blocks form the parallel layer',()=>{const recs=[{key:'A',title:'A',dependsOn:[]},{key:'B',title:'B',dependsOn:[]},{key:'C',title:'C',dependsOn:['A']}];assert.deepEqual(levelWaves(recs).map(w=>w.map(r=>r.key)),[['A','B'],['C']]);});
