> 当前执行协议已升级：参见 [执行与验收协议](docs/execution-contract.md)。专用版固定 core 1.4.4-rc.1 快照并校验 release.json；通用版独立开发；历史验收报告只代表当时版本。

# codex-tui-orchestrator

> 当前版本为 `0.9.29-rc.1` 候选版，优先支持 Windows + Node.js 22 + Codex CLI。跨机器、插件管理器升级/回滚和长时间断网等未验证场景不作稳定版保证。

Windows / Node 22+. Keeps conflict-based linked/independent grouping, dependency-ready scheduling, resource reservations, default headless exec, optional visible TUI, durable checkpoints and independent result verification.

版本：`0.9.29-rc.1`。验收记录按实际封存快照区分，见 [RC 验收记录](docs/rc-validation.md)；相同版本号不代表不同哈希之间的实测证据可通用。

## Current support / 当前支持

专用入口默认使用 Codex。原生 CLI 缺失时，首次执行会在用户级 npm 范围内用锁定版本、`--ignore-scripts` 进行一次有界自动安装并验证原生二进制；显式 `ORCH_CLI` / `CODEX_EXE` 无效时保持失败，不偷偷替换。其它 agent 不能冒充 Codex。
目前仅接通 Codex；其它 agent 不能冒充 Codex 运行。接入新宿主必须同时实现规划、交互参数、会话输出解析和完成/清理协议，不能只添加一个命令名。

## 在 Codex 中的实际体验

插件注册、启用且宿主信任 SessionStart hook（会话开始时运行的环境准备脚本）后，新会话会自动准备运行环境。PowerShell 引导入口不依赖预装 Node/npm：先验证并复用本机运行时，否则下载固定版本、核对 SHA-256 后安装到插件数据目录，再补齐锁定 SDK 和原生 CLI。直接安装入口会立即执行相同准备；插件不会自行修改宿主 hook 信任或制造登录凭据。编排子会话在宿主完成准备后禁用 hook，避免新 hook 的信任提示卡住可见任务，也不绕过信任。技能会先准备独立验收条件，再从发起工作区调用插件的绝对路径。默认使用 `--exec`，需要观察或交互时才用 `--run-windows`。仅克隆仓库不会自动注册或启用插件。

运行开始后，插件先保留每个原始任务 ID，分析依赖、冲突和未知资源；有依赖或可能冲突的任务进入同一串行块，块与块之间确认无依赖、无冲突后才并发。只有一个块时直接回到发起对话执行。每次开窗前按预测峰值检查可用内存，必须给 1000 MB 安全预留；放不下的块排队，绝不把独立块合并或硬跑。TodoList 保留原始任务身份，Execution 显示块的模式、进程、尝试次数和等待原因。普通执行必须依次出现 `started`、`completed`，窗口关闭后由主控按该块的验收条件串行检查并写入同一份报告，才会成为 `verified`；关窗、结束标记或子窗口自报不能单独证明成功。

模型语义拆分（由模型识别原子任务、依赖和资源提示）支持无项目编号但原文列明文件或目录的任务。分块器会核对所有路径提示；漏报或编造路径时整批串行，相同文件、父子目录或依赖任务也串行。Windows 系统代理仅在没有显式代理环境变量时复制到编排器进程树，不改变全局设置。`--plan` 只规划、不执行任务改动，但可能更新拆分缓存；自然语言中的隐含副作用仍须主控判断。

| 场景 | 入口 | 体验与边界 |
| --- | --- | --- |
| 多项工作后台推进 | `--exec` / `--headless` | 主对话清爽，可用 `status.mjs --watch` 观察 |
| 需要看窗口或交互 | `--run-windows` / `--visible` | 使用 Windows Terminal，只影响下一次任务 |
| 单项任务遇到断网、超时或 CLI 崩溃 | `supervise.mjs` | 有限重试并尽可能续接同一会话，副作用仍需核对 |
| 多任务运行中断 | `--resume-run <ID>` | 沿用原计划、模式和任务身份，结果不明则停在 `needs-reconciliation` |

