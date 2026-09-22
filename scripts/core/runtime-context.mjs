import fs from 'node:fs';
import path from 'node:path';

// Resolve once at the caller's entry point. Never substitute the install directory
// or CODEX_HOME for the directory that initiated this run.
export function resolveRuntimeContext(env = process.env, cwd = process.cwd()) {
  const workspace = path.resolve(cwd, String(env.WORKSPACE_DIR || '').trim() || '.');
  // 工作区"存在但不是目录"必须 fail-closed：否则失败会被推迟到 statfsSync/mkdirSync/子进程 cwd
  // 各个角落，以互不相同的错误形态炸开（穷举审计 C 组实测：`--workspace <file> --doctor` 曾 exit 0
  // 并把文件当工作区回给调用方）。不存在仍然放过——按需创建是既有行为。
  if (fs.existsSync(workspace) && !fs.statSync(workspace).isDirectory()) {
    throw new Error('WORKSPACE_NOT_A_DIRECTORY: ' + workspace + ' exists but is not a directory');
  }
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
