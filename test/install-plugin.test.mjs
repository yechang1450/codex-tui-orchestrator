import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  ensureRegistration,
  inspectRegistration,
  isPersonalMarketplaceDir,
  relativeSourcePath,
  setRegistrationSource,
} from '../scripts/repair-plugin-registration.mjs';
import {
  checkInstall,
  listInstalledCaches,
  parseArgs,
  parseCliJson,
  pickCodexCli,
  pluginEnabledInConfig,
  skillNamesOf,
  verifySkillsVisible,
} from '../scripts/install-plugin.mjs';

const TEST_TEMP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'temp');
fs.mkdirSync(TEST_TEMP, {recursive: true});

function coreFixture(pluginDir) {
  const core = path.join(pluginDir, 'scripts', 'core');
  fs.mkdirSync(core, {recursive: true});
  fs.writeFileSync(path.join(core, 'orchestrate-sdk.mjs'), 'export const marker = "checkout";\n');
  fs.writeFileSync(path.join(core, 'contracts.mjs'), 'export const CORE_VERSION = "test";\n');
}

/** 个人 marketplace 场景的夹具：home/<.agents/plugins>/marketplace.json + plugins/dist/<name>。 */
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
  fs.mkdirSync(path.join(cache, 'scripts', 'node_modules'), {recursive: true});
  fs.writeFileSync(path.join(cache, 'scripts', 'release-integrity.mjs'), "console.log(JSON.stringify({schema: 2, coreVersion: 'test', files: 0, runtimeFiles: 0}));\n");
  fs.mkdirSync(codexHome, {recursive: true});
  fs.writeFileSync(path.join(codexHome, 'config.toml'), '[plugins."demo-plugin@personal"]\nenabled = true\n');
  return {...f, codexHome, cache, options: {...f.options, codexHome, ...(cli ? {codexCli: cli} : {})}};
}

test('ensureRegistration creates the personal marketplace and points at the clean distribution', () => {
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
    assert.equal(data.plugins[0].source.path, relativeSourcePath(f.home, f.dist));
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

test('ensureRegistration reports missing distribution and foreign entries instead of guessing', () => {
  const noDist = personalFixture({withDist: false});
  try {
    const result = ensureRegistration(noDist.options);
    assert.equal(result.status, 'source_missing');
    assert.match(result.reason, /publish-dist/);
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
  assert.equal(isPersonalMarketplaceDir(path.join('/home/me', '.agents', 'plugins'), '/home/me'), true);
  assert.equal(isPersonalMarketplaceDir(path.join('/home/me', 'plugins'), '/home/me'), false);
});

test('checkInstall accepts a complete install and reports each broken step', () => {
  const f = personalFixture();
  try {
    assert.equal(ensureRegistration(f.options).ok, true);
    const version = '1.0.0';
    const cache = path.join(f.home, '.codex', 'plugins', 'cache', 'personal', 'demo-plugin', version);
    fs.mkdirSync(path.join(cache, 'scripts', 'node_modules'), {recursive: true});
    fs.writeFileSync(path.join(cache, 'scripts', 'release-integrity.mjs'), "console.log(JSON.stringify({schema: 2, coreVersion: 'test', files: 0, runtimeFiles: 0}));\n");
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

test('CLI helpers parse host output, caches, enablement, and the Codex CLI path', () => {
  assert.deepEqual(parseArgs([]).mode, 'install');
  assert.equal(parseArgs(['--check']).mode, 'check');
  assert.equal(parseArgs(['--source', 'checkout']).source, 'checkout');
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
    assert.equal(data.plugins[1].source.path, relativeSourcePath(f.home, f.dist));
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
  assert.match(result.reason, /host CLI/);
});

test('parseArgs covers the generalization flags', () => {
  assert.equal(parseArgs(['--set-source']).setSource, true);
  assert.equal(parseArgs(['--strict-skills']).strictSkills, true);
  assert.equal(parseArgs(['--strict-skills']).verifySkills, true);
  assert.equal(parseArgs(['--timeout-ms', '1000']).timeoutMs, 1000);
  assert.equal(parseArgs([]).timeoutMs, 900000);
  assert.throws(() => parseArgs(['--timeout-ms', '0']), /positive number/);
});
