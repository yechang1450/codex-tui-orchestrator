import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {verifyRelease} from '../scripts/release-integrity.mjs';
const source=fileURLToPath(new URL('..',import.meta.url));

test('clean published package runs doctor and guards its public polling entry',()=>{
 const family=path.join(source,'temp');fs.mkdirSync(family,{recursive:true});
 const root=fs.mkdtempSync(path.join(family,'package-acceptance-'));
 try{
  // A sibling of the copied fixture source avoids publishing into a source tree.
  const fixture=path.join(root,'candidate');
  fs.mkdirSync(fixture);
  for(const name of ['scripts','skills','.codex-plugin','assets','docs'])fs.cpSync(path.join(source,name),path.join(fixture,name),{recursive:true,filter:p=>!['node_modules','temp','.agent-cache.json'].includes(path.basename(p))});
  for(const name of ['repair.mjs','release.json','README.md','LICENSE'])fs.copyFileSync(path.join(source,name),path.join(fixture,name));
  const run=(file,args=[])=>spawnSync(process.execPath,[file,...args],{cwd:root,env:{...process.env,ORCH_AUTO_INSTALL_DEPS:'0'},encoding:'utf8',windowsHide:true,timeout:30000});
  const fault='import fs from "node:fs";const copy=fs.copyFileSync;let n=0;fs.copyFileSync=(...args)=>{if(++n===2)throw new Error("TEST_COPY_FAILURE");return copy(...args)};';
  const failed=spawnSync(process.execPath,['--import','data:text/javascript,'+encodeURIComponent(fault),path.join(fixture,'repair.mjs'),'--target',path.join(root,'failed-publication')],{cwd:root,encoding:'utf8',windowsHide:true,timeout:30000});
  assert.equal(failed.status,2);assert.match(failed.stderr,/TEST_COPY_FAILURE/);
  assert.deepEqual(fs.readdirSync(path.join(root,'failed-publication')),[]);
  const publication=run(path.join(fixture,'repair.mjs'),['--target',path.join(root,'published')]);
  assert.equal(publication.status,0,publication.stderr);
  const pkg=path.join(root,'published','candidate');
  assert.deepEqual(verifyRelease(pkg),verifyRelease(source));
  const previousManifest=fs.readFileSync(path.join(pkg,'release.json'));
  for(const required of ['README.md','LICENSE']){
   const omit='import fs from "node:fs";import path from "node:path";const copy=fs.copyFileSync;fs.copyFileSync=(...args)=>{if(path.basename(args[0])==='+JSON.stringify(required)+')return;return copy(...args)};';
   const destination=path.join(root,'missing-'+required);
   const incomplete=spawnSync(process.execPath,['--import','data:text/javascript,'+encodeURIComponent(omit),path.join(fixture,'repair.mjs'),'--target',destination],{cwd:root,encoding:'utf8',windowsHide:true,timeout:30000});
   assert.equal(incomplete.status,2,'must reject staged package without '+required);
   assert.match(incomplete.stderr,/Staged package missing required/);
   assert.deepEqual(fs.readdirSync(destination),[],'failed stage must be removed');
   assert.ok(fs.readFileSync(path.join(pkg,'release.json')).equals(previousManifest));
   assert.deepEqual(verifyRelease(pkg),verifyRelease(source),'previous release remains valid');
  }
  for(const required of ['docs/privacy.md','docs/terms.md']){
   const omit='import fs from "node:fs";const copy=fs.copyFileSync;fs.copyFileSync=(...args)=>{if(String(args[0]).replaceAll("\\\\","/").endsWith('+JSON.stringify(required)+'))return;return copy(...args)};';
   const destination=path.join(root,'missing-'+path.basename(required,'.md'));
   const incomplete=spawnSync(process.execPath,['--import','data:text/javascript,'+encodeURIComponent(omit),path.join(fixture,'repair.mjs'),'--target',destination],{cwd:root,encoding:'utf8',windowsHide:true,timeout:30000});
   assert.equal(incomplete.status,2,'must reject staged package without '+required);
   assert.match(incomplete.stderr,/Staged package missing required/);
   assert.deepEqual(fs.readdirSync(destination),[],'failed stage must be removed');
   assert.deepEqual(verifyRelease(pkg),verifyRelease(source),'previous release remains valid');
  }
  const next=run(path.join(fixture,'repair.mjs'),['--target',path.join(root,'next-version')]);
  assert.equal(next.status,0,next.stderr);assert.deepEqual(verifyRelease(path.join(root,'next-version','candidate')),verifyRelease(pkg));
  for(const name of ['.git','temp','.plugin-eval','node_modules'])assert.equal(fs.existsSync(path.join(pkg,name)),false);
  const missing=run(path.join(pkg,'scripts','orchestrate-sdk.mjs'),['--doctor']);
  assert.notEqual(missing.status,0);assert.match(missing.stderr,/RELEASE_DEPENDENCY_MISSING.*npm ci/);
  const missingSupervisor=run(path.join(pkg,'scripts','supervise.mjs'),['--help']);
  assert.notEqual(missingSupervisor.status,0);assert.match(missingSupervisor.stderr,/RELEASE_DEPENDENCY_MISSING.*npm ci/);
  const noSdkPoll=run(path.join(pkg,'scripts','poll-windows.mjs'),['--run-id','no-sdk-test','--timeoutMs','0']);
  assert.equal(noSdkPoll.status,1);assert.match(noSdkPoll.stderr,/timeout runId=no-sdk-test/);
  // Install the already-tested SDK fixture without downloading or copying CLI binaries.
  fs.cpSync(path.join(source,'scripts','node_modules','@openai','codex-sdk'),path.join(pkg,'scripts','node_modules','@openai','codex-sdk'),{recursive:true});
  const sdkManifest=path.join(pkg,'scripts','node_modules','@openai','codex-sdk','package.json');
  const original=fs.readFileSync(sdkManifest,'utf8');
  fs.writeFileSync(sdkManifest,JSON.stringify({...JSON.parse(original),version:'0.0.0-test'}));
  const mismatch=run(path.join(pkg,'scripts','orchestrate-sdk.mjs'),['--doctor']);
  assert.notEqual(mismatch.status,0);assert.match(mismatch.stderr,/RELEASE_DEPENDENCY_VERSION/);
  const mismatchSupervisor=run(path.join(pkg,'scripts','supervise.mjs'),['--help']);
  assert.notEqual(mismatchSupervisor.status,0);assert.match(mismatchSupervisor.stderr,/RELEASE_DEPENDENCY_VERSION/);
  fs.writeFileSync(sdkManifest,original);
  const sdkEntry=path.join(path.dirname(sdkManifest),'dist','index.js');
  const entryBytes=fs.readFileSync(sdkEntry);fs.unlinkSync(sdkEntry);
  const missingEntry=run(path.join(pkg,'scripts','orchestrate-sdk.mjs'),['--doctor']);
  assert.notEqual(missingEntry.status,0);assert.match(missingEntry.stderr,/RELEASE_DEPENDENCY_DAMAGED/);
  fs.writeFileSync(sdkEntry,entryBytes);
  for(const damaged of ['export const broken = ;','export const unrelated = true;','export class Codex {}','import "./missing-runtime-module.js";']){
   fs.writeFileSync(sdkEntry,damaged);
   const unusable=run(path.join(pkg,'scripts','orchestrate-sdk.mjs'),['--doctor']);
   assert.notEqual(unusable.status,0);assert.match(unusable.stderr,/RELEASE_DEPENDENCY_DAMAGED: SDK cannot load or lacks required interfaces.*npm ci/);
   const unusableSupervisor=run(path.join(pkg,'scripts','supervise.mjs'),['--help']);
   assert.notEqual(unusableSupervisor.status,0);assert.match(unusableSupervisor.stderr,/RELEASE_DEPENDENCY_DAMAGED: SDK cannot load or lacks required interfaces.*npm ci/);
  }
  fs.writeFileSync(sdkEntry,entryBytes);
  fs.writeFileSync(sdkManifest,'{');
  const damagedManifest=run(path.join(pkg,'scripts','orchestrate-sdk.mjs'),['--doctor']);
  assert.notEqual(damagedManifest.status,0);assert.match(damagedManifest.stderr,/RELEASE_DEPENDENCY_DAMAGED/);
  fs.writeFileSync(sdkManifest,original);
  const doctor=run(path.join(pkg,'scripts','orchestrate-sdk.mjs'),['--doctor']);
  assert.equal(doctor.status,0,doctor.stderr+'\n'+doctor.stdout);
  const supervisorHelp=run(path.join(pkg,'scripts','supervise.mjs'),['--help']);
  assert.equal(supervisorHelp.status,0,supervisorHelp.stderr);
  fs.appendFileSync(path.join(pkg,'scripts','host-cli.mjs'),'\n// test drift');
  const poll=run(path.join(pkg,'scripts','poll-windows.mjs'),['--status','--readonly']);
  assert.notEqual(poll.status,0);assert.match(poll.stderr,/RELEASE_INTEGRITY_FAILED/);
  const changedSupervisor=run(path.join(pkg,'scripts','supervise.mjs'),['--help']);
  assert.notEqual(changedSupervisor.status,0);assert.match(changedSupervisor.stderr,/RELEASE_INTEGRITY_FAILED/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
