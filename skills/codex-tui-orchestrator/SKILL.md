---
name: codex-tui-orchestrator
description: Decompose a multi-part request into linked vs independent blocks by concurrency-conflict, then run REAL executions via visible, auto-closing Codex windows (independent blocks run in parallel, linked blocks run serialized). Use for write/build/install/test/restart; read-only analysis stays inline without a window.
---

# Codex Orchestrator

When a request contains several real, executable steps (like 1 2 3 4), run this to execute them SAFELY — independent work runs in parallel windows, anything that would break if run simultaneously stays serialized.

## When to use / when not

Use ONLY for **real executions** (write / build / install / test / restart). For **read-only analysis, a pure plan, or a pure answer**, reply inline WITHOUT popping a window.

Real executions go through `--run-windows` (the sanctioned engine, matches AGENTS.md). Do **not** use headless `--run` for real work — it bypasses the visible window and is forbidden.

### 关键规则（硬约束，无例外）

以下为**硬约束**，优先级高于本文件其它描述性内容；发起编排的 Codex 对话必须照此执行，无正当理由不得违反：

1. **一轮全量交付（默认分析全部、一次并发，禁止单点串行/分批）**：每轮对话**默认分析当前全部涉及执行的任务**，把**每一个可执行任务**都纳入**同一个** `--run-windows` 调用，一次性调起 TUI 窗——`independent` 块**并行**弹窗、`linked` 块按 `dependsOn` **串行**弹窗，**禁止遗漏任何可执行任务**；**严禁**“逐个串行做、挑几项、下一步/继续说再补、一个接一个派”这类区分批做法（那只是串行能力，浪费了并行与依赖分析）。发起方必须**一次把全部可执行任务交给 SDK 分析并一次性发起**，让多窗同时跑；只有只读分析/纯解答才不弹窗。
2. **发起方必须等到全部任务执行完毕、结果齐全才停止思考**：调用 `--run-windows` 后，发起执行的 Codex 对话**必须持续轮询该子进程**，直到**全部 TUI 窗都已执行完毕并自动关闭、且 `temp\win-summary.json` 已包含全部窗口的结果**为止，在此之前**不得结束本轮**；一旦全部窗关闭且结果齐全，才可结束本轮并汇总返回。**严禁**只等“第一个窗弹出/部分完成”就提前结束。**实现为脚本**：发起方可在 `--run-windows` 之后运行 `node scripts/poll-windows.mjs --timeoutMs 1800000`，该脚本会在“全部窗执行完并自动关闭 + win-summary.json 结果齐全”前一致轮询、打印心跳，脚本以退出码 0 收尾才表示“全部完成”，否则持续打印直到超时；**即使发起方改用该脚本，也必须以脚本返回 0 为准再结束本轮**，不得提前结束。
3. **窗生命周期**：执行中每窗**上锁禁止关闭**，并检测 `dependsOn` 依赖；窗结束 **6 秒**后自动关闭（`ORCH_CLOSE_DELAY_MS=6000`，由调用时环境变量指定，保持窗多停留以便查看/稳定收尾）；**全部窗关闭＝任务全部结束**。
4. **每窗完工自查+验收**：每窗在结束前必须完成**最后一次自查+验收**——读回/复核改动文件、运行/回归确认、确认无残留与乱码、如实汇报结果；**验收不通过视为本窗未完成**，不得以“做完了”结束。
5. **发起方不得询问是否执行（直接干）**：凡确属执行类请求且用户已授权（即对话中已出现「继续/继续全面推进/直接干/允许执行/同意推进」等），发起方**必须立即调用** `--run-windows`，**严禁**先问「是否开始并行弹窗执行吗 / 要不要我执行 / 需要授权吗 / 等我确认吗」这类二次确认；只读分析与纯解答才直接回复。**能并发干的分组**，在用户说「继续/继续全面推进」之后应直接一次性并发干，不得停下来等确认。
6. **父进程侧独立复验（防窗内自报失实）**：窗内 agent 可能「自报成功但实际未生效」（例如删除/改配置被工具策略拦截却谎报成功，表现为窗结束 `exitCode` 非 0 或用例未真正落地）。**发起方不得只信窗内汇报**，必须在全部窗关闭后由**父进程/主对话**独立核验真实盘面（读回目标文件、`Test-Path` 确认已删、`git log` 确认提交、重跑脚本确认输出），不一致则以盘面为准并回滚/重做，不得以窗内“做完了”作为完成依据。
7. **执行彻底、一轮跑完（禁止把可执行的活拖到下一轮）**：凡本轮`--run-windows` 已经拉起或能并入本轮的全部可执行任务，**必须在同一轮内全部执行完、验证完、收尾完**；**严禁**“这条吧下一轮做/这条留到继续/先做几项剩下再说”。若某块需要外部条件（如用户拍板、跨服务依赖）才能推进，才允许如实说明并停下；除此之外一切真实执行都应在本轮收口。

