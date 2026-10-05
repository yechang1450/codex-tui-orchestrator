> 当前执行协议已升级：参见 [执行与验收协议](docs/execution-contract.md)。专用版固定 core 1.4.4-rc.1 快照并校验 release.json；通用版独立开发；历史验收报告只代表当时版本。

默认使用 exec+headless（通过 Codex CLI 非交互执行，不弹出终端窗口）；--run-windows 或 --visible 显式选择可见 TUI（终端交互界面）。两种模式共用调度、检查点、恢复和验收。

# codex-tui-orchestrator

> 当前版本为 `0.9.29-rc.1` 候选版。它优先支持 Windows + Node.js 22 + Codex CLI；未验证的跨机器、插件管理器升级/回滚和长时间断网场景不会被当作稳定保证。

Windows / Node 22+. Keeps conflict-based linked/independent grouping, dependency-ready scheduling, resource reservations, default headless exec, optional visible TUI, durable checkpoints and independent result verification.

版本：`0.9.29-rc.1`。验收记录按实际封存快照区分，见 [RC 验收记录](docs/rc-validation.md)；相同版本号不代表不同哈希之间的实测证据可通用。

后续 RC 版本由发布脚本递增：在仓库根目录运行 `npm --prefix scripts run version:next`，例如从 `0.9.29-rc.1` 生成 `0.9.29-rc.2`，并同步三个发行清单。首次设定新版本线可运行 `node scripts/bump-version.mjs --set <版本号>`。随后记录 CHANGELOG、重封依赖与发行清单并验证新分发。

## Current support / 当前支持

The dedicated entry defaults to Codex. An explicit non-Codex `--agent` / `ORCH_AGENT`, or invalid CLI override fails before execution. Missing native Codex CLI triggers one bounded npm installation attempt unless disabled; adapters never switch automatically.
目前仅接通 Codex；其它 agent 不能冒充 Codex 运行。接入新宿主必须同时实现规划、交互参数、会话输出解析和完成/清理协议，不能只添加一个命令名。

## Using it from Codex / 在 Codex 中的实际体验

Once the plugin is registered and enabled, its trusted SessionStart hook prepares the environment when a conversation starts. The PowerShell bootstrap can start without Node/npm: it reuses a verified local runtime or installs a checksum-verified portable runtime in the plugin data directory, restores the locked SDK and discovers/installs native Codex CLI. Host hook trust is required and is never changed by the installer. Direct installation runs the same preparation immediately. Orchestrated child sessions disable hooks after host preparation so a fresh hook review cannot block visible tasks; they never bypass hook trust. The skill keeps original task IDs, prepares independent acceptance checks and calls the absolute entry from the initiating workspace. `--exec` is the default; use `--run-windows` for a visible TUI. Cloning alone does not enable the plugin, and installation cannot supply account credentials.

一次实际运行会先把原始请求拆成带原始 ID 的原子任务，再按依赖、冲突和未知资源组成串行块；最终并行块之间没有前后依赖或资源冲突。只有一个块时直接在发起对话执行。每次开窗前按预测内存峰值检查，保留至少 1000 MB；不满足时排队，窗口结束后重新准入。你看到的是同一份任务账本的两条视图：TodoList 保留原始任务身份，Execution 显示块的模式、进程、尝试次数与等待原因。普通执行必须完成 `started`、`completed` 和主控独立验收，才算 `verified`；窗口关闭后，主控按块顺序串行检查真实产物，并把证据追加到同一份 verification report。关窗、结束标记或子窗口自报不会单独宣告成功。

模型语义拆分（由模型识别原子任务、依赖和资源提示）现在可以把没有项目编号、但明确写出文件或目录的任务拆开；确定性分块器逐项核对提示与原文，遗漏或编造路径时整批保守串行。相同文件、父子目录或显式依赖仍归入同一串行块。Windows 用户代理启用且没有显式代理环境变量时，编排器仅给自身进程树继承该代理，供规划和 Codex 子进程联网；不改系统代理或全局环境。`--plan` 只规划、不执行任务改动，但可能更新编排器的拆分缓存；语义判断仍需主控审查，不能把自然语言分析当作绝对无冲突证明。

