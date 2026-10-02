import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {coordinatorDir} from '../scripts/core/leases.mjs';
import {controllerStateDir} from '../scripts/core/controller-state.mjs';
import {controllerWindowsDir} from '../scripts/core/controller-state.mjs';
const family=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../temp');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
test('Codex default coordinator is isolated from the generic TUI pool',()=>{
 const workspace=path.resolve(family,'..'),env={...process.env,ORCH_COORDINATOR_DIR:''};
 const dir=coordinatorDir(workspace,env);
 assert.equal(path.basename(dir),'codex-coordinator');
 assert.notEqual(dir,path.join(workspace,'temp','orchestrator','coordinator'));
 if(process.platform==='win32')assert.equal(coordinatorDir(path.join(workspace,'other-workspace'),env),dir);
});
test('default coordinator authority stays outside a child-writable workspace',()=>{
 fs.mkdirSync(family,{recursive:true});const root=fs.mkdtempSync(path.join(family,'coordinator-authority-'));
 try{
  const workspace=path.join(root,'workspace'),codexHome=path.join(root,'codex-home');
  fs.mkdirSync(workspace);fs.mkdirSync(codexHome);
  const env={...process.env,CODEX_HOME:codexHome,ORCH_COORDINATOR_DIR:''};
  const dir=coordinatorDir(workspace,env);
  assert.ok(dir.startsWith(path.join(codexHome,'state','plugins','codex-tui-orchestrator')));
  assert.equal(coordinatorDir(path.join(root,'other-workspace'),env),dir);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('explicit coordinator refuses a symlink or junction in its path',()=>{
 fs.mkdirSync(family,{recursive:true});const root=fs.mkdtempSync(path.join(family,'coordinator-link-'));
 try{
  const workspace=path.join(root,'workspace');fs.mkdirSync(workspace);
  const real=path.join(root,'real');fs.mkdirSync(real);
  const link=path.join(root,'linked');
  try{fs.symlinkSync(real,link,'junction');}catch{try{fs.symlinkSync(real,link,'dir');}catch{return;}}
  assert.throws(()=>coordinatorDir(workspace,{ORCH_COORDINATOR_DIR:path.join(link,'pool')}),/symbolic link|junction|reparse/i);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('Windows short aliases cannot place controller or coordinator state inside a workspace',t=>{
 if(process.platform!=='win32')return t.skip('Windows 8.3 path aliases only');
 fs.mkdirSync(family,{recursive:true});const root=fs.mkdtempSync(path.join(family,'short-alias-family-'));
 try{
  const workspace=path.join(root,'long-workspace-directory-name');fs.mkdirSync(workspace);
  if(workspace.includes(' '))return t.skip('short-path fixture requires a workspace without spaces');
  const result=spawnSync('cmd.exe',['/d','/c',`for %I in (${workspace}) do @echo %~sI`],{encoding:'utf8',windowsHide:true});
  assert.equal(result.status,0,result.stderr);
  const alias=result.stdout.trim();
  if(alias.toLowerCase()===workspace.toLowerCase())return t.skip('8.3 aliases are unavailable on this volume');
  assert.equal(fs.realpathSync.native(alias).toLowerCase(),fs.realpathSync.native(workspace).toLowerCase());
  assert.throws(()=>controllerStateDir(workspace,{CODEX_HOME:alias}),/inside the initiating workspace/i);
  assert.throws(()=>controllerStateDir(workspace,{ORCH_CONTROLLER_ROOT:path.join(alias,'not-yet-created')}),/inside the initiating workspace/i);
  assert.throws(()=>coordinatorDir(workspace,{ORCH_COORDINATOR_DIR:path.join(alias,'not-yet-created')}),/inside the initiating workspace/i);
  const external=path.join(root,'external-not-yet-created');
  assert.equal(controllerStateDir(workspace,{ORCH_CONTROLLER_ROOT:external}),external);
  assert.equal(coordinatorDir(workspace,{ORCH_COORDINATOR_DIR:external}),external);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('local UNC aliases share controller identity and conflict keys with the drive path',t=>{
 if(process.platform!=='win32')return t.skip('Windows UNC aliases only');
 const workspace=path.resolve(family,'..');
 const unc='\\\\localhost\\c$'+workspace.slice(2);
 try {
  if(fs.realpathSync.native(unc).toLowerCase()===unc.toLowerCase())return t.skip('UNC alias unavailable');
  assert.equal(controllerWindowsDir(workspace),controllerWindowsDir(unc));
  assert.equal(coordinatorDir(workspace),coordinatorDir(unc));
 } catch (error) { return t.skip('UNC administrative share unavailable: '+error.message); }
});
for(const [parents,capacity] of [[9,8],[12,4],[40,16]])test(`${parents} independent parent processes contend for ${capacity} shared slots without lost updates`,async()=>{
 fs.mkdirSync(family,{recursive:true});const dir=fs.mkdtempSync(path.join(family,'cross-process-'));
 const module=new URL('../scripts/core/leases.mjs',import.meta.url).href;
 const worker=path.join(dir,'worker.mjs');
 fs.writeFileSync(worker,`import fs from 'node:fs';import path from 'node:path';import {reserve,release} from ${JSON.stringify(module)};
 const dir=process.argv[2],id=process.argv[3];
 try{const result=reserve(dir,{id,runId:id,keys:['test:'+id]},${capacity});fs.writeFileSync(path.join(dir,id+'.json'),JSON.stringify(result));
 while(!fs.existsSync(path.join(dir,'release')))await new Promise(r=>setTimeout(r,50));
 if(result.ok)release(dir,id);
 }catch(e){fs.writeFileSync(path.join(dir,id+'.json'),JSON.stringify({error:e.message}));process.exitCode=1;}`);
 const children=Array.from({length:parents},(_,i)=>spawn(process.execPath,[worker,dir,'run'+i],{windowsHide:true,stdio:'ignore'}));
 const exits=children.map(c=>new Promise(resolve=>{c.once('exit',resolve);c.once('error',()=>resolve(-1));}));
 try{
  // A burst of independent Windows processes serializes CIM identity
  // snapshots behind the named mutex. The production bound is 120s, so the
  // acceptance window must cover that bound instead of failing while valid
  // contenders are still waiting in the bounded queue.
  const deadline=Date.now()+180000;
  while(children.some((_,i)=>!fs.existsSync(path.join(dir,'run'+i+'.json')))&&Date.now()<deadline)await pause(100);
  const results=children.map((_,i)=>JSON.parse(fs.readFileSync(path.join(dir,'run'+i+'.json'),'utf8')));
  assert.equal(results.filter(r=>r.ok).length,capacity,JSON.stringify(results));
  assert.equal(results.filter(r=>r.reason==='capacity').length,parents-capacity,JSON.stringify(results));
  const leases=JSON.parse(fs.readFileSync(path.join(dir,'leases.json'),'utf8'));
  assert.equal(new Set(leases.map(l=>l.runId)).size,capacity);
 }finally{
  fs.writeFileSync(path.join(dir,'release'),'release');
  await Promise.all(exits);
  await pause(500);
  fs.rmSync(dir,{recursive:true,force:true});
 }
});
