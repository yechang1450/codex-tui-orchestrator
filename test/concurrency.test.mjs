import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeMaxWindows, capPlanBlocks, buildWindowWaves } from '../scripts/orchestrate-sdk.mjs';
import { buildTodoList, todoListText } from '../scripts/core/contracts.mjs';
const blocks = n => Array.from({length:n}, (_,i) => ({type:'independent', title:`p${i}`, dependsOn:[], conflictKeys:[`file:/task${i}.json`], tasks:[{id:`t${i}`, title:`task${i}`, prompt:`execute task ${i}`}]}));
const recs = plan => plan.map((b,i)=>({key:`B${i+1}`,title:b.title,b,dependsOn:b.dependsOn}));
for (const n of [0,1,7,8,9,17,65]) {
  test(`capacity caps the entire plan: ${n} tasks, at most eight blocks on 16000 MB, no loss`, () => {
    const input=blocks(n), original=structuredClone(input);
    const plan=capPlanBlocks(input,computeMaxWindows(16_000));
    assert.equal(plan.length,Math.min(n,8));
    assert.deepEqual(plan.flatMap(b=>b.tasks.map(t=>t.id)),input.flatMap(b=>b.tasks.map(t=>t.id)));
    assert.deepEqual(input,original,'planning must not mutate cached/source plans');
    for (const b of plan) if (b.tasks.length>1) assert.equal(b.type,'linked');
    assert.equal(new Set(plan.flatMap(b=>b.conflictKeys)).size,n);
    assert.equal(buildWindowWaves(recs(plan),8).flat().length,plan.length);
  });
}
test('nine tasks compact into eight blocks when 16000 MB capacity is eight',()=>{
  const plan=capPlanBlocks(blocks(9),8);
  assert.equal(plan.length,8);
  assert.equal(plan.flatMap(b=>b.tasks).length,9,'overflow stays inside the existing blocks');
  assert.deepEqual(buildWindowWaves(recs(plan),8).map(w=>w.length),[8]);
});
test('dependency ordering survives compaction without introducing a cycle',()=>{
  const input=blocks(17);
  for(let i=0;i<16;i++) input[i].dependsOn=[`p${i+1}`];
  const plan=capPlanBlocks(input,16), waves=buildWindowWaves(recs(plan),16);
  assert.deepEqual(plan.flatMap(b=>b.tasks.map(t=>t.id)),Array.from({length:17},(_,i)=>`t${16-i}`));
  assert.equal(waves.length,16);
  const finished=new Set();
  for(const b of plan) { assert.ok(b.dependsOn.every(d=>finished.has(d))); finished.add(b.title); }
});
test('existing linked tasks and resource locks remain intact',()=>{
  const input=blocks(9); input[8].type='linked'; input[8].tasks.push({id:'extra',prompt:'last task'});
  const plan=capPlanBlocks(input,12);
  assert.deepEqual(plan.at(-1).tasks.map(t=>t.id),['t8','extra']);
  assert.deepEqual(plan.at(-1).conflictKeys,['file:/task8.json']);
});
test('capacity floors system free memory in MB divided by 2000 (2 GB per block)',()=>{
  assert.equal(computeMaxWindows(4_000),2);
  assert.equal(computeMaxWindows(8_999),4);
  assert.equal(computeMaxWindows(999),0);
  assert.equal(computeMaxWindows(15_640),7);
  assert.equal(computeMaxWindows(16_000),8);
  assert.equal(computeMaxWindows(32_000),16);
  assert.equal(capPlanBlocks(blocks(17),16).length,16);
});
test('invalid capacities fail immediately',()=>{
  for(const cap of [0,-1,1.5,NaN,Infinity]) assert.throws(()=>capPlanBlocks(blocks(9),cap),RangeError);
});
test('window scheduler rejects an uncapped plan instead of creating overflow waves',()=>{
  assert.throws(()=>buildWindowWaves(recs(blocks(13)),12),/capacity/);
});
test('cyclic overflow dependencies fail explicitly rather than dropping tasks',()=>{
  const input=blocks(13); input[0].dependsOn=['p12']; input[12].dependsOn=['p0'];
  assert.throws(()=>capPlanBlocks(input,12),/cyclic/i);
  assert.equal(input.flatMap(b=>b.tasks).length,13);
});

test('block TodoList preserves the global inventory for independent and merged blocks',()=>{
  const tasks=[{id:'T001',prompt:'独立任务'},{id:'T002',prompt:'串行任务'}];
  const blocks=[{key:'B1',taskIds:['T001']},{key:'B2',taskIds:['T002']}];
  const list=buildTodoList(tasks,blocks,{T001:{status:'verified'},T002:{status:'running'}});
  assert.deepEqual(list,[
    {id:'T001',prompt:'独立任务',status:'verified',block:'B1'},
    {id:'T002',prompt:'串行任务',status:'running',block:'B2'},
  ]);
  assert.match(todoListText(list),/T001 \(verified\)/);
  assert.match(todoListText(list,'B2'),/T002 \(running\)/);
  assert.doesNotMatch(todoListText(list,'B2'),/T001/);
});

test('closing one task must never terminate the shared Windows Terminal host', async()=>{
  const {readFileSync}=await import('node:fs');
  const source=readFileSync(new URL('../scripts/core/orchestrate-sdk.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(source,/Name -eq 'WindowsTerminal\.exe'[\s\S]{0,160}taskkill/);
});