| Codex 使用场景 | 建议入口 | 体验与边界 |
| --- | --- | --- |
| 想让多项工作在后台推进 | `--exec` / `--headless` | 主对话保持清爽；仍可用 `status.mjs --watch` 观察进度 |
| 需要看窗口或临时交互 | `--run-windows` / `--visible` | 使用 Windows Terminal；只影响下一次任务，不重启当前运行 |
| 单项任务遇到断网、超时或 CLI 崩溃 | `supervise.mjs` | 有限重试并尽可能续接同一会话；外部副作用仍需核对 |
| 多任务运行中断 | `--resume-run <ID>` | 沿用原计划、模式和任务身份；结果不明的任务停在 `needs-reconciliation` |

这让 Codex 在多任务执行时少做窗口管理和人工对账，适合有明确验收条件的代码、测试和维护工作。当前提交已经在本机完成可见 Windows Terminal 六窗口实跑：80、81、82、83、game、ai-drama 六个清理任务峰值并发为 6，最终六个任务均有独立收据、主控验收通过，且每个窗口的 `cwd/workspace` 都是发起工作区；81 首次未产出收据后按账本规则自动重试并完成。当前串行全量回归为 **556 项（553 通过、0 失败、3 跳过）**；证据边界和跳过原因见 [RC 验收记录](docs/rc-validation.md)。运行时需要 Windows、Node.js 22+ 和已登录的原生 Codex CLI；引导入口可自动补齐缺失的 Node/npm 与 CLI。插件也不会把宿主原生 TodoList/spawn 卡片伪装成已接入；宿主必须消费本插件的状态契约。

Plugin entry: `node scripts/orchestrate-sdk.mjs`. Dependencies: `npm ci --prefix scripts`. Tests: `node --test --test-concurrency=1 test/*.test.mjs`. Coverage: `node scripts/coverage.mjs` runs the same serial suite and writes lcov to `.plugin-eval/coverage/lcov.info` (git-ignored, not published).

### Install or update from GitHub

With an extracted or cloned plugin directory, this entry also works before Node/npm are on PATH:

```powershell
powershell.exe -NoProfile -File "$HOME\plugins\codex-tui-orchestrator\scripts\bootstrap.ps1" -Action install
if ($LASTEXITCODE -ne 0) { throw 'Plugin installation failed.' }
```

`-Action prepare` only prepares dependencies and CLI, `-Action doctor` checks the environment, and `-Action run -Arguments @('--exec', '<request>')` forwards arguments without building a shell command. Runtime downloads are pinned and SHA-256 verified; staging is cleaned on failure. `PLUGIN_DATA/runtime` is preferred, falling back to the plugin's `temp/runtime`; global PATH and credentials are preserved. Git is needed for the optional clone/pull workflow below, not for execution from an extracted package. See [environment preparation](docs/environment-setup.md) for hook trust, offline errors and clean-machine reproduction.

The manual clone/update workflow below needs Git. Authenticate Codex before a real task run. Finish active runs before updating this checkout. The block rejects local changes, fast-forwards a clean checkout or clones it, then prepares dependencies and runs doctor; it does not register the plugin. Every native-command failure stops the block.

```powershell
& {
  $ErrorActionPreference = 'Stop'
  $InstallRoot = Join-Path $HOME 'plugins\codex-tui-orchestrator'
  if (Test-Path -LiteralPath $InstallRoot) {
    if (-not (Test-Path -LiteralPath (Join-Path $InstallRoot '.git'))) {
      throw "InstallRoot exists but is not a Git checkout: $InstallRoot. Choose another path."
    }
    $LocalChanges = @(git -C $InstallRoot status --porcelain)
    if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect the existing checkout.' }
    if ($LocalChanges.Count -gt 0) { throw 'Local changes found. Commit or resolve them before updating.' }
    git -C $InstallRoot pull --ff-only
    if ($LASTEXITCODE -ne 0) { throw 'Git update failed. Dependencies were not changed.' }
  } else {
    git clone https://github.com/yechang1450/codex-tui-orchestrator.git $InstallRoot
    if ($LASTEXITCODE -ne 0) { throw 'Git clone failed. Installation stopped.' }
  }
  & (Join-Path $InstallRoot 'scripts/bootstrap.ps1') -Action doctor
  if ($LASTEXITCODE -ne 0) { throw 'Installation diagnostics failed.' }
}
```

#### One command: install or update (recommended)

The block above only prepares a script checkout. Registering it with the plugin manager still requires the personal marketplace entry, installation, and dependency restore plus verification against the **new cache path**. `install-plugin.mjs` performs those steps and re-verifies integrity and doctor against the cache path that install actually returned. For a working-tree checkout, pass the explicit local-development switch; release installs should use an exported clean distribution:

