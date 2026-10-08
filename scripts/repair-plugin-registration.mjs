#!/usr/bin/env node
/**
* Check (and, when explicitly requested, repair) the case of a local
 * marketplace entry without changing its source path or any other entry.
 * `--ensure` additionally covers first-time installation：个人 marketplace 文件或本插件
 * 条目还不存在时补上（新建整份文件只允许发生在 <home>/.agents/plugins/marketplace.json）。
 *
 * 本地安装默认指向开发工作树，保持单目录布局；也可以显式指向由
 * `repair.mjs --target` 生成的干净分发。分发里没有 .git/temp/node_modules，
 * 安装缓存不会被本地证据和 git 历史撑大。指向分发时要求分发的 core 清单与工作树一致，
 * 否则报 stale_dist。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {coreInventory} from './release-integrity.mjs';
import {physicalPathIdentity} from './core/runtime-context.mjs';

const DEFAULT_PLUGIN_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/**
 * A plugin checkout is also its local marketplace root.  This follows Codex's
 * repo-marketplace layout and keeps a Windows checkout on D: from being
 * represented as an invalid relative path under a C: personal marketplace.
 */
export function defaultMarketplaceRoot(pluginPath = DEFAULT_PLUGIN_PATH) {
  return path.resolve(pluginPath);
}

export function defaultMarketplacePath(pluginPath = DEFAULT_PLUGIN_PATH) {
  return path.join(defaultMarketplaceRoot(pluginPath), '.agents', 'plugins', 'marketplace.json');
}
// 可选干净分发的默认根：插件工作树旁边的 dist/<插件名>（可用
// ORCH_PLUGIN_DIST_ROOT 覆盖）。单目录安装不会触发它；只有显式 --source dist
// 且提供 --dist-root 时才会生成或使用发布副本。
export function defaultDistRoot(pluginPath = DEFAULT_PLUGIN_PATH) {
  return path.resolve(process.env.ORCH_PLUGIN_DIST_ROOT || path.join(path.dirname(path.resolve(pluginPath)), 'dist'));
}

