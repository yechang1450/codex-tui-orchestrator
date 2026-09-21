#!/usr/bin/env node
/**
 * install-plugin — 一条命令完成"干净分发 → 个人 marketplace 注册 → 插件管理器安装 → 缓存依赖恢复 → 校验"。
 *
 * 为什么需要它：本机实测安装链路有四段容易漏掉的手工步骤——
 *   1) 重建干净分发（指向工作树会把 .git/ 和 temp/ 复制进安装缓存）；
 *   2) 个人 marketplace 文件/条目还不存在时要先补（缺了 `codex plugin add` 直接失败）；
 *   3) 插件管理器每次安装都会建不带 node_modules 的新缓存，必须对**新缓存路径**恢复依赖；
 *   4) 恢复后要在同一个缓存路径跑完整性检查和 doctor，确认技能与运行时都到位。
 * 漏掉第 3 步得到的是"技能在、运行时缺依赖"的半成品；漏掉第 2 步连安装都进不去。
 * 面向"第二台机器"的两件事也一并处理：缓存根跟随 CODEX_HOME（不假设 `~/.codex`），
 * 以及条目还指向旧克隆或别的机器时用 `--set-source` 重新指向本机分发。
 *
 * 用法：
 *   node scripts/install-plugin.mjs                 # 安装/更新（幂等）
 *   node scripts/install-plugin.mjs --check         # 只读校验：注册、分发新鲜度、缓存依赖、宿主启用状态（跟随 CODEX_HOME）
 *   node scripts/install-plugin.mjs --pull          # 先 git pull --ff-only（要求工作树干净）
 *   node scripts/install-plugin.mjs --set-source    # 条目指向旧克隆/别的机器时，改写成本机分发
 *   node scripts/install-plugin.mjs --verify-skills # 额外用宿主渲染一次新会话上下文（不可用只告警）
 *   node scripts/install-plugin.mjs --strict-skills # 技能可见性验证失败也当作安装失败
 *   node scripts/install-plugin.mjs --json          # 机器可读输出
 *   node scripts/install-plugin.mjs --source checkout|dist --timeout-ms <ms> --marketplace <path> --marketplace-root <path> --dist-root <path>
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {ensureRegistration, inspectRegistration, setRegistrationSource, defaultDistRoot} from './repair-plugin-registration.mjs';
import {publishDist} from './publish-dist.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_MARKETPLACE = path.join(os.homedir(), '.agents', 'plugins', 'marketplace.json');
const PLATFORM_WARNING = "this plugin's execution core is Windows-only; a non-Windows host can hold the install but runs are out of contract";

export function parseArgs(argv) {
  const out = {
    pluginPath: root,
    marketplacePath: DEFAULT_MARKETPLACE,
    marketplaceRoot: os.homedir(),
    distRoot: null,
    source: 'dist',
    mode: 'install',
    pull: false,
    skipDist: false,
    verifySkills: false,
    strictSkills: false,
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
    else if (arg === '--set-source') out.setSource = true;
    else if (arg === '--timeout-ms') { out.timeoutMs = Number(requireValue(argv, ++i, '--timeout-ms')); if (!Number.isFinite(out.timeoutMs) || out.timeoutMs <= 0) throw new Error('--timeout-ms must be a positive number'); }
    else if (arg === '--json') out.json = true;
    else if (arg === '--quiet') out.quiet = true;
    else if (arg === '--plugin') { out.pluginPath = requireValue(argv, ++i, '--plugin'); }
    else if (arg === '--source') { out.source = requireValue(argv, ++i, '--source'); }
    else if (arg === '--marketplace') { out.marketplacePath = requireValue(argv, ++i, '--marketplace'); }
    else if (arg === '--marketplace-root') { out.marketplaceRoot = requireValue(argv, ++i, '--marketplace-root'); }
    else if (arg === '--dist-root') { out.distRoot = requireValue(argv, ++i, '--dist-root'); }
    else if (arg === '--home') { out.homeDir = requireValue(argv, ++i, '--home'); }
    else if (arg === '-h' || arg === '--help') out.help = true;
    else throw new Error('unknown option: ' + arg);
  }
  return out;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (value === undefined || value.startsWith('-')) throw new Error(flag + ' requires a value');
  return value;
}

/** 宿主 CLI 解析顺序：显式环境变量优先，其次 PATH 上的 codex.exe（Windows 上避免落到 .cmd 直启）。 */
export function pickCodexCli({env = process.env} = {}) {
  for (const key of ['CODEX_CLI_PATH', 'CODEX_CLI']) {
    const value = env[key];
    if (value && fs.existsSync(value)) return value;
  }
  const entries = String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  const names = process.platform === 'win32' ? ['codex.exe', 'codex.cmd', 'codex.bat', 'codex'] : ['codex'];
  for (const name of names) {
    for (const dir of entries) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return 'codex';
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

/** 安装缓存按 `<version>` 分目录；返回 <version, dir> 列表（新的在后）。缓存根跟随 CODEX_HOME。 */
export function listInstalledCaches({codexHome = null, homeDir = os.homedir(), marketplaceName, pluginName}) {
  const base = path.join(codexHome || path.join(homeDir, '.codex'), 'plugins', 'cache', marketplaceName, pluginName);
  if (!fs.existsSync(base)) return [];
  return fs.readdirSync(base, {withFileTypes: true})
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => ({version: entry.name, dir: path.join(base, entry.name)}))
    .sort((left, right) => left.version.localeCompare(right.version));
}

/** 宿主是否已启用插件：config.toml 里要有 `[plugins."<name>@<marketplace>"]` + enabled = true。 */
export function pluginEnabledInConfig(configText, pluginId) {
  const escaped = pluginId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const section = new RegExp(`\\[plugins\\."${escaped}"\\]([\\s\\S]*?)(?=\\n\\[|$)`, 'i').exec(String(configText || ''));
  return Boolean(section && /^\s*enabled\s*=\s*true\s*$/im.test(section[1]));
}

function run(command, args, {cwd = root, allowFailure = false, timeoutMs = 15 * 60 * 1000} = {}) {
  const useShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
  const result = spawnSync(command, args, {cwd, encoding: 'utf8', windowsHide: true, shell: useShell, timeout: timeoutMs});
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

/** npm 解析：优先 npm_execpath（在 npm 脚本里运行时的真实入口），否则用 PATH 上的 npm。 */
function runNpm(args, {cwd = root, timeoutMs = 15 * 60 * 1000} = {}) {
  const execPath = process.env.npm_execpath;
  if (execPath && /\.(c?js|mjs)$/i.test(execPath) && fs.existsSync(execPath)) {
    return run(process.execPath, [execPath, ...args], {cwd, timeoutMs});
  }
  return run(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {cwd, timeoutMs});
}

function readManifest(pluginPath) {
  return JSON.parse(fs.readFileSync(path.join(pluginPath, '.codex-plugin', 'plugin.json'), 'utf8'));
}

/** 只读校验：注册匹配、分发新鲜、缓存依赖齐全、宿主已启用。 */
export function checkInstall(options = {}) {
  const pluginPath = path.resolve(options.pluginPath || root);
  const manifest = readManifest(pluginPath);
  const pluginName = manifest.name;
  const marketplacePath = path.resolve(options.marketplacePath || DEFAULT_MARKETPLACE);
  const marketplaceRoot = path.resolve(options.marketplaceRoot || os.homedir());
  const distRoot = options.distRoot || defaultDistRoot(pluginPath);
  const homeDir = options.homeDir || os.homedir();
  const codexHome = options.codexHome || process.env.CODEX_HOME || path.join(homeDir, '.codex');
  const problems = [];
  const warnings = [];

  const registration = inspectRegistration({pluginPath, marketplacePath, marketplaceRoot, distRoot});
  if (registration.status !== 'matched') {
    problems.push({step: 'registration', status: registration.status, reason: registration.reason});
  }
  const marketplaceName = registration.marketplaceName || 'personal';
  const caches = listInstalledCaches({codexHome, marketplaceName, pluginName});
  const cache = caches.find((entry) => entry.version === manifest.version) || caches[caches.length - 1] || null;
  if (!cache) {
    problems.push({step: 'cache', status: 'missing', reason: `no installed cache under ${path.join(codexHome, 'plugins', 'cache', marketplaceName, pluginName)}`});
  } else {
    if (cache.version !== manifest.version) problems.push({step: 'cache_version', status: 'stale', reason: `installed ${cache.version} but the working tree declares ${manifest.version}`});
    if (!fs.existsSync(path.join(cache.dir, 'scripts', 'node_modules'))) {
      problems.push({step: 'cache_deps', status: 'missing', reason: `restore with: npm ci --prefix "${path.join(cache.dir, 'scripts')}" --omit=optional --ignore-scripts --no-audit --no-fund`});
    } else {
      const integrity = run(process.execPath, [path.join(cache.dir, 'scripts', 'release-integrity.mjs')], {cwd: cache.dir, allowFailure: true});
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
    skills = verifySkillsVisible({codexCli: options.codexCli || pickCodexCli(), pluginName, skillNames: skillNamesOf(pluginPath)});
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
    distRoot: path.resolve(distRoot),
    environment: {platform: process.platform, node: process.version, hostCli: options.codexCli || pickCodexCli()},
    registration: {status: registration.status, sourceKind: registration.sourceKind || null},
    cache: cache ? cache.dir : null,
    skills,
    problems,
    warnings,
  };
}

/** 用宿主渲染一次新会话上下文，确认技能已进入可见清单（技能只在**新对话**里加载）。 */
export function verifySkillsVisible({codexCli = pickCodexCli(), pluginName, skillNames, cwd = root, timeoutMs = 60000} = {}) {
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

export function installPlugin(options = {}) {
  const pluginPath = path.resolve(options.pluginPath || root);
  const manifest = readManifest(pluginPath);
  const pluginName = manifest.name;
  const marketplacePath = path.resolve(options.marketplacePath || DEFAULT_MARKETPLACE);
  const marketplaceRoot = path.resolve(options.marketplaceRoot || os.homedir());
  const homeDir = options.homeDir || os.homedir();
  const distRoot = options.distRoot ? path.resolve(options.distRoot) : null;
  const codexCli = options.codexCli || pickCodexCli();
  const steps = [];

  if (options.pull) {
    const dirty = run('git', ['-C', pluginPath, 'status', '--porcelain']).stdout.trim();
    if (dirty) throw new Error('refusing to pull: the working tree has local changes');
    run('git', ['-C', pluginPath, 'pull', '--ff-only']);
    steps.push({step: 'pull', status: 'ok'});
  }
  if (!options.skipDist) {
    const published = publishDist({...(distRoot ? {target: distRoot} : {}), quiet: true});
    steps.push({step: 'publish-dist', status: 'ok', dist: published.dist, files: published.files});
  }
  const registrationOptions = {pluginPath, marketplacePath, marketplaceRoot, distRoot, source: options.source || 'dist', homeDir};
  const registration = options.setSource ? setRegistrationSource(registrationOptions) : ensureRegistration(registrationOptions);
  if (!registration.ok) throw new Error(`registration failed (${registration.status}): ${registration.reason}`);
  steps.push({step: 'registration', status: registration.status, sourceKind: registration.sourceKind || null, entryCount: registration.entryCount, changed: registration.changed === true});

  const added = run(codexCli, ['plugin', 'add', `${pluginName}@${registration.marketplaceName}`, '--json'], {timeoutMs: options.timeoutMs});
  const parsed = parseCliJson(added.stdout || added.stderr);
  const installedPath = parsed.installedPath;
  if (!installedPath || !fs.existsSync(installedPath)) throw new Error('host CLI did not report an installed path: ' + JSON.stringify(parsed).slice(0, 300));
  steps.push({step: 'plugin-add', status: 'ok', version: parsed.version || manifest.version, installedPath});

  const cacheScripts = path.join(installedPath, 'scripts');
  runNpm(['ci', '--prefix', cacheScripts, '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund'], {timeoutMs: options.timeoutMs});
  steps.push({step: 'cache-deps', status: 'ok'});
  run(process.execPath, [path.join(cacheScripts, 'release-integrity.mjs')], {cwd: installedPath, timeoutMs: options.timeoutMs});
  steps.push({step: 'cache-integrity', status: 'ok'});
  run(process.execPath, [path.join(cacheScripts, 'orchestrate-sdk.mjs'), '--doctor'], {cwd: installedPath, timeoutMs: options.timeoutMs});
  steps.push({step: 'cache-doctor', status: 'ok'});

  const summary = {
    ok: true,
    status: 'installed',
    pluginName,
    version: parsed.version || manifest.version,
    marketplaceName: registration.marketplaceName,
    installedPath,
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
    console.log(`[install-plugin] ${pluginName} ${summary.version} → ${installedPath}`);
    console.log('[install-plugin] skills load in a new Codex conversation. / 技能在新开的 Codex 对话中加载。');
    for (const warning of summary.warnings) console.log(`[install-plugin] warning (${warning.step}): ${warning.reason}`);
  }
  return summary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log('Usage: install-plugin.mjs [--check] [--install] [--pull] [--set-source] [--verify-skills] [--strict-skills] [--json] [--quiet]');
      console.log('       [--source dist|checkout] [--timeout-ms ms] [--plugin path] [--marketplace path] [--marketplace-root path] [--dist-root path] [--home path]');
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
