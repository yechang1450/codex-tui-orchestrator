import {verifyRelease} from './release-integrity.mjs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {configureEntryArgs} from './entry-options.mjs';
import {exitFatal} from './core/fatal.mjs';
// WSL（Windows Subsystem for Linux，Windows 上的 Linux 子系统）或其它非 Windows shell 启动
// node.exe 时不会带上 PATHEXT（Windows 的命令扩展名列表），PowerShell 会因此解析不了 chcp.com
// 这类无扩展名命令，窗口启动器会在首行就失败（WSL 下实测：INACTIVE_WINDOW_LAUNCH_FAILED）。
// 在入口补齐默认值，后续 wt.exe / powershell.exe / 窗口启动器都会继承它。
if (process.platform === 'win32' && !process.env.PATHEXT) {
  process.env.PATHEXT = '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC;.CPL';
}
// 这一段在模块求值期跑，没有上层 catch 可兜：任何抛出都会被 ESM 载入器连栈帧打到
// stderr。统一转成公开入口的一行 FATAL 契约（回归：test/public-fatal-contract.test.mjs）。
try {
  // 发行封印校验也在模块求值期：封印过期（改完源码还没 --seal）是最常见的失败之一，
  // 实测此前会把 release-integrity.mjs 的源码行、Node 帧和 "Node.js v…" 横幅全打给用户。
  verifyRelease();
  const publicEntry=fileURLToPath(new URL('./orchestrate-sdk.mjs',import.meta.url));
  if(process.argv[1]&&path.resolve(process.argv[1]).toLowerCase()===publicEntry.toLowerCase()){
    process.argv=[...process.argv.slice(0,2),...configureEntryArgs(process.argv.slice(2))];
  }
  if(process.env.ORCH_AGENT&&process.env.ORCH_AGENT!=='codex')throw new Error('Codex-specific adapter requires Codex');
} catch (error) {
  exitFatal(error);
}
process.env.ORCH_AGENT='codex';
