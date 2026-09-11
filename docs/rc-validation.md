# 0.5.0-rc.1 验收记录

候选核心为 `1.4.0-rc.1`，运行协议保持 2。专用仓库仅维护 Codex；通用适配器在独立的 open-tui-orchestrator 中演进。

## 实现与根因

- 默认 `--exec` / `--headless` 不弹窗；`--run` 和裸请求默认采用 headless，可由 `ORCH_EXEC_MODE` 覆盖；`--run-windows` / `--visible` 明确选择可见 TUI。
- 两种模式统一进入 runner。旧 headless 分支绕过任务账本和独立验收的问题已消除；独立 supervisor 保留单任务恢复用途。
- 隐藏 worker（独立持有执行进程及日志的进程）在容量和注册准入完成后才执行。主控退出后，worker 继续保存输出；恢复接管原 PID，不重复已验证任务。
- 主控同步协调可能让就绪等待超过计时器；以前会遗漏已写好的 PID，误报启动失败。现在先复查持久 PID，再判断超时，并为批量启动保留有限的就绪时间。
- 批量退出不再逐块重复完整 CIM（Windows 进程信息查询）扫描；先用轻量 PID 存活检查证明进程已退出。无法证明退出时仍保留租约。
- 普通失败与 provider 容量失败分别计数，容量重试不会解除普通失败预算。日志写入异常会先收尾自有子进程，再保存失败结果。
- Codex 默认协调器改用独立的 HKCU `Software/CodexTuiOrchestrator` 与 `temp/orchestrator/codex-coordinator` 命名空间；恢复先校验账本/镜像，再沿用账本中的旧协调器。这样旧通用 open-tui-orchestrator 的容量和身份清理不会改写 Codex 租约。
- TodoList（原始任务状态）只在该任务写入 started 后进入 running；completed 后等待独立验收。Execution（执行块状态，也称 spawn 状态）独立记录块模式、PID、尝试、等待及重试原因。
- 原子 summary、递增事件序号和 goal 镜像保持一致；恢复重建落后的派生镜像，重新验收也发布双状态。读者忽略不完整的事件尾行，完整损坏行会报错。
- Git 检出回归从两个核心文件扩展到全部 48 个 runtime 文件，并统一文本换行，避免检出后封存校验失效。

## 已完成的本轮验证

| 检查 | 结果 |
| --- | --- |
| 源仓完整回归 | 213 项通过、1 项真实环境跳过（专项测试加入后） |
| 最终全新发布包完整回归 | 213 项通过、1 项真实环境跳过 |
| 文档、模式、事件流与完整 Git 检出追加校验 | 9/9，通过 |
| 锁文件依赖安装 | npm ci --omit=optional --ignore-scripts，通过 |
| 发行封存 | schema 2，24 个核心文件、48 个 runtime 文件 |
| 发布包与源码 | runtime 哈希及 release.json 一致 |
| 已启用缓存 | 已修复封存不一致；与源码逐项匹配，doctor 通过 |
| 真实 headless 单任务 | 回执有效、独立验收成功、进程已退出 |
| 已安装缓存的真实可见单任务 | 回执有效、窗口自动关闭 |
| 已安装缓存的 12 块 / 13 任务 headless | 容量 12、峰值 11、19 次尝试；provider 429 导致 4 项无有效回执，严格未通过 |
| exec/TUI 状态专项验收 | 离线 5/5，通过；真实 headless + 可见 TUI 2/2，通过；覆盖 model/effort、TodoList、spawn 群及宿主边界 |

机器可读证据已写入 `test/exec-headless-validation-1.4.0-rc.1.json`。主控崩溃接管、未完成副作用不重放、启动准入失败、日志故障、输出截断、非零退出和任务逐项状态均有进程级回归。

诊断过程中曾出现就绪误判、探针位置参数遗漏，以及修订探针时的重复导入错误。相关失败未记为通过；生成的探针现在先经 Node 语法检查，再调用模型执行。容量数、启动块数和实测峰值分别记录，任何一个都不能代替有效任务回执。

## 复现

从发起工作区调用插件脚本的绝对路径；以下相对路径示例从源码根目录运行。

```powershell
node --test --test-concurrency=1 test/*.test.mjs
node scripts/release-integrity.mjs
node scripts/orchestrate-sdk.mjs --doctor
node scripts/orchestrate-sdk.mjs --status --readonly
$env:ORCH_LIVE_MODE = 'headless'
node test/live-codex.mjs
$env:ORCH_LIVE_MODE = 'visible'
node test/live-execution-mode.mjs
```

真实验收使用现有账户额度，按顺序运行。`ORCH_LIVE_ENTRY` 可指定已安装缓存的公共入口。观察运行使用 `node scripts/status.mjs --run-id <ID> --watch`，添加 `--json` 可消费结构化状态；观察器只读，退出不终止执行。

## 发布边界与历史证据

终端双面板和 JSON 状态接口已实现。Codex 原生 TodoList/spawn 卡片仍需宿主消费接口，插件不能仅靠技能注入原生卡片。不宣称跨用户安装、实际插件管理器升级回滚、重启或长期网络中断已通过。本轮临时包清理被自动审批拒绝的项目会单独记录。

1.3.4 的 [包验证](../test/package-validation-1.3.4-rc.1-historical.json)、[可见并发阻塞](../test/concurrency-validation-1.3.4-rc.1.json) 和 [控制器接管](../test/controller-adoption-validation-1.3.4-rc.1.json) 保留为历史证据，不认证当前核心。
