import fs from 'node:fs';
import { networkArgs } from './network-policy.mjs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pickNpmCli } from '../npm-cli.mjs';
import {resolvePiHost,piArgs} from './pi-host.mjs';

const WIN_TARGETS = Object.freeze([
  ['x86_64-pc-windows-msvc', 'codex.exe'],
  ['aarch64-pc-windows-msvc', 'codex.exe'],
]);

function pathApi(platform) {
  return platform === 'win32' ? path.win32 : path;
}

function vendorCandidates(root, platform) {
  const p = pathApi(platform);
  const candidates = [];
  for (const [triple, executable] of WIN_TARGETS) {
    candidates.push(p.join(root, 'vendor', triple, 'bin', executable));
    candidates.push(p.join(root, 'vendor', triple, 'codex', 'bin', executable));
    candidates.push(p.join(root, 'vendor', triple, 'codex', executable));
  }
  return candidates;
}

function packageNativeCandidates(modulesRoot, platform) {
  const p = pathApi(platform);
  const roots = [
    p.join(modulesRoot, '@openai', 'codex'),
    p.join(modulesRoot, '@openai', 'codex-win32-x64'),
    p.join(modulesRoot, '@openai', 'codex-win32-arm64'),
  ];
  const candidates = [];
  for (const root of roots) candidates.push(...vendorCandidates(root, platform));
  // npm may keep optional platform packages nested under the main package.
  for (const packageName of ['codex-win32-x64', 'codex-win32-arm64']) {
    candidates.push(...vendorCandidates(p.join(modulesRoot, '@openai', 'codex', 'node_modules', '@openai', packageName), platform));
  }
  return candidates;
}

function defaultLocalModuleRoots(platform) {
  if (platform !== process.platform) return [];
  const here = path.dirname(fileURLToPath(import.meta.url));
  return [path.resolve(here, '..', 'node_modules')];
}

function localNativeCandidates(platform, localRoots = defaultLocalModuleRoots(platform)) {
  if (platform !== 'win32') return [];
  return localRoots.flatMap(root => packageNativeCandidates(root, platform));
}

function nativeProbe(file, env = process.env) {
  try {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
    const result = spawnSync(file, ['--version'], {
      encoding: 'utf8', windowsHide: true, timeout: 8000, shell: false, env,
    });
    return result.status === 0 && /^codex-cli\s/m.test(result.stdout || '');
  } catch { return false; }
}

// Adapter contract: resolve a real CLI before any planner/window is started.
// Additional adapters must implement planning, interactive argv and completion
// capture together; a CLI name alone is not proof of compatibility.
export const adapters = Object.freeze({
  pi: Object.freeze({id:'pi',label:'pi agent',native:false,completionMarker:'__ORCH_DONE__',verified:false}),
  codex: Object.freeze({ id: 'codex', label: 'Codex CLI', native: true,
    modelEnv: 'ORCH_MODEL', effortEnv: 'ORCH_EFFORT',
    completionMarker: '__ORCH_DONE__', verified: false }),
});

export function detectHostAgent(env = process.env) {
  const explicit = String(env.ORCH_AGENT || '').trim().toLowerCase();
  if (explicit) return explicit;
  if (env.CODEX_THREAD_ID || env.CODEX_SESSION_ID) return 'codex';
  throw new Error('HOST_UNKNOWN: set ORCH_AGENT to the initiating agent; no Codex fallback.');
}

function desktopNativeCandidates(env,platform){
  if(platform!=='win32'||!env.LOCALAPPDATA)return [];
  const root=path.win32.join(env.LOCALAPPDATA,'OpenAI','Codex','bin');
  try{return fs.readdirSync(root,{withFileTypes:true}).filter(e=>e.isDirectory()).map(e=>{
    const bin=path.win32.join(root,e.name,'codex.exe');
    try{return {bin,time:fs.statSync(bin).mtimeMs};}catch{return null;}
  }).filter(Boolean).sort((a,b)=>b.time-a.time).map(e=>e.bin);}catch{return [];}
}

export function cliCandidates(env = process.env, platform = process.platform, {where = spawnSync, localRoots = defaultLocalModuleRoots(platform), desktopBins = desktopNativeCandidates(env,platform)} = {}) {
  const p = pathApi(platform);
  const explicit = env.ORCH_CLI || env.CODEX_EXE;
  if (explicit) return [p.resolve(explicit)];
  const found = [];
  for (const dir of String(env.PATH || env.Path || '').split(p.delimiter).filter(Boolean)) {
    found.push(p.join(dir, platform === 'win32' ? 'codex.exe' : 'codex'));
    // npm shims are not native executables; the SDK must receive the packaged binary.
    found.push(...packageNativeCandidates(p.join(dir, 'node_modules'), platform));
  }
  found.push(...desktopBins,...localNativeCandidates(platform, localRoots));
  // Some desktop hosts expose neither PATH nor Path to a child process even
  // though the native Codex installation is registered. Ask the Windows
  // resolver for codex.exe in that case; this never installs or selects a shim.
  if (platform === 'win32' && !found.some(file => { try { return fs.existsSync(file); } catch { return false; } })) {
    try {
      const whereExe = p.join(env.SystemRoot || env.WINDIR || 'C:\\Windows', 'System32', 'where.exe');
      const result = where(whereExe, ['codex.exe'], {encoding:'utf8', windowsHide:true, shell:false, timeout:8000});
      if (result?.status === 0) for (const line of String(result.stdout || '').split(/\r?\n/)) {
        const candidate = line.trim();
        if (candidate) found.push(candidate);
      }
    } catch { /* resolveHost reports CLI_MISSING if the native resolver is unavailable */ }
  }
  return [...new Set(found)];
}