```powershell
& {
  $ErrorActionPreference = 'Stop'
  $InstallRoot = Join-Path $HOME 'plugins\codex-tui-orchestrator'   # your checkout
  & (Join-Path $InstallRoot 'scripts/bootstrap.ps1') -Action install -Arguments @('--pull', '--verify-skills', '--local-development')
  if ($LASTEXITCODE -ne 0) { throw 'Install failed.' }
}
```

- Clone first when the checkout does not exist; `install-plugin.mjs` does not clone. `--local-development` is required for a checkout source because it may contain `.git`, `temp` and test evidence; omit it when installing an exported clean distribution with `--source dist`.
- `--pull` requires a clean tree and only runs `git pull --ff-only`.
- When `<home>/.agents/plugins/marketplace.json` is missing the tool creates it with the canonical `name: "personal"` and an entry pointing at `./plugins/codex-tui-orchestrator`; other paths still require an existing marketplace file, and existing entries and plugins are preserved.
- `node scripts/install-plugin.mjs --check` is read-only: registration match, optional distribution-versus-checkout core equality, installed cache dependencies and host enablement. `--verify-skills` additionally checks skill visibility. The PowerShell wrapper prepares missing dependencies first, so use the direct Node command for a strictly read-only check.
- The cache root follows `CODEX_HOME`, so a custom or relocated `CODEX_HOME` is checked against the same root the host CLI uses instead of assuming `~/.codex`.
- After moving machines or clones, an entry can still point at the old path: `--set-source` rewrites the single matching entry to this machine's checkout (or an explicitly selected distribution) while preserving other entries, policies and categories; duplicates, remote sources and unmatched entries still stop with a diagnostic.
- `--verify-skills` degrades to a warning when the host build does not expose the debug entry point; add `--strict-skills` when that check must be a hard gate.
- When the host CLI is not on `PATH` (for example only the desktop app's bundled `codex.exe` exists), point `CODEX_CLI_PATH` (or `CODEX_CLI`) at it first; the tool prefers that path and prints an actionable message instead of an ENOENT stack when no CLI can be found.
- Skills load in a new conversation; open one after installing.

`~/plugins/<name>` is the recommended checkout location because it matches the personal-marketplace convention; any other parent directory works as well. The older `~/.codex/plugins/<name>` location still works. Dependencies are restored from the lockfile; old `node_modules` and run artifacts are not required. Preserve the exact `skills/codex-tui-orchestrator` path casing. For local development the marketplace can point at this single checkout when `--local-development` is explicit. Public or release installs must use an exported clean distribution; it is not generated implicitly from a checkout. A plugin-manager install creates a fresh cache without `scripts/node_modules`; the recommended `bootstrap.ps1 -Action install` restores those dependencies, verifies release integrity and runs doctor against the cache path returned by the manager. Doctor checks installation and CLI discovery, not provider access or task completion; a first direct `--doctor` or `--tasks` call may prepare missing runtime dependencies. The manual clone/update block above only prepares a checkout; the recommended install command registers and updates the plugin. Direct script execution needs no registration. Automatic skill loading requires registration through the host's supported plugin installation flow, enabling the plugin, and a new conversation. Preserve Codex credentials and active workspace state.

For a local (personal-marketplace) install, the default entry points at this **single checkout**. The manager copies the whole plugin directory into its cache, so a working-tree source also copies `.git/` and `temp/` (local run state and acceptance evidence). Use the explicit export flow below when a clean package is needed for release review:

```powershell
node scripts/publish-dist.mjs --target <export-root> # writes a clean package outside the checkout and verifies the copy
codex plugin add codex-tui-orchestrator@personal
node scripts/repair-plugin-registration.mjs --check   # accepts the checkout, or an explicitly registered dist source
```

An existing personal marketplace entry must use the canonical lowercase name `codex-tui-orchestrator` and resolve to this repository. For an older mixed-case entry, the command below checks the source and repairs only its name before using the official installer. It preserves entry order, source paths, policies, and other plugins. A missing, duplicated, remote, or mismatched entry stops with a diagnostic; this command does not create a new marketplace. Run it from this repository after dependency installation and release verification. Start a new Codex conversation after reinstalling so the host loads the updated skill.

```powershell
& {
  $ErrorActionPreference = 'Stop'
  $registration = node scripts/repair-plugin-registration.mjs --check | ConvertFrom-Json
  if ($registration.status -eq 'repairable') {
    $registration = node scripts/repair-plugin-registration.mjs --repair | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or -not $registration.ok) { throw 'Registration repair failed.' }
  } elseif (-not $registration.ok) {
    throw $registration.reason
  }
  codex plugin add "$($registration.pluginName)@$($registration.marketplaceName)" --json
  if ($LASTEXITCODE -ne 0) { throw 'Plugin installation failed.' }
}
```


From the initiating workspace, call the installed script by absolute path. This minimal example creates one JSON result with a unique run identity and supplies a content check before execution. It uses the configured model quota:

```powershell
& {
  $ErrorActionPreference = 'Stop'
  $Orch = Join-Path $HOME '.codex\plugins\codex-tui-orchestrator\scripts\orchestrate-sdk.mjs'
  $Workspace = (Get-Location).Path
  $RunId = 'readme-' + [guid]::NewGuid().ToString('N')
  $ExampleDir = Join-Path $Workspace "temp\orchestrator\examples\$RunId"
  [void](New-Item -ItemType Directory -Path $ExampleDir)
  $Receipt = Join-Path $ExampleDir 'result.json'
  $Acceptance = Join-Path $ExampleDir 'acceptance.json'
  $Checks = @{ T001 = @(@{ type = 'json'; path = $Receipt; equals = @{ answer = 42; runId = $RunId } }) }
  [IO.File]::WriteAllText($Acceptance, ($Checks | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
  $Request = "Create the JSON file at `"$Receipt`" with answer equal to 42 and runId equal to $RunId. Follow the supplied task checkpoints and verify its content."
  node $Orch --workspace $Workspace --run-id $RunId --acceptance-file $Acceptance --exec $Request
  if ($LASTEXITCODE -ne 0) { throw "Run did not pass. Inspect temp/orchestrator/runs/$RunId/summary.json before retrying." }
  Get-Content -LiteralPath (Join-Path $Workspace "temp\orchestrator\runs\$RunId\summary.json")
}
```

Replace `--exec` with `--run-windows` in the same checked invocation for visible execution. Both modes use the same task list, checkpoints, recovery and verification. For a real multi-part request, define content or behavior checks for every original task ID (`T001`, `T002`, …); see [the acceptance JSON format](docs/execution-contract.md#execution-and-verification). Missing checks leave completed work at `awaiting-verification` and return nonzero, not success. Use `--verify-run` with checks to inspect an existing run without redoing its tasks. Review the summary and result before cleaning this example's completed artifacts.

The run start records the SHA-256 of the canonical acceptance contract in `manifest.json` and `summary.json`. `--verify-run` and `--resume-run` read the contract back and refuse to continue when the digest differs or the two recorded bindings disagree, so a single rewritten acceptance record cannot lower the checks. Replacing the contract on purpose (for example narrowing checks after an uncertain result) requires the explicit `--allow-acceptance-change` flag or `ORCH_ACCEPTANCE_OVERRIDE=1`, and the rebinding is written into the ledger history. Runs recorded by earlier versions carry no binding and keep verifying unchanged.

### Automatic retry and resume

For a single task that must survive a disconnected provider or a crashed CLI process, run the independent supervisor:

```powershell
$Supervisor = Join-Path $HOME '.codex\plugins\codex-tui-orchestrator\scripts\supervise.mjs'
node $Supervisor --workspace (Get-Location).Path --prompt 'Your authorized task' --max-attempts 3
```

The supervisor stores the thread ID and attempt history under `workspace/temp/orchestrator/supervisor/runs/<runId>`, retries only transport, timeout, capacity, rate-limit and server failures, and resumes the same thread when a thread ID is available. A saved run can be continued with:

```powershell
$Supervisor = Join-Path $HOME '.codex\plugins\codex-tui-orchestrator\scripts\supervise.mjs'
$RunId = 'replace-with-the-saved-run-id'
node $Supervisor --workspace (Get-Location).Path --run-id $RunId --resume
```

Supervisor success means the Codex session completed; it does not run the orchestrator's independent task acceptance checks. It uses the same native Codex executable and the same inherited provider, model and reasoning configuration as the main runner. This is bounded session recovery, not an exactly-once guarantee. When a failure may have occurred after an external side effect, the resumed prompt tells Codex to inspect the current state before repeating work. Use the checked `--exec` flow and checkpoint-based `--resume-run` for task-level acceptance.

If you want to use a local retry proxy such as `steady-relay`, start it with a
trusted OpenAI-compatible upstream first, then point the orchestrator at the
local `/v1` URL it prints. Setting this URL is also the opt-in that switches the
planner and the workers to the hardened OpenAI HTTPS provider; leave it unset to
keep inheriting the initiating Codex provider. A typical relay URL is
`http://127.0.0.1:8080/v1`.

