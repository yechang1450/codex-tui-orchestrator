import fs from 'node:fs';
import { networkArgs } from './network-policy.mjs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {resolvePiHost,piArgs} from './pi-host.mjs';

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

export function cliCandidates(env = process.env, platform = process.platform, {where = spawnSync} = {}) {
  const explicit = env.ORCH_CLI || env.CODEX_EXE;
  if (explicit) return [path.resolve(explicit)];
  const found = [];
  for (const dir of String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)) {
    found.push(path.join(dir, platform === 'win32' ? 'codex.exe' : 'codex'));
    // npm shims are not native executables; the SDK must receive the packaged binary.
    const modules = path.join(dir, 'node_modules', '@openai');
    for (const base of [path.join(modules, 'codex', 'vendor'),
      path.join(modules, 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor'),
      path.join(modules, 'codex-win32-x64', 'vendor'),
      path.join(modules, 'codex', 'node_modules', '@openai', 'codex-win32-arm64', 'vendor')]) {
      for (const triple of ['x86_64-pc-windows-msvc', 'aarch64-pc-windows-msvc']) {
        // Current npm packages place the native binary below codex/bin; older
        // packages used codex.exe directly below the target directory.
        found.push(path.join(base, triple, 'bin', 'codex.exe'));
        found.push(path.join(base, triple, 'codex', 'bin', 'codex.exe'));
        found.push(path.join(base, triple, 'codex', 'codex.exe'));
      }
    }
  }
  // Some desktop hosts expose neither PATH nor Path to a child process even
  // though the native Codex installation is registered. Ask the Windows
  // resolver for codex.exe in that case; this never installs or selects a shim.
  if (platform === 'win32' && !found.some(file => { try { return fs.existsSync(file); } catch { return false; } })) {
    try {
      const whereExe = path.join(env.SystemRoot || env.WINDIR || 'C:\\Windows', 'System32', 'where.exe');
      const result = where(whereExe, ['codex.exe'], {encoding:'utf8', windowsHide:true, shell:false, timeout:8000});
      if (result?.status === 0) for (const line of String(result.stdout || '').split(/\r?\n/)) {
        const candidate = line.trim();
        if (candidate) found.push(candidate);
      }
    } catch { /* resolveHost reports CLI_MISSING if the native resolver is unavailable */ }
  }
  return [...new Set(found)];
}

export function resolveHost({ env = process.env, agent, candidates = cliCandidates,
  probe = (file) => {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
    const result = spawnSync(file, ['--version'], {
      encoding: 'utf8', windowsHide: true, timeout: 8000, shell: false,
    });
    return result.status === 0 && /^codex-cli\s/m.test(result.stdout || '');
  } } = {}) {
  const id = agent || detectHostAgent(env);
  if(id==='pi')return resolvePiHost(env);
  const adapter = adapters[id];
  if (!adapter) throw new Error(`ADAPTER_UNSUPPORTED: ${id}; no CLI adapter implemented; no fallback or automatic install.`);
  const bin = candidates(env).find(probe);
  if (!bin) throw new Error(`CLI_MISSING: ${id}; install its CLI yourself or set ORCH_CLI to its native executable. No fallback or automatic install.`);
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
