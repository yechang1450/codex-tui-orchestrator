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
3. **每窗自查 + 只出识别码**：每窗结束前必须完成读回/回归/无乱码自验，最后**只输出一行结束标记 `__ORCH_DONE__ <本窗token>`**；执行结束即 `done`（不等同于成功），是否达成 prompt 预期由主控关窗后核对真实落盘状态。
4. **不得先问是否执行**：凡真实执行且用户已授权（出现「继续/全面推进/允许执行/同意」等），直接 `--run-windows`，严禁「要不要我弹窗/需要授权吗」类二次确认。
5. **被动调用**：未显式 @agent-tui-orchestrator 的**真实执行**，也必须主动检测并路由到 `--run-windows`；只有只读/纯方案/纯解答留在主对话。
6. **父进程复核**：全部窗关闭后，父进程用 `--verify` 或读回目标文件独立核验真实落盘，不信窗内自报；不一致→以盘面为准并纠正。
7. **执行彻底**：凡 `--run-windows` 已拉起或能并入本轮的全部可执行任务，必须本轮做完、验证完、收尾完。
8. **留痕**：真实执行后须调用 codex 侧 auto-memory（每轮）+ auto-git（git add -A 全 workspace）。
9. **orchestrator 自身改动永远优先于并独立于所有 TUI 窗**：凡属改 `orchestrate-sdk.mjs` / agent-tui-orchestrator 自身的请求，**必须先在本发起对话中 inline 就地改完并验证**，再据此发起并发 TUI 窗；`--run-windows` 遇到此类请求会**强制返回 inline、不弹窗**（TUI 窗依赖 SDK，改 SDK 的窗其自身的 watchdog/关窗也依赖被改的 SDK，会出现「改它的窗自己关不掉」）。
10. **TUI 窗 = codex CLI，默认 `deepseek-v4-flash` / `max`**：orchestrator 弹出的窗走 codex CLI，默认模型 `deepseek-v4-flash`、推理力度 `max`（`ORCH_MODEL`/`ORCH_EFFORT` 可覆盖）；只有 codex GUI 主机才用 config.toml 的 `deepseek-v4-flash-vision-exp` / `high`，二者勿混淆。

## 内嵌能力（11 项，全部恒启用、无开关）
| 能力 | 职责 |
|---|---|
| 拆块分类 | 请求→linked/independent 块 + 只读→inline 门禁 |
| 冲突锁 | 活窗资源冲突→等待/上锁/重跑；弹窗前**原子占位**（跨进程同键防「检查-弹窗」间隙竞态） |
| 依赖排序 | dependsOn 前置顺序/串行 |
| 原型门禁 | L1 空判 + L2 复杂度识别（确定性，不单开 LLM）；可行性已由拆块 LLM 判定 |
| 注册表 | 跨进程 windows/locks + 互斥；`pending` 占位窗（pid=0，超 120s 自动作废）也参与冲突判定 |
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
- 弹窗前在独占锁内先写 `pending` 占位（pid=0、保留 pidFile），弹出成功再提交真实 pid；`pending` 新鲜占位对其它编排进程视为已占用，杜绝两个进程同时通过检查后弹同键窗。
- 触发：`--run-windows` 每次 spawn 前，以及同批窗口之间。
- 依赖：注册表（读 windows/locks）。

### 依赖排序
- 解析 `dependsOn` 依赖→按层排队（wave）；linked 整块串行；independent 且无前置→同层并行。
- 触发：decompose 之后、spawn 之前。
- 边界：只处理**逻辑先后**（前置/产出依赖），**不等于**资源冲突（那是冲突锁）。

### 原型门禁（确定性）
- 每个块 spawn 前做**确定性**门禁：L1 空/无动作→拒绝；L2 复杂度识别（多句/含分析/长指令→复杂，仅作状态提示）。
- 该门禁**恒启用、无开关**，核心目的就是**确保无白窗**：绝不弹出一个“空壳/无动作/已达成”的占位窗，宁可拦下（preflight-failed）也不虚跑。
- 触发：每块 spawn 前。
- 可行性（是否可行/已达成）已由**拆块 LLM**在分块阶段判定（`feasible`/`already_done`，不可行或已完成任务会被过滤）；执行前不再为每块单开一次 LLM（避免重复往返、成本友好）。

### 注册表
- 共享 `~/.codex/orchestrator/orchestrator-windows.json` / `orchestrator-locks.json`（`ORCH_STATE_DIR` 可覆盖）；`withRegistryLock`（独占锁文件）串行写；`updateWindows/updateLocks` 锁内 load+mutate+save，只追加不整表覆盖；超过 120s 的 `pending` 死占位自动回收。
- 触发：所有读活窗/锁、写新窗口/锁、done-and-close 清理、`--status`。

