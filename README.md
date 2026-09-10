> 当前执行协议已升级：参见 [执行与验收协议](docs/execution-contract.md)。专用版固定 core 1.3.4-rc.1 快照并校验 release.json；通用版独立开发；历史验收报告只代表当时版本。

默认使用 Windows Terminal 承载可见 TUI，内部保留 PowerShell 生命周期脚本。传统控制台的不激活启动仅作显式选项，焦点保护的实测限制见 [后台窗口启动](docs/inactive-windows.md)。

# codex-tui-orchestrator

Windows / Node 22+. Keeps conflict-based linked/independent grouping, dependency-ready scheduling, resource reservations, visible interactive windows, completion watchdogs and result verification.

版本：`0.4.43-rc.1`。当前 RC 验收范围、结果与限制见 [RC 验收记录](docs/rc-validation.md)。

## Current support / 当前支持

Only the Codex CLI adapter is implemented. Unknown host, unsupported adapter or missing native CLI fails closed: no automatic install and no fallback to Codex.
目前仅接通 Codex；其它 agent 不能冒充 Codex 运行。接入新宿主必须同时实现规划、交互参数、会话输出解析和完成/清理协议，不能只添加一个命令名。

Plugin entry: `node scripts/orchestrate-sdk.mjs`. Dependencies: `npm ci --prefix scripts`. Tests: `node --test test/*.test.mjs`.

```powershell
node scripts/orchestrate-sdk.mjs --doctor
$env:WORKSPACE_DIR = 'D:\your-project'
node scripts/orchestrate-sdk.mjs --run-windows 'Your authorized multi-part task'
```

### Automatic retry and resume

For a single task that must survive a disconnected provider or a crashed CLI process, run the independent supervisor:

```powershell
node scripts/supervise.mjs --workspace D:\your-project --prompt 'Your authorized task' --max-attempts 3
```

The supervisor stores the thread ID and attempt history under `workspace/temp/orchestrator/supervisor/runs/<runId>`, retries only transport, timeout, capacity, rate-limit and server failures, and resumes the same thread when a thread ID is available. A saved run can be continued with:

```powershell
node scripts/supervise.mjs --workspace D:\your-project --run-id <runId> --resume
```

This is a bounded recovery tool, not an exactly-once guarantee. When a failure may have occurred after an external side effect, the resumed prompt tells Codex to inspect and verify the current state before repeating work. Use the existing checkpoint-based `--resume-run` flow for multi-task plans that need task-level acceptance checks.

If you want to use a local retry proxy such as `steady-relay`, start it with a
trusted OpenAI-compatible upstream first, then point the orchestrator at the
local `/v1` URL it prints. A typical relay URL is `http://127.0.0.1:8080/v1`.

```powershell
$env:ORCH_OPENAI_BASE_URL = 'http://127.0.0.1:8080/v1'
node scripts/orchestrate-sdk.mjs --doctor
```

Invoke the installed command or absolute script path from the initiating conversation directory; do not change into the installation directory. Use --plan for planning, --spawn <title> <prompt-or-file> for one visible window, and --status to inspect state. Read-only and orchestrator-self-modification requests remain inline. Explicit --run-windows can execute a single serial fallback block when inventory coverage is uncertain.

## Host contract / 宿主契约

- Generic entry: --agent / ORCH_AGENT identifies the initiating agent. Codex session variables can identify Codex; a PATH entry alone cannot identify the host.
- --cli / ORCH_CLI (or CODEX_EXE) selects the native executable. An explicit invalid path fails instead of searching for a replacement. Otherwise inspect PATH and npm packaged native binaries, verify with --version.
- ORCH_MODEL / ORCH_EFFORT are explicit overrides; TUI windows default to `gpt-5.3-codex-spark` with the highest `xhigh` reasoning effort. GUI conversation-only overrides are not automatically readable: callers must pass them.
- ORCH_SANDBOX / ORCH_APPROVAL pass the caller's authorized execution policy. Authorized execution windows default to danger-full-access / never. ORCH_SANDBOX can restrict the sandbox; approval is always never, including when a legacy ORCH_APPROVAL requests prompting. For the default authorized Codex TUI path, the launcher carries the effective never + danger-full-access envelope with `--dangerously-bypass-approvals-and-sandbox`, which also suppresses the CLI's project trust confirmation. Restricted sandbox values are preserved and never elevated. The exact workspace trust setting is passed for this invocation only; global config.toml is not modified. External host policy can still reject an operation.
- Windows Terminal is preferred; conhost is the terminal fallback, not an agent fallback. Interactive stdout is inherited, never piped through Tee-Object.
- WORKSPACE_DIR selects the task workspace. CODEX_HOME selects Codex configuration/session storage. The default workspace is the caller's current directory; --workspace / WORKSPACE_DIR explicitly overrides it. ORCH_STATE_DIR defaults to workspace/temp/orchestrator, shared by both tools in that workspace; any override must remain below workspace/temp. Cross-workspace runs share the coordinator locator; run results stay in their own workspace.
- Task temporary artifacts remain under workspace/temp and are handled by the existing cleanup protocol. Do not delete active runtime state. ORCH_SESSION_DIR can override session discovery.
- When the provider reports “Selected model is at capacity” or `server_overloaded`, the planner and visible-window runner retry automatically before any task checkpoint exists. The retry countdown is honored when present; `ORCH_CAPACITY_RETRIES` (default 3), `ORCH_CAPACITY_RETRY_MS` (default 120000) and `ORCH_CAPACITY_RETRY_MAX_MS` (default 600000) bound the behavior. Once a task has started, the normal reconciliation rules prevent an unsafe blind retry.
- Transport loss, timeout, stream interruption and a launcher that failed before writing a task checkpoint also retry automatically within the block attempt budget (`maxAttempts`, default 2). If a task was started but its result cannot be proven, the block stops at `needs-reconciliation` instead of replaying side effects.

