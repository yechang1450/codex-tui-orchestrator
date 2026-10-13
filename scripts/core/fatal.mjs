// 公开入口的失败契约（唯一定义处）：stderr 只回一行 `[orchestrator] FATAL: <原因>`，
// 零 Node 栈帧、零 ESM 载入器前言，stdout 保持空。内核入口、公开包装层与轮询/状态/
// 监督入口都从这里出口，避免各处自写 `console.error(e.stack)` 把栈帧和
// "Node.js v…" 横幅泄漏给用户（回归：test/public-fatal-contract.test.mjs）。
import fs from 'node:fs';
import {redactSensitiveText} from './redaction.mjs';

export function fatalMessage(error) {
  const raw = error && typeof error === 'object' && error.message ? error.message : error;
  const text = redactSensitiveText(String(raw ?? '').trim());
  return '[orchestrator] FATAL: ' + (text || 'unknown failure');
}

export function reportFatal(error) {
  // 同步写 fd 2：console.error 接到管道时是异步的，随后立刻退出会把它截断。
  try { fs.writeSync(2, fatalMessage(error) + '\n'); } catch { /* stderr is gone; the exit code still fails closed */ }
  // 排障出口：默认绝不附栈（契约），只有显式 ORCH_DEBUG=1 才允许把栈跟在这一行后面。
  if (process.env.ORCH_DEBUG === '1' && error && error.stack) {
    try { fs.writeSync(2, redactSensitiveText(String(error.stack)) + '\n'); } catch { /* ignore */ }
  }
  process.exitCode = 1;
}

// 模块求值期失败（选项解析、镜像校验、宿主适配）没有上层 catch 可兜：ESM 载入器会把
// 原始异常连栈帧一起打到 stderr，因此同步写完这一行后立刻以 1 退出。
export function exitFatal(error) {
  reportFatal(error);
  process.exit(1);
}

// 模块求值期的失败还有第三种入口：**动态 import 期间**抛出的错误（例如引擎在模块体里解析
// 工作区/CLI：`resolveRuntimeContext`、`resolveHost`）。这类错误既不在 main() 的 promise 里，
// 也不在被 try/catch 包住的那一段里，Node 默认会把源码行、栈帧和 "Node.js v…" 横幅一起打出来
// （穷举审计实测：`--workspace <文件> --doctor`、过期封印、缺依赖都命中过）。
// 只在"确实被当成 CLI 入口跑"时安装兜底；被当库 import 时不劫持宿主语义（测试运行器依赖这一点）。
const CLI_ENTRY = /(?:^|[\\/])(?:orchestrate-sdk|codex-entry|poll-windows|status)\.mjs$/i;
export function installFatalGuard({argv = process.argv[1], env = process.env, proc = process} = {}) {
  if (env.ORCH_FATAL_GUARD === '0') return false;
  if (!argv || !CLI_ENTRY.test(argv)) return false;
  proc.on('uncaughtException', (error) => { reportFatal(error); proc.exit ? proc.exit(1) : (proc.exitCode = 1); });
  proc.on('unhandledRejection', (reason) => { reportFatal(reason); proc.exit ? proc.exit(1) : (proc.exitCode = 1); });
  return true;
}

installFatalGuard();
