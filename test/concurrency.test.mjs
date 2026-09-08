import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeMaxWindows, capPlanBlocks, buildWindowWaves } from '../scripts/orchestrate-sdk.mjs';
const blocks = n => Array.from({length:n}, (_,i) => ({type:'independent', title:`p${i}`, dependsOn:[], conflictKeys:[`file:/task${i}.json`], tasks:[{id:`t${i}`, title:`task${i}`, prompt:`execute task ${i}`}]}));
const recs = plan => plan.map((b,i)=>({key:`B${i+1}`,title:b.title,b,dependsOn:b.dependsOn}));
for (const n of [0,1,7,8,9,17,65]) {
  test(`capacity caps the entire plan: ${n} tasks, at most eight blocks, no loss`, () => {
    const input=blocks(n), original=structuredClone(input);
    const plan=capPlanBlocks(input,computeMaxWindows(16));
    assert.equal(plan.length,Math.min(n,8));
    assert.deepEqual(plan.flatMap(b=>b.tasks.map(t=>t.id)),input.flatMap(b=>b.tasks.map(t=>t.id)));
    assert.deepEqual(input,original,'planning must not mutate cached/source plans');
    for (const b of plan) if (b.tasks.length>1) assert.equal(b.type,'linked');
    assert.equal(new Set(plan.flatMap(b=>b.conflictKeys)).size,n);
    assert.equal(buildWindowWaves(recs(plan),8).flat().length,plan.length);
  });
}
test('nine tasks become seven singleton blocks and one two-task serial block',()=>{
  const plan=capPlanBlocks(blocks(9),8);
  assert.deepEqual(plan.map(b=>b.tasks.length),[1,1,1,1,1,1,1,2]);
  assert.deepEqual(buildWindowWaves(recs(plan),8).map(w=>w.length),[8]);
});
test('dependency ordering survives compaction without introducing a cycle',()=>{
  const input=blocks(17);
  for(let i=0;i<16;i++) input[i].dependsOn=[`p${i+1}`];
  const plan=capPlanBlocks(input,8), waves=buildWindowWaves(recs(plan),8);
  assert.deepEqual(plan.flatMap(b=>b.tasks.map(t=>t.id)),Array.from({length:17},(_,i)=>`t${16-i}`));
  assert.equal(waves.length,8);
  const finished=new Set();
  for(const b of plan) { assert.ok(b.dependsOn.every(d=>finished.has(d))); finished.add(b.title); }
});
test('existing linked tasks and resource locks remain intact',()=>{
  const input=blocks(9); input[8].type='linked'; input[8].tasks.push({id:'extra',prompt:'last task'});
  const plan=capPlanBlocks(input,8);
  assert.deepEqual(plan.at(-1).tasks.map(t=>t.id),['t7','t8','extra']);
  assert.deepEqual(plan.at(-1).conflictKeys,['file:/task7.json','file:/task8.json']);
});
test('larger-memory hosts still have an eight-window ceiling',()=>{
  assert.equal(computeMaxWindows(32),8);
  assert.equal(capPlanBlocks(blocks(17),16).length,16);
});
test('invalid capacities fail immediately',()=>{
  for(const cap of [0,-1,1.5,NaN,Infinity]) assert.throws(()=>capPlanBlocks(blocks(9),cap),RangeError);
});
test('window scheduler rejects an uncapped plan instead of creating overflow waves',()=>{
  assert.throws(()=>buildWindowWaves(recs(blocks(9)),8),/capacity/);
});
test('cyclic overflow dependencies fail explicitly rather than dropping tasks',()=>{
  const input=blocks(9); input[0].dependsOn=['p8']; input[8].dependsOn=['p0'];
  assert.throws(()=>capPlanBlocks(input,8),/cyclic/i);
  assert.equal(input.flatMap(b=>b.tasks).length,9);
});

test('closing one task must never terminate the shared Windows Terminal host', async()=>{
  const {readFileSync}=await import('node:fs');
  const source=readFileSync(new URL('../scripts/core/orchestrate-sdk.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(source,/Name -eq 'WindowsTerminal\.exe'[\s\S]{0,160}taskkill/);
});