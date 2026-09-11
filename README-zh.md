> 当前执行协议已升级：参见 [执行与验收协议](docs/execution-contract.md)。专用版固定 core 1.4.0-rc.1 快照并校验 release.json；通用版独立开发；历史验收报告只代表当时版本。

# codex-tui-orchestrator

Windows / Node 22+. Keeps conflict-based linked/independent grouping, dependency-ready scheduling, resource reservations, default headless exec, optional visible TUI, durable checkpoints and independent result verification.

版本：`0.5.0-rc.1`。当前 RC 验收范围、结果与限制见 [RC 验收记录](docs/rc-validation.md)。

## Current support / 当前支持

Only the Codex CLI adapter is implemented. Unknown host, unsupported adapter or missing native CLI fails closed: no automatic install and no fallback to Codex.
目前仅接通 Codex；其它 agent 不能冒充 Codex 运行。接入新宿主必须同时实现规划、交互参数、会话输出解析和完成/清理协议，不能只添加一个命令名。

Plugin entry: `node scripts/orchestrate-sdk.mjs`. Dependencies: `npm ci --prefix scripts`. Tests: `node --test --test-concurrency=1 test/*.test.mjs`.

### 从 GitHub 重新安装

需要 Windows、Node 22+，以及已安装并完成登录的原生 Codex CLI。在选定的安装父目录内下载到新目录：

```powershell
git clone https://github.com/yechang1450/codex-tui-orchestrator.git
cd codex-tui-orchestrator
npm ci --prefix scripts --omit=optional --ignore-scripts
node scripts/release-integrity.mjs
node scripts/orchestrate-sdk.mjs --doctor
```

依赖从锁文件恢复，不需要旧的 `node_modules` 或运行产物。保留 `skills/codex-tui-orchestrator` 的准确目录大小写；发布清单同时校验路径和文件内容。doctor（安装诊断，检查依赖和 CLI 发现）不代表服务商可用或任务已完成。需要在 Codex 对话中加载技能时，还要通过插件管理器注册并启用。替换插件目录时保留 Codex 登录配置与仍在执行的工作区状态。

```powershell
node scripts/orchestrate-sdk.mjs --doctor
$env:WORKSPACE_DIR = 'D:\your-project'
node scripts/orchestrate-sdk.mjs --exec 'Your authorized multi-part task'
```

### 自动重试与继续

单个任务需要经受网络断开或 Codex 进程崩溃时，可以使用独立监督器（监督器，独立监测并恢复 Codex 会话的进程）：

```powershell
node scripts/supervise.mjs --workspace D:\your-project --prompt 'Your authorized task' --max-attempts 3
```

监督器会把会话 ID 和尝试记录保存到 `workspace/temp/orchestrator/supervisor/runs/<runId>`，只对传输错误、超时、容量不足、限流和服务端错误进行有限重试；已有会话 ID 时会继续同一个会话。保存的任务可以这样继续：

```powershell
node scripts/supervise.mjs --workspace D:\your-project --run-id <runId> --resume
```

这是一种有上限的恢复机制，不能保证外部副作用恰好执行一次。如果错误可能发生在外部操作之后，继续提示会要求 Codex 先检查并验证当前状态，再决定是否重复操作。需要多任务检查点和验收条件时，继续使用现有的 `--resume-run` 流程。

如果你要接入本地重试代理（例如 `steady-relay`），先用可信的 OpenAI 兼容上游启动它，然后把编排器指向它打印出来的本地 `/v1` 地址。常见地址是 `http://127.0.0.1:8080/v1`。

```powershell
$env:ORCH_OPENAI_BASE_URL = 'http://127.0.0.1:8080/v1'
node scripts/orchestrate-sdk.mjs --doctor
```

Invoke the installed command or absolute script path from the initiating conversation directory; do not change into the installation directory. Use --plan for planning, --spawn <title> <prompt-or-file> for one visible window, and --status to inspect state. Read-only and orchestrator-self-modification requests remain inline. --run and a bare request respect ORCH_EXEC_MODE (headless by default). --exec/--headless and --run-windows/--visible explicitly choose a mode. Either mode preserves all tasks in a serial fallback when inventory coverage is uncertain.

## 双通道实时状态

TodoList（原始任务清单）保留 T001 等任务身份。Execution（执行块状态面板，也称 spawn 状态）显示每个块的模式、PID、尝试次数、等待原因和重试时间。块已启动不代表其中每个任务都已开始。