function installerError(code) {
  const suffix = code ? ` (${String(code)})` : '';
  return new Error('CLI_AUTO_INSTALL_FAILED' + suffix);
}

function npmRoot({npm, env, platform, spawn}) {
  try {
    const result = spawn(npm.command, [...npm.args, 'root', '--global'], {
      encoding: 'utf8', windowsHide: true, shell: npm.shell, timeout: 15000, env,
    });
    if (result?.status === 0) {
      const lines = String(result.stdout || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      return lines.at(-1) || '';
    }
  } catch { /* installation already succeeded; probing below gives the final error */ }
  return '';
}

export const DEFAULT_CLI_INSTALL_SPEC = '@openai/codex@0.157.0';

/** Install a native Codex package without logging npm output or credentials. */
export function installCodexCli({env = process.env, platform = process.platform, spawn = spawnSync, localRoots = defaultLocalModuleRoots(platform), probe = file => nativeProbe(file, env)} = {}) {
  const npm = pickNpmCli({env});
  const spec = String(env.ORCH_CLI_INSTALL_SPEC || DEFAULT_CLI_INSTALL_SPEC).trim();
  if (!/^@openai\/codex@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(spec)) throw installerError('invalid_spec');
  const timeout = Number(env.ORCH_CLI_INSTALL_TIMEOUT_MS || 120000);
  if(!Number.isSafeInteger(timeout)||timeout<1||timeout>600000)throw installerError('invalid_timeout');
  let result;
  try {
    result = spawn(npm.command, [...npm.args, 'install', '--global', '--ignore-scripts', '--no-audit', '--no-fund', spec], {
      cwd: process.cwd(), encoding: 'utf8', windowsHide: true, shell: npm.shell, timeout, env,
    });
  } catch (error) {
    throw installerError(error?.code || 'spawn');
  }
  if (result?.error || result?.status !== 0) throw installerError(result?.error?.code || `exit_${result?.status ?? 'unknown'}`);
  const roots = [npmRoot({npm, env, platform, spawn}), ...localRoots].filter(Boolean);
  const candidates = [
    ...roots.flatMap(root => packageNativeCandidates(root, platform)),
    ...cliCandidates(env, platform, {localRoots}),
  ];
  const bin = [...new Set(candidates)].find(probe);
  if (!bin) throw installerError('native_binary_not_found');
  return bin;
}

export function resolveHost({ env = process.env, agent, candidates = cliCandidates,
  probe = (file) => nativeProbe(file, env), install, autoInstall } = {}) {
  const id = agent || detectHostAgent(env);
  if(id==='pi')return resolvePiHost(env);
  const adapter = adapters[id];
  if (!adapter) throw new Error(`ADAPTER_UNSUPPORTED: ${id}; no CLI adapter implemented; no fallback or automatic install.`);
  // An explicit executable is an operator decision. If it is stale or invalid,
  // fail closed instead of silently installing a different CLI and hiding the
  // configuration error.
  const explicit = String(env.ORCH_CLI || env.CODEX_EXE || '').trim();
  let bin = candidates(env).find(probe);
  const shouldAutoInstall = !explicit && (autoInstall ?? (candidates === cliCandidates && env.ORCH_AUTO_INSTALL_CLI !== '0'));
  if (!bin && id === 'codex' && shouldAutoInstall) {
    try {
      const installed = (install || (() => installCodexCli({env, probe})))();
      const installedCandidates = Array.isArray(installed) ? installed : [installed];
      bin = [...installedCandidates, ...candidates(env)].find(probe);
    } catch (error) {
      if (String(error?.message || '').startsWith('CLI_AUTO_INSTALL_FAILED')) throw error;
      throw installerError(error?.code || 'installer');
    }
  }
  if (!bin) throw new Error(`CLI_MISSING: ${id}; install its CLI yourself or set ORCH_CLI to its native executable. Automatic installation was disabled or did not produce a verified native binary.`);
  return { agent: id, config: { ...adapter, bin, available: true } };
}

export function launchArgs(config, options = {}) {
  if(config?.id==='pi'){
    if(options.sandbox&&options.sandbox!=='danger-full-access')throw new Error('PI_SANDBOX_UNSUPPORTED: pi does not implement the requested sandbox');
    return piArgs(config,{model:process.env.ORCH_MODEL,effort:process.env.ORCH_EFFORT});
  }
  if (!adapters[config?.id]) throw new Error('ADAPTER_UNSUPPORTED: refusing Codex argv for another agent.');
  const cwd = options.cwd || process.cwd();
  const sandbox = options.sandbox || 'danger-full-access';
  // Codex treats --dangerously-bypass-approvals-and-sandbox as a complete
  // authorization envelope and rejects it when -a/--ask-for-approval is also
  // supplied. Keep the explicit no-approval flag only for restricted modes.
  const args = ['--cd', cwd];
  if (sandbox === 'danger-full-access') args.push('--sandbox', sandbox);
  else args.push('-a', 'never', '--sandbox', sandbox);
  // The orchestrator has already received the initiating window's effective
  // authorization and normalizes it to never + danger-full-access. Carry that
  // envelope into Codex so project trust and command confirmations cannot stop
  // an authorized TUI window at startup. Restricted callers keep their policy.
  if (sandbox === 'danger-full-access') args.push('--dangerously-bypass-approvals-and-sandbox');
  args.push('-c', `projects.${JSON.stringify(cwd)}.trust_level="trusted"`, ...networkArgs());
  return args;
}
