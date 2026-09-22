// 公开入口的失败契约（唯一定义处）：stderr 只回一行 `[orchestrator] FATAL: <原因>`，
// 零 Node 栈帧、零 ESM 载入器前言，stdout 保持空。内核入口、公开包装层与轮询/状态/
// 监督入口都从这里出口，避免各处自写 `console.error(e.stack)` 把栈帧和
// "Node.js v…" 横幅泄漏给用户（回归：test/public-fatal-contract.test.mjs）。
import fs from 'node:fs';

export function fatalMessage(error) {
  const raw = error && typeof error === 'object' && error.message ? error.message : error;
  const text = String(raw ?? '').trim();
  return '[orchestrator] FATAL: ' + (text || 'unknown failure');
}

export function reportFatal(error) {
  // 同步写 fd 2：console.error 接到管道时是异步的，随后立刻退出会把它截断。
  try { fs.writeSync(2, fatalMessage(error) + '\n'); } catch { /* stderr is gone; the exit code still fails closed */ }
  process.exitCode = 1;
}

// 模块求值期失败（选项解析、镜像校验、宿主适配）没有上层 catch 可兜：ESM 载入器会把
// 原始异常连栈帧一起打到 stderr，因此同步写完这一行后立刻以 1 退出。
export function exitFatal(error) {
  reportFatal(error);
  process.exit(1);
}
