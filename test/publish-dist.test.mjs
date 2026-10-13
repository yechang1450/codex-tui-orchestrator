import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {inspectRegistration} from '../scripts/repair-plugin-registration.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function copyCheckout(root, {name = 'codex-tui-orchestrator', withDependencies = false} = {}) {
  const checkout = path.join(root, name);
  fs.cpSync(repo, checkout, {recursive: true, filter: source => {
    const relative = path.relative(repo, source).replaceAll('\\', '/');
    if (!relative) return true;
    const topLevel = relative.split('/')[0];
    if (['.git', 'temp', 'dist', '.plugin-eval'].includes(topLevel)) return false;
    return withDependencies || (relative !== 'scripts/node_modules' && !relative.startsWith('scripts/node_modules/'));
  }});
  return checkout;
}

test('publication requires an explicit export target and does not create a dist folder by default', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-publish-default-'));
  try {
    const checkout = copyCheckout(root);
    const result = spawnSync(process.execPath, [path.join(checkout, 'scripts', 'publish-dist.mjs')], {cwd: checkout, encoding: 'utf8', windowsHide: true});
    assert.notEqual(result.status, 0);
    assert.match(String(result.stderr), /--target is required/);
    assert.equal(fs.existsSync(path.join(root, 'dist')), false, 'default publishing must not create a sibling dist');
    assert.equal(fs.existsSync(path.join(checkout, 'dist')), false, 'default publishing must not create a nested dist');
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});

test('publication refuses a target that would delete its source checkout', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-publish-source-'));
  try {
    const checkout = copyCheckout(root);
    const manifest = path.join(checkout, 'release.json');
    const before = fs.readFileSync(manifest);
    const result = spawnSync(process.execPath, [path.join(checkout, 'scripts', 'publish-dist.mjs'), '--target', root], {cwd: checkout, encoding: 'utf8', windowsHide: true});
    assert.notEqual(result.status, 0);
    assert.ok(fs.existsSync(manifest), 'a rejected target must never delete source files');
    assert.deepEqual(fs.readFileSync(manifest), before);
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});

