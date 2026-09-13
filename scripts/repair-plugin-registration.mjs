#!/usr/bin/env node
/**
 * Check (and, when explicitly requested, repair) the case of a local
 * marketplace entry without changing its source path or any other entry.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

const DEFAULT_MARKETPLACE = path.join(os.homedir(), '.agents', 'plugins', 'marketplace.json');
const DEFAULT_PLUGIN_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function realPath(file) {
  return fs.realpathSync.native(file);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function fail(status, reason, extra = {}) {
  return {...extra, ok: false, status, reason};
}

/** Inspect registration state without writing anything. */
export function inspectRegistration({pluginPath = process.cwd(), marketplacePath = DEFAULT_MARKETPLACE, marketplaceRoot = os.homedir()} = {}) {
  const pluginRoot = path.resolve(pluginPath);
  const marketplace = path.resolve(marketplacePath);
  const root = path.resolve(marketplaceRoot);
  let pluginName;
  let manifest;
  try {
    manifest = readJson(path.join(pluginRoot, '.codex-plugin', 'plugin.json'));
    pluginName = manifest?.name;
  } catch (error) {
    return fail('invalid_manifest', error.message, {pluginPath: pluginRoot, marketplacePath: marketplace});
  }
  if (typeof pluginName !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(pluginName)) {
    return fail('invalid_manifest_name', 'manifest.name must be lowercase hyphen-case', {pluginName, pluginPath: pluginRoot, marketplacePath: marketplace});
  }
  if (pluginName.length > 64) {
    return fail('invalid_manifest_name', 'manifest.name exceeds 64 characters', {pluginName, pluginPath: pluginRoot, marketplacePath: marketplace});
  }

  let bytes;
  let data;
  try {
    bytes = fs.readFileSync(marketplace);
    data = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    return fail('invalid_marketplace', error.message, {pluginName, pluginPath: pluginRoot, marketplacePath: marketplace});
  }
  if (!Array.isArray(data?.plugins)) {
    return fail('invalid_marketplace', 'marketplace.plugins must be an array', {pluginName, pluginPath: pluginRoot, marketplacePath: marketplace});
  }
  if (typeof data.name !== 'string' || !/^[A-Za-z0-9_-]+$/.test(data.name)) {
    return fail('invalid_marketplace_name', 'marketplace.name must contain only ASCII letters, digits, underscores, or hyphens', {pluginName, pluginPath: pluginRoot, marketplacePath: marketplace});
  }

  const matches = data.plugins.filter((entry) => typeof entry?.name === 'string' && entry.name.toLowerCase() === pluginName);
  const base = {pluginName, marketplaceName: data.name, pluginPath: pluginRoot, marketplacePath: marketplace, marketplaceRoot: root, marketplaceSha256: crypto.createHash('sha256').update(bytes).digest('hex'), entryCount: matches.length};
  if (matches.length === 0) return fail('missing_entry', 'no marketplace entry matches manifest.name', base);
  if (matches.length !== 1) return fail('duplicate_entry', 'multiple marketplace entries match manifest.name case-insensitively', base);
  const entry = matches[0];
  if (entry?.source?.source !== 'local' || typeof entry?.source?.path !== 'string') {
    return fail('source_mismatch', 'matching entry must use source.local with a path', base);
  }
  let sourcePath;
  let sourceReal;
  let pluginReal;
  try {
    sourcePath = path.resolve(root, entry.source.path);
    sourceReal = realPath(sourcePath);
    pluginReal = realPath(pluginRoot);
  } catch (error) {
    return fail('source_mismatch', `entry source cannot be resolved: ${error.message}`, {...base, sourcePath});
  }
  const samePath = process.platform === 'win32'
    ? sourceReal.toLowerCase() === pluginReal.toLowerCase()
    : sourceReal === pluginReal;
  if (!samePath) {
    return fail('source_mismatch', 'entry source does not point at this plugin', {...base, sourcePath, sourceReal, pluginReal});
  }
  if (entry.name === pluginName) return {ok: true, status: 'matched', ...base, sourcePath, sourceReal, pluginReal};
  return {ok: false, status: 'repairable', reason: 'entry.name differs only by case', ...base, sourcePath, sourceReal, pluginReal};
}