## Completion / 完成

The window checks real outputs before emitting its token-specific __ORCH_DONE__ marker. The watchdog only treats assistant output as completion evidence; the parent independently verifies outputs and collects every block's terminal state. Child windows must not recursively launch orchestration or subagents.

Each run now persists a controller-owned `manifest.json`, structured `todoList` and `goal.json`. The planner creates blocks from that inventory, and every visible block receives the global TodoList plus its own block view. Goal state is a local durable mirror of run/block/task status; the Codex host may use its conversation Goal for high-level tracking, but TUI windows never call host Goal tools directly.

The authorization template supports the user's scope and host rules; it cannot grant permissions. Only use available skills. Failures and blockers must be reported, never converted to success.

## Verification scope / 验证边界

Automated tests exercise grouping, dependency-ready scheduling, locks, native CLI selection, fail-closed errors, generated PowerShell launchers, watchdog auto-close and process-tree cleanup using controlled child processes. They do not establish real model/provider availability or prove that every future agent is supported. A real model-backed visible-window acceptance run is a separate check.

## Capacity-constrained planning

Memory is detected before decomposition. Capacity uses `floor(reportedGiB * 1024 / 1000 * 3 / 4)`; on this machine the reported 15.64 GiB yields 12 execution blocks. Capacity limits the TOTAL number of execution blocks, not only the size of each launch wave. Every planning path, including cached plans and fallback plans, applies the current capacity before execution.

Overflow blocks are grouped into at most the calculated capacity. Tasks inside a merged block execute serially in dependency order, and all task bodies and conflict keys are retained. Capacity is a per-invocation plan limit, not a cross-process global quota; the shared coordinator applies the same calculated limit across active and reserved windows.

Run `node --test test/*.test.mjs` for offline regression tests. The scheduler rejects uncapped input instead of silently making overflow waves. Cyclic overflow dependencies produce an explicit error before execution rather than silently omitting tasks.

## Real-window acceptance

Run the opt-in live concurrency probe explicitly on Windows with the calculated capacity. It consumes the configured model quota and uses the host-authorized `danger-full-access` / `never` policy. Invoke the test by absolute path from the conversation directory. All windows keep that directory; probe artifacts are under its temp/. The test removes policy/path overrides from its child environment to test production defaults.

The parent measures real launcher/Codex ancestry and holds the probe set until all selected probes overlap. Acceptance requires the calculated capacity to be respected, distinct launchers, valid task receipts, and strict polling exit zero. Receipt checks include run identity, task identity, arithmetic and timestamps. The runner retains its report and isolated temporary directory for host review and scoped cleanup.

Identical full script/output paths still merge conservatively (by design); bare leaf-name fragments no longer infer conflict keys (path inference requires a multi-segment absolute path). Undeclared output paths can yield `uncaptured` despite real outputs. The fixture therefore declares distinct scripts and output files explicitly. These path-inference limitations are separate from the capacity change.

Window cleanup targets only the selected launcher's descendants. It never terminates the shared Windows Terminal host: doing so can kill unfinished tasks in another window, especially a merged block with more work remaining.

2026-09-06 早期实测（历史记录）：91 项离线测试通过；Windows Terminal 共启动 8 窗完成 9 项任务，重叠 16.621 秒；所有会话 cwd 为 D:\，审批为 never；严格轮询返回 0，窗口全部关闭。验证证据见 test/live-concurrency-result.json。测试目录的删除被宿主自动审批拒绝，已保留并记录。

## 弱网连接与免确认执行
Codex 的规划 SDK 和 TUI 窗统一使用 orchestrator-openai-https 配置（沿用 OpenAI 登录、模型与 Responses 接口，直接用 HTTPS 流式传输）。supports_websockets=false，避免每窗先等 WebSocket 超时再回退；保留网页搜索能力声明，不设置第三方地址或额外密钥，不修改全局 Codex 配置。HTTP 请求和流式重连沿用 CLI 自身的重试机制，断网本身仍可能造成连接失败。未来接入自定义服务提供方时须单独实现传输适配，不能直接套用 OpenAI 登录配置。
审批固定为 never，旧 ORCH_APPROVAL 询问模式不再恢复询问。该参数不覆盖宿主强制策略；宿主拒绝仍须如实返回。

## 发行成熟度
当前属于本机验证的候选版。发布校验、清理保护和跨环境验收要求见 [发布规则](docs/release-policy.md)；历史并发测试不代表跨机器或跨版本认证。

core 1.2.1、1.2.3 与 1.3.1 的记录属于历史证据，详情见对应实机验收文档。当前候选版的验收边界见 [RC 验收记录](docs/rc-validation.md)。

当前候选 core 1.3.4-rc.1 尚无新的模型驱动真实窗口收据；1.3.1 的窗口记录属于历史证据。

隐私与使用条款见 [隐私说明](docs/privacy.md) 与 [使用条款](docs/terms.md)。

已增加请求生效后断线、响应超时的真实进程恢复测试，验证不盲目重试及核对结果后的恢复，见 [网络异常恢复验证](docs/network-recovery-validation.md)。

发布器会在正式落盘前复核暂存副本的必需文件；缺件发布失败且保留已有版本，见 [发布完整性验证](docs/publication-validation.md)。

SDK 入口损坏或接口缺失会在引擎启动前给出依赖修复命令，见 [SDK 诊断验证](docs/sdk-diagnostic-validation.md)。

安装与不同 CLI 版本的已验证范围见 [兼容验收](docs/compatibility.md)。