test('publish-dist builds a sealed distribution with its own local marketplace catalog', () => {
  // Explicit external targets remain supported; fixtures are removed after the test.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-publish-dist-'));
  try {
    const checkout=copyCheckout(root,{withDependencies:true});
    const target = path.join(root, 'dist');
    const output = execFileSync(process.execPath, [path.join(checkout, 'scripts', 'publish-dist.mjs'), '--target', target], {encoding: 'utf8', cwd: checkout});
    assert.ok(output.includes('codex plugin marketplace add ' + JSON.stringify(path.join(target, 'codex-tui-orchestrator'))));
    assert.match(output, /codex plugin add codex-tui-orchestrator@codex-tui-orchestrator-dist/);
    const dist = path.join(target, 'codex-tui-orchestrator');
    assert.ok(fs.existsSync(path.join(dist, '.codex-plugin', 'plugin.json')), '分发必须带插件清单');
    assert.equal(fs.existsSync(path.join(dist, 'temp')), false, '分发不带本地运行状态');
    assert.equal(fs.existsSync(path.join(dist, 'test')), false, '分发不带开发测试套件');
    assert.equal(fs.existsSync(path.join(dist, '.github')), false, '分发不带 CI 元数据');
    assert.equal(fs.existsSync(path.join(dist, '.git')), false, '分发不带 git 元数据');
    assert.equal(fs.existsSync(path.join(dist, 'scripts', 'node_modules')), false, '分发不带依赖目录');
    assert.equal(fs.existsSync(path.join(dist, 'agents', 'openai.yaml')), false, 'distribution omits obsolete root agent metadata');
    assert.equal(fs.existsSync(path.join(dist, 'skills', 'codex-tui-orchestrator', 'agents', 'openai.yaml')), true, 'distribution retains active skill metadata');
    for (const sourceOnlyFile of [
      'scripts/bump-version.mjs',
      'scripts/coverage.mjs',
      'scripts/publish-dist.mjs',
      'repair.mjs',
      'docs/clean-machine-validation.md',
      'docs/release-policy.md',
      '.gitattributes',
      '.gitignore',
      'CHANGELOG.md',
      'CODE_OF_CONDUCT.md',
      'CONTRIBUTING.md',
      'SECURITY.md',
      'docs/compatibility.md',
    ]) {
      assert.equal(
        fs.existsSync(path.join(dist, sourceOnlyFile)),
        false,
        `distribution must omit source-only maintenance file ${sourceOnlyFile}`,
      );
    }
    const shippedDocs = [
      'docs/environment-setup.md',
      'docs/execution-contract.md',
      'docs/security-boundaries.md',
      'docs/terms.md',
    ].map(rel => fs.readFileSync(path.join(dist, rel), 'utf8')).join('\n');
    assert.doesNotMatch(shippedDocs, /(?:rc-validation\.md|release-policy\.md|clean-machine-validation\.md|scripts\/coverage\.mjs)/i, 'shipped documents must not link to omitted source-only material');
    for(const rel of ['README.md','README-zh.md','docs/security-boundaries.md']){
      assert.equal(fs.existsSync(path.join(dist,rel)),true,`distribution retains linked user-facing document ${rel}`);
    }
    for (const legacyPiModule of ['pi-host.mjs', 'pi-runtime.mjs', 'pi-shutdown.mjs']) {
      assert.equal(
        fs.existsSync(path.join(dist, 'scripts', 'core', legacyPiModule)),
        false,
        `Codex-only distribution must not retain unreachable Pi adapter ${legacyPiModule}`,
      );
    }
    assert.ok(fs.existsSync(path.join(dist, 'scripts', 'distribution-provenance.json')), '分发必须显式携带已认证的源码依赖来源');
    assert.ok(fs.existsSync(path.join(dist, 'scripts', 'distribution-source-release.json')), '分发必须携带认证后的源码发行封印');
    const verify = JSON.parse(execFileSync(process.execPath, [path.join(dist, 'scripts', 'release-integrity.mjs')], {encoding: 'utf8', cwd: dist}));
    assert.equal(verify.schema, 2);
    const catalogPath = path.join(dist, '.agents', 'plugins', 'marketplace.json');
    const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    assert.equal(catalog.name, 'codex-tui-orchestrator-dist');
    assert.equal(catalog.plugins.length, 1);
    assert.deepEqual(catalog.plugins[0].source, {source: 'local', path: './'});
    const release = JSON.parse(fs.readFileSync(path.join(dist, 'release.json'), 'utf8'));
    assert.ok(release.runtimeFiles['.agents/plugins/marketplace.json'], 'the distribution catalog must be sealed into the distribution release manifest');

    // `--source dist --dist-root` must choose the dist-owned catalog by default,
    // rather than trying to construct a relative path from the checkout catalog.
    const result = inspectRegistration({pluginPath: checkout, source: 'dist', distRoot: target});
    assert.equal(result.status, 'matched', JSON.stringify(result));
    assert.equal(result.sourceKind, 'dist');
    assert.equal(result.marketplacePath, catalogPath);
    assert.equal(result.marketplaceRoot, dist);

    // A user can run the default local-install flow from the exported artifact
    // itself.  That flow must discover the artifact-owned catalog rather than
    // assuming the checkout catalog name or a second dist export.
    const selfRegistration = inspectRegistration({pluginPath: dist});
    assert.equal(selfRegistration.status, 'matched', JSON.stringify(selfRegistration));
    assert.equal(selfRegistration.marketplaceName, 'codex-tui-orchestrator-dist');
    assert.equal(selfRegistration.marketplaceRoot, dist);
    assert.equal(selfRegistration.sourceReal, selfRegistration.pluginReal);
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});

test('publish-dist uses the verified manifest name when the checkout directory has a recovery suffix', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-publish-recovery-name-'));
  try {
    const checkout = copyCheckout(root, {name: 'codex-tui-orchestrator-recovery', withDependencies: true});
    const target = path.join(root, 'export');
    const result = spawnSync(process.execPath, [path.join(checkout, 'scripts', 'publish-dist.mjs'), '--target', target], {cwd: checkout, encoding: 'utf8', windowsHide: true});
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(fs.existsSync(path.join(target, 'codex-tui-orchestrator', '.codex-plugin', 'plugin.json')), true);
    assert.equal(fs.existsSync(path.join(target, 'codex-tui-orchestrator-recovery')), false);
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});

test('publish-dist authenticates source dependencies before replacing an existing distribution', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-publish-source-auth-'));
  try {
    const checkout = copyCheckout(root, {withDependencies: true});
    const target = path.join(root, 'export');
    const existing = path.join(target, 'codex-tui-orchestrator');
    fs.mkdirSync(existing, {recursive: true});
    const marker = path.join(existing, 'must-survive.txt');
    fs.writeFileSync(marker, 'source authentication happens first', 'utf8');
    const dependency = path.join(checkout, 'scripts', 'node_modules', '@openai', 'codex-sdk', 'package.json');
    fs.appendFileSync(dependency, '\n// corrupt after sealing\n');
    const result = spawnSync(process.execPath, [path.join(checkout, 'scripts', 'publish-dist.mjs'), '--target', target], {cwd: checkout, encoding: 'utf8', windowsHide: true});
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /source release authentication failed.*RELEASE_DEPENDENCY_INTEGRITY/is);
    assert.equal(fs.readFileSync(marker, 'utf8'), 'source authentication happens first');
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});