```powershell
$env:ORCH_OPENAI_BASE_URL = 'http://127.0.0.1:8080/v1'
$Orch = Join-Path $HOME '.codex\plugins\codex-tui-orchestrator\scripts\orchestrate-sdk.mjs'
node $Orch --doctor
```

Invoke the absolute script path from the initiating workspace. Use `--plan` for planning and `--status` to inspect state. The low-level `--spawn <title> <prompt-or-file>` launches one visible session and returns success only after capturing that session's result report; a self-closed window without a report returns failure. Use the checked `--exec` or `--run-windows` flow for task acceptance. Read-only and orchestrator-self-modification requests remain inline. `--run` and a bare request respect `ORCH_EXEC_MODE` (headless by default). Either execution mode preserves all tasks in a serial fallback when inventory coverage is uncertain.

## 双通道实时状态

TodoList（原始任务清单）保留 T001 等任务身份。Execution（执行块状态面板，也称 spawn 状态）显示每个块的模式、PID、尝试次数、等待原因和重试时间。块已启动不代表其中每个任务都已开始。

- started 检查点使任务进入 running；completed 进入 awaiting-verification；独立验收通过才显示 verified。
- 执行输出持续显示双状态。交互终端固定刷新面板，普通输出按状态变化追加。
- manifest.json 从规划开始保存清单；summary.json 是权威快照，events.jsonl 是带序号事件，goal.json 是派生镜像。文件都归当前工作区 temp/orchestrator/runs/<ID>。