### 窗口运行时
- 写 `win-launch-*.ps1`（UTF-8+BOM、chcp 65001）→ spawn **交互式 Codex TUI 窗** → 窗口 agent **只输出一行结束标记 `__ORCH_DONE__ <本窗token>`**（不做长篇汇报）；launcher 内置 watchdog **只认该结束符**（且必须是 agent/assistant 消息，绝不匹配被注入的提示词行）即写 `.self-closed` 强标记并杀 codex 树 → `exit 0` 自动关窗；未输出结束符时回退到"最后一条含本窗 token 的 assistant 消息"。watchdog 观察上限默认=父进程轮询上限+10 分钟（`ORCH_WATCHDOG_MAX_MIN` 可覆盖），长任务/父进程意外退出后仍能「执行结束即自关」。`Write-Result` 用 `Get-LastReport` 尽力落本窗最后输出到 `win-<s>.result.json`（有则记，无则标记需外部核对落盘）。
- **弹窗检测（精准）**：spawn 后以「pid 文件存在 + launcher(Windows Terminal pane 宿主)进程存活」双重确认窗口真弹出；**同批多个窗并行弹窗 + 并行确认**（不逐窗串行等待），失败重试（上限 3），仍失败标记 `popup-failed` 并汇报。
- **完成判定（用户方案：done=做完了，不等同于成功）**：窗口执行结束（识别码 `.self-closed` / result 文件 / codex 退出）即 `done`；是否真的达成 prompt 预期，由主控关窗后去核对真实落盘状态，而非依赖窗内汇报文本。真正的失败由 `popup-failed`/`preflight-failed` 承担。
- 触发：`--run-windows` / `--spawn`。
- **窗口 prompt 规则**：必须要求「一次性完成全部改动→读回+node --check+无乱码→才输出唯一一行 `__ORCH_DONE__ <本窗token>`；无需长篇汇报，仅在确实失败时补一句说明」，**禁止中途输出未完状态**（否则 auto-close 会误关）。

### 结果汇聚
- `--run-windows` 之后，主对话必须运行 `node scripts/poll-windows.mjs --require-all-success --timeoutMs <T>`，仅当全部块成功集（done/ok/completed/done-retried/done-on-disk）+被正确拦截（preflight-failed/locked/unlocked）时返回 0；非 0=仍有未成功→继续等/重试/如实上报（全窗已关且 summary 已终态但含失败 → 立即返回 1，不空等到超时）。
- 触发：每次 `--run-windows` 之后。

### 执行门禁
- `armEnforcement()` 写 `.orchestrator-enabled`；`--assert <kind>` 只在**被授权的窗口**（`ORCH_WINDOW=1`）里放行；headless `--run/--exec` 需 `ORCH_ALLOW_HEADLESS=1`；`agent-tui-orchestrator-preflight.mjs` 未 armed 时按 kind fail-closed（真实 kinds REFUSED+exit1，只读放行）。
- 触发：每次真实执行发起前。

### 拆块缓存
- 相同请求按 hash 缓存 block plan；命中即复用（越用越快，永不自动失效）。
- 清理：`node orchestrate-sdk.mjs --clear-cache` 或删除缓存文件。

### 清洁
- 清理 `temp/` 下 `codex-win-*`/`win-launch-*`/`win-*.result.json`/`win-*.log`/`window-*.pid` 及 `.self-closed` 标记等一次性产物（`win-summary.json` 默认保留给 poll）；清理按 pid 文件存活态保护活窗，绝不误删正在运行的窗口。
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

## 通用化 / 跨设备 / 跨 agent / 跨用户适配

本 orchestrator 对所有路径与宿主做了**通用化设计**：只要外部（宿主/用户/调用方）在进程环境注入可配置项，就能在**不同 Windows 设备、不同用户名、不同 agent** 上运行，而无需改本插件源码：

### 可配置环境变量（env-first，均有合理缺省）
- `CODEX_HOME`：权威 Codex 家目录（缺省 `~/.codex`）。跨用户/设备最关键：非默认安装、Docker、托管 CI 等通过它指向真实家目录。
- `ORCH_STATE_DIR`：本插件的稳定运行/状态目录（registry、锁、子代理共享文件），缺省 `$CODEX_HOME/orchestrator`。**不能**放在会被插件升级/重装清掉的目录。
- `ORCH_SESSION_DIR`：会话 rollout 目录，缺省 `$CODEX_HOME/sessions`。
- `ORCH_SUPERPOWERS_CACHE_DIR`：覆盖 superpowers 插件缓存路径（不同宿主/市场安装位置），缺省自动探测 `$CODEX_HOME/plugins/cache/.../superpowers`。
- `ORCH_AGENT`：选 agent：`codex|claude|gemini|opencode|aichat`。缺省 `codex`；若请求的 agent CLI 未安装，自动回退 `codex`，不报错。
- `CODEX_EXE` / `ORCH_MODEL` / `ORCH_EFFORT`：覆盖 CLI 路径与模型/努力度（跨宿主可注入不同模型）。

### 兼容点
- **不同 Windows 设备/用户名**：所有 `.codex` 路径经 `CODEX_HOME` 推导（不再硬编码 `C:\Users\<user>\.codex`）；agent 缓存文件、临时产物落在稳定家目录（`ORCH_STATE_DIR`/`$CODEX_HOME/orchestrator`），绝不在会被插件升级/重装清掉的插件脚本目录。
- **不同 agent**：`agent.mjs` 内置 codex/claude/gemini/opencode/aichat 描述表，探测对应 CLI，`ORCH_AGENT` 选择；launcher/Watchdog 按各 agent 通用结束标记 `__ORCH_DONE__ <token>` 收尾（对 codex 用 `@openai/codex-sdk`，其余按 CLI 启动参数）。
- **不同用户**：只读能力探测（superpowers/config/CLI）失败一律降级而不报错；读取 config 失败回退；无权限写 hosts 等场景输出可复制的提权指令，不硬写。
- **跨平台窗口**：优先 Windows Terminal（`wt.exe`），不可用则回退 `conhost`（`cmd /c start`）。

> 一句话：**宿主只需注入 `CODEX_HOME`（及可选 `ORCH_STATE_DIR`/`ORCH_SESSION_DIR`/`ORCH_AGENT`），即可让同一份 orchestrator 适配任意用户的 Windows 设备与任意主流 agent**，无需改代码。
