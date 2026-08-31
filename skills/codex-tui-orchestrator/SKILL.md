---
name: codex-tui-orchestrator
description: 把多部分请求按并发冲突拆成 linked/independent 块，通过可见自动关闭的 Codex TUI 窗真实并发执行（独立并行、联动串行）；纯只读/分析自动 inline 不弹窗。Use when a request contains several real, executable steps that should run concurrently without conflict; read-only analysis stays inline.
---
# Codex TUI Orchestrator (entry / dispatcher)

引擎在 `scripts/orchestrate-sdk.mjs`；本文件是**入口**：按任务场景分发 + 遵守行为纪律（`conduct`），并把**全部能力**恒启用（无用户可关闭的开关）。

## 何时弹窗 / 何时 inline
- **只读 / 纯分析 / 纯方案 / 纯解答** → 留在主对话内联，**不弹窗**。`--run-windows` 入口已有确定性只读门禁（命中只读词且无真实动作词→直接 inline、exit 0）。
- **真实执行**（写/改/建/装/测/重启/删/起停/配置/还原/解耦等） → 必须 `--run-windows` 弹可见 TUI 窗。**禁止**用 headless `--run/--exec` 做真实改动（`ORCH_ALLOW_HEADLESS=1` 仅是纯自动化逃生门）。

## 行为纪律（conduct，必守，优先级高于本文件其它描述）
1. **一轮全量交付**：每轮把全部可执行任务纳入同一个 `--run-windows`，一次性并发/串行拉起，禁止「逐个串行、挑几项、下轮再做」。
2. **保轮询（gather-results）**：`--run-windows` 之后**必须**运行 `node scripts/poll-windows.mjs --require-all-success --timeoutMs <T>`；只有它返回 0 才能结束本轮（全部块 status ∈ 成功集）。非 0=仍有未成功→继续等/重试/如实上报，绝不提前收尾。
3. **每窗自查 + 真实汇报**：每窗结束前必须完成读回/回归/无乱码自验，汇报以「【本块唯一标识】…完成」开头；自验不过=该窗未完成，禁止虚报。
4. **不得先问是否执行**：凡真实执行且用户已授权（出现「继续/全面推进/允许执行/同意」等），直接 `--run-windows`，严禁「要不要我弹窗/需要授权吗」类二次确认。能并发干的分组，用户说「继续/继续全面推进」后应一次性并发干。
5. **被动调用**：未显式 `@codex-tui-orchestrator` 的**真实执行**，也必须主动检测并路由到 `--run-windows`；只有只读/纯方案/纯解答留在主对话。
6. **父进程复核**：全部窗关闭后，父进程用 `--verify` 或读回目标文件独立核验真实落盘，不信窗内自报；不一致→以盘面为准并纠正。
7. **执行彻底**：凡 `--run-windows` 已拉起或能并入本轮的全部可执行任务，必须本轮做完、验证完、收尾完，禁止「这条下轮做/先做几项剩下再说」。
8. 留痕：经本 skill 完成的真实执行后，须调用 codex 侧 auto-memory（每轮）+ auto-git（git add -A 全 workspace）。

## 子skill = 能力（全部恒启用，无开关）
每个能力对应一个子skill，**全部恒启用**（agent 必然读取并置 I/O ON），**没有用户可关闭的开关**——避免用户误关导致编排效果打折。入口按此固定组装。

| 子skill | 职责 |
|---|---|
| `decompose-classify` | 请求→linked/independent 块 + 只读→inline 门禁 |
| `conflict-lock` | 活窗资源冲突→等待/上锁/重跑 |
| `dependency-order` | dependsOn 前置顺序/串行 |
| `prototype-gate` | 确定性可行性（L1/L2） |
| `prototype-llm` | LLM 可行性（L3，确保无白窗浪费；effort 由 `ORCH_PROTOTYPE_EFFORT`，默认 high）|
| `registry` | 跨进程 windows/locks + 互斥 |
| `window-runtime` | launcher/spawn/watchdog/close + 汇报捕获（`ORCH_TUI=wt/conhost`，`ORCH_CLOSE_DELAY_MS`）|
| `gather-results` | poll-windows 保疆询@约（常开契约）|
| `enforcement` | 执行门禁（armed/assert/kind fail-closed/headless 硬关） |
| `decompose-cache` | 拆块缓存 + `--clear-cache` |
| `hygiene` | 用完即弃清临时（`ORCH_KEEP_TEMP` 排查用） |
| `verify` | `--verify` 冲突键归因（只读诊断） |

> 全模型 effort 默认 `high`（`ORCH_EFFORT`、`ORCH_PROTOTYPE_EFFORT`）；以上为可调 I/O 参数，非能力开关。

## 引擎调用（从 `scripts/` 运行）
- `node orchestrate-sdk.mjs --run-windows "<request>"` → 批量真实执行（独立并行/联动串行，自动关窗，结果进 `temp/win-summary.json`）。
- `node orchestrate-sdk.mjs --spawn "<title>" "<prompt|.md>"` → 弹一个手动交互窗。
- `node orchestrate-sdk.mjs --plan "<request>"` → 只拆块打印（只读）。
- `node orchestrate-sdk.mjs --status [--readonly]` → 活窗/锁。
- `node orchestrate-sdk.mjs --clear-cache` → 清拆块缓存。
- `node scripts/codex-tui-orchestrator-force.mjs --status|--assert <kind>|--enable|--disable|--verify <file>` → 执行门禁与归因。
- `node scripts/codex-tui-orchestrator-preflight.mjs <kind>` → 未 armed 时按 kind fail-closed 的独立门禁。

## 依赖
- Node 22+、Codex CLI、Windows Terminal/console。
- 编码：所有文本读写显式 UTF-8（`.ps1` 带 BOM），禁 GBK 乱码。
- 执行后 auto-memory / memory-boost / auto-git 留痕。
