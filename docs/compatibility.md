# 安装与 CLI 兼容验收

## 当前环境准备入口

当前版提供不依赖预装 Node/npm 的 `scripts/bootstrap.ps1`，以及宿主信任后运行的 SessionStart hook。它复用已验证运行时，必要时安装经校验的便携 Node、锁定 SDK 和固定版本原生 CLI；登录仍由宿主账户提供。详见[环境准备](environment-setup.md)。下面关于“CLI 由宿主预装”的描述属于当时版本测试条件，不是当前自动准备能力的限制。

当前专用核心为 1.4.1-rc.1，当前验证见 [RC 验收记录](rc-validation.md)。以下是 1.3.1 历史矩阵：现场当时已确认的 Codex CLI 为 0.153.4，Windows Terminal 为 1.24.11911.0；SDK 锁定版本和历史 1.2.x 记录仍按下表标注。下表只列实测范围，不是所有功能和环境的兼容保证。完整字段见 [1.3.1 兼容矩阵](../test/compatibility-matrix-1.3.1.json)。

| Codex CLI | 环境 | 已通过 | 未覆盖 |
| --- | --- | --- | --- |
| 0.153.4 | 当前 Windows、Node 22.23.2、WT 1.24.11911.0 | doctor、只读状态、授权参数、工作区传递、八窗启动观测（当前回执受额度限制） | 持续断网、系统重启 |
| 0.149.0 | 同一 Windows、Node 22.23.2 | SDK 锁文件安装验证 | 没有该版本原生 CLI，不能推断 CLI 兼容；八窗压力、持续断网、系统重启 |

## 锁文件安装验证

2026-09-06：生成独立发行包，使用全新的 npm 缓存，实际从 registry 下载两个锁定依赖包；日志记录两次 cache miss。没有复制已有 SDK，也没有修改全局安装。

在已经安装原生 Codex CLI 的环境下，使用：

```powershell
npm ci --prefix "<插件目录>/scripts" --omit=optional --ignore-scripts --no-audit --no-fund
node "<插件目录>/scripts/orchestrate-sdk.mjs" --doctor
```

历史测试另外指定了独立 `--cache` 目录。`--omit=optional` 不下载可选的原生 CLI 包，测试显式选择本机已有 CLI；这条历史记录不是新 Windows 账户或无 CLI 环境的安装认证。当时由宿主预装原生 CLI。

## 依赖异常

缺包、版本不符、入口文件缺失或不可读、无效 package.json 或 exports 配置，会在进入执行引擎前给出明确诊断及锁文件恢复命令。不会自动修改全局依赖。完成状态轮询继续不依赖 SDK。

证据：[当前版本安装与恢复记录](../test/install-compatibility-1.2.1.json)、[0.153.4 八窗验收](live-validation-1.2.1.md)。旧版本测试过程中核心文件保持不变，第一项执行一次，恢复只接管原窗口，会话审批为 never。

剩余发行门槛包括：新用户环境（第二台机器）、未完成任务跨系统重启恢复。长期弱网（30 分钟窗口）、插件管理器升级/回滚（隔离 `CODEX_HOME` 与私有分发源两次实测）已通过，见 [RC 验收记录](rc-validation.md)。未列出的 CLI 版本仍未经验证。

第二台机器（Lecoo mini pro，全新 Windows 用户环境）到货后的安装与验收步骤、证据清单和已知坑见 [干净机器安装与验收](clean-machine-validation.md)；该清单把"新用户环境"这条门槛拆成可逐条执行的检查项，未跑完之前仍保持"未经验证"。

本轮当前源码和通用源码的最终回归数字见发布策略；矩阵中的“未验证”保持为未验证，不用另一行的通过结果替代。临时探针只写入发起工作区的 `temp` 家族，并在验证后清理。