~~~powershell
$Status = Join-Path $HOME '.codex\plugins\codex-tui-orchestrator\scripts\status.mjs'
$RunId = 'replace-with-the-saved-run-id'
node $Status --workspace (Get-Location).Path --run-id $RunId --watch
# Add --json to the command above for structured output.
~~~

status.mjs 只读且不依赖 SDK，退出观察不会终止执行。JSONL（逐行 JSON 事件）用于接入宿主界面；重连先读最新快照再跟随事件，--after 指定已观察序号。默认每 250ms 观察检查点，系统和同步协调可能延迟显示，不承诺硬实时。

Codex 原生 TodoList/spawn 卡片属于宿主界面。本插件提供持续终端面板和状态事件；原生卡片需要宿主消费同一接口，不能仅靠技能文件注入。可以随时打开观察面板；选择下一次任务的执行模式不会重启当前任务。

恢复沿用原来的执行模式和任务身份。旧记录未声明模式时仍按 visible 恢复，不会因新默认值改变执行方式。

## Host contract / 宿主契约

- Dedicated entry: Codex is the default. `--agent` / `ORCH_AGENT` may explicitly select Codex; non-Codex values are rejected. `--workspace` chooses the task workspace and `--cli` selects a native CLI override.
- --cli / ORCH_CLI (or CODEX_EXE) selects the native executable. An explicit invalid path fails instead of searching for a replacement. Otherwise inspect PATH, the desktop app native binary, and the installed plugin's npm packaged native binary, verify with `--version`, and make one bounded private-prefix `npm install --global --ignore-scripts @openai/codex@0.160.0` attempt when no verified native binary exists. Before a private installed binary executes, both its native SHA-256 and a complete 47-file platform package manifest must match release-pinned digests; this also applies on later launches. `ORCH_CLI_INSTALL_SPEC` accepts only that pinned release; another version requires updated reviewed digests. Set `ORCH_AUTO_INSTALL_CLI=0` to disable that attempt; installation output is never copied into the error message.
- The latest structured turn context in the same `CODEX_HOME` supplies the initiating conversation's model, reasoning effort and service tier. Native `config.toml` fills missing fields; `ORCH_MODEL`, `ORCH_EFFORT` and `ORCH_SERVICE_TIER` are fallback values only when neither source provides a field. `ORCH_PROVIDER=openai-https` — or a configured relay URL, which implies it — switches both the planner and the workers to the hardened OpenAI HTTPS provider; `ORCH_PROVIDER=inherit` keeps inheritance and any other value fails closed.
- The initiating Codex turn's structured sandbox, approval policy and working directory govern child launches. A restricted turn cannot switch to another workspace; missing turn policy stops execution. Direct CLI use without a turn requires an explicit native policy or `ORCH_SANDBOX` / `ORCH_APPROVAL`. Children preserve `on-request` approval and restricted sandboxes. If the default headless mode would need interactive approval, it selects visible mode; an explicit headless request is refused. Only effective danger-full-access plus never uses `--dangerously-bypass-approvals-and-sandbox` and the invocation-specific project trust override. Global config.toml is not changed.
- Headless uses hidden workers and codex exec --json with stdin prompts. Visible mode prefers Windows Terminal with conhost fallback and inherited interactive stdout. ORCH_TUI applies only to visible mode. Accepted values are `wt`, `conhost` and `inactive`; any other `ORCH_TUI` value fails closed at startup.
- WORKSPACE_DIR selects the task workspace. CODEX_HOME selects Codex configuration/session storage. The default workspace is the caller's current directory; --workspace / WORKSPACE_DIR explicitly overrides it. Run ledgers, checkpoints, the decompose cache and memory-budget state remain at `workspace/temp/orchestrator` (the ORCH_STATE_DIR default). The window registry and arming marker are stored under the controller-owned `CODEX_HOME/state/plugins/codex-tui-orchestrator/windows/<physical-workspace-id>` directory, outside a workspace-write child's writable root. The shared Codex coordinator, executable launchers, headless controls, acceptance binding, immutable run-plan binding and supervisor authority use the same external controller boundary. ORCH_COORDINATOR_DIR and the direct API's coordinator argument must also be outside the initiating workspace. If the workspace contains CODEX_HOME (for example, the entire user home), this boundary fails closed; select a narrower project workspace or an independently trusted controller root outside it.
- Task records and checkpoints remain under workspace/temp; controller-owned window registry, launchers, headless controls and acceptance bindings stay under CODEX_HOME. Do not delete active runtime state from either location. ORCH_SESSION_DIR can override session discovery. Recovery refuses a missing or changed controller-owned plan binding. Historical runs lacking that binding cannot be resumed by this version; they can still be independently rechecked with `--verify-run`. On upgrade, a non-empty registry from the previous workspace-local version blocks execution until its windows are drained or reconciled; it is never silently discarded.
- Typed account quota signals such as usage_limit_exceeded, quota_exceeded or "You've hit your usage limit" fail closed immediately. The adapter accepts the provider error in a typed `error`/`turn.failed` event or in `task_complete.error`; task text and tool output are never treated as quota authority. They do not consume the ordinary block retry budget or open replacement windows; retry only after the provider quota resets.
- When the provider reports “Selected model is at capacity” or `server_overloaded`, the planner and shared execution runner retry automatically before any task checkpoint exists. The retry countdown is honored when present; `ORCH_CAPACITY_RETRIES` (default 3), `ORCH_CAPACITY_RETRY_MS` (default 120000) and `ORCH_CAPACITY_RETRY_MAX_MS` (default 600000) bound the behavior. Once a task has started, the normal reconciliation rules prevent an unsafe blind retry.
- Transport loss, timeout, stream interruption and a launcher that failed before writing a task checkpoint also retry automatically within the block attempt budget (`maxAttempts`, default 2). If a task was started but its result cannot be proven, the block stops at `needs-reconciliation` instead of replaying side effects.

