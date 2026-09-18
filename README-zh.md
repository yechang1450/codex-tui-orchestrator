> 当前执行协议已升级：参见 [执行与验收协议](docs/execution-contract.md)。专用版固定 core 1.4.0-rc.1 快照并校验 release.json；通用版独立开发；历史验收报告只代表当时版本。

# codex-tui-orchestrator

> 当前版本为 `0.5.0-rc.1` 候选版，优先支持 Windows + Node.js 22 + Codex CLI。跨机器、插件管理器升级/回滚和长时间断网等未验证场景不作稳定版保证。

Windows / Node 22+. Keeps conflict-based linked/independent grouping, dependency-ready scheduling, resource reservations, default headless exec, optional visible TUI, durable checkpoints and independent result verification.

版本：`0.5.0-rc.1`。验收记录按实际封存快照区分，见 [RC 验收记录](docs/rc-validation.md)；相同版本号不代表不同哈希之间的实测证据可通用。

## Current support / 当前支持

专用入口默认使用 Codex。显式 `--agent` / `ORCH_AGENT` 指定非 Codex、CLI 覆盖路径无效或原生 CLI 缺失时，会在执行前报错，不自动安装 CLI 或切换适配器。
目前仅接通 Codex；其它 agent 不能冒充 Codex 运行。接入新宿主必须同时实现规划、交互参数、会话输出解析和完成/清理协议，不能只添加一个命令名。

## 在 Codex 中的实际体验

插件已经在宿主中注册并启用后，如果当前对话还没有加载技能，就新开一个对话，再把完整且已授权的多任务请求交给 Codex。技能会先准备独立验收条件，再从发起工作区调用插件的绝对路径。默认使用 `--exec`，需要观察或交互时才用 `--run-windows`。仅克隆仓库不会自动注册或启用插件。

运行开始后，插件先按冲突和依赖拆块，再按容量与锁调度。TodoList 保留原始任务身份，Execution 显示块的模式、进程、尝试次数和等待原因。普通执行必须依次出现 `started`、`completed`，并通过主控独立验收，才会成为 `verified`；关窗、结束标记或子窗口自报不能单独证明成功。只有 `started` 的任务保留为待对账；主控显式使用 `--verify-run` 核对真实结果后，才可完成这类中断任务的对账。

| 场景 | 入口 | 体验与边界 |
| --- | --- | --- |
| 多项工作后台推进 | `--exec` / `--headless` | 主对话清爽，可用 `status.mjs --watch` 观察 |
| 需要看窗口或交互 | `--run-windows` / `--visible` | 使用 Windows Terminal，只影响下一次任务 |
| 单项任务遇到断网、超时或 CLI 崩溃 | `supervise.mjs` | 有限重试并尽可能续接同一会话，副作用仍需核对 |
| 多任务运行中断 | `--resume-run <ID>` | 沿用原计划、模式和任务身份，结果不明则停在 `needs-reconciliation` |

因此，Codex 在多任务执行时少做窗口管理和人工对账，适合有明确验收条件的代码、测试和维护工作。此前流程证据覆盖 headless、可见 TUI、恢复接管、监督器和独立复核；当前候选仍须以最新真实自检和 RC 清单为准，不能把历史流程证据当作当前版本全流程通过。历史提交 `dea90f4` 曾完成覆盖 162 个文件的离线安全审计，未发现报告项；该结果不认证之后的修改；完整限制和未验证场景见 [RC 验收记录](docs/rc-validation.md)。当前边界是 Windows、Node.js 22+ 和已登录的原生 Codex CLI；模型供应商可用性、跨机器安装、插件管理器升级/回滚和长时间断网仍需单独实测。离线回归不会替它们背书，宿主原生 TodoList/spawn 卡片也不会被插件伪装成已接入。

Plugin entry: `node scripts/orchestrate-sdk.mjs`. Dependencies: `npm ci --prefix scripts`. Tests: `node --test --test-concurrency=1 test/*.test.mjs`.

### 从 GitHub 安装或更新

需要 Windows、Node 22+，以及已安装并完成登录的原生 Codex CLI。更新该副本前先结束活动运行。下面命令会显式检查并拒绝已跟踪或未跟踪的本地改动；干净副本只做快进更新，首次使用则克隆，再恢复锁文件依赖、检查完整性并运行 doctor（安装诊断，检查依赖与 CLI 发现）。每条原生命令失败都会停止整段，处理失败原因后再重试。

