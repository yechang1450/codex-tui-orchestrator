# 干净机器安装与验收

目的：在一台全新的 Windows 环境中验证“仓库 checkout → 安装 → 依赖准备 → 完整性校验 → 真实执行”的链路，并保留可核对的版本与结果证据。完成本清单只说明所记录的候选和环境已完成相应步骤；它不替代其他版本、其他宿主或其他网络条件的验证。

## 选择干净环境

- GitHub Actions 的 Windows 托管作业适合重复运行离线回归、完整性校验和无凭据安装脚本检查。预装开发工具的镜像不能证明从缺少 Node、npm 和 Codex CLI 的环境可自动准备，也不能替代可见 TUI 或登录验证。
- 本地 Windows 虚拟机适合首次安装、GUI 登录、可见窗口和失败后的快照恢复。建立只含 Windows 与 Git 的快照，再依次执行下面的引导、离线回归和真实验收。不要把登录凭据放入可分享镜像或提交到仓库。
- 独立实体机器可用于确认虚拟化环境没有掩盖终端、驱动或内存问题。分别记录每个环境的结果，不要相互替代。

选择与现有工作负载可以稳定共存的虚拟化方案；不要为了本清单改动系统启动、虚拟化或安全设置。

## 前置条件

- Windows 11（记录版本号）和 Git（`git --version` 能在 PATH 中解析）。
- 不要求预先安装 Node、npm 或原生 Codex CLI；PowerShell 引导入口负责检测和准备。已有 Node 必须为 Windows 原生 22+。
- 真正执行模型任务前需要登录 Codex；插件继承发起窗口设置，不保存任何凭据。
- 可选：Windows Terminal（可见窗模式 `ORCH_TUI=wt` 需要）。

## 一、克隆与完整性校验

使用仓库的规范 HTTPS 地址；下面的 URL 是占位示例，执行前替换为待验证仓库的实际地址。已有源码归档时可以跳过克隆并直接运行 bootstrap，但仍应在独立环境完成完整实测。

```powershell
$repositoryUrl = 'https://github.com/<owner>/<repository>.git'
$pluginRoot = Join-Path $HOME 'plugins\codex-tui-orchestrator'
git clone $repositoryUrl $pluginRoot
if ($LASTEXITCODE -ne 0) { throw '克隆失败。' }
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$pluginRoot\scripts\bootstrap.ps1" -Action install -Arguments @('--verify-skills')
if ($LASTEXITCODE -ne 0) { throw '准备或安装失败。' }
```

若要验证匿名 HTTPS 克隆，请在未登录 GitHub 的环境中重复本节并单独记录结果。需要认证的开发副本不构成匿名克隆证据。

期望：运行时准备、单一 checkout 注册、安装缓存完整性和 doctor 都成功。计数随发布变化，以当前 `release.json` 为准。宿主 hook 需单独信任，详见[环境准备](environment-setup.md)。

## 二、手工诊断路径（已有 Node/npm）

第一节的 Bootstrap 是正式安装入口。它会标记本地 checkout 开发安装，注册仓库内的 `.agents/plugins/marketplace.json`，调用宿主 marketplace 命令安装插件，再验证安装副本。直接调用安装脚本时，checkout 安装必须显式带 `--local-development`，以免把开发树误当成公开分发包。

安装后可用只读检查核对当前状态：

```powershell
Set-Location $pluginRoot
node scripts\install-plugin.mjs --check
```

期望：默认安装和注册都指向单一 checkout，不创建 `dist` 目录；检查会确认安装缓存、依赖和宿主启用状态。需要审查干净包时另行运行 `node scripts\publish-dist.mjs --target <导出根目录>`，不要把导出目录放回 checkout 内。若 CLI 探测超时导致 `CLI_MISSING`，可用 `$env:ORCH_CLI = '<codex.exe 绝对路径>'` 明确指定。

核对宿主的本地 marketplace 与已安装插件：

```powershell
node scripts\repair-plugin-registration.mjs --check   # 期望 status=matched、sourceKind=checkout
codex plugin marketplace list --json
codex plugin list --json
```

期望：marketplace 列表中有根目录为当前 checkout 的 `codex-tui-orchestrator-local`；`codex plugin list` 中有 `codex-tui-orchestrator@codex-tui-orchestrator-local`。宿主可能把本地安装缓存目录标记为 `local`，安装副本的 manifest 版本仍须等于当前发布版本。只有显式注册分发源时才会检查 `stale_dist`，此时重新运行带 `--target` 的 `publish-dist` 再安装。

## 三、离线回归（源码目录内）

测试文件不进入发布分发；在克隆源码目录执行。不要在分发目录声称测试通过。

```powershell
Set-Location $pluginRoot
node --test --test-concurrency=1 test/*.test.mjs
```

期望：零失败；需显式启用的真实模型用例会跳过，再单独运行真实验收。最新计数见 [RC 记录](rc-validation.md)，不得拿历史计数认证当前源码。任何失败都应保留原始诊断，查明根因后重跑对应测试和完整回归。

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
node scripts\orchestrate-sdk.mjs --verify-run <ID>                           # 期望：Acceptance contract changed ...（退出码 1）
node scripts\orchestrate-sdk.mjs --verify-run <ID> --allow-acceptance-change # 显式接管：告警 + 重新绑定 + 账本 history 记 acceptanceRebound
```

## 六、可见 TUI 验收（可选但建议）

```powershell
$env:ORCH_TUI = 'wt'
node scripts\orchestrate-sdk.mjs --workspace <工作区> --run-id <新ID> --acceptance-file <checks.json> --run-windows "同样的两任务请求"
```

观察点：双通道面板（TodoList + Execution）刷新；块结束后窗口自动关闭；编排结束屏幕上不残留“代码 1”错误窗；`status.mjs --watch` 能只读跟随状态。

## 七、要记录的证据

| 项目 | 采集方式 |
| --- | --- |
| 机器与系统 | 设备类型、可用内存、`winver` 版本、`node -v`、`codex --version`、WT 版本 |
| 完整性 | `release-integrity.mjs` 输出 |
| 安装与 marketplace | Bootstrap 摘要、`codex plugin marketplace list --json`、`codex plugin list --json` |
| 回归 | 测试汇总行（tests / pass / fail / skipped） |
| 真实执行 | `summary.json` 的 `success`、任务状态、`acceptance.sha256`、耗时 |
| 契约绑定 | `--verify-run` 的拒绝输出与 override 后的 history 记录 |

证据先保存在工作区 `temp/` 与本机插件目录；稳定后再把可公开的摘要 JSON 提交到 `test/`，保持账实一致。

## 已知限制与诊断提示

- 单任务请求按设计不进入编排；验收用例至少给两个任务。
- Windows 进程枚举在负载下可能超时。保留原始诊断，并且不要把无法核验的进程身份当作成功。
- 没有 Windows Terminal 时可见窗会使用可用的控制台宿主；同时记录实际宿主与观察结果。

## 本清单不覆盖

跨 Codex CLI 大版本矩阵、长时间断网、真实断电与重启恢复（如需请另跑 `test/live-powerloss.mjs`、`test/live-reboot-recovery.mjs`、`test/live-provider-outage.mjs`），以及多台机器同时写同一 `temp/` 共享目录的场景。
