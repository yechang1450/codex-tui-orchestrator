import test from 'node:test';
import assert from 'node:assert/strict';
import {ensureRuntimeDependencies} from '../scripts/entry-bootstrap.mjs';
const missing={ok:false,code:'RELEASE_DEPENDENCY_MISSING',message:'missing locked SDK'};
test('first use installs missing SDK once and verifies before continuing',async()=>{
  let calls=0,installed=0;
  const result=await ensureRuntimeDependencies({env:{},verify:async()=>++calls===1?missing:{ok:true},install:async()=>installed++});
  assert.equal(result.ok,true);assert.equal(calls,2);assert.equal(installed,1);
});
test('healthy dependencies are idempotent and failed installs stop execution',async()=>{
  await ensureRuntimeDependencies({env:{},verify:async()=>({ok:true}),install:async()=>assert.fail('unnecessary installation')});
  await assert.rejects(ensureRuntimeDependencies({env:{},verify:async()=>missing,install:async()=>{throw new Error('install failed');}}),/install failed/);
  await assert.rejects(ensureRuntimeDependencies({env:{ORCH_AUTO_INSTALL_DEPS:'0'},verify:async()=>missing,install:async()=>assert.fail('opted out')}),/missing locked SDK/);
});
