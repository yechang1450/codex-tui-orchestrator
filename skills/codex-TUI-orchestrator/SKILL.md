---
name: codex-tui-orchestrator
description: Use when codex-TUI-orchestrator receives an authorized multi-part request needing conflict/dependency-based visible Codex TUI execution with independent verification; 只读分析和修改编排器自身留在主对话。
---

# Codex TUI Orchestrator

本插件仅支持 Codex CLI。其它 Agent 由独立的 open-tui-orchestrator 实现适配。专用插件持有固定核心快照，不得链接通用开发目录；启动时按 release.json 检查核心完整性。

## 使用范围与授权

- 只读分析、方案及编排器自身修改在主对话执行。
- 适合拆分的真实任务使用 --run-windows；独立块并发，冲突或依赖任务串行。需要单独可见窗口时使用 --spawn。
- 用户已授权时直接执行，不重复询问是否批准窗口。窗口使用 never；技能不能覆盖宿主工具限制。
- 不用 headless --run/--exec 代替可见 TUI。窗内不得递归编排或另开窗口。
- 默认 ORCH_TUI=wt，使用 Windows Terminal 承载可见 TUI；内部仍使用 PowerShell 启动脚本管理执行生命周期。ORCH_TUI=inactive 仅为显式传统控制台选项，不主动切换用户窗口；它也不能保证完全避免焦点变化，见 docs/inactive-windows.md。

## 目录和容量

从发起对话目录调用 SDK 绝对路径，不切换到安装目录。默认沿用当前工作区；临时文件归入工作区 temp/orchestrator。

规划前检测内存：最大窗口数 = min(8, round(内存 GiB × 1024 ÷ 2000))。整批至多该数量的块；多余任务合并到已有块串行执行，不另排额外批次。全局容量计入活动和预留窗口。

原始任务保持稳定 ID；普通逗号后的补充说明不能丢失。模型只能分类，不得改写任务原文或凭已完成建议跳过任务。覆盖不确定时保留全部任务，并明确报告串行兜底。

每块只等待自身前置验收成功，不等待无关块。未知、自指及循环依赖在启动前报错。冲突锁考虑规范化路径及父子目录关系。

## 执行与独立验收

1. 主控准备唯一 run ID 和验收 JSON，按 T001 等原始任务 ID 定义只读检查。验收应核对内容或行为，不能仅凭文件存在。
2. 调用 node <SDK绝对路径> --run-id <ID> --acceptance-file <JSON绝对路径> --run-windows "<完整请求>"。
3. 窗内逐项执行提供的 started/completed 检查点命令；完成全部实际操作和自查后，最后只输出 __ORCH_DONE__ <本窗token>。
4. 主控运行 node <scripts绝对路径>/poll-windows.mjs --run-id <ID> --require-all-success --timeoutMs <时限>。
5. 全部原始任务 verified 且所属窗口关闭才算成功。结束标记、关窗、agent 自报及其它批次的结果都不能代替验收。
6. 缺检查或结果不符时保留任务并继续核查；不能当作完成。全部授权任务在本轮验证后交付。

产物按 run ID 放在工作区 temp/orchestrator/runs/<ID>。清理只针对本次拥有且已结束的临时文件，不删除活动窗文件或无关文件。

## 中断恢复

从原工作区运行 node <SDK绝对路径> --resume-run <ID>。使用保存的任务、计划和验收条件；按 PID、创建时间及命令行接管存活窗口，不重复启动替代窗。

已验证任务不重复执行。已开始但副作用不明确的任务进入 needs-reconciliation（需要主控核对实际结果的状态），不能盲目重跑。仅事先确定可安全重复的任务才能设置 retrySafe:true。启动器不重放整个块。

使用 --verify-run <ID> --acceptance-file <JSON> 复核已有结果。不保证任意外部操作恰好执行一次。

## 诊断和发布

- --doctor 检查依赖；--plan 仅规划；--status --readonly 检查窗口与锁。
- node <插件绝对路径>/scripts/release-integrity.mjs 校验发布核心。
- 开发改动经回归与相关真实验收后才能发布。修改核心前确认没有活动窗口，不热替换正在运行的版本。
- Codex 使用现有登录的 HTTPS Responses 配置，避免 WebSocket 首次超时回退；HTTPS 仍可能遇到断网。

详见 [执行协议](../../docs/execution-contract.md) 和 [发布规则](../../docs/release-policy.md)。