## Completion / 完成

The window checks real outputs before emitting its token-specific __ORCH_DONE__ marker. The watchdog only treats assistant output as completion evidence; the parent independently verifies outputs and collects every block's terminal state. Child windows must not recursively launch orchestration or subagents.

Each run persists `manifest.json`, structured `todoList` and `goal.json` in the workspace run directory. Separate controller-owned acceptance and run-plan digests protect the contract and immutable task-to-block mapping. The planner creates blocks from the inventory, and every execution block receives the global TodoList plus its own block view. Goal state is a local durable mirror of run/block/task status; the Codex host may use its conversation Goal for high-level tracking, but TUI windows never call host Goal tools directly.

The authorization template supports the user's scope and host rules; it cannot grant permissions. Only use available skills. Failures and blockers must be reported, never converted to success.

## Verification scope / 验证边界

Automated tests exercise grouping, dependency-ready scheduling, locks, native CLI selection, fail-closed errors, generated PowerShell launchers, watchdog auto-close and process-tree cleanup using controlled child processes. They do not establish real model/provider availability or prove that every future agent is supported. A real model-backed visible-window acceptance run is a separate check.

The focused execution acceptance suite is `node --test --test-concurrency=1 test/execution-acceptance.test.mjs`. It checks model/effort parity for headless and visible launch plans, captures the worker argv, verifies live TodoList and spawn-group events, and checks the explicit native-host integration boundary. Set `ORCH_REAL_CODEX_ACCEPTANCE=1` to additionally run one real headless and one visible TUI task; that opt-in check requires a configured Codex account and Windows desktop.

