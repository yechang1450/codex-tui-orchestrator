#!/usr/bin/env node
/**
 * install-plugin — 一条命令完成“本地 catalog 注册 → 插件管理器安装 → 缓存依赖恢复 → 校验”。
 *
 * 为什么需要它：本机实测安装链路有三段容易漏掉的手工步骤；下面第 1 行是可选的发布导出——
 *   1) 默认直接使用工作树（单目录布局）；需要干净发布包时显式选择 `--source dist --dist-root <dir>`；
 *   2) 选定源内的 marketplace catalog 必须先由宿主注册（缺了 `codex plugin add` 直接失败）；
 *   3) 插件管理器每次安装都会建不带 node_modules 的新缓存，必须对**新缓存路径**恢复依赖；
 *   4) 恢复后要在同一个缓存路径跑完整性检查和 doctor，确认技能与运行时都到位。
 * 漏掉第 3 步得到的是"技能在、运行时缺依赖"的半成品；漏掉第 2 步连安装都进不去。
 * 面向"第二台机器"的两件事也一并处理：缓存根跟随 CODEX_HOME（不假设 `~/.codex`），
 * 以及条目还指向旧克隆或别的机器时用 `--set-source` 重新指向本机 checkout。
 *
 * 用法：
 *   powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/bootstrap.ps1 -Action install # 安装/更新（幂等）
 *   node scripts/install-plugin.mjs --check         # 只读校验：注册、可选分发新鲜度、缓存依赖、宿主启用状态（跟随 CODEX_HOME）
 *   powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/bootstrap.ps1 -Action install -Arguments @('--pull')
 *   powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/bootstrap.ps1 -Action install -Arguments @('--set-source','--verify-skills')
 *   # --pull、--set-source、--verify-skills、--strict-skills 均由可信引导入口转交。
 *   node scripts/install-plugin.mjs --json          # 机器可读输出
 *   node scripts/install-plugin.mjs --source checkout|dist --timeout-ms <ms> --marketplace <path> --marketplace-root <path> --dist-root <path>
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {ensureRegistration, inspectRegistration, setRegistrationSource, defaultDistRoot, defaultMarketplacePath, defaultMarketplaceRoot, CHECKOUT_MARKETPLACE_NAME, DIST_MARKETPLACE_NAME, manifestNameProblem} from './repair-plugin-registration.mjs';
import {publishDist} from './publish-dist.mjs';
import {cliCandidates, resolveHost, verifyAuthenticodePublisher} from './core/host-cli.mjs';
import {assertTrustedNpm} from './npm-cli.mjs';
import {runtimeInventory} from './release-integrity.mjs';
import {assertNoReparsePoints,physicallySameOrChild} from './core/runtime-context.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLATFORM_WARNING = "this plugin's execution core is Windows-only; a non-Windows host can hold the install but runs are out of contract";

export function parseArgs(argv) {
  const out = {
    pluginPath: root,
    marketplacePath: null,
    marketplaceRoot: null,
    distRoot: null,
    source: 'checkout',
    mode: 'install',
    pull: false,
    skipDist: false,
    verifySkills: false,
    strictSkills: false,
    localDevelopment: false,
    setSource: false,
    timeoutMs: 15 * 60 * 1000,
    json: false,
    quiet: false,
    homeDir: os.homedir(),
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--check') out.mode = 'check';
    else if (arg === '--install') out.mode = 'install';
    else if (arg === '--pull') out.pull = true;
    else if (arg === '--skip-dist') out.skipDist = true;
    else if (arg === '--verify-skills') out.verifySkills = true;
    else if (arg === '--strict-skills') { out.verifySkills = true; out.strictSkills = true; }
    else if (arg === '--local-development') out.localDevelopment = true;
    else if (arg === '--set-source') out.setSource = true;
    else if (arg === '--timeout-ms') { out.timeoutMs = Number(requireValue(argv, ++i, '--timeout-ms')); if (!Number.isFinite(out.timeoutMs) || out.timeoutMs <= 0) throw new Error('--timeout-ms must be a positive number'); }
    else if (arg === '--json') out.json = true;
    else if (arg === '--quiet') out.quiet = true;
    else if (arg === '--plugin') { out.pluginPath = requireValue(argv, ++i, '--plugin'); }
    else if (arg === '--source') {
      out.source = requireValue(argv, ++i, '--source');
      // 枚举必须显式校验：静默把 'bogus'/空串当成 dist，会得到一份"成功"但装错来源的报告。
      if (!['dist', 'checkout'].includes(out.source)) throw new Error(`--source must be dist or checkout, got: ${out.source}`);
    }
    else if (arg === '--marketplace') { out.marketplacePath = requireValue(argv, ++i, '--marketplace'); }
    else if (arg === '--marketplace-root') { out.marketplaceRoot = requireValue(argv, ++i, '--marketplace-root'); }
    else if (arg === '--dist-root') { out.distRoot = requireValue(argv, ++i, '--dist-root'); }
    else if (arg === '--home') { out.homeDir = requireValue(argv, ++i, '--home'); }
    else if (arg === '-h' || arg === '--help') out.help = true;
    else throw new Error('unknown option: ' + arg);
  }
  const marketplaceDefaults = {source: out.source, distRoot: out.distRoot};
  if (!out.marketplacePath) out.marketplacePath = defaultMarketplacePath(out.pluginPath, marketplaceDefaults);
  if (!out.marketplaceRoot) out.marketplaceRoot = defaultMarketplaceRoot(out.pluginPath, marketplaceDefaults);
  return out;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (value === undefined || value.startsWith('-')) throw new Error(flag + ' requires a value');
  return value;
}

/** 宿主 CLI 解析顺序：显式环境变量优先，其次已安装包内的原生可执行文件。 */
export function pickCodexCli({env = process.env} = {}) {
  for (const key of ['CODEX_CLI_PATH', 'CODEX_CLI']) {
    const value = env[key];
    if (value && fs.existsSync(value)) return value;
  }
  for (const candidate of cliCandidates(env)) if (fs.existsSync(candidate)) return candidate;
  return 'codex';
}