- started 检查点使任务进入 running；completed 进入 awaiting-verification；独立验收通过才显示 verified。
- 执行输出持续显示双状态。交互终端固定刷新面板，普通输出按状态变化追加。
- manifest.json 从规划开始保存清单；summary.json 是权威快照，events.jsonl 是带序号事件，goal.json 是派生镜像。文件都归当前工作区 temp/orchestrator/runs/<ID>。

~~~powershell
node scripts/status.mjs --workspace D:\your-project --run-id <ID> --watch
node scripts/status.mjs --workspace D:\your-project --run-id <ID> --watch --json
~~~

status.mjs 只读且不依赖 SDK，退出观察不会终止执行。JSONL（逐行 JSON 事件）用于接入宿主界面；重连先读最新快照再跟随事件，--after 指定已观察序号。默认每 250ms 观察检查点，系统和同步协调可能延迟显示，不承诺硬实时。

Codex 原生 TodoList/spawn 卡片属于宿主界面。本插件提供持续终端面板和状态事件；原生卡片需要宿主消费同一接口，不能仅靠技能文件注入。可以随时打开观察面板；选择下一次任务的执行模式不会重启当前任务。

恢复沿用原来的执行模式和任务身份。旧记录未声明模式时仍按 visible 恢复，不会因新默认值改变执行方式。

## Host contract / 宿主契约

- Generic entry: --agent / ORCH_AGENT identifies the initiating agent. Codex session variables can identify Codex; a PATH entry alone cannot identify the host.
- --cli / ORCH_CLI (or CODEX_EXE) selects the native executable. An explicit invalid path fails instead of searching for a replacement. Otherwise inspect PATH and npm packaged native binaries, verify with --version.
- ORCH_MODEL / ORCH_EFFORT 是显式覆盖项；TUI 窗默认使用 `gpt-5.3-codex-spark` 与最高 `xhigh` 思考强度。GUI 对话里的临时覆盖不会自动读取，调用方需显式传入。
- 传输断开、超时、流中断，或启动器在写入任务检查点前异常退出时，执行块会在 `maxAttempts`（默认 2 次）预算内自动重试；已经写入 started 但无法证明结果的任务会停在 `needs-reconciliation`，不会盲目重做副作用。
- ORCH_SANDBOX / ORCH_APPROVAL pass the caller's authorized execution policy. Authorized execution windows default to danger-full-access / never. ORCH_SANDBOX can restrict the sandbox; approval is always never, including when a legacy ORCH_APPROVAL requests prompting. For the default authorized Codex TUI path, the launcher carries the effective never + danger-full-access envelope with `--dangerously-bypass-approvals-and-sandbox`, which also suppresses the CLI's project trust confirmation. Restricted sandbox values are preserved and never elevated. The exact workspace trust setting is passed for this invocation only; global config.toml is not modified. External host policy can still reject an operation.
- Headless uses hidden workers and codex exec --json with stdin prompts. Visible mode prefers Windows Terminal with conhost fallback and inherited interactive stdout. ORCH_TUI applies only to visible mode.
- WORKSPACE_DIR 选择任务工作区，CODEX_HOME 选择 Codex 配置和会话存储。默认工作区是调用者当前目录，也可用 --workspace / WORKSPACE_DIR 覆盖。ORCH_STATE_DIR 默认位于 workspace/temp/orchestrator；Codex 的协调器独立使用 `temp/orchestrator/codex-coordinator` 和 HKCU `Software/CodexTuiOrchestrator`，不会与 open-tui-orchestrator 共用租约池。不同工作区的 Codex 运行共享该定位器，运行结果仍留在各自工作区。ORCH_COORDINATOR_DIR 是仅用于明确共享 Codex 容量池的高级覆盖项。
- Task temporary artifacts remain under workspace/temp and are handled by the existing cleanup protocol. Do not delete active runtime state. ORCH_SESSION_DIR can override session discovery.

## Completion / 完成

The window checks real outputs before emitting its token-specific __ORCH_DONE__ marker. The watchdog only treats assistant output as completion evidence; the parent independently verifies outputs and collects every block's terminal state. Child windows must not recursively launch orchestration or subagents.

每次运行都会持久化主控拥有的 `manifest.json`、结构化 `todoList` 和 `goal.json`。规划器先从这份清单分块，每个执行块都会收到全局 TodoList 和本块视图。Goal 状态是运行/块/任务状态的本地持久镜像；Codex 宿主可以用会话级 Goal 做高层跟踪，但 TUI 窗不会直接调用宿主 Goal 工具。

The authorization template supports the user's scope and host rules; it cannot grant permissions. Only use available skills. Failures and blockers must be reported, never converted to success.

## Verification scope / 验证边界

