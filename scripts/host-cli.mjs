import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Adapter contract: resolve a real CLI before any planner/window is started.
// Additional adapters must implement planning, interactive argv and completion
// capture together; a CLI name alone is not proof of compatibility.
export const adapters = Object.freeze({
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

export function cliCandidates(env = process.env, platform = process.platform) {
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
        found.push(path.join(base, triple, 'codex', 'codex.exe'));
      }
    }
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
  const adapter = adapters[id];
  if (!adapter) throw new Error(`ADAPTER_UNSUPPORTED: ${id}; no CLI adapter implemented; no fallback or automatic install.`);
  const bin = candidates(env).find(probe);
  if (!bin) throw new Error(`CLI_MISSING: ${id}; install its CLI yourself or set ORCH_CLI to its native executable. No fallback or automatic install.`);
  return { agent: id, config: { ...adapter, bin, available: true } };
}

export function launchArgs(config, options = {}) {
  if (!adapters[config?.id]) throw new Error('ADAPTER_UNSUPPORTED: refusing Codex argv for another agent.');
  return ['--cd', options.cwd || process.cwd(), '-a', options.approval || 'on-request',
    '--sandbox', options.sandbox || 'workspace-write'];
}
