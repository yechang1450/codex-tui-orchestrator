import {testTempFamily} from './test-temp-root.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import childProcess, {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {syncBuiltinESMExports} from 'node:module';
import {
  defaultMarketplacePath,
  defaultMarketplaceRoot,
  canonicalDistMarketplaceBytes,
  ensureRegistration,
  inspectRegistration,
  isPersonalMarketplaceDir,
  relativeSourcePath,
  setRegistrationSource,
} from '../scripts/repair-plugin-registration.mjs';
import {coreInventory, runtimeInventory} from '../scripts/release-integrity.mjs';
import {
  checkInstall,
  authenticateInstalledCache,
  cacheDoctorEnvironmentForCodexHome,
  ensureCodexHomeDirectory,
  hostEnvironmentForCodexHome,
  installPlugin,
  listInstalledCaches,
  marketplaceNameConflict,
  marketplaceIsConfigured,
  parseArgs,
  parseCliJson,
  pickCodexCli,
  pickNpmCli,
  pluginEnabledInConfig,
  quoteShellArg,
  shouldPublishDistribution,
  skillNamesOf,
  verifySkillsVisible,
  validateInstalledPath,
} from '../scripts/install-plugin.mjs';
import {resolveRuntimeContext, physicallySameOrChild} from '../scripts/core/runtime-context.mjs';
import {controllerStateDir} from '../scripts/core/controller-state.mjs';
import {captureInitiatorContext} from '../scripts/core/initiator-context.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_TEMP = testTempFamily('install-plugin');
fs.mkdirSync(TEST_TEMP, {recursive: true});

function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }

function writeFixtureRelease(root) {
  fs.writeFileSync(path.join(root, 'release.json'), JSON.stringify({
    schema: 2,
    coreVersion: 'test',
    files: coreInventory(root),
    runtimeFiles: runtimeInventory(root),
  }, null, 2) + '\n');
}

