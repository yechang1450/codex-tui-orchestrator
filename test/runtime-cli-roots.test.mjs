import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runtimeCliCandidateRoots } from '../scripts/core/runtime-cli-roots.mjs';
import { cliCandidates, resolveHost } from '../scripts/core/host-cli.mjs';

const powershell=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
function grantAuthenticatedUsersModify(target){
  const script=[
    "$ErrorActionPreference='Stop'",
    '$target=[Console]::In.ReadToEnd().Trim()',
    '$acl=[IO.Directory]::GetAccessControl($target)',
    '$acl.SetAccessRuleProtection($true,$false)',
    '$current=[Security.Principal.WindowsIdentity]::GetCurrent().User',
    "$full=New-Object Security.AccessControl.FileSystemAccessRule($current,[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)",
    '$acl.SetAccessRule($full)',
    "$sharedSid=New-Object Security.Principal.SecurityIdentifier('S-1-5-11')",
    "$shared=New-Object Security.AccessControl.FileSystemAccessRule($sharedSid,[Security.AccessControl.FileSystemRights]::Modify,[Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)",
    '$acl.AddAccessRule($shared)',
    '[IO.Directory]::SetAccessControl($target,$acl)',
  ].join(';');
  const result=spawnSync(powershell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',script],{input:target,encoding:'utf8',windowsHide:true,shell:false,timeout:10_000});
  assert.equal(result.status,0,result.stderr||result.stdout);
}

test('runtime preparation derives its candidate root from bootstrap-owned PLUGIN_DATA, not inherited npm prefix', () => {
  const pluginData = 'C:\\plugin-data';
  const expected = path.join(pluginData, 'runtime', 'cli', 'node_modules');
  assert.deepEqual(
    runtimeCliCandidateRoots({plugin_data: pluginData, NPM_CONFIG_PREFIX: 'C:\\foreign-sdk\\cli'}),
    [expected],
  );
  assert.deepEqual(runtimeCliCandidateRoots({PLUGIN_DATA: pluginData, npm_config_prefix: 'C:\\other-foreign-cli'}), [expected]);
});

test('runtime preparation falls back to its own plugin temp runtime instead of inherited npm prefix', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  assert.deepEqual(
    runtimeCliCandidateRoots({npm_config_prefix: 'C:\\foreign-sdk\\cli'}),
    [path.join(root, 'temp', 'runtime', 'cli', 'node_modules')],
  );
});

test('explicit ORCH_CLI or CODEX_EXE remains authoritative before private candidate roots', () => {
  const roots = runtimeCliCandidateRoots({PLUGIN_DATA: 'C:\\plugin-data', npm_config_prefix: 'C:\\foreign-sdk\\cli'});
  for (const [key, explicit] of [['ORCH_CLI', 'C:\\operator\\codex.exe'], ['CODEX_EXE', 'C:\\operator\\codex-alt.exe']]) {
    const candidates = cliCandidates({[key]: explicit}, 'win32', {localRoots: roots, includeAmbient: false});
    assert.deepEqual(candidates, [path.win32.resolve(explicit)]);
  }
});

test('runtime preparation delegates host candidate roots to the private-prefix policy', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const source = fs.readFileSync(path.join(root, 'scripts', 'runtime-prepare.mjs'), 'utf8');
  assert.match(source, /runtimeCliCandidateRoots/);
  assert.match(source, /includeAmbient\s*:\s*false/);
});

test('direct Node runtime preparation refuses an unsafe private CLI root before dependency work',async t=>{
  if(process.platform!=='win32')return t.skip('Windows private-root contract');
  const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'orch-runtime-private-root-'));
  t.after(()=>fs.rmSync(fixture,{recursive:true,force:true}));
  const pluginData=path.join(fixture,'plugin-data'),runtimeHome=path.join(pluginData,'runtime');
  fs.mkdirSync(runtimeHome,{recursive:true});
  grantAuthenticatedUsersModify(runtimeHome);
  const runtime=await import(pathToFileURL(path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),'scripts','runtime-prepare.mjs')).href+`?unsafe-root=${Date.now()}`);
  let dependenciesTouched=false;
  await assert.rejects(()=>runtime.prepareRuntime({
    env:{PLUGIN_DATA:pluginData},platform:'win32',
    ensureRuntimeDependenciesImpl:async()=>{dependenciesTouched=true;return {version:'fixture'};},
  }),/RUNTIME_ROOT_UNSAFE_ACL/);
  assert.equal(dependenciesTouched,false);
});

