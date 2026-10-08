#!/usr/bin/env node
/**
 * publish-dist — 从当前工作树重建"干净分发"，供本地 marketplace 安装使用。
 *
 * 为什么需要它：本地安装会把插件目录整体复制进安装缓存。工作树里有 .git、
 * temp/（本地运行状态与验收证据），复制进去既占空间又让静态评估失真；分发包
 * 只带运行时文件（约 190 个文件 / 2 MB）。
 *
 * 用法：
 *   node scripts/publish-dist.mjs --target <分发根> [--quiet]
 *
 * 行为：
 *   1) 删除旧分发目录（避免新旧混合），再调用 repair.mjs --target 复制当前工作树；
 *   2) 在分发里跑 release-integrity（分发自校验），失败即返回非零；
 *   3) 写入分发自有 catalog、重新封存并校验，再打印注册该 catalog 和安装插件的命令。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {DIST_MARKETPLACE_NAME, manifestNameProblem} from './repair-plugin-registration.mjs';
import {assertNoReparsePoints} from './core/runtime-context.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

function authenticateSourceForDistribution() {
  const verification = spawnSync(process.execPath, [path.join(root, 'scripts', 'release-integrity.mjs'), '--verify-source'], {encoding: 'utf8', windowsHide: true, cwd: root});
  if (verification.status !== 0) throw new Error('source release authentication failed: ' + (verification.stderr || verification.stdout || 'exit ' + verification.status));
  const sourceRelease = fs.readFileSync(path.join(root, 'release.json'));
  const dependencyManifest = fs.readFileSync(path.join(root, 'scripts', 'dependency-integrity.json'));
  const packageLock = fs.readFileSync(path.join(root, 'scripts', 'package-lock.json'));
  let dependency;
  try { dependency = JSON.parse(dependencyManifest); } catch { throw new Error('source dependency integrity manifest changed after authentication'); }
  if (dependency?.schema !== 1 || typeof dependency.packageLockSha256 !== 'string' || !dependency.files || Array.isArray(dependency.files) || dependency.packageLockSha256 !== sha256(packageLock)) {
    throw new Error('source dependency integrity manifest changed after authentication');
  }
  return {
    sourceRelease,
    dependencyManifest,
    packageLock,
    provenance: {
      schema: 1,
      sourceReleaseSha256: sha256(sourceRelease),
      sourceDependencyManifestSha256: sha256(dependencyManifest),
      packageLockSha256: sha256(packageLock),
      dependencyFiles: Object.keys(dependency.files).length,
    },
  };
}

function writeDistributionProvenance({dist, source}) {
  const scripts = path.join(dist, 'scripts');
  const copiedRelease = fs.readFileSync(path.join(dist, 'release.json'));
  const copiedDependency = fs.readFileSync(path.join(scripts, 'dependency-integrity.json'));
  const copiedLock = fs.readFileSync(path.join(scripts, 'package-lock.json'));
  if (sha256(copiedRelease) !== source.provenance.sourceReleaseSha256
    || sha256(copiedDependency) !== source.provenance.sourceDependencyManifestSha256
    || sha256(copiedLock) !== source.provenance.packageLockSha256) {
    throw new Error('source files changed while the distribution was being copied; authenticate and publish again');
  }
  fs.writeFileSync(path.join(scripts, 'distribution-source-release.json'), source.sourceRelease);
  fs.writeFileSync(path.join(scripts, 'distribution-provenance.json'), `${JSON.stringify(source.provenance, null, 2)}\n`, 'utf8');
}

function parseArgs(argv) {
  const out = {target: null, quiet: false};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--target') {
      const value = argv[++i];
      if (!value) throw new Error('--target requires a directory');
      out.target = path.resolve(value);
    } else if (arg === '--quiet') out.quiet = true;
    else if (arg === '-h' || arg === '--help') out.help = true;
    else throw new Error('unknown option: ' + arg);
  }
  return out;
}

export function publishDist({target = null, quiet = false} = {}) {
  if (!target) throw new Error('--target is required; the default checkout layout has no dist folder');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, '.codex-plugin', 'plugin.json'), 'utf8'));
  const pluginName = manifest.name;
  const resolvedTarget = path.resolve(target);
  const dist = resolveDistDir(resolvedTarget, pluginName);
  // The next operation is recursive deletion. Validate the target and every
  // existing ancestor before mkdir/rm so a junction or symlink cannot redirect
  // publication into an unrelated directory.
  assertNoReparsePoints(resolvedTarget, 'distribution target root');
  assertNoReparsePoints(dist, 'distribution target');
  // Never let an explicit export target point inside the source checkout. The
  // next operation is rm -r and must not be able to delete source or evidence.
  const sourceReal = fs.realpathSync.native(root);
  const relativeToSource = path.relative(sourceReal, dist);
  const insideSource = relativeToSource === ''
    || (!path.isAbsolute(relativeToSource)
      && relativeToSource !== '..'
      && !relativeToSource.startsWith('..' + path.sep));
  if (insideSource) throw new Error(`distribution target must be outside the source checkout: ${dist}`);
  // The distribution intentionally omits node_modules. Authenticate the
  // complete source tree before copying, then carry that exact proof into the
  // explicit distribution-only sealing mode below.
  const source = authenticateSourceForDistribution();
  fs.mkdirSync(resolvedTarget, {recursive: true});
  // repair.mjs 拒绝已存在的目标，正是为了避免新旧混合；这里先删旧分发再重建。
  fs.rmSync(dist, {recursive: true, force: true});
  const repair = spawnSync(process.execPath, [path.join(root, 'repair.mjs'), '--target', resolvedTarget, '--name', pluginName], {encoding: 'utf8', windowsHide: true, cwd: root});
  if (repair.status !== 0) throw new Error('repair.mjs failed: ' + (repair.stderr || repair.stdout || 'exit ' + repair.status));
  writeDistributionProvenance({dist, source});
  const catalogPath = writeDistMarketplaceCatalog({dist, pluginName, category: manifest?.interface?.category});
  // repair.mjs correctly verifies the copied checkout, whose release seal names
  // the checkout catalog. Replacing that catalog is a release mutation, so seal
  // the dist copy itself and immediately verify the newly sealed bytes.
  const seal = spawnSync(process.execPath, [path.join(dist, 'scripts', 'release-integrity.mjs'), '--seal', '--distribution'], {encoding: 'utf8', windowsHide: true, cwd: dist});
  if (seal.status !== 0) throw new Error('distribution sealing failed: ' + (seal.stderr || seal.stdout || 'exit ' + seal.status));
  const verify = spawnSync(process.execPath, [path.join(dist, 'scripts', 'release-integrity.mjs')], {encoding: 'utf8', windowsHide: true, cwd: dist});
  if (verify.status !== 0) throw new Error('distribution integrity failed: ' + (verify.stderr || verify.stdout || 'exit ' + verify.status));
  const summary = JSON.parse(String(verify.stdout).trim().split('\n').pop());
  const files = (() => {
    let total = 0;
    const walk = dir => {for (const entry of fs.readdirSync(dir, {withFileTypes: true})) entry.isDirectory() ? walk(path.join(dir, entry.name)) : total++;};
    walk(dist);
    return total;
  })();
  const result = {
    dist,
    target: resolvedTarget,
    pluginName,
    marketplaceName: DIST_MARKETPLACE_NAME,
    marketplaceRoot: dist,
    marketplacePath: catalogPath,
    files,
    coreVersion: summary.coreVersion,
    coreFiles: summary.files,
    runtimeFiles: summary.runtimeFiles,
    marketplaceAdd: 'codex plugin marketplace add ' + JSON.stringify(dist),
    install: 'codex plugin add ' + pluginName + '@' + DIST_MARKETPLACE_NAME,
  };
  if (!quiet) {
    console.log('[publish-dist] ' + dist + ' (' + files + ' files, core ' + summary.coreVersion + ')');
    console.log('[publish-dist] register: ' + result.marketplaceAdd);
    console.log('[publish-dist] next: ' + result.install);
  }
  return result;
}

/** Build the dist-owned catalog after repair.mjs copies the checkout catalog. */
export function writeDistMarketplaceCatalog({dist, pluginName, category = 'Productivity'} = {}) {
  const problem = manifestNameProblem(pluginName);
  if (problem) throw new Error(`invalid .codex-plugin/plugin.json name ${JSON.stringify(pluginName)}: ${problem}`);
  const distRoot = path.resolve(dist);
  const catalogPath = path.join(distRoot, '.agents', 'plugins', 'marketplace.json');
  // repair.mjs already guarded the publication target. Re-check after the
  // copy completes so a junction or symlink introduced during that interval
  // cannot redirect this catalog write outside the newly published package.
  assertNoReparsePoints(distRoot, 'distribution root before catalog sealing');
  assertNoReparsePoints(path.dirname(catalogPath), 'distribution catalog directory');
  const catalog = {
    name: DIST_MARKETPLACE_NAME,
    interface: {displayName: 'Codex TUI Orchestrator (Distribution)'},
    plugins: [{
      name: pluginName,
      source: {source: 'local', path: './'},
      policy: {installation: 'AVAILABLE', authentication: 'ON_INSTALL'},
      category: category || 'Productivity',
  }],
  };
  fs.mkdirSync(path.dirname(catalogPath), {recursive: true});
  assertNoReparsePoints(distRoot, 'distribution root before catalog commit');
  assertNoReparsePoints(path.dirname(catalogPath), 'distribution catalog directory before catalog commit');
  fs.writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
  return catalogPath;
}