function requireTrustedInstallRuntime(env = process.env) {
  try { assertTrustedNpm(env); }
  catch (error) { throw new Error('INSTALL_RUNTIME_UNTRUSTED: ' + (error?.message || error)); }
}

export function resolveInstallCli({candidate = null, env = process.env, hostOptions = {}} = {}) {
  const explicit = candidate || env.CODEX_CLI_PATH || env.CODEX_CLI;
  const selectedEnv = explicit ? {...env, ORCH_CLI: explicit} : env;
  return resolveHost({...hostOptions, env: selectedEnv, agent: 'codex', autoInstall: false}).config.bin;
}

const TRUSTED_GIT_CERTIFICATES = Object.freeze(['3E9627155B7A6F29856321EE56D7FC25CF808407']);
function trustedGitPath(env = process.env) {
  const candidate = String(env.ORCH_GIT_PATH || '').trim();
  if (!path.isAbsolute(candidate) || !verifyAuthenticodePublisher(candidate, env, spawnSync, TRUSTED_GIT_CERTIFICATES)) {
    throw new Error('GIT_UNTRUSTED: --pull requires a verified Git for Windows executable prepared by bootstrap.ps1; run git pull manually to use another Git build.');
  }
  return candidate;
}

/** `codex plugin add --json` 可能夹带日志行：取最后一段可解析的 JSON 对象。 */
export function parseCliJson(text) {
  const trimmed = String(text || '').trim();
  const start = trimmed.lastIndexOf('\n{');
  for (const candidate of [trimmed, start >= 0 ? trimmed.slice(start + 1) : null]) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // 继续尝试下一个候选
    }
  }
  throw new Error('could not parse JSON from host CLI output: ' + trimmed.slice(0, 400));
}

function normalizeMarketplaceRoot(value) {
  const raw = String(value || '').trim().replace(/^\\\\\?\\/, '');
  if (!raw) return null;
  return path.resolve(raw);
}