```powershell
& {
  $ErrorActionPreference = 'Stop'
  $InstallRoot = Join-Path $HOME '.codex\plugins\codex-tui-orchestrator'
  if (Test-Path -LiteralPath $InstallRoot) {
    if (-not (Test-Path -LiteralPath (Join-Path $InstallRoot '.git'))) {
      throw "InstallRoot 已存在但不是 Git 副本：$InstallRoot。请改用其他路径。"
    }
    $LocalChanges = @(git -C $InstallRoot status --porcelain)
    if ($LASTEXITCODE -ne 0) { throw '无法检查现有 Git 副本。' }
    if ($LocalChanges.Count -gt 0) { throw '发现本地改动，请提交或处理后再更新。' }
    git -C $InstallRoot pull --ff-only
    if ($LASTEXITCODE -ne 0) { throw 'Git 更新失败，尚未修改依赖。' }
  } else {
    git clone https://github.com/yechang1450/codex-tui-orchestrator.git $InstallRoot
    if ($LASTEXITCODE -ne 0) { throw 'Git 克隆失败，安装已停止。' }
  }
  npm ci --prefix (Join-Path $InstallRoot 'scripts') --omit=optional --ignore-scripts
  if ($LASTEXITCODE -ne 0) { throw '依赖安装失败。' }
  node (Join-Path $InstallRoot 'scripts/release-integrity.mjs')
  if ($LASTEXITCODE -ne 0) { throw '发布完整性检查失败。' }
  node (Join-Path $InstallRoot 'scripts/orchestrate-sdk.mjs') --doctor
  if ($LASTEXITCODE -ne 0) { throw '安装诊断失败。' }
}
```

如果要放到其他安装父目录，也可以把 `$InstallRoot` 改成目标路径后执行同一段命令。

依赖从锁文件恢复，不需要旧的 `node_modules` 或运行产物。保留 `skills/codex-tui-orchestrator` 的准确目录大小写。插件管理器安装会建立全新的缓存，其中不带 `scripts/node_modules`；每次 `codex plugin add`、升级或回退后，都要对该次安装返回的插件路径运行 `npm ci --prefix <安装路径>/scripts --omit=optional --ignore-scripts --no-audit --no-fund`，再用同一个安装路径运行完整性检查和 doctor。doctor 不代表服务商可用或任务已完成。上述命令只安装或更新脚本副本，不会注册、启用、升级或回滚插件管理器中的安装。直接调用脚本无需注册；自动加载技能需要先按宿主支持的插件安装流程注册并启用，再新开对话。实际插件管理器注册、升级和回滚仍需单独验证。保留 Codex 登录配置与活动工作区状态。

已有个人 marketplace（插件目录）条目必须使用规范小写名称 `codex-tui-orchestrator`，并实际指向本仓库。下面的命令先核对源码位置，只修正旧条目的名称大小写，再调用官方安装器；保留原顺序、源码路径、策略和其他插件。条目缺失、重复、属于远端或指向其他源码时会停止，不会新建 marketplace。从本仓库完成依赖安装和完整性验证后运行；重装后在新的 Codex 对话中加载更新的技能。

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


从发起工作区调用绝对路径。以下最小示例先定义验收条件，再创建带本次运行身份的 JSON 结果；执行会使用已配置模型的额度：

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
  $Request = "创建 JSON 文件 `"$Receipt`"，其中 answer 为 42，runId 为 $RunId。按提供的任务检查点执行并核对内容。"
  node $Orch --workspace $Workspace --run-id $RunId --acceptance-file $Acceptance --exec $Request
  if ($LASTEXITCODE -ne 0) { throw "本次运行未通过，请先检查 temp/orchestrator/runs/$RunId/summary.json。" }
  Get-Content -LiteralPath (Join-Path $Workspace "temp\orchestrator\runs\$RunId\summary.json")
}
```