## Capacity-constrained planning

Capacity is dynamic by default (`ORCH_CAPACITY_MODE=dynamic`): planning preserves every atomic task and groups only dependency, conflict or unknown-scope components into serial blocks. If the result has one block, the initiating conversation executes it directly. Before orchestration, available memory at or below 1000 MB returns an inline decision. Before every window opens, the runner atomically rechecks available memory and reserves the predicted peak. A block starts only when its predicted peak is strictly below available memory minus the mandatory 1000 MB reserve; otherwise it remains queued until a lease is released. The low-level visible `--spawn` and `--selftest-close` windows use the same atomic memory admission and predicted-cost reservation. Independent blocks are never merged to fit memory, and there is no hard-run escape. Each window uses the rolling observed cost (default 400 MB, with declared task memory added once per serial block). Capacity limits the number of independently planned blocks only as an explicit safety bound; memory admission is the live queue.

An explicit capacity below the number of independent blocks is rejected so the planner cannot silently change the user's concurrency graph. Tasks inside a dependency or conflict component execute serially in dependency order, and all task bodies and conflict keys are retained. The shared coordinator applies atomic leases across active and reserved windows.

Run `node --test --test-concurrency=1 test/*.test.mjs` for offline regression tests. The scheduler rejects uncapped input instead of silently making overflow waves. Cyclic overflow dependencies produce an explicit error before execution rather than silently omitting tasks.

## Real-window acceptance

Run the opt-in live concurrency probe explicitly on Windows with the calculated capacity. It consumes the configured model quota and uses the host-authorized `danger-full-access` / `never` policy. Invoke the test by absolute path from the conversation directory. All windows keep that directory; probe artifacts are under its temp/. The test removes policy/path overrides from its child environment to test production defaults.

The parent measures real launcher/Codex ancestry and holds the probe set until all selected probes overlap. Acceptance requires the calculated capacity to be respected, distinct launchers, valid task receipts, and strict polling exit zero. Receipt checks include run identity, task identity, arithmetic and timestamps. The runner retains its report and isolated temporary directory for host review and scoped cleanup.

Identical full script/output paths still merge conservatively (by design); bare leaf-name fragments no longer infer conflict keys (path inference requires a multi-segment absolute path). Undeclared output paths can yield `uncaptured` despite real outputs. The fixture therefore declares distinct scripts and output files explicitly. These path-inference limitations are separate from the capacity change.

Window cleanup targets only the selected launcher's descendants. Startup also removes stale launcher artifacts after verifying PID and command identity. It never terminates the shared Windows Terminal host: doing so can kill unfinished tasks in another window, especially a merged block with more work remaining.

2026-09-06 早期实测（历史记录）：91 项离线测试通过；Windows Terminal 共启动 8 窗完成 9 项任务，重叠 16.621 秒；所有会话均使用隔离工作区，窗口全部关闭。原始运行回执属于本机审计资料，不随公开仓库发布。

## 弱网连接与免确认执行
规划 SDK 和 TUI 窗默认继承发起方的 Codex 配置，包括模型、model provider 与凭据，因此第三方 provider（例如在 CODEX_HOME 中配置的 deepseek）会被原样沿用，运行期间不修改全局 Codex 配置。只有显式选择 orchestrator-openai-https 时才改走 OpenAI 登录的 Responses over HTTPS：supports_websockets=false，避免每窗先等 WebSocket 超时再回退，并保留网页搜索能力声明，不设置第三方地址或额外密钥。HTTP 请求和流式重连沿用 CLI 自身的重试机制，断网本身仍可能造成连接失败。
审批固定为 never，旧 ORCH_APPROVAL 询问模式不再恢复询问。该参数不覆盖宿主强制策略；宿主拒绝仍须如实返回。

