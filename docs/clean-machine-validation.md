# 干净机器安装与验收

目的：在一台**全新 Windows 机器**上证明"私有仓库 → 干净分发 → 依赖安装 → 完整性校验 → 真实执行"整条链路可用，并留下可核对的版本与结果证据。可以使用新装系统的虚拟机或第二台实体机器；本仓库保持 private，安装只依赖私有 Git 凭据，不需要任何公网发布。

## 如何取得干净环境

- GitHub Actions 的 Windows 托管作业每次取得新虚拟机，适合重复运行离线回归、完整性校验和无凭据的安装脚本检查。镜像预装开发工具，因此**不能**证明从没有 Node/npm/Codex CLI 的系统自动补齐成功。微软的 Windows 应用测试文档说明托管 Windows 作业可以运行自动化 GUI 测试，但这里仍须另写可见 TUI 自动化与登录方案；目前的离线作业不能替代手动观察真实交互窗。仓库的 `validate.yml` 当前在 GitHub 上处于 `disabled_manually`，没有远端回执。
- 本地 Windows 虚拟机适合首次安装、GUI 登录、可见窗口、失败后的快照恢复。先安装正版或符合许可条件的 Windows 11，建立“只有 Windows 和 Git、无 Node/npm、无 Codex CLI”的快照，再依次运行下面的引导、离线回归、真实双模式验收。第二个快照可保存已登录的 Codex GUI；凭据不要放入可分享镜像或提交到仓库。
- 第二台实体机用于确认虚拟硬件和宿主特性没有掩盖驱动、终端、代理或内存问题。三个环境的测试结果分别记录，不能相互冒充。

本机 Windows 11 家庭版不支持 Windows Sandbox 或 Hyper-V 管理功能。若在这台机器上选用第三方虚拟机，需先验证其与已运行的 WSL2/Windows 虚拟化层能否稳定共存；不得为测试擅自停用 WSL、改启动配置或重装系统。

## 前置条件

- Windows 11（记录版本号）+ Git（`git --version` 能在 PATH 里解析）。
- 不要求 Node/npm 或原生 Codex CLI 预先安装；PowerShell 引导入口负责检测和补齐。已有 Node 必须为 Windows 原生 22+。
- 真正执行模型任务前需 Codex 登录；插件继承发起窗口设置，不在插件内保存任何凭据。
- 可选：Windows Terminal（可见窗模式 `ORCH_TUI=wt` 需要）。
- 私有仓库凭据：SSH key（`git clone git@github.com:yechang1450/codex-tui-orchestrator.git`）或 HTTPS + PAT。

## 一、克隆与完整性校验

以下使用本机统一的插件父目录。已有解压包时可跳过 Git，直接运行 bootstrap。第二台机器仍需完整实测；本机隔离缺失依赖测试不能代替它。

```powershell
git clone git@github.com:yechang1450/codex-tui-orchestrator.git "$HOME\plugins\codex-tui-orchestrator"
if ($LASTEXITCODE -ne 0) { throw '克隆失败。' }
& "$HOME\plugins\codex-tui-orchestrator\scripts\bootstrap.ps1" -Action install -Arguments @('--verify-skills')
if ($LASTEXITCODE -ne 0) { throw '准备或安装失败。' }
```

期望：运行时准备、干净分发、安装缓存完整性和 doctor 全部成功。计数随发布变化，以当前 `release.json` 为准。宿主 hook 需单独信任，详见[环境准备](environment-setup.md)。

## 二、手工诊断路径（已有 Node/npm）

开发树里的 `temp/`（本机证据与运行状态）与 `.git/` 不该进安装缓存，因此**从分发目录注册/运行**，不要直接把开发树挂成安装源：

```powershell
node scripts\publish-dist.mjs
cd "$HOME\plugins\dist\codex-tui-orchestrator"
npm ci --prefix .\scripts --omit=optional --ignore-scripts --no-audit --no-fund
node scripts\orchestrate-sdk.mjs --doctor
```

期望：`publish-dist` 报告分发路径与文件数（约 194 个，随发布变化）；分发目录里没有 `.git/`、`temp/`、`node_modules/`；`--doctor` 输出 JSON，`cli` 指向真实 `codex.exe`。若 CLI 探测超时导致 `CLI_MISSING`，用 `set ORCH_CLI=<codex.exe 绝对路径>` 明确指定。

注册并安装（个人 marketplace 条目指向分发，而不是开发工作树）：

```powershell
node scripts\repair-plugin-registration.mjs --check   # 期望 status=matched、sourceKind=dist
codex plugin add codex-tui-orchestrator@personal
npm ci --prefix <安装缓存路径>\scripts --omit=optional --ignore-scripts --no-audit --no-fund
node <安装缓存路径>\scripts\release-integrity.mjs      # 安装副本自校验
```

