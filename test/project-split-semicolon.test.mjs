import test from 'node:test';
import assert from 'node:assert/strict';
import {genericProjectSplit} from '../scripts/core/orchestrate-sdk.mjs';

test('adjacent Chinese semicolon project tasks split into independent blocks',()=>{
  const request='项目91：执行 node probe91.mjs 并核验结果；项目92：执行 node probe92.mjs 并核验结果';
  const result=genericProjectSplit(request);
  assert.deepEqual(result?.blocks.map(block=>block.title),['proj-91','proj-92']);
  assert.deepEqual(result.blocks.map(block=>block.type),['independent','independent']);
  assert.match(result.blocks[0].tasks[0].prompt,/probe91\.mjs/);
  assert.doesNotMatch(result.blocks[0].tasks[0].prompt,/probe92\.mjs/);
  assert.match(result.blocks[1].tasks[0].prompt,/probe92\.mjs/);
  assert.doesNotMatch(result.blocks[1].tasks[0].prompt,/probe91\.mjs/);
});