## 从 WSL 调用（Windows Subsystem for Linux）
宿主把 Codex 切到 WSL 后有三件事需要知道，否则会出现"命令没报错但行为不对"：

- WSL 里没有 Windows 的 node，编排器要用绝对路径调用 Windows 的 `node.exe`（本机为 `C:\Users\<用户>\.tools\node24-fresh\node.exe`），或直接在 Windows shell 里调用。
- **WSL 不会把自定义环境变量传给 Windows 进程**：`ORCH_TUI`、`ORCH_EXEC_MODE`、`ORCH_MODEL`、`ORCH_EFFORT`、`ORCH_PROVIDER`、`ORCH_OPENAI_BASE_URL` 等设置在 WSL 里会被静默忽略。需要它们生效，要么用 `WSLENV=ORCH_TUI:ORCH_MODEL` 之类的白名单转发（`WSLENV` 自身会被转发），要么改在 `cmd.exe` / PowerShell 里设置。
- 入口现在会自动补齐 `PATHEXT`（Windows 命令扩展名列表），窗口启动器也不再因为 `chcp` 解析失败而中止；此前从 WSL 发起时 `--selftest-close` 与可见窗都会启动失败。回归夹具同时改为与父进程类型无关（`Start-Process -Wait` / `cmd.exe /c` 包裹），因此 `node --test` 也能从 WSL 直接跑绿。

推荐做法：真机验收（需要真实窗口/真实模型）用 Windows shell 调用，离线回归两种方式都可以。示例：

```powershell
cmd.exe /c "cd /d C:\path\to\codex-tui-orchestrator && node --test --test-concurrency=1 test\*.test.mjs"
```


### WSL 现成入口（推荐直接用）

- `bash scripts/wsl/orch.sh <参数>`：从 WSL 调用编排器。它会自动（1）找到 Windows 版 node.exe；（2）把当前 shell 里的全部 `ORCH_*` 变量经 `WSLENV` 转发给 Windows 侧；（3）把 `--workspace` / `--acceptance-file` 的 `/mnt/...` 路径翻译成 `C:...`。例：`ORCH_EXEC_MODE=visible bash scripts/wsl/orch.sh --doctor`（实测 `executionMode=visible`，说明转发生效）。
- `bash scripts/wsl/run-tests.sh [测试文件...]`：从 WSL 跑离线回归。它经 Windows `cmd.exe` 执行，并把 `C:Program FilesGitcmd` 与插件 `scripts` 目录补进 PATH（此前从 WSL 直接跑会因解析不到 `git` 而假失败）。不带参数即跑全量。
- 两者都用 `ORCH_NODE_EXE` 覆盖 node.exe 路径（可选）。

## 发行成熟度
当前属于候选版。发布校验、清理保护和跨环境验收要求见 [发布规则](docs/release-policy.md)；每次代码或封存哈希变化后，都要重新确认适用的验证证据。

core 1.2.1、1.2.3 与 1.3.1 的记录属于历史证据，详情见对应实机验收文档。当前候选版的验收边界见 [RC 验收记录](docs/rc-validation.md)。

当前候选 core 1.4.4-rc.1 的证据边界见 [RC 验收记录](docs/rc-validation.md)。此前版本的窗口、包、容量和缓存同步记录均是对应快照的历史证据，不能证明当前代码已实测或当前缓存仍同步。

2026-09-13 的真实 Windows 重启后，提交 `0fca067` 的发行完整性、doctor 和 marketplace 注册经显式补收集全部通过。登录后的自动收集未触发，未完成模型任务的跨重启恢复也未认证；具体证据和补收集方式见 [重启验收说明](docs/network-reboot-validation.md)。

隐私与使用条款见 [隐私说明](docs/privacy.md) 与 [使用条款](docs/terms.md)。

许可采用 [MIT License](LICENSE)；[中文说明](LICENSE-zh.md) 供阅读参考。

已增加请求生效后断线、响应超时的真实进程恢复测试，验证不盲目重试及核对结果后的恢复，见 [网络异常恢复验证](docs/network-recovery-validation.md)。

发布器会在正式落盘前复核暂存副本的必需文件；缺件发布失败且保留已有版本，见 [发布完整性验证](docs/publication-validation.md)。

SDK 入口损坏或接口缺失会在引擎启动前给出依赖修复命令，见 [SDK 诊断验证](docs/sdk-diagnostic-validation.md)。

安装与不同 CLI 版本的已验证范围见 [兼容验收](docs/compatibility.md)。