因此，Codex 在多任务执行时少做窗口管理和人工对账，适合有明确验收条件的代码、测试和维护工作。两种执行模式都从发起窗口的结构化设置继承模型、推理级别和 service tier（服务档位）；环境变量只能在没有发起窗口设置时作为回退。当前工作树的最终离线回归为 527 项（525 通过、0 失败、2 跳过），另有 44 项聚焦回归全部通过；证据见 [RC 验收记录](docs/rc-validation.md)。运行边界是 Windows、Node.js 22+ 和已登录的原生 Codex CLI；引导入口可自动补齐缺失的 Node/npm 与 CLI。模型供应商可用性、跨机器安装、插件管理器升级/回滚和长时间断网等未验证场景不作稳定版保证。离线回归不会替它们背书，宿主原生 TodoList/spawn 卡片也不会被插件伪装成已接入。

Plugin entry: `node scripts/orchestrate-sdk.mjs`. Dependencies: `npm ci --prefix scripts`. Tests: `node --test --test-concurrency=1 test/*.test.mjs`. Coverage: `node scripts/coverage.mjs` runs the same serial suite and writes lcov to `.plugin-eval/coverage/lcov.info` (git-ignored, not published).

### 从 GitHub 安装或更新

已有解压或克隆目录时，可直接运行下面命令，Node/npm 不必预先安装：

```powershell
powershell.exe -NoProfile -File "$HOME\plugins\codex-tui-orchestrator\scripts\bootstrap.ps1" -Action install
if ($LASTEXITCODE -ne 0) { throw '插件安装失败。' }
```

`-Action prepare` 只准备环境，`-Action doctor` 准备后检查环境，`-Action run -Arguments @('--exec', '<请求>')` 传递执行参数。运行时优先放 `PLUGIN_DATA/runtime`，否则放插件内 `temp/runtime`；不修改全局 PATH，下载暂存会清理。信任边界和离线诊断见[环境准备](docs/environment-setup.md)。

下面的手工克隆流程需要 Git。真正执行任务前仍需完成 Codex 登录。更新副本前先结束活动运行；命令会拒绝本地改动，只做快进更新或首次克隆，再自动准备运行环境和运行 doctor；这一步尚未注册插件。每条原生命令失败都会停止整段。

```powershell
& {
  $ErrorActionPreference = 'Stop'
  $InstallRoot = Join-Path $HOME 'plugins\codex-tui-orchestrator'
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
  & (Join-Path $InstallRoot 'scripts/bootstrap.ps1') -Action doctor
  if ($LASTEXITCODE -ne 0) { throw '安装诊断失败。' }
}
```

上面用 `~/plugins/<名字>` 作为克隆位置（与个人 marketplace 的惯例一致）；换到别的父目录同样可行，marketplace 条目会直接指向这个 checkout。需要干净分发时再显式指定导出目录。旧位置 `~/.codex/plugins/<名字>` 也仍然能用。

#### 一条命令安装/更新（推荐）

上面那段只准备脚本副本；把它注册进插件管理器还需要补齐个人 marketplace 条目、安装、对**新缓存路径**恢复依赖并校验。`install-plugin.mjs` 把这些步骤串成一条命令，并在每次安装后对**当次安装返回的缓存路径**做完整性检查和 doctor。默认直接使用这个 checkout；需要干净包时再显式导出：

```powershell
& {
  $ErrorActionPreference = 'Stop'
  $InstallRoot = Join-Path $HOME 'plugins\codex-tui-orchestrator'   # 换成你的克隆位置
  & (Join-Path $InstallRoot 'scripts/bootstrap.ps1') -Action install -Arguments @('--pull', '--verify-skills')
  if ($LASTEXITCODE -ne 0) { throw '安装失败。' }
}
```

