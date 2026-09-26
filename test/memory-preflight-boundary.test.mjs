import test from 'node:test';
import assert from 'node:assert/strict';
import {memoryPreflight} from '../scripts/core/orchestrate-sdk.mjs';

test('preflight stays inline at or below the complete 4000 MB reserve',()=>{
  for(const available of [0,3999,4000])assert.equal(memoryPreflight(available).ok,false,String(available));
  assert.equal(memoryPreflight(4001).ok,true);
  assert.equal(memoryPreflight(5000,5000).ok,false);
  assert.equal(memoryPreflight(5001,5000).ok,true);
  assert.equal(memoryPreflight(3999,1).reserveMB,4000);
});
