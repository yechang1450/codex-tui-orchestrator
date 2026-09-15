import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {verifyChecks} from '../scripts/core/contracts.mjs';

test('JSON acceptance compares nested object contents without depending on key order',()=>{
  const family=fileURLToPath(new URL('../temp/',import.meta.url));fs.mkdirSync(family,{recursive:true});
  const root=fs.mkdtempSync(path.join(family,'json-acceptance-'));
  try {
    fs.writeFileSync(path.join(root,'value.json'),JSON.stringify({data:{b:[{y:2,x:1}],a:true}}));
    const check=expected=>verifyChecks([{type:'json',path:'value.json',equals:{data:expected}}],root);
    assert.equal(check({a:true,b:[{x:1,y:2}]}).status,'verified');
    for(const wrong of [{a:true,b:[{x:2,y:1}]},{a:true,b:[1,2]},{b:[{x:1,y:2}]}])assert.equal(check(wrong).status,'failed');
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