test('an explicit CLI does not touch an unused unsafe private runtime root',async t=>{
  if(process.platform!=='win32')return t.skip('Windows private-root contract');
  const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'orch-runtime-explicit-cli-'));
  t.after(()=>fs.rmSync(fixture,{recursive:true,force:true}));
  const pluginData=path.join(fixture,'plugin-data'),runtimeHome=path.join(pluginData,'runtime');
  fs.mkdirSync(runtimeHome,{recursive:true});
  grantAuthenticatedUsersModify(runtimeHome);
  const runtime=await import(pathToFileURL(path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),'scripts','runtime-prepare.mjs')).href+`?explicit-cli=${Date.now()}`);
  let dependenciesTouched=false,hostOptions;
  const report=await runtime.prepareRuntime({
    env:{PLUGIN_DATA:pluginData,ORCH_CLI:'C:\\operator\\codex.exe',ORCH_AUTO_INSTALL_CLI:'0'},platform:'win32',
    ensureRuntimeDependenciesImpl:async()=>{dependenciesTouched=true;return {version:'fixture'};},
    resolveHostImpl:options=>{hostOptions=options;return {agent:'codex',config:{bin:'C:\\operator\\codex.exe'}};},
  });
  assert.equal(dependenciesTouched,true);
  assert.equal(hostOptions.env.ORCH_CLI,'C:\\operator\\codex.exe');
  assert.equal(report.cliPath,'C:\\operator\\codex.exe');
});

function nativeCandidate(root) {
  return path.join(root, '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe');
}

test('runtime preparation installs its private CLI instead of selecting a legacy SDK-tree native decoy', async t => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-runtime-sdk-decoy-'));
  const pluginData = path.join(fixture, 'plugin-data');
  const privatePrefix = path.join(pluginData, 'runtime', 'cli');
  const privateModules = path.join(privatePrefix, 'node_modules');
  const sdkModules = path.join(fixture, 'scripts', 'node_modules');
  const legacyDecoy = nativeCandidate(sdkModules);
  const expectedPrivateCli = nativeCandidate(privateModules);
  fs.mkdirSync(path.dirname(legacyDecoy), {recursive: true});
  fs.writeFileSync(legacyDecoy, 'legacy SDK native CLI fixture');

  const prior = Object.fromEntries(['ORCH_AUTO_INSTALL_CLI', 'ORCH_AUTO_INSTALL_DEPS', 'ORCH_CLI']
    .map(name => [name, process.env[name]]));
  const priorExitCode = process.exitCode;
  t.after(() => {
    fs.rmSync(fixture, {recursive: true, force: true});
    for (const [name, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    process.exitCode = priorExitCode;
  });

  // Before the injectable preparation boundary exists, importing the script is
  // deliberately constrained to a no-install failure path.
  process.env.ORCH_AUTO_INSTALL_CLI = '0';
  process.env.ORCH_AUTO_INSTALL_DEPS = '0';
  process.env.ORCH_CLI = path.join(fixture, 'missing-codex.exe');
  const runtime = await import(pathToFileURL(path.join(root, 'scripts', 'runtime-prepare.mjs')).href + `?sdk-decoy=${Date.now()}`);
  process.exitCode = priorExitCode;

  assert.equal(typeof runtime.prepareRuntime, 'function', 'runtime preparation must expose an injectable host-resolution seam');

  let installed = 0;
  let observedRoots = [];
  const runtimeEnv = {
    plugin_data: pluginData,
    npm_config_prefix: path.join(fixture, 'foreign-sdk-cli'),
    ORCH_AUTO_INSTALL_CLI: '1',
  };
  const report = await runtime.prepareRuntime({
    env: runtimeEnv,
    platform: 'win32',
    ensureRuntimeDependenciesImpl: async () => ({version: '0.162.1'}),
    cliCandidatesImpl: (_env, _platform, options) => {
      observedRoots = options.localRoots.map(item => path.resolve(item));
      assert.equal(options.includeAmbient, false);
      return options.localRoots.map(item => path.resolve(item) === path.resolve(privateModules)
        ? expectedPrivateCli
        : legacyDecoy);
    },
    resolveHostImpl: options => resolveHost({
      ...options,
      env: runtimeEnv,
      probe: file => path.resolve(file) === path.resolve(expectedPrivateCli) || path.resolve(file) === path.resolve(legacyDecoy),
      verifyPrivate: file => path.resolve(file) === path.resolve(expectedPrivateCli),
      verifyExternal: file => path.resolve(file) === path.resolve(legacyDecoy),
      install: () => {
        installed += 1;
        fs.mkdirSync(path.dirname(expectedPrivateCli), {recursive: true});
        fs.writeFileSync(expectedPrivateCli, 'new private native CLI fixture');
        return expectedPrivateCli;
      },
    }),
  });

  assert.equal(installed, 1, 'a legacy SDK-tree CLI must not suppress installation');
  assert.deepEqual(observedRoots, [path.resolve(privateModules)]);
  assert.equal(fs.existsSync(legacyDecoy), true, 'the historical SDK decoy remains available but unused');
  assert.equal(report.cliPath, expectedPrivateCli);
});
