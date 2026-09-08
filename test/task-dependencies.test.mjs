import {test} from 'node:test';
import assert from 'node:assert/strict';
process.env.ORCH_AGENT='codex';
const {buildBlocksFromTasks}=await import('../scripts/orchestrate-sdk.mjs');
test('task dependencies cannot disappear when tasks share the same project block',()=>{
 const task=(id,depends_on=[])=>({id,summary:'执行'+id,project:'81',depends_on});
 assert.throws(()=>buildBlocksFromTasks([task('A',['B']),task('B',['A'])]),/Cyclic/);
 assert.throws(()=>buildBlocksFromTasks([task('A',['A'])]),/Self dependency/);
 assert.throws(()=>buildBlocksFromTasks([task('A',['missing'])]),/Unknown dependency/);
 const plan=buildBlocksFromTasks([task('B',['A']),task('A')]);
 const text=plan.flatMap(b=>b.tasks.map(t=>t.prompt)).join('\n');
 assert.ok(text.indexOf('执行A')<text.indexOf('执行B'));
});
test('project grouping retains declared resource conflicts',()=>{
 const plan=buildBlocksFromTasks([{id:'A',summary:'执行A',project:'81',conflict_hints:['file:D:/shared/config.json']}]);
 assert.ok(plan[0].conflictKeys.includes('file:D:/shared/config.json'));
});
