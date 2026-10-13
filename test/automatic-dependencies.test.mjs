import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import * as entryBootstrap from '../scripts/entry-bootstrap.mjs';
import {assertTrustedNpm} from '../scripts/npm-cli.mjs';
const {ensureRuntimeDependencies,installLockedDependencies}=entryBootstrap;
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

test('explicit SDK repair refuses an unavailable npm fallback before spawning it',async()=>{
  let spawned=false;
  await assert.rejects(installLockedDependencies({
    env:{ORCH_ALLOW_UNVERIFIED_NPM:'1'},verify:async()=>missing,
    pickNpm:()=>({command:'npm.cmd',args:[],shell:true,source:'fallback'}),
    spawn:()=>{spawned=true;return {status:0};},
  }),/NPM_UNTRUSTED: a verified npm runtime is unavailable$/);
  assert.equal(spawned,false);
});

test('trusted npm attestation accepts a Windows junction canonical path',{
  skip:process.platform!=='win32',
},t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ctui-npm-realpath-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const physical=path.join(root,'physical-runtime');
  const logical=path.join(root,'logical-runtime');
  const physicalEntry=path.join(physical,'node_modules','npm','bin','npm-cli.js');
  fs.mkdirSync(path.dirname(physicalEntry),{recursive:true});
  fs.writeFileSync(physicalEntry,'// isolated npm fixture\n','utf8');
  try { fs.symlinkSync(physical,logical,'junction'); }
  catch { t.skip('Windows directory junctions are unavailable in this environment'); return; }
  const entry=path.join(logical,'node_modules','npm','bin','npm-cli.js');
  const canonical=fs.realpathSync.native(entry);
  assert.notEqual(path.resolve(entry).toLowerCase(),path.resolve(canonical).toLowerCase(),'fixture must exercise canonical path remapping');
  const digest=crypto.createHash('sha256').update(fs.readFileSync(entry)).digest('hex');
  assert.doesNotThrow(()=>assertTrustedNpm({
    ORCH_NPM_TRUSTED:'1',npm_execpath:entry,ORCH_NPM_TRUSTED_PATH:entry,ORCH_NPM_TRUSTED_SHA256:digest,
  }));
  const otherEntry=path.join(root,'other-runtime','node_modules','npm','bin','npm-cli.js');
  fs.mkdirSync(path.dirname(otherEntry),{recursive:true});
  fs.writeFileSync(otherEntry,'// isolated npm fixture\n','utf8');
  assert.throws(()=>assertTrustedNpm({
    ORCH_NPM_TRUSTED:'1',npm_execpath:entry,ORCH_NPM_TRUSTED_PATH:otherEntry,ORCH_NPM_TRUSTED_SHA256:digest,
  }),/NPM_UNTRUSTED/,'canonicalization must still reject a different npm entry');
});

test('explicit dependency repair bridges only a missing Desktop npm runtime',async()=>{
  assert.equal(typeof entryBootstrap.repairExplicitDependencyInstall,'function','the explicit repair bridge must be available to the CLI entry');
  let installCalls=0,bridgeCalls=0,repaired=false;
  const result=await entryBootstrap.repairExplicitDependencyInstall({
    env:{},platform:'win32',verify:async()=>repaired?{ok:true,version:'0.162.1'}:missing,
    install:async()=>{installCalls++;throw new Error('NPM_UNTRUSTED: bootstrap must attest the exact npm entry path');},
    bridge:async()=>{bridgeCalls++;repaired=true;return {ok:true,status:'installed',dependency:'@openai/codex-sdk',version:'0.162.1'};},
  });
  assert.equal(result.status,'installed');
  assert.equal(installCalls,1);
  assert.equal(bridgeCalls,1);
});

test('explicit dependency repair never bridges healthy, damaged, or reentrant states',async()=>{
  assert.equal(typeof entryBootstrap.repairExplicitDependencyInstall,'function','the explicit repair bridge must be available to the CLI entry');
  let bridgeCalls=0,installCalls=0;
  const bridge=async()=>{bridgeCalls++;return {ok:true,status:'installed'};};
  const healthy=await entryBootstrap.repairExplicitDependencyInstall({
    env:{},platform:'win32',verify:async()=>({ok:true,version:'0.162.1'}),
    install:async()=>{installCalls++;return {ok:true,status:'already-present'};},bridge,
  });
  assert.equal(healthy.status,'already-present');
  assert.equal(installCalls,1);
  assert.equal(bridgeCalls,0);
  await assert.rejects(entryBootstrap.repairExplicitDependencyInstall({
    env:{},platform:'win32',verify:async()=>({ok:false,code:'RELEASE_DEPENDENCY_INTEGRITY',message:'sealed SDK differs'}),
    install:async()=>{installCalls++;throw new Error('NPM_UNTRUSTED: unrelated');},bridge,
  }),/NPM_UNTRUSTED/);
  await assert.rejects(entryBootstrap.repairExplicitDependencyInstall({
    env:{ORCH_DEP_REPAIR_BOOTSTRAP:'1'},platform:'win32',verify:async()=>missing,
    install:async()=>{installCalls++;throw new Error('NPM_UNTRUSTED: reentry must fail');},bridge,
  }),/NPM_UNTRUSTED/);
  await assert.rejects(entryBootstrap.repairExplicitDependencyInstall({
    env:{},platform:'linux',verify:async()=>missing,
    install:async()=>{installCalls++;throw new Error('NPM_UNTRUSTED: non-Windows');},bridge,
  }),/NPM_UNTRUSTED/);
  assert.equal(bridgeCalls,0);
});

test('Desktop repair bridge invokes only the trusted bootstrap action with a bounded timeout',()=>{
  assert.equal(typeof entryBootstrap.bootstrapExplicitDependencyRepair,'function');
  let observed;
  const result=entryBootstrap.bootstrapExplicitDependencyRepair({
    timeoutMs:6500,env:{PLUGIN_DATA:'C:\\acceptance-data'},
    releaseVerify:()=>({schema:2}),powershell:()=> 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    windowsRoot:()=> 'C:\\Windows',safeEnvironment:extra=>({SystemRoot:'C:\\Windows',...extra}),
    spawn:(command,args,options)=>{
      observed={command,args,options};
      return {status:0,stdout:JSON.stringify({ok:true,status:'installed'})};
    },
  });
  assert.equal(result.status,'installed');
  assert.equal(observed.command,'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.deepEqual(observed.args.slice(-5),['-Action','repair-deps','-Json','-TimeoutSeconds','7']);
  assert.equal(observed.options.shell,false);
  assert.equal(observed.options.cwd,'C:\\Windows');
  assert.equal(observed.options.env.ORCH_DEP_REPAIR_BOOTSTRAP,'1');
  assert.equal(observed.options.env.PLUGIN_DATA,'C:\\acceptance-data');
});
