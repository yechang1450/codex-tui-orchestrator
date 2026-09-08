import test from 'node:test';
import assert from 'node:assert/strict';
import * as publicEntry from '../scripts/orchestrate-sdk.mjs';
import * as engine from '../scripts/core/orchestrate-sdk.mjs';

test('validated public entry preserves every engine export',()=>{
 assert.deepEqual(Object.keys(publicEntry),Object.keys(engine));
 for(const key of Object.keys(engine))assert.equal(publicEntry[key],engine[key],key);
});
