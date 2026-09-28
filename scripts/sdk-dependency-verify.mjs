import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {verifyDependencyTree} from './dependency-integrity.mjs';
import {verifyRelease} from './release-integrity.mjs';

// 锁定的 SDK 依赖（@openai/codex-sdk）自检器。
//
// 关键取舍：这个模块**永不抛错**，只回结论。调用方分两种用法——
//   * 入口需要在加载引擎前就决定"修还是停"（`--install-deps` 必须能在依赖缺失时跑起来）；
//   * 传统 gate 只要一句 throw（见 sdk-dependency-check.mjs）。
// 之前的实现把校验和"抛错"揉在一起，于是依赖一缺，`--help`/`--doctor`/`--install-deps`
// 全部变成 Node 栈打印。
const scriptsDir = fileURLToPath(new URL('.', import.meta.url));

/** Keep the repair command copy/paste-safe in PowerShell and shell environments. */
export function dependencyRepairInstruction(dir = scriptsDir) {
  return 'npm ci --prefix '
    + (process.platform === 'win32' ? `'${String(dir).replaceAll("'", "''")}'` : JSON.stringify(String(dir)))
    + ' --omit=optional --ignore-scripts --no-audit --no-fund';
}

export function lockedSdkVersion(dir = scriptsDir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).dependencies['@openai/codex-sdk'];
}

export async function verifyLockedSdk({dir = scriptsDir, instruction = dependencyRepairInstruction(dir)} = {}) {
  try {
    verifyRelease(path.resolve(scriptsDir, '..'));
  } catch (error) {
    return {ok: false, code: 'RELEASE_INTEGRITY_FAILED', message: `RELEASE_INTEGRITY_FAILED: ${error?.message || 'release files differ from the sealed package'}`};
  }
  let expected;
  try {
    expected = lockedSdkVersion(dir);
  } catch (error) {
    return {ok: false, code: 'RELEASE_DEPENDENCY_DAMAGED', message: 'RELEASE_DEPENDENCY_DAMAGED: package.json cannot be read; restore with ' + instruction};
  }
  let entry;
  try {
    entry = fileURLToPath(import.meta.resolve('@openai/codex-sdk'));
  } catch (error) {
    if (['ERR_INVALID_PACKAGE_CONFIG', 'ERR_PACKAGE_PATH_NOT_EXPORTED'].includes(error.code)) {
      return {ok: false, code: 'RELEASE_DEPENDENCY_DAMAGED', message: 'RELEASE_DEPENDENCY_DAMAGED: SDK package metadata is invalid; restore with ' + instruction};
    }
    if (error.code !== 'ERR_MODULE_NOT_FOUND') {
      return {ok: false, code: 'RELEASE_DEPENDENCY_UNEXPECTED', message: 'RELEASE_DEPENDENCY_UNEXPECTED: SDK resolution failed (' + (error.code || error.message) + '); restore with ' + instruction};
    }
    return {ok: false, code: 'RELEASE_DEPENDENCY_MISSING', message: 'RELEASE_DEPENDENCY_MISSING: install the locked SDK dependency with ' + instruction};
  }
  try {
    if (!fs.statSync(entry).isFile()) throw new Error('not a file');
    fs.accessSync(entry, fs.constants.R_OK);
  } catch {
    return {ok: false, code: 'RELEASE_DEPENDENCY_DAMAGED', message: 'RELEASE_DEPENDENCY_DAMAGED: SDK entry is missing or unreadable; restore with ' + instruction};
  }
  const dependencyRoot = path.resolve(scriptsDir, 'node_modules');
  const relativeEntry = path.relative(dependencyRoot, path.resolve(entry));
  if (relativeEntry === '' || relativeEntry.startsWith('..' + path.sep) || path.isAbsolute(relativeEntry)) {
    return {ok: false, code: 'RELEASE_DEPENDENCY_INTEGRITY', message: 'RELEASE_DEPENDENCY_INTEGRITY: SDK resolved outside the sealed dependency tree; restore with ' + instruction};
  }
  const integrity = verifyDependencyTree({dir: scriptsDir});
  if (!integrity.ok) return {...integrity, message: integrity.message + '; restore with ' + instruction};
  let found;
  let walk = path.dirname(entry);
  while (true) {
    const manifest = path.join(walk, 'package.json');
    if (fs.existsSync(manifest)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
        if (pkg.name === '@openai/codex-sdk') { found = pkg.version; break; }
      } catch { /* an unrelated broken manifest must not decide this check */ }
    }
    const parent = path.dirname(walk);
    if (parent === walk) break;
    walk = parent;
  }
  if (found !== expected) {
    return {ok: false, code: 'RELEASE_DEPENDENCY_VERSION', message: `RELEASE_DEPENDENCY_VERSION: expected ${expected}, found ${found || 'unknown'}; restore with ${instruction}`};
  }
  try {
    const sdk = await import('@openai/codex-sdk');
    if (typeof sdk.Codex !== 'function'
      || typeof sdk.Codex.prototype?.startThread !== 'function'
      || typeof sdk.Codex.prototype?.resumeThread !== 'function') throw new Error('missing interfaces');
  } catch {
    return {ok: false, code: 'RELEASE_DEPENDENCY_DAMAGED', message: 'RELEASE_DEPENDENCY_DAMAGED: SDK cannot load or lacks required interfaces; restore with ' + instruction};
  }
  return {ok: true, code: null, message: null, entry, version: found, expected, instruction};
}
