import fs from 'node:fs';
import path from 'node:path';

// Resolve once at the caller's entry point. Never substitute the install directory
// or CODEX_HOME for the directory that initiated this run.
export function resolveRuntimeContext(env = process.env, cwd = process.cwd()) {
  const workspace = path.resolve(cwd, String(env.WORKSPACE_DIR || '').trim() || '.');
  assertNoReparsePoints(workspace, 'WORKSPACE_DIR');
  // 工作区"存在但不是目录"必须 fail-closed：否则失败会被推迟到 statfsSync/mkdirSync/子进程 cwd
  // 各个角落，以互不相同的错误形态炸开（穷举审计 C 组实测：`--workspace <file> --doctor` 曾 exit 0
  // 并把文件当工作区回给调用方）。不存在仍然放过——按需创建是既有行为。
  if (fs.existsSync(workspace) && !fs.statSync(workspace).isDirectory()) {
    throw new Error('WORKSPACE_NOT_A_DIRECTORY: ' + workspace + ' exists but is not a directory');
  }
  const temp = path.join(workspace, 'temp');
  assertNoReparsePoints(temp, 'workspace temp');
  const override = String(env.ORCH_STATE_DIR || '').trim();
  const state = override ? resolveStateOverride(temp, override) : path.join(temp, 'orchestrator');
  assertNoReparsePoints(state, 'ORCH_STATE_DIR');
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

// A lexical path check does not stop a pre-existing symlink/junction/reparse
// point from redirecting runtime state outside the workspace. Walk every
// existing component before any mkdir/write call and fail closed when one is a
// link. Missing tail components are safe to create only after their existing
// ancestors have passed this check.
export function assertNoReparsePoints(target, label = 'path') {
  const absolute = path.resolve(String(target));
  let current = absolute;
  while (true) {
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error(`${label} cannot contain a symbolic link, junction, or reparse point: ${current}`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return absolute;
}
