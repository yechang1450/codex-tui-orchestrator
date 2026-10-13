import {testTempFamily} from './test-temp-root.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {atomicJson} from '../scripts/core/leases.mjs';

const family=testTempFamily('atomic-state');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
test('atomic state replacement survives a real transient Windows reader lock',{skip:process.platform!=='win32'},async()=>{
 fs.mkdirSync(family,{recursive:true});const root=fs.mkdtempSync(path.join(family,'atomic-lock-'));
 const file=path.join(root,'summary.json'),ready=path.join(root,'ready');let child;
 const quote=s=>"'"+s.replaceAll("'","''")+"'";
 try {
  atomicJson(file,{generation:1});
  const script=`$s=[IO.File]::Open(${quote(file)},[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);try{[IO.File]::WriteAllText(${quote(ready)},'ready');Start-Sleep -Milliseconds 350}finally{$s.Dispose()}`;
  child=spawn('powershell.exe',['-NoProfile','-Command',script],{windowsHide:true,stdio:'ignore'});
  const exited=new Promise(resolve=>{child.once('exit',resolve);child.once('error',resolve);});
  const end=Date.now()+15000;while(!fs.existsSync(ready)&&Date.now()<end&&child.exitCode===null)await pause(10);
  assert.ok(fs.existsSync(ready),'lock holder did not become ready');
  atomicJson(file,{generation:2});
  assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')),{generation:2});await exited;
  assert.equal(fs.readdirSync(root).some(n=>n.endsWith('.tmp')),false);
 }finally{if(child&&child.exitCode===null){const exited=new Promise(r=>child.once('exit',r));child.kill();await exited;}fs.rmSync(root,{recursive:true,force:true});}
});

test('failed atomic replacement preserves destination and removes its own temporary file',()=>{
 fs.mkdirSync(family,{recursive:true});const root=fs.mkdtempSync(path.join(family,'atomic-failure-'));
 try {
  const file=path.join(root,'summary.json');fs.mkdirSync(file);fs.writeFileSync(path.join(file,'owned'),'keep');
  assert.throws(()=>atomicJson(file,{generation:2}));
  assert.equal(fs.readFileSync(path.join(file,'owned'),'utf8'),'keep');
  assert.deepEqual(fs.readdirSync(root),['summary.json']);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
