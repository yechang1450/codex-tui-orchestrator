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
 *   3) 打印分发路径和后续安装命令。
 */
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {manifestNameProblem} from './repair-plugin-registration.mjs';
import {assertNoReparsePoints} from './core/runtime-context.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
  const pluginName = JSON.parse(fs.readFileSync(path.join(root, '.codex-plugin', 'plugin.json'), 'utf8')).name;
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
  fs.mkdirSync(resolvedTarget, {recursive: true});
  // repair.mjs 拒绝已存在的目标，正是为了避免新旧混合；这里先删旧分发再重建。
  fs.rmSync(dist, {recursive: true, force: true});
  const repair = spawnSync(process.execPath, [path.join(root, 'repair.mjs'), '--target', resolvedTarget], {encoding: 'utf8', windowsHide: true, cwd: root});
  if (repair.status !== 0) throw new Error('repair.mjs failed: ' + (repair.stderr || repair.stdout || 'exit ' + repair.status));
  const verify = spawnSync(process.execPath, [path.join(dist, 'scripts', 'release-integrity.mjs')], {encoding: 'utf8', windowsHide: true, cwd: dist});
  if (verify.status !== 0) throw new Error('distribution integrity failed: ' + (verify.stderr || verify.stdout || 'exit ' + verify.status));
  const summary = JSON.parse(String(verify.stdout).trim().split('\n').pop());
  const files = (() => {
    let total = 0;
    const walk = dir => {for (const entry of fs.readdirSync(dir, {withFileTypes: true})) entry.isDirectory() ? walk(path.join(dir, entry.name)) : total++;};
    walk(dist);
    return total;
  })();
  const result = {dist, target: resolvedTarget, pluginName, files, coreVersion: summary.coreVersion, coreFiles: summary.files, runtimeFiles: summary.runtimeFiles, install: 'codex plugin add ' + pluginName + '@personal'};
  if (!quiet) {
    console.log('[publish-dist] ' + dist + ' (' + files + ' files, core ' + summary.coreVersion + ')');
    console.log('[publish-dist] next: ' + result.install);
  }
  return result;
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
  // repair.mjs 按**检出目录名**落盘（<target>/<basename>），分发路径按清单名计算；
  // 两者不一致时原地失败并指明原因，别让后面的完整性校验报一个看不懂的 ENOENT。
  if (path.basename(root) !== pluginName) {
    throw new Error(`checkout directory ${JSON.stringify(path.basename(root))} must equal manifest.name ${JSON.stringify(pluginName)} so the distribution lands in ${JSON.stringify(dist)}`);
  }
  return dist;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log('Usage: publish-dist.mjs --target <distribution root> [--quiet]');
      process.exit(0);
    }
    publishDist({...options, ...(options.quiet ? {} : {})});
    process.exit(0);
  } catch (error) {
    console.error('[publish-dist] ' + (error?.message || error));
    process.exit(1);
  }
}