function sameFilesystemPath(left, right) {
  if (!left || !right) return false;
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

/** Match the host's configured marketplace by both its catalog name and root. */
export function marketplaceIsConfigured(marketplaces, {name, root} = {}) {
  const expectedRoot = normalizeMarketplaceRoot(root);
  if (!expectedRoot || typeof name !== 'string' || !Array.isArray(marketplaces)) return false;
  return marketplaces.some((entry) => entry?.name === name
    && sameFilesystemPath(normalizeMarketplaceRoot(entry.root), expectedRoot));
}

/** A marketplace name is host-global; never replace a different checkout implicitly. */
export function marketplaceNameConflict(marketplaces, {name, root} = {}) {
  const expectedRoot = normalizeMarketplaceRoot(root);
  if (!expectedRoot || typeof name !== 'string' || !Array.isArray(marketplaces)) return null;
  const conflicting = marketplaces.find((entry) => entry?.name === name
    && !sameFilesystemPath(normalizeMarketplaceRoot(entry.root), expectedRoot));
  return conflicting ? normalizeMarketplaceRoot(conflicting.root) || String(conflicting.root || '') : null;
}

function readConfiguredMarketplaces(codexCli, timeoutMs) {
  const result = run(codexCli, ['plugin', 'marketplace', 'list', '--json'], {timeoutMs});
  const parsed = parseCliJson(result.stdout || result.stderr);
  if (!Array.isArray(parsed.marketplaces)) throw new Error('host CLI did not return a marketplace list');
  return parsed.marketplaces;
}

/** Register the checkout root through the host CLI, then read it back exactly. */
function ensureMarketplaceConfigured({codexCli, marketplaceRoot, marketplaceName, timeoutMs}) {
  const before = readConfiguredMarketplaces(codexCli, timeoutMs);
  if (marketplaceIsConfigured(before, {name: marketplaceName, root: marketplaceRoot})) {
    return {changed: false, marketplaces: before};
  }
  const conflictRoot = marketplaceNameConflict(before, {name: marketplaceName, root: marketplaceRoot});
  if (conflictRoot) {
    throw new Error(`MARKETPLACE_NAME_CONFLICT: ${marketplaceName} is already registered at ${conflictRoot}; refusing to replace it. Confirm the old checkout is unused, then run: codex plugin marketplace remove ${marketplaceName}`);
  }
  run(codexCli, ['plugin', 'marketplace', 'add', marketplaceRoot, '--json'], {timeoutMs});
  const after = readConfiguredMarketplaces(codexCli, timeoutMs);
  if (!marketplaceIsConfigured(after, {name: marketplaceName, root: marketplaceRoot})) {
    throw new Error(`marketplace registration did not resolve ${marketplaceName} at ${marketplaceRoot}`);
  }
  return {changed: true, marketplaces: after};
}

/** 安装缓存按 `<version>` 分目录；返回 <version, dir> 列表（新的在后）。缓存根跟随 CODEX_HOME。 */
export function listInstalledCaches({codexHome = null, homeDir = os.homedir(), marketplaceName, pluginName}) {
  const base = path.join(codexHome || path.join(homeDir, '.codex'), 'plugins', 'cache', marketplaceName, pluginName);
  if (!fs.existsSync(base)) return [];
  try { assertNoReparsePoints(base, 'plugin cache root'); } catch { return []; }
  return fs.readdirSync(base, {withFileTypes: true})
    .filter((entry) => {
      if (!entry.isDirectory() || entry.name.startsWith('.')) return false;
      try { assertNoReparsePoints(path.join(base, entry.name), 'plugin version cache'); return true; }
      catch { return false; }
    })
    .map((entry) => ({version: entry.name, dir: path.join(base, entry.name)}))
    .sort((left, right) => left.version.localeCompare(right.version));
}

/** 宿主是否已启用插件：config.toml 里要有 `[plugins."<name>@<marketplace>"]` + enabled = true。 */
export function pluginEnabledInConfig(configText, pluginId) {
  const escaped = pluginId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const section = new RegExp(`\\[plugins\\."${escaped}"\\]([\\s\\S]*?)(?=\\n\\[|$)`, 'i').exec(String(configText || ''));
  return Boolean(section && /^\s*enabled\s*=\s*true\s*$/im.test(section[1]));
}

/** 走 shell 时必须自己加引号：Node 只把参数用空格拼起来，含空格/中文的路径会被拆开。 */
export function quoteShellArg(value) {
  const text = String(value);
  // cmd.exe expands percent variables (and delayed-expansion bangs) before it
  // honors quoting. Reject these bytes instead of allowing a path or argument
  // supplied by a caller to change the shell command structure.
  if (/[%!\r\n]/.test(text)) throw new Error('UNSAFE_SHELL_ARGUMENT: percent, exclamation, or newline is not allowed');
  if (!/[\s"^&|<>()]/.test(text)) return text;
  return '"' + text.replace(/"/g, '""') + '"';
}

/** 默认单目录安装不生成发布副本；只有显式选择 --source dist 才会导出干净包。 */
export function shouldPublishDistribution({source = 'checkout', skipDist = false} = {}) {
  return !skipDist && source === 'dist';
}

function run(command, args, {cwd = root, allowFailure = false, timeoutMs = 15 * 60 * 1000, shell = null} = {}) {
  const needsShell = shell === null ? process.platform === 'win32' && /\.(cmd|bat)$/i.test(command) : shell;
  const file = needsShell ? [command, ...args].map(quoteShellArg).join(' ') : command;
  const argv = needsShell ? [] : args;
  const result = spawnSync(file, argv, {cwd, encoding: 'utf8', windowsHide: true, shell: needsShell, timeout: timeoutMs});
  if (result.error) {
    if (result.error.code === 'ENOENT') throw new Error(`command not found: ${command} (install the native Codex CLI or point CODEX_CLI_PATH at it)`);
    if (result.error.code === 'ETIMEDOUT') throw new Error(`${command} timed out after ${Math.round(timeoutMs / 1000)}s`);
    throw new Error(`${command} failed to start: ${result.error.message}`);
  }
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (exit ${result.status}): ${(result.stderr || result.stdout || '').trim().slice(0, 400)}`);
  }
  return result;
}

/**
 * npm 解析：优先 npm_execpath（npm 脚本里的真实入口），其次 npm.cmd 同级的 npm-cli.js，
 * 最后才退回 npm.cmd + shell。走 JS 入口能彻底绕开 Windows 命令行引号问题
 * （本机实测：路径含空格时 `npm.cmd ci --prefix <path>` 会失败，`node npm-cli.js ci` 正常）。
 */
export function pickNpmCli({env = process.env, nodePath = process.execPath} = {}) {
  const execPath = env.npm_execpath;
  if (execPath && /\.(c?js|mjs)$/i.test(execPath) && fs.existsSync(execPath)) {
    return {command: nodePath, args: [execPath], shell: false, source: 'npm_execpath'};
  }
  const entries = String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  const names = process.platform === 'win32' ? ['npm.cmd', 'npm'] : ['npm'];
  for (const name of names) {
    for (const dir of entries) {
      const shim = path.join(dir, name);
      if (!fs.existsSync(shim)) continue;
      if (process.platform === 'win32') {
        const cli = path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
        if (fs.existsSync(cli)) return {command: nodePath, args: [cli], shell: false, source: 'npm-cli.js'};
        return {command: shim, args: [], shell: true, source: 'npm-shim'};
      }
      return {command: shim, args: [], shell: false, source: 'npm'};
    }
  }
  return {command: process.platform === 'win32' ? 'npm.cmd' : 'npm', args: [], shell: process.platform === 'win32', source: 'fallback'};
}

/** npm 执行：一律带上解析出来的入口前缀。 */
function runNpm(args, {cwd = root, timeoutMs = 15 * 60 * 1000} = {}) {
  const npm = pickNpmCli();
  return run(npm.command, [...npm.args, ...args], {cwd, timeoutMs, shell: npm.shell});
}

function readManifest(pluginPath) {
  return JSON.parse(fs.readFileSync(path.join(pluginPath, '.codex-plugin', 'plugin.json'), 'utf8'));
}

/** 只读校验：注册匹配、分发新鲜、缓存依赖齐全、宿主已启用。 */
export function checkInstall(options = {}) {
  const pluginPath = path.resolve(options.pluginPath || root);
  const manifest = readManifest(pluginPath);
  const pluginName = manifest.name;
  const source = options.source || 'checkout';
  const configuredDistRoot = options.distRoot ? path.resolve(options.distRoot) : null;
  const distRoot = configuredDistRoot || defaultDistRoot(pluginPath);
  const marketplaceDefaults = {source, distRoot};
  const marketplacePath = path.resolve(options.marketplacePath || defaultMarketplacePath(pluginPath, marketplaceDefaults));
  const marketplaceRoot = path.resolve(options.marketplaceRoot || defaultMarketplaceRoot(pluginPath, marketplaceDefaults));
  const homeDir = options.homeDir || os.homedir();
  const codexHome = options.codexHome || process.env.CODEX_HOME || path.join(homeDir, '.codex');
  const problems = [];
  const warnings = [];
  const nameProblem = manifestNameProblem(pluginName);
  if (nameProblem) problems.push({step: 'manifest_name', status: 'invalid', reason: nameProblem});
  // Do not continue into cache discovery when the manifest name is malformed.
  // A path traversal-shaped name can otherwise influence path.join before the
  // later registration check notices the invalid component.
  if (nameProblem) {
    return {
      ok: false,
      status: 'incomplete',
      pluginName,
      version: manifest.version,
      marketplaceName: null,
      marketplacePath,
      codexHome,
      distRoot: configuredDistRoot,
      environment: {platform: process.platform, node: process.version, hostCli: options.codexCli || null},
      registration: {status: 'invalid', sourceKind: null},
      cache: null,
      skills: null,
      problems,
      warnings,
    };
  }

  const registration = inspectRegistration({pluginPath, marketplacePath, marketplaceRoot, distRoot, source});
  if (registration.status !== 'matched') {
    problems.push({step: 'registration', status: registration.status, reason: registration.reason});
  }
  const marketplaceName = registration.marketplaceName || (source === 'dist' ? DIST_MARKETPLACE_NAME : CHECKOUT_MARKETPLACE_NAME);
  const caches = listInstalledCaches({codexHome, marketplaceName, pluginName});
  // Current Codex hosts label copies from a local marketplace as `local`, while
  // the copied manifest retains the package's real semantic version.  Both
  // values are part of the contract: the directory label selects the expected
  // cache path and the manifest version authenticates the actual plugin.
  const cache = caches.find((entry) => entry.version === manifest.version || entry.version === 'local') || caches[caches.length - 1] || null;
  let validatedCache = null;
  if (!cache) {
    problems.push({step: 'cache', status: 'missing', reason: `no installed cache under ${path.join(codexHome, 'plugins', 'cache', marketplaceName, pluginName)}`});
  } else {
    const cacheVersionMatches = cache.version === manifest.version || cache.version === 'local';
    if (!cacheVersionMatches) problems.push({step: 'cache_version', status: 'stale', reason: `installed ${cache.version} but the working tree declares ${manifest.version}`});
    try {
      validatedCache = validateInstalledPath({
        installedPath: cache.dir,
        codexHome,
        marketplaceName,
        pluginName,
        version: cache.version,
        manifestVersion: manifest.version,
      });
    } catch (error) {
      problems.push({step: 'cache_path', status: 'failed', reason: error?.message || String(error)});
    }
    const cacheDir = validatedCache?.installedPath || cache.dir;
    if (validatedCache && !fs.existsSync(path.join(cacheDir, 'scripts', 'node_modules'))) {
      problems.push({step: 'cache_deps', status: 'missing', reason: `restore with: npm ci --prefix "${path.join(cacheDir, 'scripts')}" --omit=optional --ignore-scripts --no-audit --no-fund`});
    } else if (validatedCache && cacheVersionMatches && registration.status === 'matched' && registration.sourceReal) {
      try {
        authenticateInstalledCache({sourcePath: registration.sourceReal, installedPath: cacheDir});
      } catch (error) {
        problems.push({step: 'cache_authentication', status: 'failed', reason: error?.message || String(error)});
      }
    } else if (validatedCache && cacheVersionMatches && registration.status === 'matched') {
      problems.push({step: 'cache_authentication', status: 'failed', reason: 'CACHE_AUTHENTICATION_FAILED: registered source path is unavailable'});
    }
    if (validatedCache && !problems.some((problem) => ['cache_path', 'cache_deps', 'cache_authentication'].includes(problem.step)) && cacheVersionMatches && registration.status === 'matched') {
      const integrity = runAuthenticatedCacheScript({
        sourcePath: registration.sourceReal,
        installedPath: cacheDir,
        scriptPath: path.join(cacheDir, 'scripts', 'release-integrity.mjs'),
        cwd: cacheDir,
        timeoutMs: options.timeoutMs,
        allowFailure: true,
      });
      if (integrity.status !== 0) problems.push({step: 'cache_integrity', status: 'failed', reason: (integrity.stderr || integrity.stdout || '').trim().slice(0, 300)});
    }
  }

  const configPath = path.join(codexHome, 'config.toml');
  if (!fs.existsSync(configPath)) {
    problems.push({step: 'host_config', status: 'missing', reason: configPath});
  } else if (!pluginEnabledInConfig(fs.readFileSync(configPath, 'utf8'), `${pluginName}@${marketplaceName}`)) {
    problems.push({step: 'host_config', status: 'disabled', reason: `${pluginName}@${marketplaceName} is not enabled in ${configPath}`});
  }
  let skills = null;
  if (options.verifySkills) {
    skills = verifySkillsVisible({codexCli: options.codexCli, pluginName, skillNames: skillNamesOf(pluginPath)});
    if (!skills.ok) {
      const entry = {step: 'skills_visible', status: 'unverified', reason: skills.reason || `host prompt context does not list: ${skills.missing.join(', ')}`};
      if (options.strictSkills) problems.push(entry); else warnings.push(entry);
    }
  }
  if (process.platform !== 'win32') {
    warnings.push({step: 'platform', status: 'unsupported', reason: PLATFORM_WARNING});
  }

  return {
    ok: problems.length === 0,
    status: problems.length === 0 ? 'ok' : 'incomplete',
    pluginName,
    version: manifest.version,
    marketplaceName,
    marketplacePath,
    codexHome,
    // null means the single-checkout layout is active; a path is shown only
    // when the caller explicitly selected a clean distribution root.
    distRoot: configuredDistRoot,
    environment: {platform: process.platform, node: process.version, hostCli: options.codexCli || pickCodexCli()},
    registration: {status: registration.status, sourceKind: registration.sourceKind || null},
    cache: validatedCache?.installedPath || (cache ? cache.dir : null),
    skills,
    problems,
    warnings,
  };
}

/** 用宿主渲染一次新会话上下文，确认技能已进入可见清单（技能只在**新对话**里加载）。 */
export function verifySkillsVisible({codexCli = null, pluginName, skillNames, cwd = root, timeoutMs = 60000} = {}) {
  try { codexCli = resolveInstallCli({candidate: codexCli}); }
  catch (error) { return {ok: false, missing: skillNames || [], reason: String(error?.message || error)}; }
  const result = spawnSync(codexCli, ['debug', 'prompt-input', 'install-plugin-verification'], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(codexCli),
    timeout: timeoutMs,
  });
  if (result.error) {
    const reason = result.error.code === 'ENOENT' ? `host CLI not found: ${codexCli}` : `host CLI verification failed to start: ${result.error.message}`;
    return {ok: false, missing: skillNames || [], reason};
  }
  const text = String(result.stdout || '') + String(result.stderr || '');
  // 宿主版本差异：debug 子命令可能不存在；这时按"未能验证"处理，不当作安装失败。
  if (result.status !== 0) return {ok: false, missing: skillNames || [], reason: `host CLI verification unavailable (exit ${result.status}): ${text.trim().slice(0, 200)}`};
  const missing = (skillNames || []).filter((name) => !text.includes(`${pluginName}:${name}`));
  return {ok: missing.length === 0, missing, bytes: text.length};
}

export function skillNamesOf(pluginPath) {
  const skills = path.join(pluginPath, 'skills');
  if (!fs.existsSync(skills)) return [];
  return fs.readdirSync(skills, {withFileTypes: true})
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(skills, entry.name, 'SKILL.md')))
    .map((entry) => entry.name);
}

/**
 * Authenticate the installed cache against the exact local source selected by
 * marketplace registration. The cache's release-integrity verifier and doctor
 * are executable code, so neither may be trusted to authenticate itself.
 */
export function authenticateInstalledCache({sourcePath, installedPath} = {}) {
  if (!sourcePath || !installedPath) throw new Error('CACHE_AUTHENTICATION_FAILED: source and installed cache paths are required');
  const source = path.resolve(String(sourcePath || ''));
  const installed = path.resolve(String(installedPath || ''));
  let expected;
  let actual;
  try {
    const sourceStat = fs.lstatSync(source);
    const installedStat = fs.lstatSync(installed);
    if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink() || !installedStat.isDirectory() || installedStat.isSymbolicLink()) {
      throw new Error('source and installed cache roots must be regular directories');
    }
    expected = runtimeInventory(source);
    actual = runtimeInventory(installed);
  } catch (error) {
    throw new Error(`CACHE_AUTHENTICATION_FAILED: unable to inventory source/cache (${error?.message || error})`);
  }
  for (const required of ['scripts/release-integrity.mjs', 'scripts/orchestrate-sdk.mjs']) {
    if (!expected[required] || !actual[required]) {
      throw new Error(`CACHE_AUTHENTICATION_FAILED: required cache verifier or doctor is missing: ${required}`);
    }
  }
  const expectedNames = Object.keys(expected).sort();
  const actualNames = Object.keys(actual).sort();
  if (expectedNames.length !== actualNames.length || expectedNames.some((name, index) => name !== actualNames[index])) {
    throw new Error('CACHE_AUTHENTICATION_FAILED: installed cache files differ from the registered source');
  }
  for (const name of expectedNames) {
    if (actual[name] !== expected[name]) {
      throw new Error(`CACHE_AUTHENTICATION_FAILED: installed cache file differs from the registered source: ${name}`);
    }
  }
  return {ok: true, files: actualNames.length, sourcePath: source, installedPath: installed};
}

// Keep the authentication boundary on both sides of every cache script. A
// cache can be replaced after the first inventory, so a successful child
// process is not enough evidence that the authenticated bytes were the ones
// that actually ran.
function runAuthenticatedCacheScript({sourcePath, installedPath, scriptPath, args = [], cwd, timeoutMs, allowFailure = false}) {
  authenticateInstalledCache({sourcePath, installedPath});
  let result;
  let executionError;
  try {
    result = run(process.execPath, [scriptPath, ...args], {cwd, timeoutMs, allowFailure});
  } catch (error) {
    executionError = error;
  }
  let authenticationError;
  try {
    authenticateInstalledCache({sourcePath, installedPath});
  } catch (error) {
    authenticationError = error;
  }
  if (authenticationError) throw authenticationError;
  if (executionError) throw executionError;
  return result;
}

/**
 * Validate the host-reported cache path before any dependency install or
 * script execution. The native host is trusted for the install operation, but
 * its JSON result is still treated as untrusted input at this boundary.
 */
export function validateInstalledPath({installedPath, codexHome, marketplaceName, pluginName, version, manifestVersion = version}) {
  const reported = path.resolve(String(installedPath || ''));
  const cacheRoot = path.resolve(codexHome, 'plugins', 'cache', marketplaceName, pluginName);
  const cacheBase = path.resolve(codexHome, 'plugins', 'cache');
  const marketplaceRoot = path.resolve(cacheBase, marketplaceName);
  const expected = path.join(cacheRoot, version);
  let realReported, realExpected, realRoot, realCacheBase, realMarketplaceRoot;
  try {
    // The host's reported cache path is untrusted. Reject a reparse point at
    // any ancestor before resolving it; checking only the final version path
    // would allow a junction at <cache>/<marketplace>/<plugin> to redirect
    // authentication and execution outside CODEX_HOME.
    for (const [label, candidate] of [['cache root', cacheBase], ['marketplace root', marketplaceRoot], ['plugin cache root', cacheRoot], ['version cache', expected], ['reported cache', reported]]) {
      assertNoReparsePoints(candidate, label);
    }
    if (!physicallySameOrChild(cacheBase, cacheRoot)) throw new Error('cache root is outside the canonical CODEX_HOME cache directory');
    realReported = fs.realpathSync(reported);
    realExpected = fs.realpathSync(expected);
    realRoot = fs.realpathSync(cacheRoot);
    realCacheBase = fs.realpathSync(cacheBase);
    realMarketplaceRoot = fs.realpathSync(marketplaceRoot);
  } catch {
    throw new Error('HOST_INSTALL_PATH_INVALID: installed cache path is missing or not canonical');
  }
  const same = process.platform === 'win32' ? (a, b) => a.toLowerCase() === b.toLowerCase() : (a, b) => a === b;
  if (!same(realReported, realExpected) || !same(path.dirname(realExpected), realRoot) ||
      !same(path.dirname(realRoot), realMarketplaceRoot) || !same(path.dirname(realMarketplaceRoot), realCacheBase)) {
    throw new Error('HOST_INSTALL_PATH_INVALID: installed cache path is outside the expected plugin cache');
  }
  const manifestPath = path.join(realReported, '.codex-plugin', 'plugin.json');
  const scriptsPath = path.join(realReported, 'scripts');
  let manifest;
  try {
    if (!fs.statSync(scriptsPath).isDirectory() || fs.lstatSync(scriptsPath).isSymbolicLink()) throw new Error('scripts');
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('HOST_INSTALL_PATH_INVALID: installed cache is missing a regular scripts directory or manifest');
  }
  if (manifest?.name !== pluginName || manifest?.version !== manifestVersion) {
    throw new Error('HOST_INSTALL_PATH_INVALID: installed manifest does not match the requested plugin');
  }
  return {installedPath: realReported, scriptsPath: path.resolve(scriptsPath)};
}

export function installPlugin(options = {}) {
  requireTrustedInstallRuntime();
  const pluginPath = path.resolve(options.pluginPath || root);
  const manifest = readManifest(pluginPath);
  const pluginName = manifest.name;
  // 清单名在**任何文件系统动作之前**校验：publish-dist 会按这个名字递归删除分发目录，
  // 注册检查里的同名判据跑得太晚（回归：test/publish-dist.test.mjs 的越界删除用例）。
  const nameProblem = manifestNameProblem(pluginName);
  if (nameProblem) throw new Error(`invalid .codex-plugin/plugin.json name ${JSON.stringify(pluginName)}: ${nameProblem}`);
  const source = options.source || 'checkout';
  const distRoot = options.distRoot ? path.resolve(options.distRoot) : null;
  const marketplaceDefaults = {source, distRoot};
  const marketplacePath = path.resolve(options.marketplacePath || defaultMarketplacePath(pluginPath, marketplaceDefaults));
  const marketplaceRoot = path.resolve(options.marketplaceRoot || defaultMarketplaceRoot(pluginPath, marketplaceDefaults));
  const homeDir = options.homeDir || os.homedir();
  // A live checkout can contain .git/temp/test receipts and is not a public
  // publication source. Keep checkout installs available for an explicitly
  // local development invocation only; release installs must use clean dist.
  const checkoutDev = options.localDevelopment === true || process.env.ORCH_LOCAL_DEVELOPMENT === '1';
  if (source === 'checkout' && !checkoutDev) {
    throw new Error('CHECKOUT_INSTALL_REQUIRES_LOCAL_DEVELOPMENT: use --source dist for a clean package, or pass --local-development for an explicit local-only install');
  }
  const codexCli = resolveInstallCli({candidate: options.codexCli});
  const steps = [];

  if (options.pull) {
    const git = trustedGitPath();
    const dirty = run(git, ['-C', pluginPath, 'status', '--porcelain']).stdout.trim();
    if (dirty) throw new Error('refusing to pull: the working tree has local changes');
    if (!verifyAuthenticodePublisher(git, process.env, spawnSync, TRUSTED_GIT_CERTIFICATES)) throw new Error('GIT_UNTRUSTED: Git changed after the initial check.');
    run(git, ['-C', pluginPath, 'pull', '--ff-only']);
    steps.push({step: 'pull', status: 'ok'});
  }
  if (shouldPublishDistribution({source, skipDist: options.skipDist})) {
    if (!distRoot) throw new Error('--source dist requires --dist-root <directory>; the default install layout has no dist folder');
    const published = publishDist({target: distRoot, quiet: true});
    steps.push({step: 'publish-dist', status: 'ok', dist: published.dist, files: published.files});
  }
  const registrationOptions = {pluginPath, marketplacePath, marketplaceRoot, distRoot, source, homeDir};
  const registration = options.setSource ? setRegistrationSource(registrationOptions) : ensureRegistration(registrationOptions);
  if (!registration.ok) throw new Error(`registration failed (${registration.status}): ${registration.reason}`);
  steps.push({step: 'registration', status: registration.status, sourceKind: registration.sourceKind || null, entryCount: registration.entryCount, changed: registration.changed === true});

  const marketplace = ensureMarketplaceConfigured({
    codexCli,
    marketplaceRoot,
    marketplaceName: registration.marketplaceName,
    timeoutMs: options.timeoutMs,
  });
  steps.push({step: 'marketplace-add', status: 'ok', changed: marketplace.changed, root: marketplaceRoot});

  const added = run(codexCli, ['plugin', 'add', `${pluginName}@${registration.marketplaceName}`, '--json'], {timeoutMs: options.timeoutMs});
  const parsed = parseCliJson(added.stdout || added.stderr);
  const installedPath = parsed.installedPath;
  if (!installedPath || !fs.existsSync(installedPath)) throw new Error('host CLI did not report an installed path: ' + JSON.stringify(parsed).slice(0, 300));
  const installedCacheVersion = parsed.version || manifest.version;
  const validatedInstall = validateInstalledPath({
    installedPath,
    codexHome: process.env.CODEX_HOME || path.join(homeDir, '.codex'),
    marketplaceName: registration.marketplaceName,
    pluginName,
    version: installedCacheVersion,
    manifestVersion: manifest.version,
  });
  authenticateInstalledCache({sourcePath: registration.sourceReal, installedPath: validatedInstall.installedPath});
  steps.push({step: 'plugin-add', status: 'ok', version: manifest.version, cacheVersion: installedCacheVersion, installedPath: validatedInstall.installedPath});

  const cacheScripts = validatedInstall.scriptsPath;
  runNpm(['ci', '--prefix', cacheScripts, '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund'], {timeoutMs: options.timeoutMs});
  steps.push({step: 'cache-deps', status: 'ok'});
  // npm ci is intentionally script-free. Authenticate on both sides of each
  // cache script so a changed cache is detected even if it races finalization.
  runAuthenticatedCacheScript({
    sourcePath: registration.sourceReal,
    installedPath: validatedInstall.installedPath,
    scriptPath: path.join(cacheScripts, 'release-integrity.mjs'),
    cwd: validatedInstall.installedPath,
    timeoutMs: options.timeoutMs,
  });
  steps.push({step: 'cache-integrity', status: 'ok'});
  runAuthenticatedCacheScript({
    sourcePath: registration.sourceReal,
    installedPath: validatedInstall.installedPath,
    scriptPath: path.join(cacheScripts, 'orchestrate-sdk.mjs'),
    args: ['--doctor'],
    cwd: validatedInstall.installedPath,
    timeoutMs: options.timeoutMs,
  });
  steps.push({step: 'cache-doctor', status: 'ok'});

  const summary = {
    ok: true,
    status: 'installed',
    pluginName,
    version: manifest.version,
    cacheVersion: installedCacheVersion,
    marketplaceName: registration.marketplaceName,
    installedPath: validatedInstall.installedPath,
    codexHome: process.env.CODEX_HOME || path.join(homeDir, '.codex'),
    environment: {platform: process.platform, node: process.version, hostCli: codexCli},
    steps,
    warnings: [],
    next: 'skills load in a new Codex conversation. / 技能在新开的 Codex 对话里加载；编排调用从发起工作区用绝对路径调用入口脚本。',
  };
  const skillNames = skillNamesOf(pluginPath);
  summary.skills = skillNames;
  if (options.verifySkills) {
    const visibility = verifySkillsVisible({codexCli, pluginName, skillNames});
    const reason = visibility.reason || `host prompt context does not list: ${visibility.missing.join(', ')}`;
    if (visibility.ok) {
      summary.skillsVisible = true;
      steps.push({step: 'skills-visible', status: 'ok', skills: skillNames});
    } else if (options.strictSkills) {
      throw new Error(`installed, but skill visibility verification failed: ${reason}`);
    } else {
      summary.skillsVisible = false;
      summary.warnings.push({step: 'skills-visible', status: 'unverified', reason});
      steps.push({step: 'skills-visible', status: 'warning', reason});
    }
  }
  if (process.platform !== 'win32') {
    summary.warnings.push({step: 'platform', status: 'unsupported', reason: PLATFORM_WARNING});
  }
  if (!options.quiet) {
    // --json 是机器可读契约：进度与告警必须走 stderr，否则 stdout 不是纯 JSON（穷举审计 E 组实测：
    // 成功路径上 JSON.parse(stdout) 直接失败）。人类模式下 stdout 保持原样。
    const say = options.json ? console.error : console.log;
    say(`[install-plugin] ${pluginName} ${summary.version} → ${installedPath}`);
    say('[install-plugin] skills load in a new Codex conversation. / 技能在新开的 Codex 对话中加载。');
    for (const warning of summary.warnings) say(`[install-plugin] warning (${warning.step}): ${warning.reason}`);
  }
  return summary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log('Usage: install-plugin.mjs [--check] [--install] [--pull] [--set-source] [--verify-skills] [--strict-skills] [--local-development] [--json] [--quiet]');
      console.log('       [--source checkout|dist] [--timeout-ms ms] [--plugin path] [--marketplace path] [--marketplace-root path] [--dist-root path] [--home path]');
      console.log('On Windows use powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/bootstrap.ps1 -Action install -Arguments @(...) for installs; direct --check is read-only.');
      process.exit(0);
    }
    const result = options.mode === 'check' ? checkInstall(options) : installPlugin(options);
    console.log(JSON.stringify(result));
    process.exit(result.ok ? 0 : 1);
  } catch (error) {
    console.log(JSON.stringify({ok: false, status: 'error', reason: error?.message || String(error)}));
    process.exit(1);
  }
}
