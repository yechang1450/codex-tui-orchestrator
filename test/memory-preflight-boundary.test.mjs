import test from 'node:test';
import assert from 'node:assert/strict';
import {memoryPreflight} from '../scripts/core/orchestrate-sdk.mjs';

test('preflight stays inline at or below the complete 1000 MB reserve',()=>{
  for(const available of [0,999,1000])assert.equal(memoryPreflight(available).ok,false,String(available));
  assert.equal(memoryPreflight(1001).ok,true);
  assert.equal(memoryPreflight(2000,2000).ok,false);
  assert.equal(memoryPreflight(2001,2000).ok,true);
  assert.equal(memoryPreflight(999,1).reserveMB,1000);
});