- 工作树不存在时先 `git clone`（见上）；`install-plugin.mjs` 不负责克隆。
- `--pull` 要求工作树干净，只做 `git pull --ff-only`。
- 个人 marketplace 文件 `<home>/.agents/plugins/marketplace.json` 不存在时按规范创建（顶层 `name: "personal"`，本插件条目默认指向 `./plugins/codex-tui-orchestrator`）；其它路径仍然要求文件已存在，既有条目与其它插件原样保留。
- `node scripts/install-plugin.mjs --check` 是只读复核：注册、可选分发一致性、缓存依赖与启用状态；`--verify-skills` 再检查技能可见性。PowerShell 引导入口会先准备依赖，严格只读复核请使用上述 Node 入口。
- 缓存根跟随 `CODEX_HOME`：`CODEX_HOME` 放在默认位置之外（例如 D 盘或自定义目录）时，校验与安装都用同一个根，不会把别处的缓存当成已安装。
- 换机器或换克隆目录后条目可能还指向旧路径：`--set-source` 默认把唯一条目的安装源改写成本机 checkout，也可以显式指定分发（保留其它条目、策略与分类）；重复、远端或无匹配条目仍然停下报错。
- `--verify-skills` 在宿主版本不支持该调试入口时只记为告警（`warnings`），不影响安装结论；需要把它当硬门槛时加 `--strict-skills`。
- 宿主 CLI 不在 PATH 上时（例如只装了桌面版自带的 `codex.exe`），先设 `CODEX_CLI_PATH`（或 `CODEX_CLI`）指向它；脚本优先使用该路径，找不到 CLI 时给出可执行提示而不是 ENOENT 堆栈。
- 技能在**新开对话**时加载，装完请开一个新对话。

依赖从锁文件恢复，不需要旧的 `node_modules` 或运行产物。保留 `skills/codex-tui-orchestrator` 的准确目录大小写。默认安装直接使用这个单一 checkout，不再自动创建 `dist` 副本；需要干净发布包时才显式执行导出。插件管理器安装会建立全新的缓存，其中不带 `scripts/node_modules`；推荐的 `bootstrap.ps1 -Action install` 会在管理器返回的新缓存路径恢复依赖、校验发行完整性并运行 doctor。doctor 不代表服务商可用或任务已完成；首次直接调用 `--doctor` 或 `--tasks` 可能补齐缺失的运行依赖。上面的手工克隆流程只准备副本；推荐的一条命令会注册并更新插件。直接调用脚本无需注册；自动加载技能需要注册、启用并新开对话。保留 Codex 登录配置与活动工作区状态。

本机安装（个人 marketplace）默认把条目指向**单一 checkout**。管理器会把插件目录整体复制进安装缓存，因此 `.git/` 和 `temp/`（本地运行状态与验收证据）也会随之复制；需要干净发布包时再使用下面的显式导出流程：

```powershell
node scripts/publish-dist.mjs --target <导出根目录> # 在 checkout 外写入干净发布包并校验
codex plugin add codex-tui-orchestrator@personal
node scripts/repair-plugin-registration.mjs --check   # 默认接受 checkout；显式分发源仍要求核心一致
```

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

