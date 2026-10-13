import {testTempFamily} from './test-temp-root.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {verifyChecks} from '../scripts/core/contracts.mjs';

test('JSON acceptance compares nested object contents without depending on key order',()=>{
  const family=testTempFamily('json-acceptance');fs.mkdirSync(family,{recursive:true});
  const root=fs.mkdtempSync(path.join(family,'json-acceptance-'));
  try {
    fs.writeFileSync(path.join(root,'value.json'),JSON.stringify({data:{b:[{y:2,x:1}],a:true}}));
    const check=expected=>verifyChecks([{type:'json',path:'value.json',equals:{data:expected}}],root);
    assert.equal(check({a:true,b:[{x:1,y:2}]}).status,'verified');
    for(const wrong of [{a:true,b:[{x:2,y:1}]},{a:true,b:[1,2]},{b:[{x:1,y:2}]}])assert.equal(check(wrong).status,'failed');
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('JSON acceptance mismatch diagnostics describe shapes without echoing expected or actual credential values',()=>{
  const family=testTempFamily('json-acceptance');fs.mkdirSync(family,{recursive:true});
  const root=fs.mkdtempSync(path.join(family,'json-acceptance-private-'));
  const expected='expected-private-token',actual='actual-private-token';
  try {
    fs.writeFileSync(path.join(root,'value.json'),JSON.stringify({token:actual}));
    const result=verifyChecks([{type:'json',path:'value.json',equals:{token:expected}}],root);
    assert.equal(result.status,'failed');
    assert.equal(result.reason.includes(expected),false);
    assert.equal(result.reason.includes(actual),false);
    assert.match(result.reason,/expected string, actual string/);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('JSON acceptance enforces a bounded handle read for workspace evidence',()=>{
  const family=testTempFamily('json-acceptance');fs.mkdirSync(family,{recursive:true});
  const root=fs.mkdtempSync(path.join(family,'json-acceptance-limit-'));
  try {
    fs.writeFileSync(path.join(root,'large.json'),Buffer.alloc(1024*1024+1,0x20));
    const result=verifyChecks([{type:'json',path:'large.json',equals:{done:true}}],root);
    assert.equal(result.status,'failed');
    assert.match(result.reason,/SAFE_WORKSPACE_READ_LIMIT/);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('JSON acceptance rejects a workspace junction that resolves outside the bound root',t=>{
  const family=testTempFamily('json-acceptance');fs.mkdirSync(family,{recursive:true});
  const parent=fs.mkdtempSync(path.join(family,'json-acceptance-junction-'));
  const root=path.join(parent,'workspace'),outside=path.join(parent,'outside');
  try {
    fs.mkdirSync(root);fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'value.json'),JSON.stringify({done:true}));
    try {fs.symlinkSync(outside,path.join(root,'linked'),'junction');}
    catch {return t.skip('Windows junctions are unavailable to this account');}
    const result=verifyChecks([{type:'json',path:path.join('linked','value.json'),equals:{done:true}}],root);
    assert.equal(result.status,'failed');
    assert.match(result.reason,/SAFE_WORKSPACE_READ_OUTSIDE_ROOT/);
  } finally {fs.rmSync(parent,{recursive:true,force:true});}
});

test('absent acceptance rejects a workspace junction instead of treating an outside missing path as absent',t=>{
  const family=testTempFamily('json-acceptance');fs.mkdirSync(family,{recursive:true});
  const parent=fs.mkdtempSync(path.join(family,'absent-junction-'));
  const root=path.join(parent,'workspace'),outside=path.join(parent,'outside');
  try {
    fs.mkdirSync(root);fs.mkdirSync(outside);
    try {fs.symlinkSync(outside,path.join(root,'linked'),'junction');}
    catch {return t.skip('Windows junctions are unavailable to this account');}
    const result=verifyChecks([{type:'absent',path:path.join('linked','missing.txt')}],root);
    assert.equal(result.status,'failed');
    assert.match(result.reason,/SAFE_WORKSPACE_READ_(?:TARGET|OUTSIDE_ROOT)/);
  } finally {fs.rmSync(parent,{recursive:true,force:true});}
});
