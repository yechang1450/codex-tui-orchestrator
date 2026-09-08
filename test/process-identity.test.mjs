import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {processSnapshot} from '../scripts/core/leases.mjs';

test('real process identity preserves Unicode command arguments',{skip:process.platform!=='win32'},async()=>{
 const marker='process-\u4e2d\u6587-\u00e9-identity';
 const child=spawn(process.execPath,['-e','setTimeout(()=>{},30000)',marker],{windowsHide:true,stdio:'ignore'});
 try {
  await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
  const actual=processSnapshot().get(child.pid);
  assert.ok(actual);assert.ok(actual.CommandLine.includes(marker),actual.CommandLine);
 }finally{const gone=new Promise(r=>child.once('exit',r));child.kill();await gone;}
});
