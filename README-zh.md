# agent-tui-orchestrator

> 作者：**Yang Wenchàng**

把多部分请求按「并发冲突」拆成 **安全并行块**，并通过 **真实可见的 Codex TUI 窗** 执行——独立任务并发、会破坏的串行。

> 命名说明：插件 id、`name` 字段、目录、GitHub 仓库、显示名均为小写连字符 `agent-tui-orchestrator`，符合 Codex 插件清单规范。

## 能力结构（多合一）

插件只暴露 **一个 skill**（`skills/agent-tui-orchestrator/SKILL.md`），拆块分类、冲突锁、依赖排序、原型门禁（确定性+LLM）、注册表、窗口运行时、结果汇聚、执行门禁、拆块缓存、清洁、归因验证 **12 项能力全部内嵌其中**，恒启用、无开关；可调参数只有 `ORCH_*` 环境变量。

## 编排设计（依赖图 + 有界并行）

核心判断轴：
> **同时跑这两个任务，会不会破坏东西？**

- 会（都改同一文件/配置、重启同一服务、用同端口/库、一个依赖另一个输出）→ **linked** → 合并为单块，**严格串行**。
- 不会（改不相交文件/子系统）→ **independent** → 各自独立块，**并行**。

## 运行方式

- **`--run-windows`（真实执行的引擎）**：拆块后，每个 independent 块弹出自己的真实、可交互 Codex TUI 窗（默认 Windows Terminal）并行运行；linked 块单窗串行。执行前 SDK 预检与运行中窗口的冲突，冲突则等待，仍冲突则上锁。每窗任务完成即自动关窗（经会话 task_complete + 结果回写兜底），结果汇总到 `temp/win-summary.json`。
- **`--spawn`（真实可交互窗）**：弹出带预置提示词的真实终端运行 Codex。
- **`--run` / `--exec`（无头 SDK 线程）**：仅供纯自动化；真实改动必须走 `--run-windows`（见 AGENTS.md）。

## 用法

```bash
node orchestrate-sdk.mjs --plan "1. ... 2. ... 3. ..."
node orchestrate-sdk.mjs --run-windows "1. ... 2. ... 3. ..."
node orchestrate-sdk.mjs --spawn "My Task" "./temp/my-task.md"
```

## 拆块缓存（越用越快）

相同请求缓存 **永久**（`orchestrator-decompose-cache.json`）且**永不自动失效**——仅手动 `--clear-cache`（或删除缓存文件）才会重置。首次请求走规则+LLM 拆块，之后相同请求立即命中缓存。完全可移植——对**任意用户**有效，**无硬编码路径**。

## 配置（环境变量，全部可选）

| 变量 | 默认 | 含义 |
|-----|------|------|
| `WORKSPACE_DIR` | `process.cwd()` | 工作目录（自动探测，从不硬编码）。 |
| `CODEX_EXE` | 自动检测 | `codex` CLI 路径。 |
| `PYTHON` | `python` | 预制到弹窗 PATH 的 Python。 |
| `ORCH_MODEL` | `Codex 默认模型（不指定时用 Codex 自身默认）` | 线程用模型。 |
| `ORCH_EFFORT` | `high` | 推理档位（low/high/max，通用）。 |
| `ORCH_TIMEOUT_MS` | `20000000` | 等全部窗完成的总时长上限。 |
| `ORCH_DECOMPOSE_TIMEOUT_MS` | `6000000` | 只读 LLM 拆块超时。 |
| `ORCH_RETRIES` | `2` | 块重试次数。 |
| `ORCH_WAIT_MS` | `120000` | 等待冲突窗关闭的最长时间。 |
| `ORCH_CLOSE_DELAY_MS` | `1000` | 窗完成后自动关窗的读缓冲。 |
| `ORCH_TUI` | `wt` | `wt`=Windows Terminal（最佳 CJK 输入法），`conhost`=经典控制台。 |

## 编码与输入法

所有文本读写**显式 UTF-8**；启动器设 `[Console]::OutputEncoding`/`$OutputEncoding = UTF-8` 并用 `-Encoding UTF8` 读提示词。`.ps1` 启动器**UTF-8 带 BOM** + `chcp 65001`，防止中文在中文 Windows（默认 GBK/936）上乱码。

## 依赖

- Node 18+（ESM）。
- `@openai/codex-sdk`（见 `scripts/package.json`）。
- 可用的 Codex CLI（模型可经 `ORCH_MODEL` 配置）。

## 许可证

MIT——见 `LICENSE`。

## 免责声明

本工具会执行真实改动（写/建/装/测/重启/进程管理）。请先看 `--plan` 并做好备份。按"AS IS"提供，无任何保证；版权持有者不承担使用带来的损害。