运行开始时会把验收契约的规范化 SHA-256 摘要写进 `manifest.json` 和 `summary.json`；`--verify-run` 与 `--resume-run` 会重新读取契约比对摘要。契约与摘要不一致、或两份账本摘要互相冲突时直接拒绝，避免执行窗改写一份记录给自己降低验收门槛。确实要换契约（例如不确定结果后收紧检查）必须显式加 `--allow-acceptance-change` 或 `ORCH_ACCEPTANCE_OVERRIDE=1`，重新绑定会写进账本 history 留痕。旧版本记录的运行没有摘要，仍按原来方式可验收。

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
- `--cli` / `ORCH_CLI`（或 `CODEX_EXE`）选择原生 CLI；显式路径无效时直接报错。自动安装只接受版本、Windows 原生二进制 SHA-256 和完整 47 文件平台包清单均已固定校验的 `@openai/codex@0.160.0`，安装到插件私有运行目录；首次和后续执行前都核对摘要。`ORCH_CLI_INSTALL_SPEC` 只能指定这一已固定版本。
- 发起对话最近一轮结构化 `turn_context` 会提供发起窗口的 model、thinking level 和 service tier；缺失字段才从同一 `CODEX_HOME/config.toml` 补齐，两者都缺失时才使用 `ORCH_MODEL`、`ORCH_EFFORT`、`ORCH_SERVICE_TIER` 兜底，环境变量不能覆盖发起窗口设置。`ORCH_PROVIDER=openai-https`（或配置了中继地址，二者等价）会让规划器和执行窗改走 orchestrator-openai-https；`ORCH_PROVIDER=inherit` 保持继承，其它取值一律 fail-closed。
- 传输断开、超时、流中断，或启动器在写入任务检查点前异常退出时，执行块会在 `maxAttempts`（默认 2 次）预算内自动重试；已经写入 started 但无法证明结果的任务会停在 `needs-reconciliation`，不会盲目重做副作用。
- 子窗口继承发起 Codex 会话的结构化沙箱、审批策略和工作目录。受限会话不能改用其他工作区；会话策略缺失时拒绝开窗。脱离会话直接调用 CLI，须在原生配置或 `ORCH_SANDBOX` / `ORCH_APPROVAL` 中明确给出策略。需要交互审批时，默认 headless 改用可见窗；显式 headless 请求会被拒绝。只有实际策略为 `danger-full-access` 加 `never` 时才加免审批参数和本次调用专用的项目信任覆盖；不改全局 `config.toml`。
- Headless uses hidden workers and codex exec --json with stdin prompts. Visible mode prefers Windows Terminal with conhost fallback and inherited interactive stdout. ORCH_TUI applies only to visible mode. Accepted values are `wt`, `conhost` and `inactive`; any other `ORCH_TUI` value fails closed at startup.
- WORKSPACE_DIR 选择任务工作区，CODEX_HOME 选择 Codex 配置和会话存储。默认工作区是调用者当前目录，也可用 --workspace / WORKSPACE_DIR 覆盖。运行账本、检查点、窗口注册表和编排器启用标记都留在 `workspace/temp/orchestrator`（ORCH_STATE_DIR 默认位置）；拆块缓存和内存预算状态也在这里。窗口注册表和启用标记属于工作区内的调度元数据，拥有 workspace-write 的子任务可以删除或修改它们，因此不能把它们当作安全边界。Codex 协调器独立使用外部 controller state 和 `temp/orchestrator/codex-coordinator`，不会与 open-tui-orchestrator 共用租约池；可见启动器、headless 控制、验收绑定和不可变运行计划绑定也使用外部 controller state。不同工作区的 Codex 运行共享该定位器，运行结果仍留在各自工作区。ORCH_COORDINATOR_DIR 是仅用于明确共享 Codex 容量池的高级覆盖项，必须位于发起工作区之外。
- Task temporary artifacts and the window registry remain under workspace/temp and are handled by the existing cleanup protocol; controller-owned launchers and acceptance controls remain under CODEX_HOME. Do not delete active runtime state. ORCH_SESSION_DIR can override session discovery.
- provider 明确返回账户用量上限（本次账号额度已耗尽），例如 usage_limit_exceeded、quota_exceeded 或 "You've hit your usage limit" 时，立即 fail-closed；适配器只接受结构化 `error`/`turn.failed` 事件或 `task_complete.error` 中的 provider 错误，任务文本和工具输出不会被当作配额依据。它不会消耗块的普通失败预算，也不会再开替代窗口，需等 provider 配额恢复后再重试。

## Completion / 完成

窗口会先检查真实输出，再发出本次令牌对应的 `__ORCH_DONE__` 标记。看门狗（监视子进程并在异常时收尾的组件）只把助手输出当作完成线索；主控还会独立验收输出，并收集每个块的终态。子窗口不得递归启动编排器或子代理。

每次运行都会持久化主控拥有的 `manifest.json`、结构化 `todoList` 和 `goal.json`。规划器先从这份清单分块，每个执行块都会收到全局 TodoList 和本块视图。Goal 状态是运行/块/任务状态的本地持久镜像；Codex 宿主可以用会话级 Goal 做高层跟踪，但 TUI 窗不会直接调用宿主 Goal 工具。

授权模板只表达用户范围和宿主规则，不能授予额外权限。只能使用当前可用的技能；失败和阻塞必须报告，不能改写成成功。

