import path from 'node:path';

// Capture host-owned values when this process first loads the public entry.
// Argument parsing is allowed to configure a standalone CLI invocation, but it
// must never overwrite the desktop turn's workspace authority.
export function captureInitiatorContext(env = process.env, cwd = process.cwd()) {
  const threadId = String(env.CODEX_THREAD_ID || env.CODEX_SESSION_ID || '').trim();
  const rawWorkspace = String(env.WORKSPACE_DIR || '').trim();
  return Object.freeze({
    threadId,
    workspace: rawWorkspace ? path.resolve(cwd, rawWorkspace) : '',
  });
}

export const PROCESS_INITIATOR_CONTEXT = captureInitiatorContext();
