import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {coreInventory,verifyRelease,runtimeInventory} from '../scripts/release-integrity.mjs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('sealing rejects CRLF runtime text before replacing the release manifest',()=>{
 const base=path.join(process.cwd(),'temp');fs.mkdirSync(base,{recursive:true});const root=fs.mkdtempSync(path.join(base,'release-eol-'));
 try{
  for(const dir of ['.codex-plugin','scripts/core','skills'])fs.mkdirSync(path.join(root,dir),{recursive:true});
  for(const file of ['release-integrity.mjs','dependency-integrity.mjs'])fs.copyFileSync(fileURLToPath(new URL('../scripts/'+file,import.meta.url)),path.join(root,'scripts',file));
  fs.mkdirSync(path.join(root,'scripts','node_modules','@openai','codex-sdk'),{recursive:true});
  fs.writeFileSync(path.join(root,'scripts/package-lock.json'),'{"lockfileVersion":3}\n');
  fs.writeFileSync(path.join(root,'scripts/node_modules','@openai','codex-sdk','package.json'),'{"name":"@openai/codex-sdk"}\n');
  fs.writeFileSync(path.join(root,'scripts/node_modules','@openai','codex-sdk','index.js'),'export const ready = true;\n');
  fs.writeFileSync(path.join(root,'scripts/core/contracts.mjs'),"export const CORE_VERSION='test';\n");
  fs.writeFileSync(path.join(root,'scripts/core/orchestrate-sdk.mjs'),'// entry\n');
  fs.writeFileSync(path.join(root,'repair.mjs'),'// repair\n');
  const manifest=path.join(root,'.codex-plugin/plugin.json');fs.writeFileSync(manifest,'{\r\n  "name": "fixture"\r\n}\r\n');
  fs.writeFileSync(path.join(root,'release.json'),'previous seal');
  const dependency=spawnSync(process.execPath,[path.join(root,'scripts/dependency-integrity.mjs'),'--seal'],{encoding:'utf8',windowsHide:true});assert.equal(dependency.status,0,dependency.stderr);
  const seal=()=>spawnSync(process.execPath,[path.join(root,'scripts/release-integrity.mjs'),'--seal'],{encoding:'utf8',windowsHide:true});
  const rejected=seal();assert.notEqual(rejected.status,0);assert.match(rejected.stderr,/RELEASE_NONCANONICAL_LINE_ENDINGS.*plugin\.json/);
  assert.equal(fs.readFileSync(path.join(root,'release.json'),'utf8'),'previous seal');
  fs.writeFileSync(manifest,fs.readFileSync(manifest,'utf8').replaceAll('\r\n','\n'));
  const accepted=seal();assert.equal(accepted.status,0,accepted.stderr);assert.equal(verifyRelease(root).schema,2);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('sealing refuses a stale dependency seal without replacing release.json',()=>{
 const base=path.join(process.cwd(),'temp');fs.mkdirSync(base,{recursive:true});const root=fs.mkdtempSync(path.join(base,'release-dependency-order-'));
 try{
  for(const dir of ['scripts/core','scripts/node_modules/@openai/codex-sdk'])fs.mkdirSync(path.join(root,dir),{recursive:true});
  for(const file of ['release-integrity.mjs','dependency-integrity.mjs'])fs.copyFileSync(fileURLToPath(new URL('../scripts/'+file,import.meta.url)),path.join(root,'scripts',file));
  fs.writeFileSync(path.join(root,'scripts/core/contracts.mjs'),"export const CORE_VERSION='test';\n");
  fs.writeFileSync(path.join(root,'scripts/core/orchestrate-sdk.mjs'),'// entry\n');
  fs.writeFileSync(path.join(root,'scripts/package-lock.json'),'{"lockfileVersion":3}\n');
  fs.writeFileSync(path.join(root,'scripts/node_modules/@openai/codex-sdk/package.json'),'{"name":"@openai/codex-sdk"}\n');
  fs.writeFileSync(path.join(root,'scripts/node_modules/@openai/codex-sdk/index.js'),'export const ready = true;\n');
  const dependencySeal=()=>spawnSync(process.execPath,[path.join(root,'scripts/dependency-integrity.mjs'),'--seal'],{encoding:'utf8',windowsHide:true});
  const releaseSeal=()=>spawnSync(process.execPath,[path.join(root,'scripts/release-integrity.mjs'),'--seal'],{encoding:'utf8',windowsHide:true});
  const initial=dependencySeal();assert.equal(initial.status,0,initial.stderr);
  fs.writeFileSync(path.join(root,'scripts/package-lock.json'),'{"lockfileVersion":4}\n');
  const previous='previous outer seal\n';fs.writeFileSync(path.join(root,'release.json'),previous);
  const rejected=releaseSeal();assert.notEqual(rejected.status,0);assert.match(rejected.stderr,/RELEASE_DEPENDENCY_INTEGRITY.*package-lock\.json/);
  assert.equal(fs.readFileSync(path.join(root,'release.json'),'utf8'),previous);
  const resealed=dependencySeal();assert.equal(resealed.status,0,resealed.stderr);
  const accepted=releaseSeal();assert.equal(accepted.status,0,accepted.stderr);
  assert.equal(verifyRelease(root).schema,2);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('distribution sealing requires explicit verified source provenance when dependencies are omitted',()=>{
 const base=path.join(process.cwd(),'temp');fs.mkdirSync(base,{recursive:true});const root=fs.mkdtempSync(path.join(base,'release-distribution-provenance-'));
 const source=path.join(root,'source'),dist=path.join(root,'dist');
 const sha256=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
 try{
  for(const dir of ['scripts/core','scripts/node_modules/@openai/codex-sdk'])fs.mkdirSync(path.join(source,dir),{recursive:true});
  for(const file of ['release-integrity.mjs','dependency-integrity.mjs'])fs.copyFileSync(fileURLToPath(new URL('../scripts/'+file,import.meta.url)),path.join(source,'scripts',file));
  fs.writeFileSync(path.join(source,'scripts/core/contracts.mjs'),"export const CORE_VERSION='test';\n");
  fs.writeFileSync(path.join(source,'scripts/core/orchestrate-sdk.mjs'),'// entry\n');
  fs.writeFileSync(path.join(source,'scripts/package-lock.json'),'{"lockfileVersion":3}\n');
  fs.writeFileSync(path.join(source,'scripts/node_modules/@openai/codex-sdk/package.json'),'{"name":"@openai/codex-sdk"}\n');
  fs.writeFileSync(path.join(source,'scripts/node_modules/@openai/codex-sdk/index.js'),'export const ready = true;\n');
  const sourceDependency=spawnSync(process.execPath,[path.join(source,'scripts/dependency-integrity.mjs'),'--seal'],{encoding:'utf8',windowsHide:true});assert.equal(sourceDependency.status,0,sourceDependency.stderr);
  const sourceRelease=spawnSync(process.execPath,[path.join(source,'scripts/release-integrity.mjs'),'--seal'],{encoding:'utf8',windowsHide:true});assert.equal(sourceRelease.status,0,sourceRelease.stderr);
  fs.cpSync(source,dist,{recursive:true,filter:file=>path.basename(file)!=='node_modules'});
  const previous='previous distribution seal\n';fs.writeFileSync(path.join(dist,'release.json'),previous);
  const seal=args=>spawnSync(process.execPath,[path.join(dist,'scripts/release-integrity.mjs'),...args],{encoding:'utf8',windowsHide:true});
  const missingProof=seal(['--seal','--distribution']);assert.notEqual(missingProof.status,0);assert.match(missingProof.stderr,/RELEASE_DISTRIBUTION_PROVENANCE.*distribution-provenance/i);
  assert.equal(fs.readFileSync(path.join(dist,'release.json'),'utf8'),previous,'distribution mode must require explicit source provenance');
  const sourceDependencyManifest=path.join(source,'scripts/dependency-integrity.json');
  const dependency=JSON.parse(fs.readFileSync(sourceDependencyManifest,'utf8'));
  fs.copyFileSync(path.join(source,'release.json'),path.join(dist,'scripts/distribution-source-release.json'));
  fs.writeFileSync(path.join(dist,'scripts/distribution-provenance.json'),JSON.stringify({
   schema:1,
   sourceReleaseSha256:sha256(path.join(source,'release.json')),
   sourceDependencyManifestSha256:sha256(sourceDependencyManifest),
   packageLockSha256:dependency.packageLockSha256,
   dependencyFiles:Object.keys(dependency.files).length,
  },null,2)+'\n');
  const strict=seal(['--seal']);assert.notEqual(strict.status,0);assert.match(strict.stderr,/RELEASE_DEPENDENCY_INTEGRITY.*node_modules/i);
  assert.equal(fs.readFileSync(path.join(dist,'release.json'),'utf8'),previous,'ordinary sealing must not infer distribution mode from a missing tree');
  const distribution=seal(['--seal','--distribution']);assert.equal(distribution.status,0,distribution.stderr);
  assert.equal(verifyRelease(dist).schema,2);
  const sealed=fs.readFileSync(path.join(dist,'release.json'),'utf8');
  const malformed={...dependency,packageLockSha256:'0'.repeat(64)};
  fs.writeFileSync(path.join(dist,'scripts/dependency-integrity.json'),JSON.stringify(malformed,null,2)+'\n');
  const rejected=seal(['--seal','--distribution']);assert.notEqual(rejected.status,0);assert.match(rejected.stderr,/RELEASE_DISTRIBUTION_PROVENANCE.*dependency-integrity/i);
  assert.equal(fs.readFileSync(path.join(dist,'release.json'),'utf8'),sealed,'invalid provenance must not replace a valid distribution release');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('release verification rejects changed and injected core files',()=>{
 const base=path.join(process.cwd(),'temp');fs.mkdirSync(base,{recursive:true});const root=fs.mkdtempSync(path.join(base,'release-test-'));
 try{const core=path.join(root,'scripts','core');fs.mkdirSync(core,{recursive:true});
 fs.writeFileSync(path.join(core,'contracts.mjs'),'original');fs.writeFileSync(path.join(core,'orchestrate-sdk.mjs'),'entry');
 fs.writeFileSync(path.join(root,'release.json'),JSON.stringify({schema:2,coreVersion:'test',files:coreInventory(root),runtimeFiles:runtimeInventory(root)}));
 assert.equal(verifyRelease(root).files,2);fs.writeFileSync(path.join(core,'contracts.mjs'),'changed');assert.throws(()=>verifyRelease(root),/INTEGRITY_FAILED/);
 fs.writeFileSync(path.join(core,'contracts.mjs'),'original');fs.writeFileSync(path.join(core,'injected.mjs'),'extra');assert.throws(()=>verifyRelease(root),/INTEGRITY_FAILED/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('runtime seal rejects a changed local marketplace catalog',()=>{
 const base=path.join(process.cwd(),'temp');fs.mkdirSync(base,{recursive:true});const root=fs.mkdtempSync(path.join(base,'marketplace-seal-'));
 try{
  const core=path.join(root,'scripts','core');fs.mkdirSync(core,{recursive:true});
  fs.mkdirSync(path.join(root,'.agents','plugins'),{recursive:true});
  fs.writeFileSync(path.join(core,'contracts.mjs'),'original');fs.writeFileSync(path.join(core,'orchestrate-sdk.mjs'),'entry');
  const catalog=path.join(root,'.agents','plugins','marketplace.json');
  fs.writeFileSync(catalog,'{"name":"trusted"}\n');
  const snapshot=runtimeInventory(root);
  assert.equal(snapshot['.agents/plugins/marketplace.json'],crypto.createHash('sha256').update('{"name":"trusted"}\n').digest('hex'));
  fs.writeFileSync(path.join(root,'release.json'),JSON.stringify({schema:2,coreVersion:'test',files:coreInventory(root),runtimeFiles:snapshot}));
  verifyRelease(root);
  fs.writeFileSync(catalog,'{"name":"redirected"}\n');
  assert.throws(()=>verifyRelease(root),/RELEASE_INTEGRITY_FAILED/);
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