把上例同一条调用的 `--exec` 改为 `--run-windows` 即可选择可见执行；两种模式共用任务清单、检查点、恢复和验收。实际多任务请求要为每个原始任务 ID（`T001`、`T002` 等）定义内容或行为检查，格式见[验收协议](docs/execution-contract.md#execution-and-verification)。缺少验收条件时，已完成工作仍停在 `awaiting-verification`（等待主控验收），入口返回非零，不会当作成功。可以用 `--verify-run` 补充检查而不重做任务。读回 summary 和结果后，再清理本示例已结束的产物。

### 自动重试与继续

单个任务需要经受网络断开或 Codex 进程崩溃时，可以使用独立监督器（监督器，独立监测并恢复 Codex 会话的进程）：

```powershell
$Supervisor = Join-Path $HOME '.codex\plugins\codex-tui-orchestrator\scripts\supervise.mjs'
node $Supervisor --workspace (Get-Location).Path --prompt 'Your authorized task' --max-attempts 3
```

监督器会把会话 ID 和尝试记录保存到 `workspace/temp/orchestrator/supervisor/runs/<runId>`，只对传输错误、超时、容量不足、限流和服务端错误进行有限重试；已有会话 ID 时会继续同一个会话。保存的任务可以这样继续：

```powershell
$Supervisor = Join-Path $HOME '.codex\plugins\codex-tui-orchestrator\scripts\supervise.mjs'
$RunId = 'replace-with-the-saved-run-id'
node $Supervisor --workspace (Get-Location).Path --run-id $RunId --resume
```

监督器报告成功只表示 Codex 会话结束，不会运行编排器的独立任务验收。它与主运行器共用原生 Codex 可执行文件，以及同一套继承来的 provider、模型和推理强度配置。它提供有上限的会话恢复，不能保证外部副作用恰好执行一次。如果错误可能发生在外部操作之后，继续提示会要求 Codex 先检查当前状态，再决定是否重复操作。需要任务验收时，使用带验收文件的 `--exec` 和现有 `--resume-run` 流程。

如果你要接入本地重试代理（例如 `steady-relay`），先用可信的 OpenAI 兼容上游启动它，然后把编排器指向它打印出来的本地 `/v1` 地址。设置该地址同时也是显式选择项：规划器和执行窗会改走 orchestrator-openai-https；不设置则继续继承发起方的 Codex provider。常见地址是 `http://127.0.0.1:8080/v1`。

```powershell
$env:ORCH_OPENAI_BASE_URL = 'http://127.0.0.1:8080/v1'
$Orch = Join-Path $HOME '.codex\plugins\codex-tui-orchestrator\scripts\orchestrate-sdk.mjs'
node $Orch --doctor
```

从发起工作区调用绝对脚本路径。用 `--plan` 只规划，`--status` 查看状态。底层 `--spawn <title> <prompt-or-file>` 启动单个可见会话，并只在捕获到该会话的结果报告后返回成功；窗口自闭但没有报告会返回失败。需要任务验收时使用带验收文件的 `--exec` 或 `--run-windows`。只读请求和编排器自身修改留在当前对话；`--run` 与裸请求遵循 `ORCH_EXEC_MODE`（默认 headless）。资源清单不确定时，两种执行模式都会保留全部任务并串行兜底。

## 双通道实时状态

TodoList（原始任务清单）保留 T001 等任务身份。Execution（执行块状态面板，也称 spawn 状态）显示每个块的模式、PID、尝试次数、等待原因和重试时间。块已启动不代表其中每个任务都已开始。

- started 检查点使任务进入 running；completed 进入 awaiting-verification；独立验收通过才显示 verified。
- 执行输出持续显示双状态。交互终端固定刷新面板，普通输出按状态变化追加。
- manifest.json 从规划开始保存清单；summary.json 是权威快照，events.jsonl 是带序号事件，goal.json 是派生镜像。文件都归当前工作区 temp/orchestrator/runs/<ID>。

~~~powershell
$Status = Join-Path $HOME '.codex\plugins\codex-tui-orchestrator\scripts\status.mjs'
$RunId = 'replace-with-the-saved-run-id'
node $Status --workspace (Get-Location).Path --run-id $RunId --watch
# 在上一条命令追加 --json，可读取结构化输出。
~~~

status.mjs 只读且不依赖 SDK，退出观察不会终止执行。JSONL（逐行 JSON 事件）用于接入宿主界面；重连先读最新快照再跟随事件，--after 指定已观察序号。默认每 250ms 观察检查点，系统和同步协调可能延迟显示，不承诺硬实时。

Codex 原生 TodoList/spawn 卡片属于宿主界面。本插件提供持续终端面板和状态事件；原生卡片需要宿主消费同一接口，不能仅靠技能文件注入。可以随时打开观察面板；选择下一次任务的执行模式不会重启当前任务。

恢复沿用原来的执行模式和任务身份。旧记录未声明模式时仍按 visible 恢复，不会因新默认值改变执行方式。

## Host contract / 宿主契约

- 专用入口默认 Codex；`--agent` / `ORCH_AGENT` 可显式选择 Codex，非 Codex 值会被拒绝。`--workspace` 指定任务工作区，`--cli` 指定原生 CLI 覆盖路径。
- --cli / ORCH_CLI (or CODEX_EXE) selects the native executable. An explicit invalid path fails instead of searching for a replacement. Otherwise inspect PATH and npm packaged native binaries, verify with --version.
- ORCH_MODEL / ORCH_EFFORT 是显式覆盖项；规划器和两种执行模式默认继承原生 Codex 配置，包括其中的 model provider 与凭据（第三方 provider 同样沿用）。`ORCH_PROVIDER=openai-https`（或配置了中继地址，二者等价）会让规划器和执行窗改走 orchestrator-openai-https；`ORCH_PROVIDER=inherit` 保持继承，其它取值一律 fail-closed。GUI 对话里的临时覆盖不会自动读取，调用方需显式传入。
- 传输断开、超时、流中断，或启动器在写入任务检查点前异常退出时，执行块会在 `maxAttempts`（默认 2 次）预算内自动重试；已经写入 started 但无法证明结果的任务会停在 `needs-reconciliation`，不会盲目重做副作用。
- ORCH_SANDBOX / ORCH_APPROVAL pass the caller's authorized execution policy. Authorized execution windows default to danger-full-access / never. ORCH_SANDBOX can restrict the sandbox; approval is always never, including when a legacy ORCH_APPROVAL requests prompting. For the default authorized Codex TUI path, the launcher carries the effective never + danger-full-access envelope with `--dangerously-bypass-approvals-and-sandbox`, which also suppresses the CLI's project trust confirmation. Restricted sandbox values are preserved and never elevated. The exact workspace trust setting is passed for this invocation only; global config.toml is not modified. External host policy can still reject an operation.
- Headless uses hidden workers and codex exec --json with stdin prompts. Visible mode prefers Windows Terminal with conhost fallback and inherited interactive stdout. ORCH_TUI applies only to visible mode. Accepted values are `wt`, `conhost` and `inactive`; any other `ORCH_TUI` value fails closed at startup.
- WORKSPACE_DIR 选择任务工作区，CODEX_HOME 选择 Codex 配置和会话存储。默认工作区是调用者当前目录，也可用 --workspace / WORKSPACE_DIR 覆盖。ORCH_STATE_DIR 默认位于 workspace/temp/orchestrator；Codex 的协调器独立使用 `temp/orchestrator/codex-coordinator` 和 HKCU `Software/CodexTuiOrchestrator`，不会与 open-tui-orchestrator 共用租约池。不同工作区的 Codex 运行共享该定位器，运行结果仍留在各自工作区。ORCH_COORDINATOR_DIR 是仅用于明确共享 Codex 容量池的高级覆盖项。
- Task temporary artifacts remain under workspace/temp and are handled by the existing cleanup protocol. Do not delete active runtime state. ORCH_SESSION_DIR can override session discovery.
- provider 明确返回账户用量上限（本次账号额度已耗尽），例如 usage_limit_exceeded、quota_exceeded 或 "You've hit your usage limit" 时，立即 fail-closed；适配器只接受结构化 `error`/`turn.failed` 事件或 `task_complete.error` 中的 provider 错误，任务文本和工具输出不会被当作配额依据。它不会消耗块的普通失败预算，也不会再开替代窗口，需等 provider 配额恢复后再重试。

## Completion / 完成

窗口会先检查真实输出，再发出本次令牌对应的 `__ORCH_DONE__` 标记。看门狗（监视子进程并在异常时收尾的组件）只把助手输出当作完成线索；主控还会独立验收输出，并收集每个块的终态。子窗口不得递归启动编排器或子代理。

每次运行都会持久化主控拥有的 `manifest.json`、结构化 `todoList` 和 `goal.json`。规划器先从这份清单分块，每个执行块都会收到全局 TodoList 和本块视图。Goal 状态是运行/块/任务状态的本地持久镜像；Codex 宿主可以用会话级 Goal 做高层跟踪，但 TUI 窗不会直接调用宿主 Goal 工具。

授权模板只表达用户范围和宿主规则，不能授予额外权限。只能使用当前可用的技能；失败和阻塞必须报告，不能改写成成功。

## Verification scope / 验证边界

Automated tests exercise grouping, dependency-ready scheduling, locks, native CLI selection, fail-closed errors, generated PowerShell launchers, watchdog auto-close and process-tree cleanup using controlled child processes. They do not establish real model/provider availability or prove that every future agent is supported. A real model-backed visible-window acceptance run is a separate check.

专项验收测试命令为 `node --test --test-concurrency=1 test/execution-acceptance.test.mjs`。它检查 headless 与可见 TUI 的 model/effort 一致性、worker 实际 argv、TodoList 实时状态、spawn 群状态事件，以及宿主原生卡片接入边界。设置 `ORCH_REAL_CODEX_ACCEPTANCE=1` 会额外运行一次真实 headless 和一次真实可见 TUI；该检查需要已配置 Codex 账户和 Windows 桌面环境。

## Capacity-constrained planning

Memory is detected before decomposition. Capacity budgets 2 GB per execution block and uses the machine's detected physical memory: `floor(machineMemoryMB / 2000)`, i.e. `floor(machineMemoryMB / 1000)` divided by two. A 15,640 MB machine yields 7 execution blocks and a 16,000 MB machine yields 8, independent of how much memory is free at launch. Capacity limits the TOTAL number of execution blocks, not only the size of each launch wave. Every planning path, including cached plans and fallback plans, applies the current capacity before execution.

Overflow blocks are grouped into at most the calculated capacity. Tasks inside a merged block execute serially in dependency order, and all task bodies and conflict keys are retained. Capacity is a per-invocation plan limit, not a cross-process global quota; the shared coordinator applies the same calculated limit across active and reserved windows.

离线回归测试运行 `node --test --test-concurrency=1 test/*.test.mjs`。调度器会拒绝未限容量的输入，不会悄悄制造溢出波次；溢出依赖形成环时，会在执行前明确报错，不会静默遗漏任务。

## Real-window acceptance

Run the opt-in live concurrency probe explicitly on Windows with the calculated capacity. It consumes the configured model quota and uses the host-authorized `danger-full-access` / `never` policy. Invoke the test by absolute path from the conversation directory. All windows keep that directory; probe artifacts are under its temp/. The test removes policy/path overrides from its child environment to test production defaults.

The parent measures real launcher/Codex ancestry and holds the probe set until all selected probes overlap. Acceptance requires the calculated capacity to be respected, distinct launchers, valid task receipts, and strict polling exit zero. Receipt checks include run identity, task identity, arithmetic and timestamps. The runner retains its report and isolated temporary directory for host review and scoped cleanup.

Identical full script/output paths still merge conservatively. Bare leaf-name fragments do not infer conflict keys; path inference requires a multi-segment absolute path. Undeclared output paths can yield `uncaptured` despite real outputs. The fixture therefore declares distinct scripts and output files explicitly.

Window cleanup targets only the selected launcher's descendants. Startup also removes stale launcher artifacts after verifying PID and command identity. It never terminates the shared Windows Terminal host: doing so can kill unfinished tasks in another window, especially a merged block with more work remaining.

2026-09-06 早期实测（历史记录）：91 项离线测试通过；Windows Terminal 共启动 8 窗完成 9 项任务，重叠 16.621 秒；所有会话 cwd 为 D:\，审批为 never；严格轮询返回 0，窗口全部关闭。验证证据见 test/live-concurrency-result.json。测试目录的删除被宿主自动审批拒绝，已保留并记录。

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

## 发行成熟度
当前属于候选版。发布校验、清理保护和跨环境验收要求见 [发布规则](docs/release-policy.md)；每次代码或封存哈希变化后，都要重新确认适用的验证证据。

当前候选 core 1.4.0-rc.1 的证据边界见 [RC 验收记录](docs/rc-validation.md)。此前 1.4.0-rc.1 与更早版本的窗口、包、容量和缓存同步记录均是对应快照的历史证据，不能证明当前代码已实测或当前缓存仍同步。

2026-09-13 的真实 Windows 重启后，提交 `0fca067` 的发行完整性、doctor 和 marketplace 注册经显式补收集全部通过。登录后的自动收集未触发，未完成模型任务的跨重启恢复也未认证；具体证据和补收集方式见 [重启验收说明](docs/network-reboot-validation.md)。

隐私与使用条款见 [隐私说明](docs/privacy.md) 与 [使用条款](docs/terms.md)。

安装与不同 CLI 版本的已验证范围见 [兼容验收](docs/compatibility.md)。
