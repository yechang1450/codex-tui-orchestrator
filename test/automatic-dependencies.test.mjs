import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {ensureRuntimeDependencies,installLockedDependencies} from '../scripts/entry-bootstrap.mjs';
const missing={ok:false,code:'RELEASE_DEPENDENCY_MISSING',message:'missing locked SDK'};
const npmEntry=fileURLToPath(import.meta.url);
const npmDigest=crypto.createHash('sha256').update(fs.readFileSync(npmEntry)).digest('hex');
const trustedNpm={ORCH_NPM_TRUSTED:'1',npm_execpath:npmEntry,ORCH_NPM_TRUSTED_PATH:npmEntry,ORCH_NPM_TRUSTED_SHA256:npmDigest};
test('first use installs missing SDK once and verifies before continuing',async()=>{
  let calls=0,installed=0;
  const result=await ensureRuntimeDependencies({env:trustedNpm,verify:async()=>++calls===1?missing:{ok:true},install:async()=>installed++});
  assert.equal(result.ok,true);assert.equal(calls,2);assert.equal(installed,1);
});
test('healthy dependencies are idempotent and failed installs stop execution',async()=>{
  await ensureRuntimeDependencies({env:{},verify:async()=>({ok:true}),install:async()=>assert.fail('unnecessary installation')});
  await assert.rejects(ensureRuntimeDependencies({env:trustedNpm,verify:async()=>missing,install:async()=>{throw new Error('install failed');}}),/install failed/);
  await assert.rejects(ensureRuntimeDependencies({env:{ORCH_AUTO_INSTALL_DEPS:'0'},verify:async()=>missing,install:async()=>assert.fail('opted out')}),/missing locked SDK/);
});
test('untrusted npm cannot restore missing SDK automatically',async()=>{
  await assert.rejects(ensureRuntimeDependencies({env:{},verify:async()=>missing,install:async()=>assert.fail('untrusted npm must not run')}),/NPM_UNTRUSTED/);
  await assert.rejects(ensureRuntimeDependencies({env:{ORCH_NPM_TRUSTED:'1'},verify:async()=>missing,install:async()=>assert.fail('npm entry is absent')}),/NPM_UNTRUSTED/);
});
test('explicit SDK repair also refuses ambient npm before spawning it',async()=>{
  let spawned=false;
  await assert.rejects(installLockedDependencies({env:{},verify:async()=>missing,
    spawn:()=>{spawned=true;return {status:0};}}),/NPM_UNTRUSTED/);
  assert.equal(spawned,false);
});
