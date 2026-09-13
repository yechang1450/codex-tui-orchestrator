# 0.5.0-rc.1 验收记录

候选核心标签为 `1.4.0-rc.1`，运行协议保持 2。专用仓库仅维护 Codex；通用适配器在独立的 open-tui-orchestrator 中演进。

验证证据绑定实际提交和封存哈希，不只绑定版本标签。下文保留此前快照的结果；自那次实测后代码和哈希已经变化，因此这些记录不认证当前代码、当前发布包或当前启用缓存。当前副本已重新执行本轮对应验证；未重新执行的项目仍保持未通过或未验证。

## 当前公开前清单

- [x] 窗口/焦点层探针区分系统默认终端转交与真正的传统控制台；显式 conhost 路径和 Windows Terminal 路径均完成真实启动、回执读回及关闭检查。端到端插件自检另列，不能由此项代替。见 [当前焦点证据](../test/inactive-window-validation-current.json)。
- [x] 修正同步焦点探针的启动采样盲区、工作目录漏验和输入就绪检查；历史连续输入通过记录不再认证启动期间输入。
- [ ] 连续输入：本轮真实探针未取得发起窗口的前台焦点，已在启动前停止且未发送按键（`inputAttempts=0`、`inputDelivered=0`）；不能作为通过。详见 [当前公开前证据](../test/private-readiness-validation.json)。
- [x] 已安装缓存真实 `selftest-close` 与会话归属：修复原始 token 误命中父会话；最新回执确认自检通过（正确回复、自然退出、无强制关闭、无孤儿进程）。
- [ ] 当前快照的容量级真实 Codex 任务全部得到有效回执。本轮 12 容量/13 任务实测峰值 11，19 次启动中多块收到 provider `429 Too Many Requests`、模型刷新超时或 rollout 线程丢失，最终回执不完整；详见 [当前公开前证据](../test/private-readiness-validation.json)。
- [ ] 实际插件管理器升级与回滚、长期断网和系统重启恢复。干净隔离 `CODEX_HOME` 的 marketplace 注册、官方安装、doctor、卸载读回已通过；控制器停止/接管已通过，受控本地 HTTP 故障恢复 9/9 已通过。当前 marketplace 是 local source，CLI 明确不支持 `marketplace upgrade`，因此升级/回滚仍未认证；防火墙注入因当前 Windows 身份非管理员被拒绝，未改变网络状态，provider 长断网与真实系统重启仍未认证。详见 [当前公开前证据](../test/private-readiness-validation.json)。

## 跨重启验收桥接

真实重启会中断当前 Codex 对话，不能靠在线观察器判定结果。`test/reboot-validation.ps1 -Mode prepare` 会在仓库 `temp/` 写入重启前记录，并在当前用户的 `HKCU\Software\Microsoft\Windows\CurrentVersion\RunOnce` 注册一次性收集器；登录后收集器自动读回启动时间、release integrity、doctor 和 marketplace 注册状态，写入同一目录的 `post-reboot.json`，随后移除自身。只有 `bootChanged=true` 且三项命令均为零退出码才算通过；这仍是持久化与启动后健康检查，不替代 provider 长断网或带未完成真实模型任务的重启恢复。

