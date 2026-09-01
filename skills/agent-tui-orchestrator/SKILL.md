---
name: agent-tui-orchestrator
description: 把多部分请求按并发冲突拆成 linked/independent 块，通过可见自动关闭的 Codex TUI 窗真实并发执行（独立并行、联动串行）；纯只读/分析自动 inline 不弹窗。Use when a request contains several real, executable steps that should run concurrently without conflict; read-only analysis stays inline.
---
# Agent TUI Orchestrator（多合一 · 单 skill 承载全部能力）

引擎在 `scripts/orchestrate-sdk.mjs`；本 skill 是**唯一入口**，把全部编排能力（拆块分类 / 冲突锁 / 依赖排序 / 原型门禁 / 注册表 / 窗口运行时 / 结果汇聚 / 执行门禁 / 拆块缓存 / 清洁 / 归因验证）**内嵌为一套**，全部恒启用、无用户可关闭的开关。

## 何时弹窗 / 何时 inline
- **只读 / 纯分析 / 纯方案 / 纯解答** → 留在主对话内联，**不弹窗**。`--run-windows` 入口已有确定性只读门禁（命中只读词且无真实动作词→直接 inline、exit 0）。
- **真实执行**（写/改/建/装/测/重启/删/起停/配置/还原/解耦等） → 必须 `--run-windows` 弹可见 TUI 窗。**禁止**用 headless `--run/--exec` 做真实改动（`ORCH_ALLOW_HEADLESS=1` 仅是纯自动化逃生门）。

## 行为纪律（conduct，必守，优先级最高）
1. **一轮全量交付**：每轮把全部可执行任务纳入同一个 `--run-windows`，一次性并发/串行拉起，禁止「逐个串行、挑几项、下轮再做」。
2. **保轮询**：`--run-windows` 之后**必须**运行 `node scripts/poll-windows.mjs --require-all-success --timeoutMs <T>`；只有它返回 0 才能结束本轮（全部块 status ∈ 成功集）。非 0=仍有未成功→继续等/重试/如实上报，绝不提前收尾。
3. **每窗自查 + 真实汇报**：每窗结束前必须完成读回/回归/无乱码自验，汇报以「【本块唯一标识】…完成」开头；自验不过=该窗未完成，禁止虚报。
4. **不得先问是否执行**：凡真实执行且用户已授权（出现「继续/全面推进/允许执行/同意」等），直接 `--run-windows`，严禁「要不要我弹窗/需要授权吗」类二次确认。
5. **被动调用**：未显式 @agent-tui-orchestrator 的**真实执行**，也必须主动检测并路由到 `--run-windows`；只有只读/纯方案/纯解答留在主对话。
6. **父进程复核**：全部窗关闭后，父进程用 `--verify` 或读回目标文件独立核验真实落盘，不信窗内自报；不一致→以盘面为准并纠正。
7. **执行彻底**：凡 `--run-windows` 已拉起或能并入本轮的全部可执行任务，必须本轮做完、验证完、收尾完。
8. **留痕**：真实执行后须调用 codex 侧 auto-memory（每轮）+ auto-git（git add -A 全 workspace）。

## 内嵌能力（12 项，全部恒启用、无开关）
| 能力 | 职责 |
|---|---|
| 拆块分类 | 请求→linked/independent 块 + 只读→inline 门禁 |
| 冲突锁 | 活窗资源冲突→等待/上锁/重跑 |
| 依赖排序 | dependsOn 前置顺序/串行 |
| 原型门禁-确定性 | L1/L2 可行性，简单块不调 LLM |
| 原型门禁-LLM | L3 可行性（确保无白窗浪费；effort `ORCH_PROTOTYPE_EFFORT` 默认 high）|
| 注册表 | 跨进程 windows/locks + 互斥 |
| 窗口运行时 | launcher/spawn/watchdog/close + 汇报捕获（`ORCH_TUI=wt/conhost`、`ORCH_CLOSE_DELAY_MS`）|
| 结果汇聚 | poll-windows 保轮询契约（常开）|
| 执行门禁 | armed/assert/kind fail-closed + headless 硬关 |
| 拆块缓存 | 相同请求缓存 + `--clear-cache` |
| 清洁 | 用完即弃清临时（`ORCH_KEEP_TEMP` 排查用）|
| 归因验证 | `--verify` 冲突键归因（只读诊断）|

## 能力细节（内嵌实现约定）
### 拆块分类
- 两段式：**LLM 先定性**（扁平任务清单 `{tasks:[{id,summary,kind,project,conflict_hints,depends_on,feasible,already_done}]}`，字段少、禁工具、纯 JSON）→ **确定性分块引擎**（代码按 project 分组、工具独立、模块→项目 hint 归位、依赖映射、可行性过滤）。
- 模块→项目 hint 经 `ORCH_TASK_HINTS`（JSON 映射，如 `{"会员管理":"82"}`）传入，把「没写项目号但属于某项目」的任务归位。
- 入口只读门禁：明显两端走确定性快判，歧义交 LLM；fail-safe 判真实执行。
- **autosafe 检测**：拆成单一/串行块时，不弹窗，返回 `{"mode":"inline",...}` 由发起对话就地串行执行。
- 触发：任一 `--run-windows` 请求。

### 冲突锁
- 与**正在运行的窗**比对 conflictKeys；重叠→等待其关闭；仍冲突→上锁（`locked` 终态，不误窗）；冲突释放→自动重跑。
- 触发：`--run-windows` 每次 spawn 前，以及同批窗口之间。
- 依赖：注册表（读 windows/locks）。