function sealFixtureDistribution({checkout, dist, pluginName, category = 'Productivity'}) {
  const lock = Buffer.from('{"lockfileVersion":3}\n');
  fs.mkdirSync(path.join(checkout, '.agents', 'plugins'), {recursive: true});
  fs.writeFileSync(path.join(checkout, '.agents', 'plugins', 'marketplace.json'), JSON.stringify({
    name: 'checkout',
    plugins: [{name: pluginName, source: {source: 'local', path: './'}, policy: {installation: 'AVAILABLE', authentication: 'ON_INSTALL'}, category}],
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(checkout, 'scripts', 'package-lock.json'), lock);
  const dependency = Buffer.from(`${JSON.stringify({schema: 1, packageLockSha256: sha256(lock), files: {}}, null, 2)}\n`);
  fs.writeFileSync(path.join(checkout, 'scripts', 'dependency-integrity.json'), dependency);
  writeFixtureRelease(checkout);
  const sourceRelease = fs.readFileSync(path.join(checkout, 'release.json'));
  fs.cpSync(checkout, dist, {recursive: true});
  fs.mkdirSync(path.join(dist, '.agents', 'plugins'), {recursive: true});
  fs.writeFileSync(path.join(dist, '.agents', 'plugins', 'marketplace.json'), canonicalDistMarketplaceBytes({pluginName, category}));
  fs.writeFileSync(path.join(dist, 'scripts', 'distribution-source-release.json'), sourceRelease);
  fs.writeFileSync(path.join(dist, 'scripts', 'distribution-provenance.json'), JSON.stringify({
    schema: 1,
    sourceReleaseSha256: sha256(sourceRelease),
    sourceDependencyManifestSha256: sha256(dependency),
    packageLockSha256: sha256(lock),
    dependencyFiles: 0,
  }, null, 2) + '\n');
  writeFixtureRelease(dist);
}

function withFakeSkillCliProbe(fakeCli, run) {
  const original = childProcess.spawnSync;
  const expected = path.resolve(fakeCli);
  const calls = [];
  childProcess.spawnSync = (command, args = [], options) => {
    if (path.resolve(String(command)) === expected) {
      calls.push({args: [...args], options});
      const isVersionProbe = args.length === 1 && args[0] === '--version';
      return {
        status: 0,
        stdout: isVersionProbe ? 'codex-cli fixture\n' : 'demo-plugin:demo-skill\n',
        stderr: '',
      };
    }
    return original(command, args, options);
  };
  syncBuiltinESMExports();
  try {
    return run(calls);
  } finally {
    childProcess.spawnSync = original;
    syncBuiltinESMExports();
  }
}

test('direct installer selects npm packaged native CLI beside a codex.cmd shim', t => {
  if (process.platform !== 'win32') return t.skip('Windows native CLI layout');
  const dir = fs.mkdtempSync(path.join(TEST_TEMP, 'install-cli-shim-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const native = path.join(dir, 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe');
  fs.mkdirSync(path.dirname(native), {recursive: true});
  fs.writeFileSync(path.join(dir, 'codex.cmd'), '@echo off\r\n');
  fs.writeFileSync(native, 'fixture');
  assert.equal(pickCodexCli({env: {PATH: dir, Path: ''}}), native);
});
test('installer host resolution skips an untrusted discovered CLI and preserves explicit choice', async t => {
  const {resolveInstallCli} = await import('../scripts/install-plugin.mjs');
  assert.equal(typeof resolveInstallCli, 'function');
  const dir = fs.mkdtempSync(path.join(TEST_TEMP, 'install-cli-trust-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const unsigned = path.join(dir, 'first.exe');
  const signed = path.join(dir, 'second.exe');
  fs.writeFileSync(unsigned, 'unsigned fixture');
  fs.writeFileSync(signed, 'signed fixture');
  const hostOptions = {
    candidates: env => env.ORCH_CLI ? [env.ORCH_CLI] : [unsigned, signed],
    verifyExternal: file => file === signed,
    probe: file => file === signed,
  };
  assert.equal(resolveInstallCli({env: {ORCH_AGENT: 'codex'}, hostOptions}), signed);
  assert.throws(() => resolveInstallCli({candidate: unsigned, env: {ORCH_AGENT: 'codex'}, hostOptions}), /CLI_UNTRUSTED/);
});

test('direct Node installation exposes no Git pull primitive and rejects --pull before other setup', async () => {
  const installer = await import('../scripts/install-plugin.mjs');
  assert.equal(typeof installer.trustedGitPath, 'undefined');
  assert.equal(typeof installer.pullTrustedGitCheckout, 'undefined');
  assert.throws(
    () => installer.installPlugin({pull: true, pluginPath: path.join(TEST_TEMP, 'missing-plugin-for-pull') }),
    /PULL_REQUIRES_BOOTSTRAP/,
  );
});

test('direct Node CLI rejects --pull before a requested read-only check can inspect caller state', () => {
  const result = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'install-plugin.mjs'), '--check', '--pull', '--plugin', path.join(TEST_TEMP, 'missing-plugin-for-cli-pull')], {
    encoding: 'utf8',
    env: {...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: 'C:\\caller-controlled'},
  });
  assert.equal(result.status, 1);
  const response = JSON.parse(result.stdout);
  assert.match(response.reason, /PULL_REQUIRES_BOOTSTRAP/);
});

test('direct installer CLI rejects every obsolete --skip-dist spelling at argument parsing', () => {
  for (const unsupported of ['--skip-dist', '--skip-dist=legacy']) {
    const result = spawnSync(process.execPath, [
      path.join(repoRoot, 'scripts', 'install-plugin.mjs'),
      '--check',
      unsupported,
      '--plugin', path.join(TEST_TEMP, 'missing-plugin-for-cli-skip-dist'),
    ], {encoding: 'utf8'});
    assert.equal(result.status, 1, `${unsupported} must fail before a direct installer command can inspect its source`);
    const response = JSON.parse(result.stdout);
    assert.match(response.reason, /^SKIP_DIST_UNSUPPORTED:/, `${unsupported} must preserve the canonical public rejection code`);
  }
});

test('installer creates a fresh explicit CODEX_HOME and refuses a file in its place', () => {
  const root = fs.mkdtempSync(path.join(TEST_TEMP, 'fresh-codex-home-'));
  const codexHome = path.join(root, 'state', 'codex');
  const blocked = path.join(root, 'blocked-home');
  try {
    assert.equal(fs.existsSync(codexHome), false);
    assert.equal(ensureCodexHomeDirectory(codexHome), path.resolve(codexHome));
    assert.equal(fs.lstatSync(codexHome).isDirectory(), true);
    fs.writeFileSync(blocked, 'not a directory');
    assert.throws(() => ensureCodexHomeDirectory(blocked), /CODEX_HOME_CREATE_FAILED/);
    assert.equal(fs.readFileSync(blocked, 'utf8'), 'not a directory');
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test('host subprocesses receive exactly the requested CODEX_HOME', () => {
  const bound = hostEnvironmentForCodexHome({CODEX_HOME: 'old', Codex_Home: 'older', KEEP: 'yes'}, 'D:\\isolated\\codex');
  assert.equal(bound.CODEX_HOME, path.resolve('D:\\isolated\\codex'));
  assert.equal(bound.KEEP, 'yes');
  assert.equal(Object.keys(bound).filter(key => key.toUpperCase() === 'CODEX_HOME').length, 1);
  assert.equal(Object.isFrozen(bound), true);
});

test('cache doctor receives an isolated diagnostic workspace instead of caller execution state', t => {
  const root = fs.mkdtempSync(path.join(TEST_TEMP, 'cache-doctor-environment-'));
  const codexHome = path.join(root, 'isolated-codex-home');
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  fs.mkdirSync(codexHome, {recursive: true});
  const environment = cacheDoctorEnvironmentForCodexHome({
    CODEX_HOME: 'caller-home',
    Codex_Home: 'caller-home-duplicate',
    WORKSPACE_DIR: path.join(root, 'caller-workspace'),
    workspace_dir: path.join(root, 'caller-workspace-duplicate'),
    ORCH_STATE_DIR: 'caller-state',
    orch_controller_root: path.join(root, 'caller-controller'),
    ORCH_COORDINATOR_DIR: path.join(root, 'caller-coordinator'),
    ORCH_RUN_ID: 'caller-run',
    ORCH_ACCEPTANCE_FILE: path.join(root, 'caller-acceptance.json'),
    ORCH_ACCEPTANCE_OVERRIDE: '1',
    ORCH_SESSION_DIR: path.join(root, 'caller-session'),
    ORCH_ISOLATED_ACCEPTANCE: path.join(root, 'caller-isolated-acceptance.json'),
    ORCH_ISOLATED_ABORT_TOKEN: 'caller-abort',
    ORCH_AGENT: 'foreign-agent',
    orCh_AgEnT: 'other',
    CODEX_THREAD_ID: 'caller-thread',
    codex_session_id: 'caller-session-id',
    CODEX_PERMISSION_PROFILE: ':danger-full-access',
    CODEX_TASK_WORKSPACE_VERIFYING_IDENTITY: 'caller-workspace-identity',
    CODEX_APP_TOOLS_PIPE_PATH: '\\\\.\\pipe\\caller-tools',
    ORCH_CLI: 'C:\\verified\\codex.exe',
    ORCH_NPM_TRUSTED: '1',
    KEEP: 'yes',
  }, codexHome);

  assert.equal(environment.CODEX_HOME, path.resolve(codexHome));
  assert.equal(environment.WORKSPACE_DIR, path.join(path.resolve(codexHome), '.tmp', 'install-doctor-workspace'));
  assert.equal(environment.ORCH_CLI, 'C:\\verified\\codex.exe');
  assert.equal(environment.ORCH_NPM_TRUSTED, '1');
  assert.equal(environment.ORCH_AGENT, 'codex');
  assert.equal(environment.KEEP, 'yes');
  for (const key of ['ORCH_STATE_DIR', 'ORCH_CONTROLLER_ROOT', 'ORCH_COORDINATOR_DIR', 'ORCH_RUN_ID', 'ORCH_ACCEPTANCE_FILE', 'ORCH_ACCEPTANCE_OVERRIDE', 'ORCH_SESSION_DIR', 'ORCH_ISOLATED_ACCEPTANCE', 'ORCH_ISOLATED_ABORT_TOKEN', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CODEX_PERMISSION_PROFILE', 'CODEX_TASK_WORKSPACE_VERIFYING_IDENTITY', 'CODEX_APP_TOOLS_PIPE_PATH']) {
    assert.equal(Object.keys(environment).some(name => name.toUpperCase() === key), false, `${key} must not reach the cache doctor`);
  }
  assert.equal(Object.keys(environment).filter(name => name.toUpperCase() === 'CODEX_HOME').length, 1);
  assert.equal(Object.keys(environment).filter(name => name.toUpperCase() === 'WORKSPACE_DIR').length, 1);
  assert.equal(Object.keys(environment).filter(name => name.toUpperCase() === 'ORCH_AGENT').length, 1);
  assert.equal(Object.isFrozen(environment), true);
  assert.equal(captureInitiatorContext(environment).threadId, '', 'the diagnostic workspace must not inherit a desktop turn binding');
  const context = resolveRuntimeContext(environment);
  const controller = path.join(path.resolve(codexHome), 'state', 'plugins', 'codex-tui-orchestrator');
  assert.equal(physicallySameOrChild(context.workspace, controller), false);
  // The suite may run with TEMP redirected below the user profile, so the
  // "inherited from a shared temporary volume" premise is established
  // explicitly here before the refusal is proven.
  const aclScript = [
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
  const aclChanged = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', aclScript], {input: codexHome, encoding: 'utf8', windowsHide: true, timeout: 30000});
  assert.equal(aclChanged.status, 0, aclChanged.stderr || aclChanged.stdout);
  assert.throws(
    () => controllerStateDir(context.workspace, environment),
    /CONTROLLER_ROOT_UNSAFE_ACL/,
    'a test root with an inherited or granted shared-writer ACL must not become controller authority',
  );
});

function coreFixture(pluginDir) {
  const core = path.join(pluginDir, 'scripts', 'core');
  fs.mkdirSync(core, {recursive: true});
  fs.writeFileSync(path.join(core, 'orchestrate-sdk.mjs'), 'export const marker = "checkout";\n');
  fs.writeFileSync(path.join(core, 'contracts.mjs'), 'export const CORE_VERSION = "test";\n');
  fs.writeFileSync(path.join(pluginDir, 'scripts', 'release-integrity.mjs'), "console.log(JSON.stringify({schema: 2, coreVersion: 'test', files: 0, runtimeFiles: 0}));\n");
  fs.writeFileSync(path.join(pluginDir, 'scripts', 'orchestrate-sdk.mjs'), 'console.log("doctor ok");\n');
}

/** 个人 marketplace 场景的夹具：home/<.agents/plugins>/marketplace.json + 单目录插件 checkout。 */
function personalFixture({marketplace = null, withDist = true} = {}) {
  const home = fs.mkdtempSync(path.join(TEST_TEMP, 'install-plugin-'));
  const plugin = path.join(home, 'plugins', 'demo-plugin');
  const dist = path.join(home, 'plugins', 'dist', 'demo-plugin');
  fs.mkdirSync(path.join(plugin, '.codex-plugin'), {recursive: true});
  fs.mkdirSync(path.join(plugin, 'skills', 'demo-skill'), {recursive: true});
  fs.writeFileSync(path.join(plugin, '.codex-plugin', 'plugin.json'), JSON.stringify({name: 'demo-plugin', version: '1.0.0', interface: {category: 'Productivity'}}, null, 2) + '\n');
  fs.writeFileSync(path.join(plugin, 'skills', 'demo-skill', 'SKILL.md'), '---\nname: demo-skill\n---\n');
  coreFixture(plugin);
  if (withDist) coreFixture(dist);
  const marketplacePath = path.join(home, '.agents', 'plugins', 'marketplace.json');
  if (marketplace) {
    fs.mkdirSync(path.dirname(marketplacePath), {recursive: true});
    fs.writeFileSync(marketplacePath, JSON.stringify(marketplace, null, 2) + '\n');
  }
  return {home, plugin, dist, marketplacePath, options: {pluginPath: plugin, marketplacePath, marketplaceRoot: home, distRoot: path.join(home, 'plugins', 'dist'), homeDir: home}};
}

/** 注册 + 缓存 + 宿主配置都齐备的夹具（含可自定义的 CODEX_HOME）。 */
function completeFixture({codexHomeRelative = '.codex', cli = null} = {}) {
  const f = personalFixture();
  assert.equal(ensureRegistration(f.options).ok, true);
  const codexHome = path.join(f.home, codexHomeRelative);
  const cache = path.join(codexHome, 'plugins', 'cache', 'personal', 'demo-plugin', '1.0.0');
  fs.cpSync(f.plugin, cache, {recursive: true});
  fs.mkdirSync(path.join(cache, 'scripts', 'node_modules'), {recursive: true});
  fs.mkdirSync(codexHome, {recursive: true});
  fs.writeFileSync(path.join(codexHome, 'config.toml'), '[plugins."demo-plugin@personal"]\nenabled = true\n');
  return {...f, codexHome, cache, options: {...f.options, codexHome, ...(cli ? {codexCli: cli} : {})}};
}

test('installPlugin rejects a managed cache before ordinary checkout installation handling', () => {
  const f = completeFixture();
  try {
    const marketplaceBefore = fs.readFileSync(f.marketplacePath);
    assert.throws(
      () => installPlugin({
        pluginPath: f.cache,
        marketplacePath: f.marketplacePath,
        marketplaceRoot: f.home,
        codexHome: f.codexHome,
        homeDir: f.home,
      }),
      /MANAGED_CACHE_INSTALL_FORBIDDEN/,
    );
    assert.deepEqual(fs.readFileSync(f.marketplacePath), marketplaceBefore, 'a rejected cache install must not rewrite the marketplace catalog');
  } finally {
    fs.rmSync(f.home, {recursive: true, force: true});
  }
});

test('ensureRegistration creates the personal marketplace and points at the checkout root', () => {
  const f = personalFixture();
  try {
    const result = ensureRegistration(f.options);
    assert.equal(result.ok, true);
    assert.equal(result.status, 'created');
    assert.equal(result.created, true);
    assert.equal(result.marketplaceName, 'personal');
    const data = JSON.parse(fs.readFileSync(f.marketplacePath, 'utf8'));
    assert.equal(data.name, 'personal');
    assert.equal(data.plugins.length, 1);
    assert.equal(data.plugins[0].name, 'demo-plugin');
    assert.equal(data.plugins[0].source.source, 'local');
    assert.equal(data.plugins[0].source.path, relativeSourcePath(f.home, f.plugin));
    assert.deepEqual(data.plugins[0].policy, {installation: 'AVAILABLE', authentication: 'ON_INSTALL'});
    assert.equal(inspectRegistration(f.options).status, 'matched');

    const bytes = fs.readFileSync(f.marketplacePath);
    const second = ensureRegistration(f.options);
    assert.equal(second.status, 'matched');
    assert.deepEqual(fs.readFileSync(f.marketplacePath), bytes, 'second run must be read-only');
  } finally {
    fs.rmSync(f.home, {recursive: true, force: true});
  }
});

test('host-reported install paths are contained canonical cache directories', () => {
  const home = fs.mkdtempSync(path.join(TEST_TEMP, 'install-path-boundary-'));
  try {
    const cache = path.join(home, '.codex', 'plugins', 'cache', 'personal', 'demo-plugin', '1.0.0');
    fs.mkdirSync(path.join(cache, 'scripts'), {recursive: true});
    fs.mkdirSync(path.join(cache, '.codex-plugin'), {recursive: true});
    fs.writeFileSync(path.join(cache, '.codex-plugin', 'plugin.json'), JSON.stringify({name: 'demo-plugin', version: '1.0.0'}));
    const valid = validateInstalledPath({installedPath: cache, codexHome: path.join(home, '.codex'), marketplaceName: 'personal', pluginName: 'demo-plugin', version: '1.0.0'});
    assert.equal(valid.installedPath, fs.realpathSync(cache));
    assert.equal(valid.scriptsPath, fs.realpathSync(path.join(cache, 'scripts')));
    const outside = path.join(home, 'outside');
    fs.mkdirSync(path.join(outside, 'scripts'), {recursive: true});
    fs.mkdirSync(path.join(outside, '.codex-plugin'), {recursive: true});
    fs.writeFileSync(path.join(outside, '.codex-plugin', 'plugin.json'), JSON.stringify({name: 'demo-plugin', version: '1.0.0'}));
    assert.throws(() => validateInstalledPath({installedPath: outside, codexHome: path.join(home, '.codex'), marketplaceName: 'personal', pluginName: 'demo-plugin', version: '1.0.0'}), /HOST_INSTALL_PATH_INVALID/);
  } finally { fs.rmSync(home, {recursive: true, force: true}); }
});

test('a local marketplace cache may use the host cache label while preserving the manifest version', () => {
  const home = fs.mkdtempSync(path.join(TEST_TEMP, 'install-local-cache-'));
  try {
    const cache = path.join(home, '.codex', 'plugins', 'cache', 'repo-local', 'demo-plugin', 'local');
    fs.mkdirSync(path.join(cache, 'scripts'), {recursive: true});
    fs.mkdirSync(path.join(cache, '.codex-plugin'), {recursive: true});
    fs.writeFileSync(path.join(cache, '.codex-plugin', 'plugin.json'), JSON.stringify({name: 'demo-plugin', version: '1.0.0'}));
    const valid = validateInstalledPath({
      installedPath: cache,
      codexHome: path.join(home, '.codex'),
      marketplaceName: 'repo-local',
      pluginName: 'demo-plugin',
      version: 'local',
      manifestVersion: '1.0.0',
    });
    assert.equal(valid.installedPath, fs.realpathSync(cache));
  } finally { fs.rmSync(home, {recursive: true, force: true}); }
});

test('cache authentication rejects modified verifier or doctor bytes', () => {
  const root = fs.mkdtempSync(path.join(TEST_TEMP, 'install-cache-auth-'));
  const source = path.join(root, 'source');
  const cache = path.join(root, 'cache');
  try {
    fs.mkdirSync(path.join(source, '.codex-plugin'), {recursive: true});
    fs.mkdirSync(path.join(source, 'scripts', 'core'), {recursive: true});
    fs.writeFileSync(path.join(source, '.codex-plugin', 'plugin.json'), '{}\n');
    fs.writeFileSync(path.join(source, 'scripts', 'release-integrity.mjs'), 'export const verifier = true;\n');
    fs.writeFileSync(path.join(source, 'scripts', 'orchestrate-sdk.mjs'), 'export const doctor = true;\n');
    fs.writeFileSync(path.join(source, 'scripts', 'core', 'orchestrate-sdk.mjs'), 'export const core = true;\n');
    fs.cpSync(source, cache, {recursive: true});

    assert.equal(authenticateInstalledCache({sourcePath: source, installedPath: cache}).ok, true);
    fs.writeFileSync(path.join(cache, 'scripts', 'release-integrity.mjs'), 'console.log("forged verifier");\n');
    assert.throws(
      () => authenticateInstalledCache({sourcePath: source, installedPath: cache}),
      error => /CACHE_AUTHENTICATION_FAILED/.test(error.message) && error.message.includes('scripts/release-integrity.mjs'),
    );
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test('checkInstall does not execute a cache verifier before authentication', () => {
  const root = fs.mkdtempSync(path.join(TEST_TEMP, 'install-cache-gate-'));
  const plugin = path.join(root, 'plugin');
  const marketplacePath = path.join(root, '.agents', 'plugins', 'marketplace.json');
  const codexHome = path.join(root, '.codex');
  const cache = path.join(codexHome, 'plugins', 'cache', 'personal', 'demo-plugin', '1.0.0');
  const marker = path.join(root, 'verifier-ran');
  const originalNative = fs.realpathSync.native;
  fs.realpathSync.native = fs.realpathSync;
  try {
    fs.mkdirSync(path.join(plugin, '.codex-plugin'), {recursive: true});
    fs.mkdirSync(path.join(plugin, 'scripts', 'core'), {recursive: true});
    fs.writeFileSync(path.join(plugin, '.codex-plugin', 'plugin.json'), JSON.stringify({name: 'demo-plugin', version: '1.0.0'}) + '\n');
    fs.writeFileSync(path.join(plugin, 'scripts', 'release-integrity.mjs'), 'export const verifier = true;\n');
    fs.writeFileSync(path.join(plugin, 'scripts', 'orchestrate-sdk.mjs'), 'export const doctor = true;\n');
    fs.writeFileSync(path.join(plugin, 'scripts', 'core', 'orchestrate-sdk.mjs'), 'export const core = true;\n');
    assert.equal(ensureRegistration({pluginPath: plugin, marketplacePath, marketplaceRoot: root, homeDir: root}).ok, true);
    fs.cpSync(plugin, cache, {recursive: true});
    fs.mkdirSync(path.join(cache, 'scripts', 'node_modules'), {recursive: true});
    fs.mkdirSync(codexHome, {recursive: true});
    fs.writeFileSync(path.join(codexHome, 'config.toml'), '[plugins."demo-plugin@personal"]\nenabled = true\n');
    fs.writeFileSync(path.join(cache, 'scripts', 'release-integrity.mjs'), `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'ran');\n`);

    const result = checkInstall({pluginPath: plugin, marketplacePath, marketplaceRoot: root, codexHome, homeDir: root});
    assert.equal(result.ok, false);
    assert.equal(result.problems.some((problem) => problem.step === 'cache_authentication'), true);
    assert.equal(fs.existsSync(marker), false, 'untrusted cache verifier must never run');
  } finally {
    fs.realpathSync.native = originalNative;
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test('checkInstall does not execute a cache verifier when an implicitly discovered dist is unverified', () => {
  const root = fs.mkdtempSync(path.join(TEST_TEMP, 'implicit-dist-cache-gate-'));
  const checkout = path.join(root, 'checkout');
  const distRoot = path.join(root, 'export');
  const dist = path.join(distRoot, 'demo-plugin');
  const codexHome = path.join(root, '.codex');
  const marker = path.join(root, 'verifier-ran');
  try {
    fs.mkdirSync(path.join(checkout, '.codex-plugin'), {recursive: true});
    fs.writeFileSync(path.join(checkout, '.codex-plugin', 'plugin.json'), JSON.stringify({name: 'demo-plugin', version: '1.0.0'}) + '\n');
    coreFixture(checkout);
    sealFixtureDistribution({checkout, dist, pluginName: 'demo-plugin'});
    // This is a non-core runtime change. The catalog still points at dist, so
    // checkout-mode inspection must reject it before cache execution.
    fs.writeFileSync(path.join(dist, 'scripts', 'release-integrity.mjs'), `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'ran');\n`);
    const cache = path.join(codexHome, 'plugins', 'cache', 'codex-tui-orchestrator-dist', 'demo-plugin', 'local');
    fs.cpSync(dist, cache, {recursive: true});
    fs.mkdirSync(path.join(cache, 'scripts', 'node_modules'), {recursive: true});
    fs.mkdirSync(codexHome, {recursive: true});
    fs.writeFileSync(path.join(codexHome, 'config.toml'), '[plugins."demo-plugin@codex-tui-orchestrator-dist"]\nenabled = true\n');

    const result = checkInstall({
      pluginPath: checkout,
      marketplacePath: path.join(dist, '.agents', 'plugins', 'marketplace.json'),
      marketplaceRoot: dist,
      distRoot,
      codexHome,
      homeDir: root,
    });
    assert.equal(result.registration.status, 'dist_unverified', JSON.stringify(result.problems));
    assert.equal(result.problems.some((problem) => problem.step === 'registration' && problem.status === 'dist_unverified'), true);
    assert.equal(fs.existsSync(marker), false, 'an unverified implicit dist must not get to execute its cache verifier');
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test('checkInstall never probes host skill visibility from an unverified distribution', () => {
  for (const source of ['checkout', 'dist']) {
    const root = fs.mkdtempSync(path.join(TEST_TEMP, `unverified-dist-skill-gate-${source}-`));
    const checkout = path.join(root, 'checkout');
    const distRoot = path.join(root, 'export');
    const dist = path.join(distRoot, 'demo-plugin');
    const codexHome = path.join(root, '.codex');
    const fakeCli = path.join(root, 'injected-skill-probe.exe');
    try {
      fs.mkdirSync(path.join(checkout, '.codex-plugin'), {recursive: true});
      fs.mkdirSync(path.join(checkout, 'skills', 'demo-skill'), {recursive: true});
      fs.writeFileSync(path.join(checkout, '.codex-plugin', 'plugin.json'), JSON.stringify({name: 'demo-plugin', version: '1.0.0'}) + '\n');
      fs.writeFileSync(path.join(checkout, 'skills', 'demo-skill', 'SKILL.md'), '---\nname: demo-skill\n---\n');
      coreFixture(checkout);
      sealFixtureDistribution({checkout, dist, pluginName: 'demo-plugin'});
      // Alter a non-core runtime file after sealing. Both explicit and
      // catalog-discovered dist sources must be rejected before a host probe
      // can load their enabled plugin context.
      fs.writeFileSync(path.join(dist, 'scripts', 'release-integrity.mjs'), 'console.log("forged verifier");\n');
      const cache = path.join(codexHome, 'plugins', 'cache', 'codex-tui-orchestrator-dist', 'demo-plugin', 'local');
      fs.cpSync(dist, cache, {recursive: true});
      fs.mkdirSync(path.join(cache, 'scripts', 'node_modules'), {recursive: true});
      fs.mkdirSync(codexHome, {recursive: true});
      fs.writeFileSync(path.join(codexHome, 'config.toml'), '[plugins."demo-plugin@codex-tui-orchestrator-dist"]\nenabled = true\n');
      fs.writeFileSync(fakeCli, 'fixture');

      const common = {
        pluginPath: checkout,
        distRoot,
        codexHome,
        homeDir: root,
        verifySkills: true,
        codexCli: fakeCli,
        env: {...process.env, ORCH_ALLOW_UNVERIFIED_CLI: '1'},
        ...(source === 'dist'
          ? {source: 'dist'}
          : {marketplacePath: path.join(dist, '.agents', 'plugins', 'marketplace.json'), marketplaceRoot: dist}),
      };
      withFakeSkillCliProbe(fakeCli, (calls) => {
        const advisory = checkInstall(common);
        assert.equal(advisory.registration.status, 'dist_unverified', JSON.stringify(advisory.problems));
        assert.equal(advisory.skills?.status, 'skipped');
        assert.equal(advisory.skills?.skipped, true);
        assert.equal(advisory.warnings.some((warning) => warning.step === 'skills_visible' && warning.status === 'skipped'), true);
        assert.equal(calls.length, 0, `${source} unverified dist must not resolve, probe, or spawn the injected host CLI`);

        const strict = checkInstall({...common, strictSkills: true});
        assert.equal(strict.status, 'incomplete');
        assert.equal(strict.skills?.status, 'skipped');
        assert.equal(strict.problems.some((problem) => problem.step === 'skills_visible' && problem.status === 'skipped'), true);
        assert.equal(calls.length, 0, `${source} strict check must not resolve, probe, or spawn the injected host CLI`);
      });
    } finally {
      fs.rmSync(root, {recursive: true, force: true});
    }
  }
});

test('checkInstall probes skill visibility after a matching registration authenticates its installed cache', () => {
  const fixture = completeFixture();
  const fakeCli = path.join(fixture.home, 'injected-skill-probe.exe');
  try {
    fs.writeFileSync(fakeCli, 'fixture');
    withFakeSkillCliProbe(fakeCli, (calls) => {
      const result = checkInstall({...fixture.options, verifySkills: true, codexCli: fakeCli, env: {...process.env, ORCH_ALLOW_UNVERIFIED_CLI: '1'}});
      assert.equal(result.registration.status, 'matched', JSON.stringify(result.problems));
      assert.equal(result.skills?.ok, true, JSON.stringify(result.skills));
      assert.notEqual(result.skills?.status, 'skipped');
      assert.equal(result.warnings.some((warning) => warning.step === 'skills_visible'), false);
      assert.deepEqual(calls.map((call) => call.args), [
        ['--version'],
        ['debug', 'prompt-input', 'install-plugin-verification'],
      ], 'a matched authenticated cache must resolve and run the host skill probe');
    });
  } finally {
    fs.rmSync(fixture.home, {recursive: true, force: true});
  }
});

test('checkInstall skips host skill visibility when a matching registration has an unauthenticated cache', () => {
  const fixture = completeFixture();
  const fakeCli = path.join(fixture.home, 'injected-skill-probe.exe');
  try {
    fs.writeFileSync(path.join(fixture.cache, 'scripts', 'release-integrity.mjs'), 'console.log("forged cache verifier");\n');
    fs.writeFileSync(fakeCli, 'fixture');
    const common = {
      ...fixture.options,
      verifySkills: true,
      codexCli: fakeCli,
      env: {...process.env, ORCH_ALLOW_UNVERIFIED_CLI: '1'},
    };
    withFakeSkillCliProbe(fakeCli, (calls) => {
      const advisory = checkInstall(common);
      assert.equal(advisory.registration.status, 'matched', JSON.stringify(advisory.problems));
      assert.equal(advisory.problems.some((problem) => problem.step === 'cache_authentication'), true);
      assert.equal(advisory.skills?.status, 'skipped');
      assert.equal(advisory.warnings.some((warning) => warning.step === 'skills_visible' && warning.status === 'skipped'), true);
      assert.equal(calls.length, 0, 'an unauthenticated cache must not reach the injected host CLI');

      const strict = checkInstall({...common, strictSkills: true});
      assert.equal(strict.status, 'incomplete');
      assert.equal(strict.problems.some((problem) => problem.step === 'skills_visible' && problem.status === 'skipped'), true);
      assert.equal(calls.length, 0, 'strict validation must also leave the injected host CLI untouched');
    });
  } finally {
    fs.rmSync(fixture.home, {recursive: true, force: true});
  }
});

test('ensureRegistration appends to an existing marketplace without touching other entries', () => {
  const other = {name: 'other-plugin', source: {source: 'local', path: './plugins/other-plugin'}, policy: {installation: 'AVAILABLE', authentication: 'ON_USE'}, category: 'Engineering'};
  const f = personalFixture({marketplace: {name: 'personal', interface: {displayName: 'Personal'}, plugins: [other]}});
  try {
    const result = ensureRegistration(f.options);
    assert.equal(result.status, 'appended');
    assert.equal(result.entryCount, 1);
    const data = JSON.parse(fs.readFileSync(f.marketplacePath, 'utf8'));
    assert.equal(data.interface.displayName, 'Personal');
    assert.deepEqual(data.plugins[0], other);
    assert.equal(data.plugins[1].name, 'demo-plugin');
    assert.equal(inspectRegistration(f.options).status, 'matched');
  } finally {
    fs.rmSync(f.home, {recursive: true, force: true});
  }
});

test('ensureRegistration refuses to invent a marketplace outside the personal convention', () => {
  const f = personalFixture();
  try {
    const elsewhere = path.join(f.home, 'somewhere', 'marketplace.json');
    const result = ensureRegistration({...f.options, marketplacePath: elsewhere});
    assert.equal(result.ok, false);
    assert.equal(result.status, 'create_forbidden');
    assert.equal(fs.existsSync(elsewhere), false);
  } finally {
    fs.rmSync(f.home, {recursive: true, force: true});
  }
});

test('ensureRegistration uses the checkout by default and still reports an explicitly missing distribution', () => {
  const noDist = personalFixture({withDist: false});
  try {
    const result = ensureRegistration(noDist.options);
    assert.equal(result.status, 'created');
    assert.equal(result.sourceKind, 'checkout');
    const missingDist = ensureRegistration({...noDist.options, source: 'dist'});
    assert.equal(missingDist.status, 'source_missing');
    assert.match(missingDist.reason, /rebuild a sealed distribution from the source checkout/i);
  } finally {
    fs.rmSync(noDist.home, {recursive: true, force: true});
  }
  const foreign = personalFixture({marketplace: {name: 'personal', plugins: [{name: 'demo-plugin', source: {source: 'local', path: './plugins/elsewhere/demo-plugin'}, policy: {installation: 'AVAILABLE', authentication: 'ON_INSTALL'}, category: 'Test'}]}});
  try {
    const result = ensureRegistration(foreign.options);
    assert.equal(result.status, 'source_mismatch');
    assert.match(result.reason, /fix or remove it by hand/);
  } finally {
    fs.rmSync(foreign.home, {recursive: true, force: true});
  }
});

test('path helpers keep marketplace entries relative to the marketplace root', () => {
  assert.equal(relativeSourcePath('C:\\home\\me', 'C:\\home\\me\\plugins\\dist\\demo'), './plugins/dist/demo');
  assert.equal(relativeSourcePath('/home/me', '/home/me/plugins/dist/demo'), './plugins/dist/demo');
  if (process.platform === 'win32') {
    assert.throws(
      () => relativeSourcePath('C:\\fixture-root', 'D:\\fixture-source\\codex-tui-orchestrator'),
      /MARKETPLACE_SOURCE_OUTSIDE_ROOT/,
      'a cross-volume local source must never become ./D:/... in marketplace.json',
    );
  }
  assert.equal(isPersonalMarketplaceDir(path.join('/home/me', '.agents', 'plugins'), '/home/me'), true);
  assert.equal(isPersonalMarketplaceDir(path.join('/home/me', 'plugins'), '/home/me'), false);
});

test('installer defaults use the repository marketplace rooted at the checkout', () => {
  const checkout = path.join(TEST_TEMP, 'repo-marketplace-defaults', 'codex-tui-orchestrator');
  assert.equal(defaultMarketplaceRoot(checkout), path.resolve(checkout));
  assert.equal(defaultMarketplacePath(checkout), path.join(path.resolve(checkout), '.agents', 'plugins', 'marketplace.json'));
});

test('explicit dist source defaults bind installer and registration to the dist-owned catalog', () => {
  const root = fs.mkdtempSync(path.join(TEST_TEMP, 'dist-marketplace-defaults-'));
  try {
    const checkout = path.join(root, 'checkout');
    const distRoot = path.join(root, 'export');
    const dist = path.join(distRoot, 'demo-plugin');
    fs.mkdirSync(path.join(checkout, '.codex-plugin'), {recursive: true});
    fs.writeFileSync(path.join(checkout, '.codex-plugin', 'plugin.json'), JSON.stringify({name: 'demo-plugin', version: '1.0.0'}) + '\n');
    coreFixture(checkout);
    sealFixtureDistribution({checkout, dist, pluginName: 'demo-plugin'});

    const parsed = parseArgs(['--plugin', checkout, '--source', 'dist', '--dist-root', distRoot]);
    assert.equal(parsed.marketplaceRoot, dist);
    assert.equal(parsed.marketplacePath, path.join(dist, '.agents', 'plugins', 'marketplace.json'));

    const registration = inspectRegistration({pluginPath: checkout, source: 'dist', distRoot});
    assert.equal(registration.status, 'matched', JSON.stringify(registration));
    assert.equal(registration.marketplaceRoot, dist);
    const ensured = ensureRegistration({pluginPath: checkout, source: 'dist', distRoot});
    assert.equal(ensured.status, 'matched', JSON.stringify(ensured));
    assert.equal(ensured.marketplacePath, path.join(dist, '.agents', 'plugins', 'marketplace.json'));

    const codexHome = path.join(root, '.codex');
    const cache = path.join(codexHome, 'plugins', 'cache', 'codex-tui-orchestrator-dist', 'demo-plugin', 'local');
    fs.cpSync(dist, cache, {recursive: true});
    fs.mkdirSync(path.join(cache, 'scripts', 'node_modules'), {recursive: true});
    fs.mkdirSync(codexHome, {recursive: true});
    fs.writeFileSync(path.join(codexHome, 'config.toml'), '[plugins."demo-plugin@codex-tui-orchestrator-dist"]\nenabled = true\n');
    const checked = checkInstall({pluginPath: checkout, source: 'dist', distRoot, codexHome, homeDir: root});
    assert.equal(checked.ok, true, JSON.stringify(checked.problems));
    assert.equal(checked.marketplaceName, 'codex-tui-orchestrator-dist');
    assert.equal(checked.marketplacePath, path.join(dist, '.agents', 'plugins', 'marketplace.json'));
    assert.equal(checked.registration.sourceKind, 'dist');
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});

test('marketplace discovery binds the catalog name to the exact repository root', () => {
  const root = path.join(TEST_TEMP, 'marketplace-discovery', 'codex-tui-orchestrator');
  const dist = path.join(TEST_TEMP, 'marketplace-discovery', 'export', 'codex-tui-orchestrator');
  assert.equal(marketplaceIsConfigured([
    {name: 'codex-tui-orchestrator-local', root},
  ], {name: 'codex-tui-orchestrator-local', root}), true);
  assert.equal(marketplaceIsConfigured([
    {name: 'codex-tui-orchestrator-local', root: path.join(TEST_TEMP, 'elsewhere')},
  ], {name: 'codex-tui-orchestrator-local', root}), false);
  assert.equal(marketplaceIsConfigured([
    {name: 'other-marketplace', root},
  ], {name: 'codex-tui-orchestrator-local', root}), false);
  assert.equal(marketplaceNameConflict([
    {name: 'codex-tui-orchestrator-local', root: path.join(TEST_TEMP, 'elsewhere')},
  ], {name: 'codex-tui-orchestrator-local', root}), path.resolve(TEST_TEMP, 'elsewhere'));
  assert.equal(marketplaceNameConflict([
    {name: 'other-marketplace', root: path.join(TEST_TEMP, 'elsewhere')},
  ], {name: 'codex-tui-orchestrator-local', root}), null);
  const coexisting = [
    {name: 'codex-tui-orchestrator-local', root},
    {name: 'codex-tui-orchestrator-dist', root: dist},
  ];
  assert.equal(marketplaceIsConfigured(coexisting, {name: 'codex-tui-orchestrator-local', root}), true);
  assert.equal(marketplaceIsConfigured(coexisting, {name: 'codex-tui-orchestrator-dist', root: dist}), true);
});

test('checkInstall accepts a complete install and reports each broken step', () => {
  const f = personalFixture();
  try {
    assert.equal(ensureRegistration(f.options).ok, true);
    const version = '1.0.0';
    const cache = path.join(f.home, '.codex', 'plugins', 'cache', 'personal', 'demo-plugin', version);
    fs.cpSync(f.plugin, cache, {recursive: true});
    fs.mkdirSync(path.join(cache, 'scripts', 'node_modules'), {recursive: true});
    fs.mkdirSync(path.join(f.home, '.codex'), {recursive: true});
    fs.writeFileSync(path.join(f.home, '.codex', 'config.toml'), '[plugins."demo-plugin@personal"]\nenabled = true\n');

    const ok = checkInstall({...f.options, codexHome: path.join(f.home, '.codex')});
    assert.equal(ok.ok, true, JSON.stringify(ok.problems));
    assert.equal(ok.registration.status, 'matched');
    assert.equal(ok.cache, cache);

    fs.rmSync(path.join(cache, 'scripts', 'node_modules'), {recursive: true, force: true});
    fs.writeFileSync(path.join(f.home, '.codex', 'config.toml'), '[plugins."demo-plugin@personal"]\nenabled = false\n');
    const broken = checkInstall({...f.options, codexHome: path.join(f.home, '.codex')});
    assert.equal(broken.ok, false);
    assert.deepEqual(broken.problems.map((problem) => problem.step).sort(), ['cache_deps', 'host_config']);
  } finally {
    fs.rmSync(f.home, {recursive: true, force: true});
  }
});

test('checkInstall recognizes the current host local cache label', () => {
  const f = completeFixture();
  try {
    const localCache = path.join(f.codexHome, 'plugins', 'cache', 'personal', 'demo-plugin', 'local');
    fs.renameSync(f.cache, localCache);
    const result = checkInstall(f.options);
    assert.equal(result.ok, true, JSON.stringify(result.problems));
    assert.equal(result.cache, localCache);
  } finally {
    fs.rmSync(f.home, {recursive: true, force: true});
  }
});

test('CLI helpers parse host output, caches, enablement, and the Codex CLI path', () => {
  assert.deepEqual(parseArgs([]).mode, 'install');
  assert.equal(parseArgs([]).source, 'checkout');
  assert.equal(shouldPublishDistribution({source: 'checkout'}), false);
  assert.equal(shouldPublishDistribution({source: 'dist'}), true);
  assert.equal(parseArgs(['--check']).mode, 'check');
  assert.equal(parseArgs(['--source', 'checkout']).source, 'checkout');
  assert.throws(() => parseArgs(['--source', 'dist', '--skip-dist']), /SKIP_DIST_UNSUPPORTED/);
  assert.throws(() => installPlugin({source: 'dist', skipDist: true}), /SKIP_DIST_UNSUPPORTED/);
  assert.throws(() => parseArgs(['--source']), /requires a value/);
  assert.throws(() => parseArgs(['--nope']), /unknown option/);
  assert.deepEqual(parseCliJson('{"installedPath":"C:\\\\x","version":"1.0.0"}'), {installedPath: 'C:\\x', version: '1.0.0'});
  assert.deepEqual(parseCliJson('log line\n{"installedPath":"C:\\\\x"}').installedPath, 'C:\\x');
  assert.throws(() => parseCliJson('not json'), /could not parse JSON/);
  assert.equal(pluginEnabledInConfig('[plugins."demo-plugin@personal"]\nenabled = true\n', 'demo-plugin@personal'), true);
  assert.equal(pluginEnabledInConfig('[plugins."demo-plugin@personal"]\nenabled = false\n', 'demo-plugin@personal'), false);
  assert.equal(pluginEnabledInConfig('[plugins."other@personal"]\nenabled = true\n', 'demo-plugin@personal'), false);

  const home = fs.mkdtempSync(path.join(TEST_TEMP, 'install-cache-'));
  try {
    for (const version of ['0.9.0', '1.0.0']) fs.mkdirSync(path.join(home, '.codex', 'plugins', 'cache', 'personal', 'demo-plugin', version), {recursive: true});
    const caches = listInstalledCaches({homeDir: home, marketplaceName: 'personal', pluginName: 'demo-plugin'});
    assert.deepEqual(caches.map((entry) => entry.version), ['0.9.0', '1.0.0']);
    const fakeCli = path.join(TEST_TEMP, 'fake-codex.exe');
    fs.writeFileSync(fakeCli, '');
    try {
      assert.equal(pickCodexCli({env: {CODEX_CLI_PATH: fakeCli, PATH: ''}}), fakeCli);
    } finally {
      fs.rmSync(fakeCli, {force: true});
    }
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
  assert.deepEqual(skillNamesOf(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')), ['codex-tui-orchestrator']);
});

test('cache discovery and checkInstall follow CODEX_HOME instead of the home directory', () => {
  const f = completeFixture({codexHomeRelative: 'codex-home-elsewhere'});
  try {
    const caches = listInstalledCaches({codexHome: f.codexHome, marketplaceName: 'personal', pluginName: 'demo-plugin'});
    assert.deepEqual(caches.map((entry) => entry.version), ['1.0.0']);
    const result = checkInstall(f.options);
    assert.equal(result.ok, true, JSON.stringify(result.problems));
    assert.equal(result.codexHome, f.codexHome);
    assert.equal(result.cache, f.cache);
    assert.equal(result.environment.platform, process.platform);

    // 同一台机器上 home/.codex 里没有缓存：必须报缺失，而不是把别处的缓存当成已安装
    const misplaced = checkInstall({...f.options, codexHome: path.join(f.home, '.codex')});
    assert.equal(misplaced.ok, false);
    assert.equal(misplaced.problems.some((problem) => problem.step === 'cache'), true);
  } finally {
    fs.rmSync(f.home, {recursive: true, force: true});
  }
});

test('setRegistrationSource re-points a single stale entry and preserves every other entry', () => {
  const other = {name: 'other-plugin', source: {source: 'local', path: './plugins/other-plugin'}, policy: {installation: 'AVAILABLE', authentication: 'ON_USE'}, category: 'Engineering'};
  const stale = {name: 'demo-plugin', source: {source: 'local', path: './plugins/gone-from-another-machine/demo-plugin'}, policy: {installation: 'AVAILABLE', authentication: 'ON_INSTALL'}, category: 'Test'};
  const f = personalFixture({marketplace: {name: 'personal', interface: {displayName: 'Personal'}, plugins: [other, stale]}});
  try {
    assert.equal(inspectRegistration(f.options).status, 'source_mismatch');
    const result = setRegistrationSource(f.options);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.status, 'source-set');
    assert.equal(result.changed, true);
    const data = JSON.parse(fs.readFileSync(f.marketplacePath, 'utf8'));
    assert.equal(data.plugins[1].source.path, relativeSourcePath(f.home, f.plugin));
    assert.deepEqual(data.plugins[0], other, '其它条目必须原样保留');
    assert.equal(data.plugins[1].category, 'Test', '既有策略与分类不被改写');
    assert.equal(inspectRegistration(f.options).status, 'matched');
    const again = setRegistrationSource(f.options);
    assert.equal(again.status, 'matched');
    assert.equal(again.changed, false);
  } finally {
    fs.rmSync(f.home, {recursive: true, force: true});
  }
});

test('setRegistrationSource refuses an implicitly discovered unverified distribution before rewriting it', () => {
  const f = personalFixture();
  try {
    fs.mkdirSync(path.dirname(f.marketplacePath), {recursive: true});
    fs.writeFileSync(f.marketplacePath, JSON.stringify({name: 'personal', plugins: [{name: 'demo-plugin', source: {source: 'local', path: relativeSourcePath(f.home, f.dist)}}]}, null, 2) + '\n');
    const before = fs.readFileSync(f.marketplacePath);
    const result = setRegistrationSource({...f.options, source: 'checkout'});
    assert.equal(result.status, 'dist_unverified', JSON.stringify(result));
    assert.deepEqual(fs.readFileSync(f.marketplacePath), before, 'an unverified dist must not be rewritten through a checkout request');
  } finally {
    fs.rmSync(f.home, {recursive: true, force: true});
  }
});

test('skill visibility is advisory unless --strict-skills is requested', () => {
  const f = completeFixture();
  try {
    const brokenCli = path.join(f.home, 'not-a-real-cli');
    const advisory = checkInstall({...f.options, verifySkills: true, codexCli: brokenCli});
    assert.equal(advisory.ok, true, JSON.stringify(advisory.problems));
    assert.equal(advisory.warnings.some((warning) => warning.step === 'skills_visible'), true);
    const strict = checkInstall({...f.options, verifySkills: true, strictSkills: true, codexCli: brokenCli});
    assert.equal(strict.ok, false);
    assert.equal(strict.problems.some((problem) => problem.step === 'skills_visible'), true);
  } finally {
    fs.rmSync(f.home, {recursive: true, force: true});
  }
});

test('verifySkillsVisible reports an unavailable host CLI instead of throwing', () => {
  const result = verifySkillsVisible({codexCli: path.join(TEST_TEMP, 'missing-codex.exe'), pluginName: 'demo-plugin', skillNames: ['demo-skill']});
  assert.equal(result.ok, false);
  assert.match(result.reason, /CLI_MISSING|host CLI/);
});

test('parseArgs covers the generalization flags', () => {
  assert.equal(parseArgs(['--set-source']).setSource, true);
  assert.equal(parseArgs(['--strict-skills']).strictSkills, true);
  assert.equal(parseArgs(['--strict-skills']).verifySkills, true);
  assert.equal(parseArgs(['--timeout-ms', '1000']).timeoutMs, 1000);
  assert.equal(parseArgs([]).timeoutMs, 900000);
  assert.throws(() => parseArgs(['--timeout-ms', '0']), /positive number/);
});

test('npm resolution prefers a JS entry so spaced paths survive the command line', () => {
  const dir = fs.mkdtempSync(path.join(TEST_TEMP, 'npm-cli-'));
  try {
    const fakeNode = path.join(dir, 'node.exe');
    const fakeNpm = path.join(dir, 'npm_execpath.js');
    fs.writeFileSync(fakeNode, '');
    fs.writeFileSync(fakeNpm, '');

    const fromEnv = pickNpmCli({env: {npm_execpath: fakeNpm, PATH: ''}, nodePath: fakeNode});
    assert.equal(fromEnv.source, 'npm_execpath');
    assert.equal(fromEnv.command, fakeNode);
    assert.deepEqual(fromEnv.args, [fakeNpm]);
    assert.equal(fromEnv.shell, false);

    // PATH 上只有 npm.cmd，但同级带 npm-cli.js → 仍然走 node + JS 入口（绕开 cmd 引号问题）
    const binDir = path.join(dir, 'bin');
    const cliDir = path.join(binDir, 'node_modules', 'npm', 'bin');
    fs.mkdirSync(cliDir, {recursive: true});
    fs.writeFileSync(path.join(binDir, 'npm.cmd'), '');
    const cli = path.join(cliDir, 'npm-cli.js');
    fs.writeFileSync(cli, '');
    const fromPath = pickNpmCli({env: {PATH: binDir}, nodePath: fakeNode});
    assert.equal(fromPath.source, 'npm-cli.js');
    assert.equal(fromPath.command, fakeNode);
    assert.deepEqual(fromPath.args, [cli]);
    assert.equal(fromPath.shell, false);

    // 只有 shim 时才退回 shell，此时参数必须自带引号
    fs.rmSync(cli);
    const shimOnly = pickNpmCli({env: {PATH: binDir}, nodePath: fakeNode});
    assert.equal(shimOnly.source, 'npm-shim');
    assert.equal(shimOnly.shell, true);
    assert.equal(quoteShellArg('C:\\Program Files\\nodejs\\npm.cmd'), '"C:\\Program Files\\nodejs\\npm.cmd"');
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
  assert.equal(quoteShellArg('plain'), 'plain');
  assert.equal(quoteShellArg('C:\\has space\\x'), '"C:\\has space\\x"');
  assert.equal(quoteShellArg('has"quote'), '"has""quote"');
  assert.throws(() => quoteShellArg('C:\\temp\\%ORCH_QUOTE_TEST%\\x'), /UNSAFE_SHELL_ARGUMENT/);
  assert.throws(() => quoteShellArg('C:\\temp\\!ORCH_QUOTE_TEST!\\x'), /UNSAFE_SHELL_ARGUMENT/);
  assert.throws(() => quoteShellArg('line\nnext'), /UNSAFE_SHELL_ARGUMENT/);
});
