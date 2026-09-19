#!/usr/bin/env node
/**
 * publish-dist — 从当前工作树重建"干净分发"，供本地 marketplace 安装使用。
 *
 * 为什么需要它：本地安装会把插件目录整体复制进安装缓存。工作树里有 .git、
 * temp/（本地运行状态与验收证据），复制进去既占空间又让静态评估失真；分发包
 * 只带运行时文件（约 190 个文件 / 2 MB）。
 *
 * 用法：
 *   node scripts/publish-dist.mjs [--target <分发根>] [--quiet]
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
import {defaultDistRoot} from './repair-plugin-registration.mjs';

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

export function publishDist({target = defaultDistRoot(root), quiet = false} = {}) {
  const pluginName = JSON.parse(fs.readFileSync(path.join(root, '.codex-plugin', 'plugin.json'), 'utf8')).name;
  const dist = path.join(target, pluginName);
  fs.mkdirSync(target, {recursive: true});
  // repair.mjs 拒绝已存在的目标，正是为了避免新旧混合；这里先删旧分发再重建。
  fs.rmSync(dist, {recursive: true, force: true});
  const repair = spawnSync(process.execPath, [path.join(root, 'repair.mjs'), '--target', target], {encoding: 'utf8', windowsHide: true, cwd: root});
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
  const result = {dist, target, pluginName, files, coreVersion: summary.coreVersion, coreFiles: summary.files, runtimeFiles: summary.runtimeFiles, install: 'codex plugin add ' + pluginName + '@personal'};
  if (!quiet) {
    console.log('[publish-dist] ' + dist + ' (' + files + ' files, core ' + summary.coreVersion + ')');
    console.log('[publish-dist] next: ' + result.install);
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log('Usage: publish-dist.mjs [--target <distribution root>] [--quiet]');
      process.exit(0);
    }
    publishDist({...options, ...(options.quiet ? {} : {})});
    process.exit(0);
  } catch (error) {
    console.error('[publish-dist] ' + (error?.message || error));
    process.exit(1);
  }
}