function samePath(left, right) {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function pathIsInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function resolveLocalMarketplaceSource(marketplaceRoot, sourcePath) {
  if (typeof sourcePath !== 'string' || !sourcePath.startsWith('./')) {
    throw new Error('MARKETPLACE_SOURCE_INVALID: local source.path must start with ./');
  }
  const resolved = path.resolve(marketplaceRoot, sourcePath);
  if (!pathIsInside(marketplaceRoot, resolved)) {
    throw new Error('MARKETPLACE_SOURCE_OUTSIDE_ROOT: local source.path must stay inside the marketplace root');
  }
  return resolved;
}

function realPath(file) {
  // Reuse the runtime's physical identity resolver. Managed Windows hosts can
  // deny native realpath even when the path is readable; the resolver keeps a
  // canonical long-name identity through its guarded fallback and still
  // fails closed when neither resolver is available.
  if (!fs.existsSync(file)) {
    const error = new Error('ENOENT: path does not exist: ' + file);
    error.code = 'ENOENT';
    throw error;
  }
  return physicalPathIdentity(file);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function fail(status, reason, extra = {}) {
  return {...extra, ok: false, status, reason};
}

// 插件名的唯一判据（install-plugin / publish-dist / 注册检查共用）：
// 它会被拼进分发目录、缓存目录和 marketplace 条目，所以必须先证明它是单段、
// 小写连字符名——否则 "..\\victim" 这类名字会在任何检查之前被 path.join 抬出目标根。
export const MANIFEST_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export function manifestNameProblem(pluginName) {
  if (typeof pluginName !== 'string' || !MANIFEST_NAME_PATTERN.test(pluginName)) return 'manifest.name must be lowercase hyphen-case';
  if (pluginName.length > 64) return 'manifest.name exceeds 64 characters';
  return null;
}

/** Inspect registration state without writing anything. */
export function inspectRegistration({pluginPath = process.cwd(), marketplacePath = null, marketplaceRoot = null, distRoot = null} = {}) {
  const pluginRoot = path.resolve(pluginPath);
  const marketplace = path.resolve(marketplacePath || defaultMarketplacePath(pluginRoot));
  const root = path.resolve(marketplaceRoot || defaultMarketplaceRoot(pluginRoot));
  let pluginName;
  let manifest;
  try {
    manifest = readJson(path.join(pluginRoot, '.codex-plugin', 'plugin.json'));
    pluginName = manifest?.name;
  } catch (error) {
    return fail('invalid_manifest', error.message, {pluginPath: pluginRoot, marketplacePath: marketplace});
  }
  const nameProblem = manifestNameProblem(pluginName);
  if (nameProblem) {
    return fail('invalid_manifest_name', nameProblem, {pluginName, pluginPath: pluginRoot, marketplacePath: marketplace});
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
    sourcePath = resolveLocalMarketplaceSource(root, entry.source.path);
    sourceReal = realPath(sourcePath);
    pluginReal = realPath(pluginRoot);
  } catch (error) {
    return fail('source_mismatch', `entry source cannot be resolved: ${error.message}`, {...base, sourcePath});
  }
  const distSource = path.resolve(distRoot || defaultDistRoot(pluginRoot), pluginName);
  let distReal = null;
  try { distReal = realPath(distSource); } catch { /* 分发还不存在 */ }
  const checkoutMatch = samePath(sourceReal, pluginReal);
  const distMatch = !!distReal && samePath(sourceReal, distReal);
  if (!checkoutMatch && !distMatch) {
    return fail('source_mismatch', 'entry source does not point at this plugin or its clean distribution', {...base, sourcePath, sourceReal, pluginReal, ...(distReal ? {distSource: distReal} : {})});
  }
  if (distMatch) {
    // 分发的价值是"和工作树同一份核心"；不一致就是陈旧分发，必须先重新生成再安装。
    let distCore;
    let checkoutCore;
    try {
      distCore = coreInventory(distSource);
      checkoutCore = coreInventory(pluginRoot);
    } catch (error) {
      return fail('dist_unreadable', 'distribution core cannot be read: ' + error.message, {...base, sourcePath, sourceReal, pluginReal, distSource: distReal});
    }
    if (JSON.stringify(distCore) !== JSON.stringify(checkoutCore)) {
      return fail('stale_dist', 'distribution core differs from the checkout; rebuild the distribution before reinstalling', {...base, sourcePath, sourceReal, pluginReal, distSource: distReal});
    }
  }
  const sourceKind = distMatch ? 'dist' : 'checkout';
  const distInfo = distMatch ? {distSource: distReal} : {};
  if (entry.name === pluginName) return {ok: true, status: 'matched', sourceKind, ...base, sourcePath, sourceReal, pluginReal, ...distInfo};
  return {ok: false, status: 'repairable', sourceKind, reason: 'entry.name differs only by case', ...base, sourcePath, sourceReal, pluginReal, ...distInfo};
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

/** 个人 marketplace 的约定路径：只有这里允许被 `--ensure` 新建。 */
export function isPersonalMarketplaceDir(dir, homeDir = os.homedir()) {
  const expected = path.join(path.resolve(homeDir), '.agents', 'plugins');
  const left = path.resolve(dir);
  return process.platform === 'win32' ? left.toLowerCase() === expected.toLowerCase() : left === expected;
}

/** 把绝对路径写成相对 marketplaceRoot 的 POSIX 风格路径（marketplace source.path 的写法）。 */
export function relativeSourcePath(marketplaceRoot, target) {
  const root = path.resolve(marketplaceRoot);
  const source = path.resolve(target);
  if (!pathIsInside(root, source)) {
    throw new Error('MARKETPLACE_SOURCE_OUTSIDE_ROOT: local plugin source must stay inside the marketplace root');
  }
  const rel = path.relative(root, source).replaceAll('\\', '/');
  return rel ? './' + rel : './';
}

/** 首次安装写入的条目不继承其它 marketplace 的写法：策略固定、名称用清单里的规范名。 */
function canonicalEntry({pluginName, category, sourcePath, marketplaceRoot}) {
  return {
    name: pluginName,
    source: {source: 'local', path: relativeSourcePath(marketplaceRoot, sourcePath)},
    policy: {installation: 'AVAILABLE', authentication: 'ON_INSTALL'},
    category: category || 'Productivity',
  };
}

/**
 * 检查并补齐个人 marketplace 条目（首次安装用）。
 *
 * 与 `repairRegistration` 的分工：`repair` 只修已存在条目的名称大小写；`ensure` 负责
 * 个人 marketplace 文件或本插件条目还不存在的那一步。新建整份 marketplace 文件只允许发生在
 * `<home>/.agents/plugins/marketplace.json`（Codex 隐式发现的个人 marketplace）；其它路径仍然
 * 要求文件已存在，避免凭空造出别的 marketplace。既有条目、其它插件与顶层元数据一律保留。
 * `setRegistrationSource` 用于换机器/换克隆目录：把唯一条目的安装源改写到当前分发或工作树。
 */
export function ensureRegistration({pluginPath = process.cwd(), marketplacePath = null, marketplaceRoot = null, distRoot = null, source = 'checkout', homeDir = os.homedir()} = {}) {
  const pluginRoot = path.resolve(pluginPath);
  const marketplace = path.resolve(marketplacePath || defaultMarketplacePath(pluginRoot));
  const root = path.resolve(marketplaceRoot || defaultMarketplaceRoot(pluginRoot));
  let manifest;
  try {
    manifest = readJson(path.join(pluginRoot, '.codex-plugin', 'plugin.json'));
  } catch (error) {
    return fail('invalid_manifest', error.message, {pluginPath: pluginRoot, marketplacePath: marketplace});
  }
  const pluginName = manifest?.name;
  if (typeof pluginName !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(pluginName)) {
    return fail('invalid_manifest_name', 'manifest.name must be lowercase hyphen-case', {pluginName, pluginPath: pluginRoot, marketplacePath: marketplace});
  }
  if (source !== 'dist' && source !== 'checkout') {
    return fail('invalid_source', "source must be 'dist' or 'checkout'", {pluginName, pluginPath: pluginRoot, marketplacePath: marketplace});
  }

  const sourcePath = source === 'checkout' ? pluginRoot : path.resolve(distRoot || defaultDistRoot(pluginRoot), pluginName);
  let sourceReal;
  try {
    sourceReal = realPath(sourcePath);
  } catch (error) {
    return fail('source_missing', `install source does not exist yet (${sourcePath}); build it first (node scripts/publish-dist.mjs)`, {pluginName, pluginPath: pluginRoot, marketplacePath: marketplace, sourcePath});
  }

  const options = {pluginPath: pluginRoot, marketplacePath: marketplace, marketplaceRoot: root, distRoot, source, homeDir};
  const inspected = inspectRegistration(options);
  if (inspected.status === 'matched') {
    const requestedKind = source === 'checkout' ? 'checkout' : 'dist';
    if (inspected.sourceKind === requestedKind) return {...inspected, status: 'matched', created: false};
    // A matching entry can still point at the other supported source kind.
    // Honor the caller's explicit source instead of treating the old path as final.
    return setRegistrationSource({...options, source});
  }
  if (inspected.status === 'repairable') {
    const repaired = repairRegistration(options);
    return {...repaired, created: false};
  }

  let entry;
  try {
    entry = canonicalEntry({pluginName, category: manifest?.interface?.category, sourcePath: sourceReal, marketplaceRoot: root});
  } catch (error) {
    return fail('source_outside_marketplace', error.message, {pluginName, pluginPath: pluginRoot, marketplacePath: marketplace, marketplaceRoot: root, sourcePath: sourceReal});
  }
  const base = {pluginName, marketplaceName: null, pluginPath: pluginRoot, marketplacePath: marketplace, marketplaceRoot: root, sourcePath: sourceReal, entry, created: false};
  const fileExists = fs.existsSync(marketplace);

  if (fileExists) {
    if (inspected.status !== 'missing_entry') return inspectFailure(inspected, base);
    let expected;
    let data;
    try {
      expected = fs.readFileSync(marketplace);
      data = JSON.parse(expected.toString('utf8'));
    } catch (error) {
      return fail('invalid_marketplace', error.message, base);
    }
    if (!Array.isArray(data?.plugins)) return fail('invalid_marketplace', 'marketplace.plugins must be an array', base);
    if (typeof data.name !== 'string' || !/^[A-Za-z0-9_-]+$/.test(data.name)) {
      return fail('invalid_marketplace_name', 'marketplace.name must contain only ASCII letters, digits, underscores, or hyphens', base);
    }
    const updated = {...data, plugins: [...data.plugins, entry]};
    atomicReplace(marketplace, `${JSON.stringify(updated, null, 2)}\n`, expected);
    const after = inspectRegistration(options);
    if (after.status !== 'matched') return inspectFailure(after, base, 'postcheck_failed');
    return {ok: true, ...after, status: 'appended', entry, created: false};
  }

  if (!isPersonalMarketplaceDir(path.dirname(marketplace), homeDir)) {
    return fail('create_forbidden', 'refusing to create a non-personal marketplace; the personal marketplace lives at <home>/.agents/plugins/marketplace.json', base);
  }
  if (inspected.status !== 'invalid_marketplace') return inspectFailure(inspected, base);
  fs.mkdirSync(path.dirname(marketplace), {recursive: true});
  const seeded = {name: 'personal', interface: {displayName: 'Personal'}, plugins: [entry]};
  try {
    fs.writeFileSync(marketplace, `${JSON.stringify(seeded, null, 2)}\n`, {flag: 'wx'});
  } catch (error) {
    return fail('concurrent_change', `refusing to overwrite a marketplace that appeared while installing: ${error.message}`, base);
  }
  const after = inspectRegistration(options);
  if (after.status !== 'matched') return inspectFailure(after, base, 'postcheck_failed');
  return {ok: true, ...after, status: 'created', entry, created: true};
}

/** 把唯一条目的安装源改写到本插件当前的源（默认 checkout）；缺文件或条目时退化为 `--ensure`。 */
export function setRegistrationSource({pluginPath = process.cwd(), marketplacePath = null, marketplaceRoot = null, distRoot = null, source = 'checkout', homeDir = os.homedir()} = {}) {
  const resolvedPluginPath = path.resolve(pluginPath);
  const options = {
    pluginPath: resolvedPluginPath,
    marketplacePath: path.resolve(marketplacePath || defaultMarketplacePath(resolvedPluginPath)),
    marketplaceRoot: path.resolve(marketplaceRoot || defaultMarketplaceRoot(resolvedPluginPath)),
    distRoot,
    source,
  };
  const inspected = inspectRegistration(options);
  if (inspected.status === 'matched') {
    const requestedKind = options.source === 'checkout' ? 'checkout' : 'dist';
    if (inspected.sourceKind === requestedKind) return {...inspected, status: 'matched', changed: false};
    // Continue below so --set-source can move a still-valid old dist/checkout entry.
  }
  if (inspected.status === 'missing_entry' || !fs.existsSync(options.marketplacePath)) {
    const ensured = ensureRegistration({...options, source, homeDir});
    return {...ensured, changed: ensured.status !== 'matched'};
  }
  let manifest;
  try {
    manifest = readJson(path.join(options.pluginPath, '.codex-plugin', 'plugin.json'));
  } catch (error) {
    return fail('invalid_manifest', error.message, {pluginPath: options.pluginPath, marketplacePath: options.marketplacePath});
  }
  const pluginName = manifest?.name;
  if (typeof pluginName !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(pluginName)) {
    return fail('invalid_manifest_name', 'manifest.name must be lowercase hyphen-case', {pluginName, pluginPath: options.pluginPath});
  }
  const sourcePath = source === 'checkout' ? options.pluginPath : path.resolve(distRoot || defaultDistRoot(options.pluginPath), pluginName);
  let sourceReal;
  try {
    sourceReal = realPath(sourcePath);
  } catch (error) {
    return fail('source_missing', `install source does not exist yet (${sourcePath}); build it first (node scripts/publish-dist.mjs)`, {pluginName, marketplacePath: options.marketplacePath, sourcePath});
  }
  let expected;
  let data;
  try {
    expected = fs.readFileSync(options.marketplacePath);
    data = JSON.parse(expected.toString('utf8'));
  } catch (error) {
    return fail('invalid_marketplace', error.message, {pluginName, marketplacePath: options.marketplacePath});
  }
  if (!Array.isArray(data?.plugins)) return fail('invalid_marketplace', 'marketplace.plugins must be an array', {pluginName, marketplacePath: options.marketplacePath});
  const matches = data.plugins.filter((entry) => typeof entry?.name === 'string' && entry.name.toLowerCase() === pluginName.toLowerCase());
  if (matches.length === 0) return fail('missing_entry', 'no marketplace entry matches manifest.name', {pluginName, marketplacePath: options.marketplacePath});
  if (matches.length !== 1) return fail('duplicate_entry', 'multiple marketplace entries match manifest.name case-insensitively', {pluginName, marketplacePath: options.marketplacePath});
  const index = data.plugins.indexOf(matches[0]);
  const previous = JSON.parse(JSON.stringify(matches[0]));
  const updated = JSON.parse(JSON.stringify(data));
  updated.plugins[index].name = pluginName;
  try {
    updated.plugins[index].source = {source: 'local', path: relativeSourcePath(options.marketplaceRoot, sourceReal)};
  } catch (error) {
    return fail('source_outside_marketplace', error.message, {pluginName, marketplacePath: options.marketplacePath, marketplaceRoot: options.marketplaceRoot, sourcePath: sourceReal});
  }
  if (!updated.plugins[index].policy) updated.plugins[index].policy = {installation: 'AVAILABLE', authentication: 'ON_INSTALL'};
  if (!updated.plugins[index].category) updated.plugins[index].category = manifest?.interface?.category || 'Productivity';
  atomicReplace(options.marketplacePath, `${JSON.stringify(updated, null, 2)}\n`, expected);
  const after = inspectRegistration(options);
  if (after.status !== 'matched') return fail('postcheck_failed', 'marketplace did not read back as matched', {before: inspected, after});
  return {ok: true, ...after, status: 'source-set', changed: true, previous};
}

/** 把 inspect 的失败原样带出，并补上可操作的下一步提示。 */
function inspectFailure(inspected, base, status = inspected.status) {
  const hints = {
    missing_entry: 'run with --ensure to append the canonical entry',
    duplicate_entry: 'remove the duplicate entries before installing',
    source_mismatch: 'the existing entry points at another source; re-point it with --set-source when it really is this plugin, or fix or remove it by hand',
    stale_dist: 'rebuild the distribution (node scripts/publish-dist.mjs), then install again',
    invalid_marketplace_name: 'marketplace.name must match [A-Za-z0-9_-]+',
    dist_unreadable: 'the distribution core cannot be read; rebuild it (node scripts/publish-dist.mjs)',
  };
  const hint = hints[inspected.status];
  return fail(status, hint ? `${inspected.reason} — ${hint}` : inspected.reason, {...base, inspected});
}

function parseArgs(argv) {
  const out = {pluginPath: DEFAULT_PLUGIN_PATH, marketplacePath: null, marketplaceRoot: null, distRoot: null, source: 'checkout', mode: 'check'};
  const positional = [];
  let mode;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--repair') {
      if (mode && mode !== 'repair') throw new Error('--check, --repair and --ensure are mutually exclusive');
      mode = 'repair';
    }
    else if (arg === '--check') {
      if (mode && mode !== 'check') throw new Error('--check, --repair and --ensure are mutually exclusive');
      mode = 'check';
    }
    else if (arg === '--ensure') {
      if (mode && mode !== 'ensure') throw new Error('--check, --repair and --ensure are mutually exclusive');
      mode = 'ensure';
    }
    else if (arg === '--set-source') {
      if (mode && mode !== 'set-source') throw new Error('--check, --repair, --ensure and --set-source are mutually exclusive');
      mode = 'set-source';
    }
    else if (arg === '--source') {
      if (argv[i + 1] === undefined || argv[i + 1].startsWith('-')) throw new Error('--source requires a value');
      i++;
      out.source = argv[i];
      // 与 install-plugin 同一条枚举纪律：静默把垃圾值当成 dist 会得到"成功但装错来源"。
      if (!['dist', 'checkout'].includes(out.source)) throw new Error(`--source must be dist or checkout, got: ${out.source}`);
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
    else if (arg === '--dist-root') {
      if (argv[i + 1] === undefined || argv[i + 1].startsWith('-')) throw new Error('--dist-root requires a value');
      i++;
      out.distRoot = argv[i];
    }
    else if (arg === '-h' || arg === '--help') out.help = true;
    else if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`);
    else positional.push(arg);
  }
  if (positional.length > 1) throw new Error('only one plugin path is supported');
  if (positional[0]) out.pluginPath = positional[0];
  if (!out.marketplacePath) out.marketplacePath = defaultMarketplacePath(out.pluginPath);
  if (!out.marketplaceRoot) out.marketplaceRoot = defaultMarketplaceRoot(out.pluginPath);
  if (mode) out.mode = mode;
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log('Usage: repair-plugin-registration.mjs [plugin-path] [--check|--repair|--ensure|--set-source] [--source dist|checkout] [--marketplace path] [--marketplace-root path] [--dist-root path] [--json]');
      process.exit(0);
    }
    const result = options.mode === 'repair' ? repairRegistration(options)
      : options.mode === 'ensure' ? ensureRegistration(options)
      : options.mode === 'set-source' ? setRegistrationSource(options)
      : inspectRegistration(options);
    console.log(JSON.stringify(result));
    process.exit(result.ok ? 0 : 1);
  } catch (error) {
    console.log(JSON.stringify({ok: false, status: 'error', reason: error.message}));
    process.exit(1);
  }
}
