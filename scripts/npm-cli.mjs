import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** Bootstrap marks its verified npm tree and passes the exact JS entry. */
export function assertTrustedNpm(env = process.env) {
  if (process.platform !== 'win32' || env.ORCH_ALLOW_UNVERIFIED_NPM === '1') return;
  const entry = String(env.npm_execpath || '');
  const attestedPath = String(env.ORCH_NPM_TRUSTED_PATH || '');
  let regular = false, realEntry = '', realAttestedPath = '', digest = '';
  try {
    regular = path.isAbsolute(entry) && /\.(?:c?js|mjs)$/i.test(entry) && fs.lstatSync(entry).isFile() && !fs.lstatSync(entry).isSymbolicLink();
    if (regular) {
      realEntry = fs.realpathSync.native(entry);
      digest = crypto.createHash('sha256').update(fs.readFileSync(realEntry)).digest('hex');
    }
  }
  catch { /* missing or linked npm entry is not a verified runtime */ }
  try {
    const stat = path.isAbsolute(attestedPath) && /\.(?:c?js|mjs)$/i.test(attestedPath) ? fs.lstatSync(attestedPath) : null;
    if (stat?.isFile() && !stat.isSymbolicLink()) realAttestedPath = fs.realpathSync.native(attestedPath);
  }
  catch { /* an attestation must name a regular npm entry */ }
  const attestedDigest = String(env.ORCH_NPM_TRUSTED_SHA256 || '').toLowerCase();
  if (env.ORCH_NPM_TRUSTED !== '1' || !regular || !realAttestedPath || !attestedDigest ||
      path.resolve(realAttestedPath).toLowerCase() !== path.resolve(realEntry).toLowerCase() ||
      !/^[a-f0-9]{64}$/.test(attestedDigest) || attestedDigest !== digest) {
    throw new Error('NPM_UNTRUSTED: bootstrap must attest the exact npm entry path and SHA-256 before installation, or explicitly set ORCH_ALLOW_UNVERIFIED_NPM=1 for repair.');
  }
}
/** 走 shell 时必须自己加引号：Node 只把参数用空格拼起来，含空格/中文的路径会被拆开。 */
export function quoteShellArg(value) {
  const text = String(value);
  // cmd.exe expands percent variables (and delayed-expansion bangs) before it
  // honors quoting. Reject these bytes instead of allowing a path or argument
  // supplied by a caller to change the shell command structure.
  if (/[%!\r\n]/.test(text)) throw new Error('UNSAFE_SHELL_ARGUMENT: percent, exclamation, or newline is not allowed');
  if (!/[\s"^&|<>()]/.test(text)) return text;
  return '"' + text.replace(/"/g, '""') + '"';
}

/**
 * npm 解析：优先 npm_execpath（npm 脚本里的真实入口），其次 npm.cmd 同级的 npm-cli.js，
 * 最后才退回 npm.cmd + shell。走 JS 入口能彻底绕开 Windows 命令行引号问题
 * （本机实测：路径含空格时 `npm.cmd ci --prefix <path>` 会失败，`node npm-cli.js ci` 正常）。
 */
export function pickNpmCli({env = process.env, nodePath = process.execPath} = {}) {
  const execPath = env.npm_execpath;
  if (execPath && /\.(c?js|mjs)$/i.test(execPath) && fs.existsSync(execPath)) {
    return {command: nodePath, args: [execPath], shell: false, source: 'npm_execpath'};
  }
  const entries = String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  const names = process.platform === 'win32' ? ['npm.cmd', 'npm'] : ['npm'];
  for (const name of names) {
    for (const dir of entries) {
      const shim = path.join(dir, name);
      if (!fs.existsSync(shim)) continue;
      if (process.platform === 'win32') {
        const cli = path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
        if (fs.existsSync(cli)) return {command: nodePath, args: [cli], shell: false, source: 'npm-cli.js'};
        return {command: shim, args: [], shell: true, source: 'npm-shim'};
      }
      return {command: shim, args: [], shell: false, source: 'npm'};
    }
  }
  return {command: process.platform === 'win32' ? 'npm.cmd' : 'npm', args: [], shell: process.platform === 'win32', source: 'fallback'};
}