export function atomicReplace(file, content, expected) {
  const current = fs.readFileSync(file);
  if (!current.equals(expected)) throw new Error('marketplace changed concurrently; refusing to overwrite');
  const mode = fs.statSync(file).mode & 0o777;
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(temp, content, {flag: 'wx', mode});
    fs.chmodSync(temp, mode);
    // Rename is the only commit step. If the platform refuses replacement,
    // leave the original marketplace untouched and report the error.
    const beforeCommit = fs.readFileSync(file);
    if (!beforeCommit.equals(expected)) throw new Error('marketplace changed before commit; refusing to overwrite');
    fs.renameSync(temp, file);
  } finally {
    try { fs.rmSync(temp, {force: true}); } catch {}
  }
}

/** Repair the one validated case-only drift, then read it back. */
export function repairRegistration(options = {}) {
  const before = inspectRegistration(options);
  if (before.status !== 'repairable') return before;
  const marketplacePath = before.marketplacePath;
  const expected = fs.readFileSync(marketplacePath);
  const expectedHash = crypto.createHash('sha256').update(expected).digest('hex');
  if (expectedHash !== before.marketplaceSha256) {
    return fail('concurrent_change', 'marketplace changed before repair; refusing to overwrite', {before});
  }
  const data = JSON.parse(expected.toString('utf8'));
  const index = data.plugins.findIndex((entry) => typeof entry?.name === 'string' && entry.name.toLowerCase() === before.pluginName);
  if (index < 0) return fail('concurrent_change', 'matching entry disappeared before repair', before);
  data.plugins[index].name = before.pluginName;
  atomicReplace(marketplacePath, `${JSON.stringify(data, null, 2)}\n`, expected);
  const after = inspectRegistration(options);
  if (after.status !== 'matched') return fail('postcheck_failed', 'marketplace did not read back as matched', {before, after});
  return {ok: true, ...after, status: 'repaired'};
}

function parseArgs(argv) {
  const out = {pluginPath: DEFAULT_PLUGIN_PATH, marketplacePath: DEFAULT_MARKETPLACE, marketplaceRoot: os.homedir(), repair: false};
  const positional = [];
  let mode;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--repair') {
      if (mode === 'check') throw new Error('--check and --repair are mutually exclusive');
      mode = 'repair'; out.repair = true;
    }
    else if (arg === '--check') {
      if (mode === 'repair') throw new Error('--check and --repair are mutually exclusive');
      mode = 'check'; out.repair = false;
    }
    else if (arg === '--json') out.json = true;
    else if (arg === '--marketplace') {
      if (argv[i + 1] === undefined || argv[i + 1].startsWith('-')) throw new Error('--marketplace requires a value');
      i++;
      out.marketplacePath = argv[i];
    }
    else if (arg === '--marketplace-root') {
      if (argv[i + 1] === undefined || argv[i + 1].startsWith('-')) throw new Error('--marketplace-root requires a value');
      i++;
      out.marketplaceRoot = argv[i];
    }
    else if (arg === '-h' || arg === '--help') out.help = true;
    else if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`);
    else positional.push(arg);
  }
  if (positional.length > 1) throw new Error('only one plugin path is supported');
  if (positional[0]) out.pluginPath = positional[0];
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log('Usage: repair-plugin-registration.mjs [plugin-path] [--check|--repair] [--marketplace path] [--marketplace-root path] [--json]');
      process.exit(0);
    }
    const result = options.repair ? repairRegistration(options) : inspectRegistration(options);
    console.log(JSON.stringify(result));
    process.exit(result.ok ? 0 : 1);
  } catch (error) {
    console.log(JSON.stringify({ok: false, status: 'error', reason: error.message}));
    process.exit(1);
  }
}