test('repair rejects an unsafe explicit destination name before writing outside its target', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-publish-name-escape-'));
  try {
    const target = path.join(root, 'export');
    const victim = path.join(root, 'victim');
    fs.mkdirSync(victim, {recursive: true});
    fs.writeFileSync(path.join(victim, 'marker.txt'), 'must survive', 'utf8');
    const result = spawnSync(process.execPath, [path.join(repo, 'repair.mjs'), '--target', target, '--name', '..\\victim'], {encoding: 'utf8', cwd: repo, windowsHide: true});
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /destination name|safe path segment/i);
    assert.equal(fs.readFileSync(path.join(victim, 'marker.txt'), 'utf8'), 'must survive');
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});

// 回归（2026-09-22 穷举审计实测抓到）：publishDist 把 manifest.name 直接 path.join
// 到分发根上，然后 rmSync(recursive) —— 一个 name = "..\\victim" 的清单会在
// 任何校验之前递归删掉分发根之外的同名目录（实测已复现）。判据：畸形清单名必须先被
// 拒绝，且目标目录必须原样存活。
test('publish-dist refuses a manifest name that escapes the distribution root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-publish-escape-'));
  try {
    const fake = path.join(root, 'fake-plugin');
    fs.mkdirSync(path.join(fake, 'scripts'), {recursive: true});
    fs.mkdirSync(path.join(fake, '.codex-plugin'), {recursive: true});
    for (const rel of ['scripts/publish-dist.mjs', 'scripts/repair-plugin-registration.mjs', 'scripts/release-integrity.mjs', 'repair.mjs']) {
      fs.copyFileSync(path.join(repo, rel), path.join(fake, rel));
    }
    fs.writeFileSync(path.join(fake, '.codex-plugin', 'plugin.json'), JSON.stringify({name: '..\\victim', version: '0.0.1'}), 'utf8');
    const victim = path.join(root, 'victim');
    fs.mkdirSync(victim, {recursive: true});
    fs.writeFileSync(path.join(victim, 'marker.txt'), 'must survive', 'utf8');

    const result = spawnSync(process.execPath, [path.join(fake, 'scripts', 'publish-dist.mjs'), '--target', path.join(root, 'dist')], {encoding: 'utf8', cwd: fake, windowsHide: true});
    assert.notEqual(result.status, 0, 'malformed manifest name must fail the publish');
    assert.ok(fs.existsSync(path.join(victim, 'marker.txt')), 'a directory outside the distribution root must never be deleted');
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});
test('publish-dist refuses a target beneath a junction before recursive cleanup',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'orch-publish-junction-'));
 try{
  const outside=path.join(root,'outside');fs.mkdirSync(outside);
  const marker=path.join(outside,'marker.txt');fs.writeFileSync(marker,'survives','utf8');
  const link=path.join(root,'linked');
  try{fs.symlinkSync(outside,link,'junction');}catch{try{fs.symlinkSync(outside,link,'dir');}catch{return;}}
  const result=spawnSync(process.execPath,[path.join(repo,'scripts','publish-dist.mjs'),'--target',link],{encoding:'utf8',cwd:repo,windowsHide:true});
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/symbolic link|junction|reparse/i);
  assert.equal(fs.readFileSync(marker,'utf8'),'survives');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
