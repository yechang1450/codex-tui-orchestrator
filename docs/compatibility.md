# 安装与 CLI 兼容验收

当前专用核心为 1.3.4-rc.1，当前验证见 [RC 验收记录](rc-validation.md)。以下是 1.3.1 历史矩阵：现场当时已确认的 Codex CLI 为 0.153.4，Windows Terminal 为 1.24.11911.0；SDK 锁定版本和历史 1.2.x 记录仍按下表标注。下表只列实测范围，不是所有功能和环境的兼容保证。完整字段见 [1.3.1 兼容矩阵](../test/compatibility-matrix-1.3.1.json)。

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

测试另外指定了独立 `--cache` 目录。`--omit=optional` 不下载可选的原生 CLI 包，测试显式选择本机已有 CLI；这不是新 Windows 账户或无 CLI 环境的安装认证。原生 CLI 的安装仍由宿主环境负责。

## 依赖异常

缺包、版本不符、入口文件缺失或不可读、无效 package.json 或 exports 配置，会在进入执行引擎前给出明确诊断及锁文件恢复命令。不会自动修改全局依赖。完成状态轮询继续不依赖 SDK。

证据：[当前版本安装与恢复记录](../test/install-compatibility-1.2.1.json)、[0.153.4 八窗验收](live-validation-1.2.1.md)。旧版本测试过程中核心文件保持不变，第一项执行一次，恢复只接管原窗口，会话审批为 never。

剩余发行门槛包括：新用户环境、实际插件管理器升级回滚、长期弱网及系统重启验收。未列出的 CLI 版本仍未经验证。

本轮当前源码和通用源码的最终回归数字见发布策略；矩阵中的“未验证”保持为未验证，不用另一行的通过结果替代。临时探针只写入发起工作区的 `temp` 家族，并在验证后清理。
