import fs from 'node:fs';
import path from 'node:path';

/** 走 shell 时必须自己加引号：Node 只把参数用空格拼起来，含空格/中文的路径会被拆开。 */
export function quoteShellArg(value) {
  const text = String(value);
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

/** `npm <args>` 的完整调用；调用方自己决定用 spawnSync 还是自己的 run 包装。 */
export function resolveNpmInvocation(args, options = {}) {
  const npm = pickNpmCli(options);
  return {command: npm.command, args: [...npm.args, ...args], shell: npm.shell, source: npm.source};
}
