import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Offline fixtures must not inherit authority that belongs to the desktop
// conversation which launched the parent test process. Production modules
// capture these values at import time, so this file is loaded with Node's
// --import flag before any test or product module is evaluated.
//
// Keep the filesystem and configuration roots intact: fixtures deliberately
// provide their own WORKSPACE_DIR while CODEX_HOME can still support tests of
// ordinary standalone configuration. Only host-owned authority is removed.
export const HOST_AUTHORITY_KEYS = Object.freeze([
  'CODEX_THREAD_ID',
  'CODEX_SESSION_ID',
  'CODEX_PERMISSION_PROFILE',
  'CODEX_TASK_WORKSPACE_VERIFYING_IDENTITY',
]);

export function isolateHostAuthority(env = process.env) {
  for (const key of HOST_AUTHORITY_KEYS) delete env[key];
  return env;
}

isolateHostAuthority();

// Windows' shared Temp directory may grant an AppContainer SID write access.
// Product controller/runtime roots must reject that boundary, so test fixtures
// use a disposable directory below the current user's profile instead of
// accidentally normalizing an unsafe ACL as a valid test default.
if (process.platform === 'win32' && !process.env.ORCH_TEST_TEMP_ROOT) {
  const root = path.join(os.homedir(), `.codex-tui-orchestrator-test-${process.pid}`);
  fs.mkdirSync(root, {recursive: true});
  process.env.ORCH_TEST_TEMP_ROOT = root;
  process.env.TEMP = root;
  process.env.TMP = root;
  process.once('exit', () => { try { fs.rmSync(root, {recursive: true, force: true, maxRetries: 20, retryDelay: 200}); } catch {} });
}