“窗结束 6 秒后自动关闭”对应 `--run-windows` 执行时设置 `ORCH_CLOSE_DELAY_MS=6000`（引擎默认 8000ms 不变；规则只通过环境变量指定 6000，**不修改 SDK 核心的默认值**）。本硬约束只新增执行规则，**不改动**分块、依赖、结果回收的底层逻辑。

## Classification (the key rule)

Classify by **concurrency conflict, not by shared data**:
- If running two tasks **at the same time would break something** (same file/config, same service/port/DB, one needs the other's output, a prerequisite) -> **linked** -> merge into ONE block, strictly **serialized**, never parallel.
- If a task can run concurrently with everything with no problem -> **independent** -> its OWN block, run **in parallel**.

Don't over-merge: two tasks that touch disjoint files/subsystems are independent and each gets its own window. If the decompose model ever bundles independent tasks into one `independent` block, `orchestrate-sdk.mjs` hard-splits it into one block per task (so each independent task pops its OWN window in parallel); only a `linked` block keeps multiple tasks (single serialized window).

## Usage

从本插件的 `scripts/` 目录运行：

- `node orchestrate-sdk.mjs --run-windows "<request>"` -> **THE engine**. Decompose (read-only) + execute. Each **independent** block pops its OWN real **interactive** Codex TUI window and runs in PARALLEL; each **linked** block stays in ONE window and runs serialized. Before executing it SDK-pre-checks each block against running windows: if it conflicts it **WAITS** for the conflicting window to close, then executes. A block still conflicting after the wait (or colliding with another block in the same batch) is LOCKED (not spawned). Every window **auto-closes** when its task finishes (detected via the session's `task_complete` event); the agent's final message + per-block status go to `temp\win-summary.json`.
- `node orchestrate-sdk.mjs --spawn "<title>" "<prompt|.md>"` -> pop ONE real **interactive** Codex TUI window (manual `/exit` or Ctrl+C to close). Use when you want to watch/interact with a single task.
- `node orchestrate-sdk.mjs --plan "<request>"` -> decompose only (read-only thread), print blocks JSON. Review the plan before executing.
- `node orchestrate-sdk.mjs --status` -> list alive windows + pending locks (locks release automatically when the blocking window closes).

(`--run` / `--exec` headless SDK threads remain available for pure automation only and are NOT sanctioned for real changes per AGENTS.md.)

## How auto-close works

The interactive TUI (`codex "prompt"`) does **not** exit on its own when a task finishes — it stays at the input prompt. The orchestrator closes it for you: every Codex session writes its rollout to `~/.codex/sessions/.../rollout-<ts>-<id>.jsonl`, and a completed turn ends with `{"type":"event_msg","payload":{"type":"task_complete"...}}`. `--run-windows` (1) finds its window's session rollout by matching the block's unique token (no stale `before` snapshot), (2) polls for `task_complete`, (3) grabs the agent's final message into `temp\win-summary.json`, then (4) waits `ORCH_CLOSE_DELAY_MS` (default 8s) and closes the window **gracefully** via `closeWindow`. The launcher (a PowerShell that ends `& codex …; exit 0`) is the process Windows Terminal hosts; Windows Terminal runs its profile process with `closeOnExit:"graceful"` — exit code `0` auto-closes the pane, a non-zero exit keeps the pane and shows "[已退出进程，代码为 X]". So `closeWindow` kills **only** the launcher's direct child (codex) and its subtree (`Get-CimInstance` by `ParentProcessId` then `taskkill /T /F`), **never the launcher**, so `& codex` returns and the launcher reaches `exit 0` → Windows Terminal auto-closes the pane. It then polls the launcher PID and only force-kills it (and logs) as a last resort if it is genuinely stuck. Use `--spawn` only when you want to run the interactive TUI yourself and close it manually.

## Enforcement (technical, not just AGENTS)

The sanctioned engine for REAL execution is `--run-windows` — a real, visible, **interactive** Codex TUI window (never headless). This is enforced at the tool level, not only by prompt discipline:

- **Headless is hard-off.** `--run` / `--exec` (the windowless SDK thread path) refuse to run unless `ORCH_ALLOW_HEADLESS=1`. That flag is for pure windowless automation only and is **never** the sanctioned path for real changes (build/install/test/restart/write).
- **`scripts/codex-tui-orchestrator-force.mjs`** is the checkable gate. Run it **before** any real execution:
  - `node codex-tui-orchestrator-force.mjs --status` → enforcement armed? + which windows are alive.
  - `node codex-tui-orchestrator-force.mjs --assert <write|build|install|test|restart|run|all>` → exits `0` only for a **sanctioned window**; otherwise it **refuses** and tells you to route via `--run-windows`.
- **`$env:CODEX_ORCH_WINDOW=1`** is set inside every window launcher. That is the "I am a sanctioned execution window" signal that makes `--assert` pass. Real writes/builds/restarts happen **only** from inside such a window.
- A once-engaged orchestrator writes `temp\.orchestrator-enabled`, so enforcement stays armed across sessions until `force-guard --disable` is run.

## Config (env, portable)

| Variable | Default | Meaning |
|----------|---------|---------|
| `WORKSPACE_DIR` | `process.cwd()` | Working directory threads/windows operate in (your repo, e.g. `$WORKSPACE_DIR`). |
| `CODEX_EXE` | auto-detect | Path to the `codex` CLI binary. |
| `PYTHON` | `python` | Python to prepend to the spawned window's `PATH`. |
| `ORCH_MODEL` | `deepseek-v4-flash-vision-exp` | Model the threads/windows use. |
| `ORCH_EFFORT` | `high` | Reasoning effort. |
| `ORCH_TIMEOUT_MS` | `420000` | Treat a block attempt as failed after this long. |
| `ORCH_DECOMPOSE_TIMEOUT_MS` | `300000` | Timeout for the read-only LLM decompose/classification call before falling back to a serialized window. |
| `ORCH_RETRIES` | `2` | Retry count. |
| `ORCH_WAIT_MS` | `120000` | Max time to WAIT for a conflicting running window to close before executing. |
| `ORCH_CLOSE_DELAY_MS` | `8000` | Read-buffer before a finished window auto-closes. |
| `ORCH_ALLOW_HEADLESS` | unset | If `1`, re-enables the headless `--run`/`--exec` path for pure windowless automation. **Never** use for real changes. |
| `ORCH_TUI` | `wt` | Terminal hosting the visible Codex window: `wt` = Windows Terminal (best CJK IME/输入法 + richer TUI), `conhost` = classic console. |
| `ORCH_KEEP_TEMP` | unset | `1` keeps `temp\win-summary.json` for debugging; default removes it after the run (used-and-discarded). |

## Constraints

- Only orchestrate REAL executions (write/build/install/test). Read-only analysis stays inline.
- **Never split a linked chain across parallel blocks** — running step 1 and step 2 simultaneously breaks them. Keep the whole linked chain in ONE block, strict order.
 - All text I/O is explicit UTF-8 (`[Console]::OutputEncoding`/`$OutputEncoding` and `-Encoding UTF8`; `.ps1` launchers written UTF-8 with BOM). No GBK/dependent-on-locale encoding. Launchers also run `chcp 65001` + `[Console]::InputEncoding = UTF-8` so the input code page (default 936/GBK) matches Codex and the Microsoft Pinyin IME doesn't intermittently fail to commit. For the strongest IME support set `ORCH_TUI=wt`. `wt.exe` is a WindowsApps App Execution Alias (a reparse point) that Node's `fs.existsSync` cannot stat (`false`/`EACCES`) — `--run-windows` now detects it via `where.exe wt.exe` and hosts the TUI in Windows Terminal (best CJK IME) instead of silently falling back to conhost. Best-effort note: the interactive Codex TUI reads raw terminal input, so live Chinese IME composition can still be limited even under Windows Terminal; compose Chinese elsewhere and paste it (Ctrl+V) into the window, or use the Codex desktop app.
- The interactive TUI window runs `codex --cd <workspace> -a never --sandbox danger-full-access <prompt>`. It does **not** auto-exit on completion; the orchestrator detects the session `task_complete` and closes the window by killing **only the codex child** so the launcher reaches `exit 0` (Windows Terminal auto-closes the pane). Never force-kill the launcher itself in `closeWindow` — that makes it exit non-zero and leaves the pane stuck on "[已退出进程，代码为 X]". Keep the launcher's trailing `exit 0`.
- **Batch temp artifacts are used-and-discarded.** `codex-win-*.md` / `win-launch-*.ps1` / `win-*.result.json` / `win-*.log` / `window-*.pid` / `win-summary.json` are deleted after the run (set `ORCH_KEEP_TEMP=1` to keep `win-summary.json` for debugging). No leftovers accumulate in `temp`.
- **执行后必须调用 auto-memory/memory-boost，且一旦启用本 skill 即硬性生效：** 任何经本 skill 完成的真实执行（改动/构建/安装/测试/重启/写文件/改配置/起服务/起停进程）之后，必须调用 codex 侧 auto-memory 留痕（追加到当日记忆档），并在每日 0 点由 memory-boost 压缩进 MEMORY.md；此约束不因会话结束或窗口关闭而失效。本约束仅作合规性要求，不修改本文件既有流程/底层逻辑。

## 执行后验证（必做）

任何真实改动/抓取/生成**之后**，必须执行验证，不允许只改不查、只跑不看：

- **读回文件**：重新读取刚写入的文件，确认内容已落地、无残留——无中间标记、无重复/多余尾部、无乱码。
- **产物流落正确**：确认生成/写入的产物落在它对应的“家”目录，没有散落到别处，也没有写孤儿文件；中间缓存/一次性产物在完成后一并清理。
- **UTF-8 无 BOM**：确认保存的文本文件编码为 UTF-8 无 BOM，不依赖系统默认/控制台代码页（不出现 GBK/936 生成的乱码）。
- **配置/功能改动**：涉及配置或功能改动时，验证命令可执行、结果见真——能编译/能运行/能返回真实结果，并通过回归；做不到的必须说明原因。

以上为必做环节，用于守住“变动即验证、账实一致”。不修改既有流程；本文件以 UTF-8 无 BOM 保存。

## 免责声明 / 风险提示

> 本工具仅用于**本人已明确授权**的本地系统与测试环境；使用者需自行评估并承担风险。

- **风险自担**：执行真实改动、构建、安装、测试、重启、起停服务、删除/覆盖文件等操作，均可能造成数据丢失、服务中断或系统异常；使用者对上述操作产生的一切后果**自行承担**。
- **先备份**：执行删除、覆盖、配置变更或起停服务之前，必须先对受影响的数据、配置、文件做完整备份，并确认可恢复。
- **仅限已授权系统**：只允许在**本人已授权**的系统/环境中使用；严禁用于未授权系统或他人资产。
- **生产环境禁用**：本工具面向本地开发/测试，**禁止直接用于生产环境**；如确需用于生产，须先经相关责任方书面批准，并完成完整备份与演练。
- **合法合规**：使用者须遵守**当地法律法规**（含但不限于《中华人民共和国网络安全法》《中华人民共和国数据安全法》《中华人民共和国个人信息保护法》），不得利用本工具从事违法、侵权或未经授权访问他人系统等活动。
- **敏感信息保护**：口令、API Key、个人身份/个人信息等敏感数据不应写入本工具生成的任何文件或记忆档；如涉及，须按适用法律进行保护与脱敏。

## Skill documentation（文档字段）

- **Prerequisites / 前置条件：** Node 22 + Codex CLI（`codex` 可执行，路径见 `CODEX_EXE`）；Windows 10/11（TUI 依赖 `wt.exe` 或 `conhost`）；`WORKSPACE_DIR` 指向工作区（如 `$WORKSPACE_DIR`）；只读分析无需弹窗。
- **Installation / 安装：** 无需单独安装；来自 `~/.codex/skills/codex-tui-orchestrator/`，脚本在 `scripts/`。启用后先运行 `node scripts/codex-tui-orchestrator-force.mjs --assert <type>` 确认为合规执行窗；一次性产物自动清理（`ORCH_KEEP_TEMP=1` 可保留）。
- **Parameters / 参数表：** 见上文「Config (env, portable)」表（`WORKSPACE_DIR`/`CODEX_EXE`/`ORCH_MODEL`/`ORCH_EFFORT`/`ORCH_TIMEOUT_MS`/`ORCH_RETRIES`/`ORCH_WAIT_MS`/`ORCH_CLOSE_DELAY_MS`/`ORCH_ALLOW_HEADLESS`/`ORCH_TUI`/`ORCH_KEEP_TEMP`）。
- **Examples / 示例：** 见上文「Usage」：`node orchestrate-sdk.mjs --run-windows "<request>"`、`--spawn`、`--plan`、`--status`，及 `codex-tui-orchestrator-force.mjs --status/--assert`。
- **Validation / 验证步骤：** 见上文「执行后验证（必做）」：读回改动文件、产物落位正确、UTF-8 无 BOM、配置/功能改动跑通并可回归。
- **License & disclaimer / 免责许可证：** 见上文「免责声明 / 风险提示」：仅限本人已授权环境、先备份、生产禁用、合法合规、敏感信息保护。
- **Dependencies / 依赖：** Node 22、Codex CLI、Windows Terminal/console、`scripts/orchestrate-sdk.mjs`、`scripts/codex-tui-orchestrator-force.mjs`、`scripts/codex-tui-orchestrator-preflight.mjs`；执行后须调用 auto-memory/memory-boost 留痕。

