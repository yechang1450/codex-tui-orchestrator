import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {coreInventory,verifyRelease,runtimeInventory} from '../scripts/release-integrity.mjs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('sealing rejects CRLF runtime text before replacing the release manifest',()=>{
 const base=path.join(process.cwd(),'temp');fs.mkdirSync(base,{recursive:true});const root=fs.mkdtempSync(path.join(base,'release-eol-'));
 try{
  for(const dir of ['.codex-plugin','scripts/core','skills'])fs.mkdirSync(path.join(root,dir),{recursive:true});
  fs.copyFileSync(fileURLToPath(new URL('../scripts/release-integrity.mjs',import.meta.url)),path.join(root,'scripts/release-integrity.mjs'));
  fs.writeFileSync(path.join(root,'scripts/core/contracts.mjs'),"export const CORE_VERSION='test';\n");
  fs.writeFileSync(path.join(root,'scripts/core/orchestrate-sdk.mjs'),'// entry\n');
  fs.writeFileSync(path.join(root,'repair.mjs'),'// repair\n');
  const manifest=path.join(root,'.codex-plugin/plugin.json');fs.writeFileSync(manifest,'{\r\n  "name": "fixture"\r\n}\r\n');
  fs.writeFileSync(path.join(root,'release.json'),'previous seal');
  const seal=()=>spawnSync(process.execPath,[path.join(root,'scripts/release-integrity.mjs'),'--seal'],{encoding:'utf8',windowsHide:true});
  const rejected=seal();assert.notEqual(rejected.status,0);assert.match(rejected.stderr,/RELEASE_NONCANONICAL_LINE_ENDINGS.*plugin\.json/);
  assert.equal(fs.readFileSync(path.join(root,'release.json'),'utf8'),'previous seal');
  fs.writeFileSync(manifest,fs.readFileSync(manifest,'utf8').replaceAll('\r\n','\n'));
  const accepted=seal();assert.equal(accepted.status,0,accepted.stderr);assert.equal(verifyRelease(root).schema,2);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('release verification rejects changed and injected core files',()=>{
 const base=path.join(process.cwd(),'temp');fs.mkdirSync(base,{recursive:true});const root=fs.mkdtempSync(path.join(base,'release-test-'));
 try{const core=path.join(root,'scripts','core');fs.mkdirSync(core,{recursive:true});
 fs.writeFileSync(path.join(core,'contracts.mjs'),'original');fs.writeFileSync(path.join(core,'orchestrate-sdk.mjs'),'entry');
 fs.writeFileSync(path.join(root,'release.json'),JSON.stringify({schema:1,coreVersion:'test',files:coreInventory(root)}));
 assert.equal(verifyRelease(root).files,2);fs.writeFileSync(path.join(core,'contracts.mjs'),'changed');assert.throws(()=>verifyRelease(root),/INTEGRITY_FAILED/);
 fs.writeFileSync(path.join(core,'contracts.mjs'),'original');fs.writeFileSync(path.join(core,'injected.mjs'),'extra');assert.throws(()=>verifyRelease(root),/INTEGRITY_FAILED/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('publisher excludes git and runtime debris and refuses an existing release',()=>{
 const base=path.join(process.cwd(),'temp');fs.mkdirSync(base,{recursive:true});const root=fs.mkdtempSync(path.join(base,'publish-test-'));
 try{
  const source=path.join(root,'source'),target=path.join(root,'published');
  fs.mkdirSync(path.join(source,'scripts','core'),{recursive:true});fs.mkdirSync(path.join(source,'.git'));fs.mkdirSync(path.join(source,'temp'));
  for(const [name,text] of Object.entries({'README.md':'readme','LICENSE':'license','SKILL.md':'skill','.git/config':'private metadata','temp/junk':'runtime','scripts/core/contracts.mjs':'core'}))fs.writeFileSync(path.join(source,name),text);
  fs.copyFileSync(fileURLToPath(new URL('../repair.mjs',import.meta.url)),path.join(source,'repair.mjs'));
  fs.copyFileSync(fileURLToPath(new URL('../scripts/release-integrity.mjs',import.meta.url)),path.join(source,'scripts','release-integrity.mjs'));
  fs.copyFileSync(fileURLToPath(new URL('../scripts/core/runtime-context.mjs',import.meta.url)),path.join(source,'scripts','core','runtime-context.mjs'));
  fs.writeFileSync(path.join(source,'scripts','core','orchestrate-sdk.mjs'),'entry');
  fs.mkdirSync(path.join(source,'.codex-plugin'));fs.mkdirSync(path.join(source,'skills'));
  fs.mkdirSync(path.join(source,'skills','source'));fs.writeFileSync(path.join(source,'skills','source','SKILL.md'),'skill');
  fs.writeFileSync(path.join(source,'.codex-plugin','plugin.json'),'{}');
  fs.writeFileSync(path.join(source,'release.json'),JSON.stringify({schema:2,coreVersion:'test',files:coreInventory(source),runtimeFiles:runtimeInventory(source)}));
  const publish=()=>spawnSync(process.execPath,[path.join(source,'repair.mjs'),'--target',target],{encoding:'utf8',windowsHide:true});
  const first=publish();assert.equal(first.status,0,first.stderr);assert.ok(fs.existsSync(path.join(target,'source','scripts','core','contracts.mjs')));
  assert.equal(fs.existsSync(path.join(target,'source','.git')),false);assert.equal(fs.existsSync(path.join(target,'source','temp')),false);
  assert.equal(publish().status,2);
  const alias=path.join(root,'source-alias');fs.symlinkSync(source,alias,'junction');
  const aliased=spawnSync(process.execPath,[path.join(source,'repair.mjs'),'--target',path.join(alias,'nested')],{encoding:'utf8',windowsHide:true});
  assert.equal(aliased.status,2);assert.match(aliased.stderr,/(outside the source tree|symbolic link|junction|reparse point)/);
  assert.equal(fs.existsSync(path.join(source,'nested')),false);
  const dotNamed=spawnSync(process.execPath,[path.join(source,'repair.mjs'),'--target',path.join(source,'..named')],{encoding:'utf8',windowsHide:true});
  assert.equal(dotNamed.status,2);assert.match(dotNamed.stderr,/outside the source tree/);
  assert.equal(fs.existsSync(path.join(source,'..named')),false);
  const clean=spawnSync(process.execPath,[path.join(source,'repair.mjs'),'--clean'],{encoding:'utf8',windowsHide:true});
  assert.equal(clean.status,0,clean.stderr);
  assert.equal(fs.readFileSync(path.join(source,'.git','config'),'utf8'),'private metadata');
  assert.equal(fs.readFileSync(path.join(source,'temp','junk'),'utf8'),'runtime');
  fs.appendFileSync(path.join(source,'scripts','release-integrity.mjs'),'\n// drift');
  assert.throws(()=>verifyRelease(source),/INTEGRITY_FAILED/);
  const bad=spawnSync(process.execPath,[path.join(source,'repair.mjs'),'--target',path.join(root,'invalid-release')],{encoding:'utf8',windowsHide:true});
  assert.equal(bad.status,2);assert.equal(fs.existsSync(path.join(root,'invalid-release')),false);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
