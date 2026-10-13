import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {assertWorkspaceAbsent,bindWorkspaceRoot,readWorkspaceFile} from '../scripts/core/safe-workspace-read.mjs';

function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'otui-safe-workspace-read-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  return root;
}

test('safe workspace reader returns UTF-8 text and the digest from one bounded read handle',t=>{
  const root=fixture(t),file=path.join(root,'input.txt'),text='hello 中文';
  fs.writeFileSync(file,text,'utf8');
  const binding=bindWorkspaceRoot(root);
  const value=readWorkspaceFile({root,binding,target:file,maxBytes:1024,mode:'text'});
  assert.equal(value.text,text);
  assert.equal(value.sha256,crypto.createHash('sha256').update(text,'utf8').digest('hex'));
  assert.equal(value.size,Buffer.byteLength(text));
});

test('safe workspace reader rejects a file that exceeds the caller bound',t=>{
  const root=fixture(t),file=path.join(root,'large.bin');
  fs.writeFileSync(file,Buffer.alloc(1025));
  const binding=bindWorkspaceRoot(root);
  assert.throws(()=>readWorkspaceFile({root,binding,target:file,maxBytes:1024,mode:'hash'}),/SAFE_WORKSPACE_READ_LIMIT/);
});

test('safe workspace reader rejects a workspace junction to an outside file',t=>{
  const parent=fixture(t),root=path.join(parent,'workspace'),outside=path.join(parent,'outside');
  fs.mkdirSync(root);fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'sentinel.txt'),'outside','utf8');
  try { fs.symlinkSync(outside,path.join(root,'linked'),'junction'); }
  catch { return t.skip('Windows junctions are unavailable to this account'); }
  const binding=bindWorkspaceRoot(root);
  assert.throws(()=>readWorkspaceFile({root,binding,target:path.join(root,'linked','sentinel.txt'),maxBytes:1024,mode:'text'}),/SAFE_WORKSPACE_READ_OUTSIDE_ROOT/);
});

test('safe workspace reader proves an absent path without following a workspace junction',t=>{
  const parent=fixture(t),root=path.join(parent,'workspace'),outside=path.join(parent,'outside');
  fs.mkdirSync(root);fs.mkdirSync(outside);
  const binding=bindWorkspaceRoot(root);
  assert.doesNotThrow(()=>assertWorkspaceAbsent({root,binding,target:path.join(root,'missing.txt')}));
  try { fs.symlinkSync(outside,path.join(root,'linked'),'junction'); }
  catch { return t.skip('Windows junctions are unavailable to this account'); }
  assert.throws(()=>assertWorkspaceAbsent({root,binding,target:path.join(root,'linked','missing.txt')}),/SAFE_WORKSPACE_READ_(?:TARGET|OUTSIDE_ROOT)/);
});

test('safe workspace reader rejects an NTFS hard link to a file outside the workspace',t=>{
  const parent=fixture(t),root=path.join(parent,'workspace'),outside=path.join(parent,'outside');
  fs.mkdirSync(root);fs.mkdirSync(outside);
  const source=path.join(outside,'source.txt'),linked=path.join(root,'linked.txt');fs.writeFileSync(source,'outside','utf8');
  try { fs.linkSync(source,linked); }
  catch { return t.skip('NTFS hard links are unavailable to this account'); }
  const binding=bindWorkspaceRoot(root);
  assert.throws(()=>readWorkspaceFile({root,binding,target:linked,maxBytes:1024,mode:'hash'}),/SAFE_WORKSPACE_READ_MULTIPLE_LINKS/);
});

test('safe workspace reader rejects a workspace path replaced after its root was bound',t=>{
  const parent=fixture(t),root=path.join(parent,'workspace'),moved=path.join(parent,'workspace-original');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root,'input.txt'),'original','utf8');
  const binding=bindWorkspaceRoot(root);
  fs.renameSync(root,moved);
  fs.mkdirSync(root);
  const replacement=path.join(root,'input.txt');
  fs.writeFileSync(replacement,'replacement','utf8');
  assert.throws(()=>readWorkspaceFile({root,binding,target:replacement,maxBytes:1024,mode:'text'}),/SAFE_WORKSPACE_READ_ROOT_BINDING/);
});