### 依赖排序
- 解析 `dependsOn` 依赖→按层排队（wave）；linked 整块串行；independent 且无前置→同层并行。
- 触发：decompose 之后、spawn 之前。
- 边界：只处理**逻辑先后**（前置/产出依赖），**不等于**资源冲突（那是冲突锁）。

### 原型门禁-确定性
- 每个块 spawn 前做**确定性**可行性判断：L1 空/无动作→拒绝；L2 复杂度分类（多句/含分析/长指令→复杂）。
- 触发：每块 spawn 前。
- 与 LLM 原型门禁：本能力是**不花 LLM 的判断**；复杂块才交给 LLM 原型门禁。

### 原型门禁-LLM
- 确定性判「复杂」的块，再请 LLM（只读）判「该任务是否可行、不矛盾」，只回「可行/不可行」。
- 触发：复杂块（恒启用）。
- 目的：**确保无白窗浪费**——复杂块先判可行性，避免开出空白/注定失败的窗。
- LLM 报错/超时→ fail-safe PASS（不误拦，宁可多测也不白开窗）。

### 注册表
- 共享 `temp/orchestrator-windows.json` / `orchestrator-locks.json`；`withRegistryLock`（独占锁文件）串行写；`updateWindows/updateLocks` 锁内 load+mutate+save，只追加不整表覆盖。
- 触发：所有读活窗/锁、写新窗口/锁、done-and-close 清理、`--status`。

### 窗口运行时
- 写 `win-launch-*.ps1`（UTF-8+BOM、chcp 65001）→ spawn 可见 TUI → watchdog 在「最终完成标记」后杀 codex 子进程→launcher `exit 0`→窗自动关；同时从 rollout 捕获最终汇报写入 `win-summary.json`。
- **弹窗检测 + 重试**：spawn 后轮询 pid 文件确认窗口真弹出；失败重试（上限 3），仍失败标记 `popup-failed` 并汇报，不把没弹出来的窗当运行中。
- **汇报驱动关窗**：watchdog 等 task_complete 稳定 ~6s（给父进程足够时间捕获汇报）才杀 codex 子进程，确保汇报不因关窗丢失；关闭与汇报互为检测点。
- 触发：`--run-windows` / `--spawn`。
- **窗口 prompt 规则**：必须要求「一次性完成全部改动→读回+node --check+无乱码→才输出以【本块唯一标识】…完成 开头的最终汇报」，**禁止中途输出未完状态**（否则 auto-close 会误关）。

### 结果汇聚
- `--run-windows` 之后，主对话必须运行 `node scripts/poll-windows.mjs --require-all-success --timeoutMs <T>`，仅当全部块成功集（done/ok/completed/done-retried）+被正确拦截（preflight-failed/locked/unlocked）时返回 0；非 0=仍有未成功→继续等/重试/如实上报。
- 触发：每次 `--run-windows` 之后。

### 执行门禁
- `armEnforcement()` 写 `.orchestrator-enabled`；`--assert <kind>` 只在**被授权的窗口**（CODEX_ORCH_WINDOW=1）里放行；headless `--run/--exec` 需 `ORCH_ALLOW_HEADLESS=1`；`agent-tui-orchestrator-preflight.mjs` 未 armed 时按 kind fail-closed（真实 kinds REFUSED+exit1，只读放行）。
- 触发：每次真实执行发起前。

### 拆块缓存
- 相同请求按 hash 缓存 block plan；命中即复用（越用越快，永不自动失效）。
- 清理：`node orchestrate-sdk.mjs --clear-cache` 或删除缓存文件。

### 清洁
- 清理 `temp/` 下 `codex-win-*`/`win-launch-*`/`win-*.result.json`/`win-*.log`/`window-*.pid` 等一次性产物（`win-summary.json` 默认保留给 poll）。
- 触发：`--run-windows` / `--spawn` 结束后。

### 归因验证
- 判断某个改动文件是否可归因到**窗内受权写入**：剥离 `file:/dir:/port:/service:` 前缀后做路径感知匹配。
- 触发：`agent-tui-orchestrator-force.mjs --verify <file>`。

## 引擎调用（从 `scripts/` 运行）
- `node orchestrate-sdk.mjs --run-windows "<request>"` → 批量真实执行（独立并行/联动串行，自动关窗，结果进 `temp/win-summary.json`）。
- `node orchestrate-sdk.mjs --spawn "<title>" "<prompt|.md>"` → 弹一个手动交互窗。
- `node orchestrate-sdk.mjs --plan "<request>"` → 只拆块打印（只读）。
- `node orchestrate-sdk.mjs --status [--readonly]` → 活窗/锁。
- `node orchestrate-sdk.mjs --clear-cache` → 清拆块缓存。
- `node scripts/agent-tui-orchestrator-force.mjs --status|--assert <kind>|--enable|--disable|--verify <file>` → 执行门禁与归因。
- `node scripts/agent-tui-orchestrator-preflight.mjs <kind>` → 未 armed 时按 kind fail-closed 的独立门禁。

## 依赖
- Node 22+、Codex CLI、Windows Terminal/console。
- 编码：所有文本读写显式 UTF-8（`.ps1` 带 BOM），禁 GBK 乱码。
- 执行后 auto-memory / memory-boost / auto-git 留痕。
