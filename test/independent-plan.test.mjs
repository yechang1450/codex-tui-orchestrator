import test from 'node:test';
import assert from 'node:assert/strict';
import {partitionIndependentBlocks} from '../scripts/core/plan-policy.mjs';
const block=(title,dependsOn=[],keys=['file:/'+title])=>({title,dependsOn,conflictKeys:keys,tasks:[{id:title,prompt:title,sourceIds:[title]}]});
test('dependent components merge in topological order and independent work survives',()=>{
  const input=[block('b',['a']),block('a'),block('c')];
  const p=partitionIndependentBlocks(input);
  assert.equal(p.length,2);
  assert.deepEqual(p[0].tasks.map(t=>t.id),['a','b']);
  assert.ok(p.every(b=>b.dependsOn.length===0));
  assert.equal(input[0].dependsOn[0],'a');
});
test('transitive conflicts join the whole component; scoped independent work stays separate',()=>{
  const p=partitionIndependentBlocks([block('a',[],['dir:/shared']),block('b',[],['file:/shared/b']),block('c',['b']),block('d')]);
  assert.equal(p.length,2);assert.equal(p[0].tasks.length,3);
});
test('unknown scope is conservative and cycles cannot be hidden by grouping',()=>{
  assert.equal(partitionIndependentBlocks([block('a',[],[]),block('b')]).length,1);
  assert.throws(()=>partitionIndependentBlocks([block('a',['b']),block('b',['a'])]),/Cyclic/);
  assert.throws(()=>partitionIndependentBlocks([block('a',['missing'])]),/Unknown/);
});
