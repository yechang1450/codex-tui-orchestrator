import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const family=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../temp');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
test('nine independent parent processes contend for eight shared slots without lost updates',async()=>{
 fs.mkdirSync(family,{recursive:true});const dir=fs.mkdtempSync(path.join(family,'cross-process-'));
 const module=new URL('../scripts/core/leases.mjs',import.meta.url).href;
 const worker=path.join(dir,'worker.mjs');
 fs.writeFileSync(worker,`import fs from 'node:fs';import path from 'node:path';import {reserve,release} from ${JSON.stringify(module)};
 const dir=process.argv[2],id=process.argv[3];
 try{const result=reserve(dir,{id,runId:id,keys:['test:'+id]},8);fs.writeFileSync(path.join(dir,id+'.json'),JSON.stringify(result));
 while(!fs.existsSync(path.join(dir,'release')))await new Promise(r=>setTimeout(r,50));
 if(result.ok)release(dir,id);
 }catch(e){fs.writeFileSync(path.join(dir,id+'.json'),JSON.stringify({error:e.message}));process.exitCode=1;}`);
 const children=Array.from({length:9},(_,i)=>spawn(process.execPath,[worker,dir,'run'+i],{windowsHide:true,stdio:'ignore'}));
 const exits=children.map(c=>new Promise(resolve=>{c.once('exit',resolve);c.once('error',()=>resolve(-1));}));
 try{
  const deadline=Date.now()+60000;
  while(children.some((_,i)=>!fs.existsSync(path.join(dir,'run'+i+'.json')))&&Date.now()<deadline)await pause(100);
  const results=children.map((_,i)=>JSON.parse(fs.readFileSync(path.join(dir,'run'+i+'.json'),'utf8')));
  assert.equal(results.filter(r=>r.ok).length,8,JSON.stringify(results));
  assert.equal(results.filter(r=>r.reason==='capacity').length,1,JSON.stringify(results));
  const leases=JSON.parse(fs.readFileSync(path.join(dir,'leases.json'),'utf8'));
  assert.equal(new Set(leases.map(l=>l.runId)).size,8);
 }finally{
  fs.writeFileSync(path.join(dir,'release'),'release');
  await Promise.all(exits);
  await pause(500);
  fs.rmSync(dir,{recursive:true,force:true});
 }
});
