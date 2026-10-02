import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

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

// Return one stable identity for an existing path (and its not-yet-created
// descendants). Windows may expose the same local directory through a long
// name, an 8.3 alias, or the local administrative UNC share. These spellings
// must not create separate controller directories, conflict keys, or mutexes.
export function physicalPathIdentity(target) {
  const absolute = assertNoReparsePoints(target, 'physical path');
  let existing = absolute;
  const tail = [];
  while (true) {
    try {
      const resolved = path.resolve(fs.realpathSync.native(existing), ...tail);
      return normalizePhysicalPath(resolved);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const next = path.dirname(existing);
      // A synthetic drive/UNC root used by a plan or test may not exist on
      // this machine. Once every existing ancestor has been checked, its
      // lexical spelling is the only available identity; retain it rather
      // than turning a harmless key comparison into an ENOENT.
      if (next === existing) return normalizePhysicalPath(absolute);
      tail.unshift(path.basename(existing));
      existing = next;
    }
  }
}

function normalizePhysicalPath(value) {
  if (process.platform !== 'win32') return path.resolve(value);
  let normalized = path.resolve(String(value)).replaceAll('/', '\\');
  // realpathSync.native can retain the extended-path prefix.
  normalized = normalized.replace(/^\\\\\?\\/, '');
  // A local administrative share is another spelling of the local drive. The
  // machine name is read once from the OS; arbitrary remote UNC shares are not
  // rewritten because they may refer to a different filesystem.
  // COMPUTERNAME is caller-controlled process environment. Use the OS-reported
  // hostname for local admin-share normalization so an injected variable cannot
  // make an arbitrary remote UNC path look like a local drive.
  const host = String(os.hostname() || '').trim();
  let local = /^\\\\(?:localhost|127\.0\.0\.1)\\([a-z])\$\\(.*)$/i.exec(normalized);
  if (!local && host) {
    const prefix = `\\\\${host}\\`;
    if (normalized.toLowerCase().startsWith(prefix.toLowerCase())) {
      const suffix = /^([a-z])\$\\(.*)$/i.exec(normalized.slice(prefix.length));
      if (suffix) local = suffix;
    }
  }
  if (local) normalized = `${local[1]}:\\${local[2]}`;
  return normalized.toLowerCase();
}

// Security-sensitive containment must compare physical directories as well as
// path spellings: on Windows an 8.3 name can refer to the same workspace.
export function physicallySameOrChild(parent, child) {
  const root = assertNoReparsePoints(parent, 'workspace');
  const target = assertNoReparsePoints(child, 'candidate path');
  const realRoot = physicalPathIdentity(root);
  const realTarget = physicalPathIdentity(target);
  if (realTarget === realRoot || realTarget.startsWith(realRoot + path.sep)) return true;
  const normalize = value => process.platform === 'win32'
    ? String(value).replaceAll('/', '\\').toLowerCase()
    : String(value);
  // Drive mappings and UNC spellings may retain different strings even after
  // realpath. The workspace itself may not exist yet, so compare the nearest
  // existing workspace ancestor with candidate ancestors and then compare the
  // remaining path components below that same physical directory.
  let rootAnchor = root, rootStat;
  while (true) {
    try { rootStat = fs.statSync(rootAnchor, { bigint: true }); break; }
    catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const next = path.dirname(rootAnchor);
      if (next === rootAnchor) throw error;
      rootAnchor = next;
    }
  }
  const rootTail = normalize(path.relative(rootAnchor, root));
  let current = target;
  while (true) {
    try {
      const stat = fs.statSync(current, { bigint: true });
      if (stat.dev === rootStat.dev && stat.ino === rootStat.ino) {
        const targetTail = normalize(path.relative(current, target));
        if (!rootTail || targetTail === rootTail || targetTail.startsWith(rootTail + path.sep)) return true;
      }
    } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    const next = path.dirname(current);
    if (next === current) return false;
    current = next;
  }
}