Automated tests exercise grouping, dependency-ready scheduling, locks, native CLI selection, fail-closed errors, generated PowerShell launchers, watchdog auto-close and process-tree cleanup using controlled child processes. They do not establish real model/provider availability or prove that every future agent is supported. A real model-backed visible-window acceptance run is a separate check.

专项验收测试命令为 `node --test --test-concurrency=1 test/execution-acceptance.test.mjs`。它检查 headless 与可见 TUI 的 model/effort 一致性、worker 实际 argv、TodoList 实时状态、spawn 群状态事件，以及宿主原生卡片接入边界。设置 `ORCH_REAL_CODEX_ACCEPTANCE=1` 会额外运行一次真实 headless 和一次真实可见 TUI；该检查需要已配置 Codex 账户和 Windows 桌面环境。

## Capacity-constrained planning

Memory is detected before decomposition. Capacity uses `floor(reportedGiB * 1024 / 1000 * 3 / 4)`; on this machine the reported 15.64 GiB yields 12 execution blocks. Capacity limits the TOTAL number of execution blocks, not only the size of each launch wave. Every planning path, including cached plans and fallback plans, applies the current capacity before execution.

Overflow blocks are grouped into at most the calculated capacity. Tasks inside a merged block execute serially in dependency order, and all task bodies and conflict keys are retained. Capacity is a per-invocation plan limit, not a cross-process global quota; the shared coordinator applies the same calculated limit across active and reserved windows.

Run `node --test --test-concurrency=1 test/*.test.mjs` for offline regression tests. The scheduler rejects uncapped input instead of silently making overflow waves. Cyclic overflow dependencies produce an explicit error before execution rather than silently omitting tasks.

## Real-window acceptance

Run the opt-in live concurrency probe explicitly on Windows with the calculated capacity. It consumes the configured model quota and uses the host-authorized `danger-full-access` / `never` policy. Invoke the test by absolute path from the conversation directory. All windows keep that directory; probe artifacts are under its temp/. The test removes policy/path overrides from its child environment to test production defaults.

The parent measures real launcher/Codex ancestry and holds the probe set until all selected probes overlap. Acceptance requires the calculated capacity to be respected, distinct launchers, valid task receipts, and strict polling exit zero. Receipt checks include run identity, task identity, arithmetic and timestamps. The runner retains its report and isolated temporary directory for host review and scoped cleanup.

Shared script paths or identical leaf names can trigger conservative conflict merging. Undeclared output paths can yield `uncaptured` despite real outputs. The fixture therefore declares distinct scripts and output files explicitly. These path-inference limitations are separate from the capacity change.

Window cleanup targets only the selected launcher's descendants. It never terminates the shared Windows Terminal host: doing so can kill unfinished tasks in another window, especially a merged block with more work remaining.

2026-09-06 早期实测（历史记录）：91 项离线测试通过；Windows Terminal 共启动 8 窗完成 9 项任务，重叠 16.621 秒；所有会话 cwd 为 D:\，审批为 never；严格轮询返回 0，窗口全部关闭。验证证据见 test/live-concurrency-result.json。测试目录的删除被宿主自动审批拒绝，已保留并记录。

## 弱网连接与免确认执行
Codex 的规划 SDK 和 TUI 窗统一使用 orchestrator-openai-https 配置（沿用 OpenAI 登录、模型与 Responses 接口，直接用 HTTPS 流式传输）。supports_websockets=false，避免每窗先等 WebSocket 超时再回退；保留网页搜索能力声明，不设置第三方地址或额外密钥，不修改全局 Codex 配置。HTTP 请求和流式重连沿用 CLI 自身的重试机制，断网本身仍可能造成连接失败。未来接入自定义服务提供方时须单独实现传输适配，不能直接套用 OpenAI 登录配置。
审批固定为 never，旧 ORCH_APPROVAL 询问模式不再恢复询问。该参数不覆盖宿主强制策略；宿主拒绝仍须如实返回。

## 发行成熟度
当前属于本机验证的候选版。发布校验、清理保护和跨环境验收要求见 [发布规则](docs/release-policy.md)；历史并发测试不代表跨机器或跨版本认证。

当前候选 core 1.4.0-rc.1 的验收以 [RC 验收记录](docs/rc-validation.md) 为准。1.3.4 的窗口、包与容量记录属于历史证据，不用于证明这次默认模式变更。

隐私与使用条款见 [隐私说明](docs/privacy.md) 与 [使用条款](docs/terms.md)。

安装与不同 CLI 版本的已验证范围见 [兼容验收](docs/compatibility.md)。
