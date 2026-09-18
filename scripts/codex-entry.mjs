import {verifyRelease} from './release-integrity.mjs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {configureEntryArgs} from './entry-options.mjs';
// WSL（Windows Subsystem for Linux，Windows 上的 Linux 子系统）或其它非 Windows shell 启动
// node.exe 时不会带上 PATHEXT（Windows 的命令扩展名列表），PowerShell 会因此解析不了 chcp.com
// 这类无扩展名命令，窗口启动器会在首行就失败（WSL 下实测：INACTIVE_WINDOW_LAUNCH_FAILED）。
// 在入口补齐默认值，后续 wt.exe / powershell.exe / 窗口启动器都会继承它。
if (process.platform === 'win32' && !process.env.PATHEXT) {
  process.env.PATHEXT = '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC;.CPL';
}
verifyRelease();
const publicEntry=fileURLToPath(new URL('./orchestrate-sdk.mjs',import.meta.url));
if(process.argv[1]&&path.resolve(process.argv[1]).toLowerCase()===publicEntry.toLowerCase()){
  process.argv=[...process.argv.slice(0,2),...configureEntryArgs(process.argv.slice(2))];
}
if(process.env.ORCH_AGENT&&process.env.ORCH_AGENT!=='codex')throw new Error('Codex-specific adapter requires Codex');
process.env.ORCH_AGENT='codex';
