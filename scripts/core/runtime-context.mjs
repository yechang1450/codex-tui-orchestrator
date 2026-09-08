import path from 'node:path';

// Resolve once at the caller's entry point. Never substitute the install directory
// or CODEX_HOME for the directory that initiated this run.
export function resolveRuntimeContext(env = process.env, cwd = process.cwd()) {
  const workspace = path.resolve(cwd, String(env.WORKSPACE_DIR || '').trim() || '.');
  const temp = path.join(workspace, 'temp');
  const override = String(env.ORCH_STATE_DIR || '').trim();
  const state = override ? resolveStateOverride(temp, override) : path.join(temp, 'orchestrator');
  return { workspace, temp, state };
}

function resolveStateOverride(temp, override) {
  // Runtime state is part of the initiating workspace. Relative overrides are
  // rooted at workspace/temp, while absolute overrides are accepted only when
  // they already point below that directory.
  const candidate = path.isAbsolute(override) ? path.resolve(override) : path.resolve(temp, override);
  const relative = path.relative(temp, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`ORCH_STATE_DIR must stay under the initiating workspace temp directory: ${candidate}`);
  }
  return candidate;
}