## Verification scope / 验证边界

Automated tests exercise grouping, dependency-ready scheduling, locks, native CLI selection, fail-closed errors, generated PowerShell launchers, watchdog auto-close and process-tree cleanup using controlled child processes. They do not establish real model/provider availability or prove that every future agent is supported. A real model-backed visible-window acceptance run is a separate check.

专项验收测试命令为 `node --test --test-concurrency=1 test/execution-acceptance.test.mjs`。它检查 headless 与可见 TUI 的 model/effort 一致性、worker 实际 argv、TodoList 实时状态、spawn 群状态事件，以及宿主原生卡片接入边界。设置 `ORCH_REAL_CODEX_ACCEPTANCE=1` 会额外运行一次真实 headless 和一次真实可见 TUI；该检查需要已配置 Codex 账户和 Windows 桌面环境。

## Capacity-constrained planning

Capacity is dynamic by default (`ORCH_CAPACITY_MODE=dynamic`): planning preserves every atomic task and groups only dependency, conflict or unknown-scope components into serial blocks. If the result has one block, the initiating conversation executes it directly. Before orchestration, available memory at or below 1000 MB returns an inline decision. Before every window opens, the runner atomically rechecks available memory and reserves the predicted peak. A block starts only when its predicted peak is strictly below available memory minus the mandatory 1000 MB reserve; otherwise it remains queued until a lease is released. Independent blocks are never merged to fit memory, and there is no hard-run escape. Each window uses the rolling observed cost (default 400 MB, with declared task memory added once per serial block). Capacity limits the number of independently planned blocks only as an explicit safety bound; memory admission is the live queue.

An explicit capacity below the number of independent blocks is rejected so the planner cannot silently change the user's concurrency graph. Tasks inside a dependency or conflict component execute serially in dependency order, and all task bodies and conflict keys are retained. The shared coordinator applies atomic leases across active and reserved windows.

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


### WSL 现成入口（推荐直接用）

- `bash scripts/wsl/orch.sh <参数>`：从 WSL 调用编排器。它会自动（1）找到 Windows 版 node.exe；（2）把当前 shell 里的全部 `ORCH_*` 变量经 `WSLENV` 转发给 Windows 侧；（3）把 `--workspace` / `--acceptance-file` 的 `/mnt/...` 路径翻译成 `C:...`。例：`ORCH_EXEC_MODE=visible bash scripts/wsl/orch.sh --doctor`（实测 `executionMode=visible`，说明转发生效）。
- `bash scripts/wsl/run-tests.sh [测试文件...]`：从 WSL 跑离线回归。它经 Windows `cmd.exe` 执行，并把 `C:Program FilesGitcmd` 与插件 `scripts` 目录补进 PATH（此前从 WSL 直接跑会因解析不到 `git` 而假失败）。不带参数即跑全量。
- 两者都用 `ORCH_NODE_EXE` 覆盖 node.exe 路径（可选）。

## 发行成熟度
当前属于候选版。发布校验、清理保护和跨环境验收要求见 [发布规则](docs/release-policy.md)；每次代码或封存哈希变化后，都要重新确认适用的验证证据。

当前候选 core 1.4.4-rc.1 的证据边界见 [RC 验收记录](docs/rc-validation.md)。此前版本的窗口、包、容量和缓存同步记录均是对应快照的历史证据，不能证明当前代码已实测或当前缓存仍同步。

2026-09-13 的真实 Windows 重启后，提交 `0fca067` 的发行完整性、doctor 和 marketplace 注册经显式补收集全部通过。登录后的自动收集未触发，未完成模型任务的跨重启恢复也未认证；具体证据和补收集方式见 [重启验收说明](docs/network-reboot-validation.md)。

隐私与使用条款见 [隐私说明](docs/privacy.md) 与 [使用条款](docs/terms.md)。

许可采用 [MIT License](LICENSE)；[中文说明](LICENSE-zh.md) 供阅读参考。

安装与不同 CLI 版本的已验证范围见 [兼容验收](docs/compatibility.md)。