// 回归（2026-09-22 穷举审计实测抓到）：此前 pluginName 直接从清单取出后 path.join 到
// 分发根上就 rmSync(recursive)，清单里写 "..\\victim" 会在任何校验之前递归删掉分发根
// 之外的同名目录（实测已复现）。判据（test/publish-dist.test.mjs）：畸形名字必须先被
// 拒绝，且目标目录原样存活；正常名字解析结果必须仍是分发根的直接子目录。
export function resolveDistDir(resolvedTarget, pluginName) {
  const problem = manifestNameProblem(pluginName);
  if (problem) throw new Error(`invalid .codex-plugin/plugin.json name ${JSON.stringify(pluginName)}: ${problem}`);
  const dist = path.resolve(resolvedTarget, pluginName);
  if (path.dirname(dist) !== path.resolve(resolvedTarget)) {
    throw new Error(`plugin name escapes the distribution root: ${JSON.stringify(pluginName)}`);
  }
  // repair.mjs receives the already validated manifest name through --name.
  // Recovery worktrees may have a suffix, so their directory basename must
  // never determine the public distribution directory.
  return dist;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log('Usage: publish-dist.mjs --target <distribution root> [--quiet]');
      console.log('Exports a sealed package with its own codex-tui-orchestrator-dist local marketplace catalog.');
      process.exit(0);
    }
    publishDist({...options, ...(options.quiet ? {} : {})});
    process.exit(0);
  } catch (error) {
    console.error('[publish-dist] ' + (error?.message || error));
    process.exit(1);
  }
}