执行方式：先运行 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\test\reboot-validation.ps1 -Mode prepare -Workspace <仓库绝对路径> -Id <唯一ID>`，然后重启并登录；登录后 RunOnce 会自动收集。回到 Codex 后读取 `temp/reboot-validation-<唯一ID>/post-reboot.json`，再决定是否关闭这条门槛。
- [x] 当前代码提交 `4fdcaa3` 已完成一次标准源码安全扫描：7 个高风险源码面、0 个可报告发现；随后仅同步了本记录与证据文件。扫描覆盖为 partial，环境与容量门槛仍需独立实测。扫描 ID 与限制记录在 [当前公开前证据](../test/private-readiness-validation.json)。

仓库保持 Private。静态评分不替代上述运行和安装证据。

## 此前实现与根因记录

- 默认 `--exec` / `--headless` 不弹窗；`--run` 和裸请求默认采用 headless，可由 `ORCH_EXEC_MODE` 覆盖；`--run-windows` / `--visible` 明确选择可见 TUI。
- 两种模式统一进入 runner。旧 headless 分支绕过任务账本和独立验收的问题已消除；独立 supervisor 保留单任务恢复用途。
- 隐藏 worker（独立持有执行进程及日志的进程）在容量和注册准入完成后才执行。主控退出后，worker 继续保存输出；恢复接管原 PID，不重复已验证任务。
- 主控同步协调可能让就绪等待超过计时器；以前会遗漏已写好的 PID，误报启动失败。现在先复查持久 PID，再判断超时，并为批量启动保留有限的就绪时间。
- 批量退出不再逐块重复完整 CIM（Windows 进程信息查询）扫描；先用轻量 PID 存活检查证明进程已退出。无法证明退出时仍保留租约。
- 普通失败与 provider 容量失败分别计数，容量重试不会解除普通失败预算。日志写入异常会先收尾自有子进程，再保存失败结果。
- Codex 默认协调器改用独立的 HKCU `Software/CodexTuiOrchestrator` 与 `temp/orchestrator/codex-coordinator` 命名空间；恢复先校验账本/镜像，再沿用账本中的旧协调器。这样旧通用 open-tui-orchestrator 的容量和身份清理不会改写 Codex 租约。
- TodoList（原始任务状态）只在该任务写入 started 后进入 running；completed 后等待独立验收。Execution（执行块状态，也称 spawn 状态）独立记录块模式、PID、尝试、等待及重试原因。
- 原子 summary、递增事件序号和 goal 镜像保持一致；恢复重建落后的派生镜像，重新验收也发布双状态。读者忽略不完整的事件尾行，完整损坏行会报错。
- 历史 Git 检出回归覆盖当时的 48 个 runtime 文件，并统一文本换行，避免检出后封存校验失效。
- GitHub 全新下载暴露了 Git 索引仍使用大写 `skills/codex-TUI-orchestrator`、封存清单使用小写目录的差异。Windows 本地路径匹配掩盖了该问题；现已通过 Git 重命名统一小写，增加索引精确路径回归。原有从工作区复制后再建 Git 的回归无法覆盖索引与本地目录名不一致。

## 此前快照的历史验证

| 检查 | 结果 |
| --- | --- |
| 当时源码完整回归 | 213 项通过、1 项真实环境跳过（专项测试加入后） |
| 当时全新发布包完整回归 | 213 项通过、1 项真实环境跳过 |
| 历史 GitHub 克隆重装（目录大小写修复后） | 提交 `6c82982`；独立 npm ci、48 个 runtime 文件校验、doctor、只读 status 通过；完整回归 214 项通过、1 项真实模型用例未启用 |
| 文档、模式、事件流与完整 Git 检出追加校验 | 9/9，通过 |
| 锁文件依赖安装 | npm ci --omit=optional --ignore-scripts，通过 |
| 历史发行封存快照 | schema 2，24 个核心文件、48 个 runtime 文件；当前封存为 24/50 |
| 发布包与源码 | runtime 哈希及 release.json 一致 |
| 当时已启用缓存 | 当时修复了封存不一致，逐项匹配及 doctor 通过；不代表当前缓存已同步 |
| 真实 headless 单任务 | 回执有效、独立验收成功、进程已退出 |
| 已安装缓存的真实可见单任务 | 回执有效、窗口自动关闭 |
| 已安装缓存的 12 块 / 13 任务 headless | 容量 12、峰值 11、19 次尝试；provider 429 导致 4 项无有效回执，严格未通过 |
| exec/TUI 状态专项验收 | 离线 5/5，通过；真实 headless + 可见 TUI 2/2，通过；覆盖 model/effort、TodoList、spawn 群及宿主边界 |

历史汇总在 `test/exec-headless-validation-1.4.0-rc.1.json`，生成时间为 2026-09-11。它没有记录本次修改后的封存哈希，不能单独证明当前快照通过。当前 core 1.4.0-rc.1 的历史流程逐项记录在 [当前流程证据](../test/live-process-validation-current.json)：headless、可见 TUI、控制器中断后恢复接管、监督器、低层 `--spawn` 结果捕获、`--verify-run`、受控网络恢复和发行包流程均有实际结果；Legacy 控制台焦点保护、连续输入探针和个人 marketplace 注册及官方安装已通过；升级/回滚仍未验证。这些证据不替代容量级多任务验收。提交 `dea90f4a3d5e482b70e4cc9bea694133ad82615a` 还完成了覆盖 162 个文件的离线安全审计，报告项为 0；审计范围是当前源代码、PowerShell 启动器、清单、CI、文档、测试和已跟踪证据，限制是未进行外部部署或恶意多用户运行。仓库中的进程级回归覆盖主控崩溃接管、未完成副作用不重放、启动准入失败、日志故障、输出截断、非零退出和任务逐项状态。

历史 GitHub 重装检查直接使用远端全新克隆与锁文件依赖安装，没有复制旧 SDK 或运行档案；沿用本机已安装的 Codex CLI。它只验证所记提交的分发与脚本安装，不替代插件管理器注册/重新启用、跨用户安装或真实模型服务验收。验证副本与临时运行记录不纳入 Git。

README 与 README-zh 的安装块会显式检查 `git status --porcelain`，拒绝本地改动，并在 clone、pull、npm ci、完整性检查或 doctor 任一步失败时停止。命令块只管理源码脚本副本；自动加载技能仍要求在宿主支持的流程中注册并启用插件。个人 marketplace 注册、官方安装及 cache hash/doctor 已读回通过；实际升级/回滚、跨用户安装仍需分别验证。

两个 README 的执行示例先准备唯一运行 ID 和只读验收 JSON，再从发起工作区调用绝对入口。缺少任务验收条件时结果为 `awaiting-verification`，不返回任务成功。独立 supervisor 仅判断 Codex 会话完成，不运行这套任务验收。

此前诊断出现过就绪误判、探针位置参数遗漏，以及修订探针时的重复导入错误。相关失败未记为通过；生成的探针应先经 Node 语法检查，再调用模型执行。容量数、启动块数和实测峰值分别记录，任何一个都不能代替有效任务回执。

## 复现

从发起工作区调用插件脚本的绝对路径；以下相对路径示例从源码根目录运行。

```powershell
& {
  $ErrorActionPreference = 'Stop'
  node --test --test-concurrency=1 test/*.test.mjs
  if ($LASTEXITCODE -ne 0) { throw '离线回归失败。' }
  node scripts/release-integrity.mjs
  if ($LASTEXITCODE -ne 0) { throw '完整性检查失败。' }
  node scripts/orchestrate-sdk.mjs --doctor
  if ($LASTEXITCODE -ne 0) { throw '安装诊断失败。' }
  node scripts/orchestrate-sdk.mjs --status --readonly
  if ($LASTEXITCODE -ne 0) { throw '只读状态检查失败。' }
}
```

以下为真实验收入口，会使用已配置模型的额度并可能打开可见窗口；它们不属于离线回归。每项单独运行并读回新结果，不用旧文件代替：

```powershell
$env:ORCH_LIVE_MODE = 'headless'
node test/live-codex.mjs
if ($LASTEXITCODE -ne 0) { throw '真实 headless 验收未通过。' }
```

```powershell
$env:ORCH_LIVE_MODE = 'visible'
node test/live-execution-mode.mjs
if ($LASTEXITCODE -ne 0) { throw '真实可见执行验收未通过。' }
```

真实验收使用现有账户额度，按顺序运行。`ORCH_LIVE_ENTRY` 可指定已安装缓存的公共入口。观察运行使用 `node scripts/status.mjs --run-id <ID> --watch`，添加 `--json` 可消费结构化状态；观察器只读，退出不终止执行。

## 发布边界与历史证据

终端双面板和 JSON 状态接口已实现。Codex 原生 TodoList/spawn 卡片仍需宿主消费接口，插件不能仅靠技能注入原生卡片。不宣称当前代码已完成真实容量验收、跨用户安装、实际插件管理器升级回滚、重启或长期网络中断。旧记录中的缓存同步和清理结果只属于当时快照。

1.3.4 的 [包验证](../test/package-validation-1.3.4-rc.1-historical.json)、[可见并发阻塞](../test/concurrency-validation-1.3.4-rc.1.json) 和 [控制器接管](../test/controller-adoption-validation-1.3.4-rc.1.json) 保留为历史证据，不认证当前核心。
