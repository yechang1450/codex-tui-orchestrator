import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as contracts from '../scripts/core/contracts.mjs';
const {requestTasks,ledgerPlan}=contracts;
process.env.ORCH_AGENT='codex';
const sdk=await import('../scripts/orchestrate-sdk.mjs');
test('nine original comma-rich tasks remain eight complete execution blocks',()=>{
 const request=Array.from({length:9},(_,i)=>`项目${91+i}：执行 node D:/temp/demo/project-${91+i}/probe.mjs，读回结果验证，记录检查点`).join('；');
 const candidate=sdk.genericProjectSplit(request);
 assert.equal(candidate?.blocks.length,9);
 const result=ledgerPlan(request,candidate.blocks,8,(blocks,cap)=>{while(blocks.length>cap){const last=blocks.pop();blocks.at(-1).tasks.push(...last.tasks);}return blocks;});
 assert.equal(result.plan.length,8);assert.equal(result.tasks.length,9);
 assert.deepEqual(result.plan.map(b=>b.tasks.flatMap(t=>t.sourceIds).length),[1,1,1,1,1,1,1,2]);
});
test('model summaries are rebound to original IDs before grouping',()=>{
 assert.equal(typeof contracts.bindClassifiedTasks,'function');
 const original='项目91：修改页面，检查结果；项目92：修改接口，运行测试';
 const assigned=contracts.bindClassifiedTasks(original,[{id:'T001',summary:'rewritten',project:'91'},{id:'T002',summary:'short',project:'92',depends_on:['T001']}]);
 assert.equal(assigned[0].summary,requestTasks(original)[0].prompt);
 assert.deepEqual(assigned[1].depends_on,['T001']);
 assert.throws(()=>contracts.bindClassifiedTasks(original,[{id:'T001'}]),/inventory/);
});
test('task parsing preserves quoted command separators and splits explicit comma-separated projects',()=>{
 assert.deepEqual(requestTasks('项目91：运行 node -e "console.log(1); console.log(2)"，然后验收；项目92：修复页面').map(t=>t.prompt),['项目91：运行 node -e "console.log(1); console.log(2)"，然后验收','项目92：修复页面']);
 assert.equal(requestTasks('修复81的空白，优化82的UI').length,2);
});
test('an apostrophe in prose cannot swallow following tasks',()=>{
 assert.deepEqual(requestTasks("项目91：don't remove data，检查结果；项目92：运行测试").map(t=>t.prompt),["项目91：don't remove data，检查结果",'项目92：运行测试']);
});