期望：安装缓存里只有运行时文件（约 194 个、2 MB，没有 `.git/`、`temp/`、`node_modules/`），且它的 `scripts\core` 与工作树逐字节一致；`codex plugin list` 能看到该插件。若注册校验报 `stale_dist`，说明分发比工作树旧，重新跑一次 `publish-dist` 再安装。

## 三、离线回归（源码目录内）

测试文件不进入发布分发；在克隆源码目录执行。不要在分发目录声称测试通过。

```powershell
Set-Location "$HOME\plugins\codex-tui-orchestrator"
node --test --test-concurrency=1 test/*.test.mjs
```

期望：零失败；需显式启用的真实模型用例会跳过，再单独运行真实验收。最新计数见 [RC 记录](rc-validation.md)，不得拿历史的 302 项计数认证当前源码。任何失败保留原始诊断、查明根因、修复后重跑对应测试和完整回归。

## 四、真实执行验收（headless）

两个任务才能进编排（单任务请求按设计直接判 out-of-scope）。验收文件示例 `checks.json`：

```json
{
  "T001": [{"type": "json", "path": "temp/one.json", "equals": {"id": "one", "answer": 42}}],
  "T002": [{"type": "json", "path": "temp/two.json", "equals": {"id": "two", "answer": 42}}]
}
```

```powershell
node scripts\orchestrate-sdk.mjs --workspace <工作区> --run-id <新ID> --acceptance-file <checks.json 绝对路径> --exec "在 <工作区> 创建 temp/one.json（id=one、answer=42）；在 <工作区> 创建 temp/two.json（id=two、answer=42）。"
```

期望：退出码 0，`<工作区>\temp\orchestrator\runs\<ID>\summary.json` 里 `success=true`、两个任务 `verified`。同一目录下 `manifest.json` 与 `summary.json` 都应出现 `acceptance.sha256`。

## 五、验收契约绑定（回归检查）

执行窗能改写工作区，所以验收契约与账本绑定：改写 `<run>\acceptance.json` 后再次验收必须被拒绝。

```powershell
node scripts\orchestrate-sdk.mjs --verify-run <ID>                        # 期望：Acceptance contract changed ...（退出码 1）
node scripts\orchestrate-sdk.mjs --verify-run <ID> --allow-acceptance-change  # 显式接管：告警 + 重新绑定 + 账本 history 记 acceptanceRebound
```

## 六、可见 TUI 验收（可选但建议）

```powershell
$env:ORCH_TUI = 'wt'
node scripts\orchestrate-sdk.mjs --workspace <工作区> --run-id <新ID> --acceptance-file <checks.json> --run-windows "同样的两任务请求"
```

观察点：双通道面板（TodoList + Execution）刷新；块结束后窗口自动关闭；编排结束屏幕上不残留"代码 1"错误窗；`status.mjs --watch` 能只读跟随状态。

## 七、要记录的证据

| 项目 | 采集方式 |
| --- | --- |
| 机器与系统 | 型号（Lecoo mini pro）、内存、`winver` 版本、`node -v`、`codex --version`、WT 版本 |
| 完整性 | `release-integrity.mjs` 输出 |
| 分发 | `repair.mjs --target` 输出 + 文件数 |
| 回归 | 测试汇总行（tests / pass / fail / skipped） |
| 真实执行 | `summary.json` 的 `success`、任务状态、`acceptance.sha256`、耗时 |
| 契约绑定 | `--verify-run` 的拒绝输出与 override 后的 history 记录 |

证据先落在工作区 `temp/` 与本机插件目录，稳定后再把摘要 JSON 提交到 `test/`，保持账实一致。

## 本机实测的已知坑

- **首次在全新工作区运行**：`temp\orchestrator` 不存在时，加锁会因目录缺失失败（已修复：加锁前先建目录）。修复前表现为规划静默退化成单串行块，或直接 `out-of-scope`。
- **机器繁忙时进程枚举超时**：Windows CIM 查询在负载下会超时；身份校验现在有 3 次有界重试，且没有 pid 文件时不再枚举。身份不一致仍然立即失败，不做降级。
- **单任务请求**：按设计不进编排，直接提示用 Codex 普通执行；验收用例至少给两个任务。
- **私有仓库**：`git clone` 需要凭据；插件运行期不访问 GitHub，也不需要公网发布或 marketplace。
- **可见窗模式**：没有 Windows Terminal 时退回 conhost，功能等价但外观不同。

## 本清单不覆盖

跨 Codex CLI 大版本矩阵、长时间断网、真实断电与重启恢复（如需请另跑 `test/live-powerloss.mjs`、`test/live-reboot-recovery.mjs`、`test/live-provider-outage.mjs`），以及多台机器同时写同一 `temp/` 共享目录的场景。
