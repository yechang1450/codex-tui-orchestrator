#!/usr/bin/env node
// version-bump.mjs — exp/stable 版本与发布辅助
// 用法:
//   node version-bump.mjs                      # 读当前版本，打印建议（不修改）
//   node version-bump.mjs --branch exp --bump 0.0.1   # 在 exp 分支：版本 +0.0.1（或指定值）
//   node version-bump.mjs --branch master --bump 0.1.0  # 在 master 分支：版本 +0.1.0
//
// 语义：
//   - exp（测试版）：版本号可带 -exp 后缀（例如 0.7.23-exp），日常开发在这里迭代。
//   - master（正式版）：版本号升到正式（去掉 -exp），tag vX.Y.Z 作为 latest release。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve(process.cwd());
const manifestFile = path.join(root, '.codex-plugin', 'plugin.json');
const args = process.argv.slice(2);

function argVal(name) { const i = args.indexOf('--' + name); return i >= 0 && args[i + 1] ? args[i + 1] : null; }
function readVersion() {
  if (!fs.existsSync(manifestFile)) { console.error('找不到 ' + manifestFile); process.exit(2); }
  const j = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  return { version: j.version, manifest: j };
}
function writeVersion(j, v) { j.version = v; fs.writeFileSync(manifestFile, JSON.stringify(j, null, 2) + '\n', 'utf8'); }

const branch = argVal('branch') || '';
const bump = argVal('bump') || '';
const { version, manifest } = readVersion();

// 去掉 cachebuster 后缀（+codex.xxx 仅本地安装用，不进仓库版本语义）
const base = version.split('+')[0];
function parse(v) { const m = String(v).match(/^(\d+)\.(\d+)\.(\d+)(-exp)?$/); return m ? { maj: +m[1], min: +m[2], pat: +m[3], exp: !!m[4] } : null; }

function bumpVersion(b, inc) {
  const n = inc.split('.').map(Number);
  let maj = b.maj, min = b.min, pat = b.pat;
  if (n.length === 3) { maj += n[0]; min += n[1]; pat += n[2]; }
  else if (n.length === 2) { min += n[0]; pat += n[1]; }
  else if (n.length === 1) { pat += n[0]; }
  return { maj, min, pat };
}

const parsed = parse(base || '0.0.0');
if (!parsed) { console.error('无法解析版本: ' + version); process.exit(2); }

if (branch === 'exp') {
  const next = bump ? bumpVersion(parsed, bump) : null;
  const v = next ? `${next.maj}.${next.min}.${next.pat}-exp` : `${parsed.maj}.${parsed.min}.${parsed.pat}-exp`;
  if (bump && next) { writeVersion(manifest, v); console.log('exp 版本 -> ' + v); }
  else { console.log('当前 branch=exp，建议测试版: ' + v); }
} else if (branch === 'master') {
  const next = bump ? bumpVersion(parsed, bump) : null;
  const v = next ? `${next.maj}.${next.min}.${next.pat}` : parsed.exp
    ? `${parsed.maj}.${parsed.min}.${parsed.pat}`
    : `${parsed.maj}.${parsed.min}.${parsed.pat}`;
  if (bump && next) { writeVersion(manifest, v); console.log('master 版本 -> ' + v); }
  else { console.log('当前 branch=master，建议正式版 tag: v' + v); }
} else {
  console.log('当前版本: ' + version);
  console.log('  exp 分支   -> 发布 pre-release:   v' + base + '-exp');
  console.log('  master 分支 -> 发布 latest release: v' + base);
  try {
    const cur = String(execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' })).trim();
    console.log('  当前 git 分支: ' + cur);
  } catch {}
}
