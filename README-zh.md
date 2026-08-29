# codex-orchestrator（中文说明）

> Author: **Yang Wenchàng**

把一个多任务请求拆成**安全的并行块**再执行：独立的工作并发跑，会互相破坏的则串行。

## 编排思想（依赖图有界并行）

底层模型仍是**依赖图**，但它给「同一时刻跑多少」加了个上限：**有界并行**。大多数编排器最大化吞吐；这个工具按更保守的轴分类：

> **这两个任务"同时跑"会不会出问题？**

- **会**（改同一文件/配置、重启同一服务、用同一端口/DB、一个依赖另一个、有先后关系）→ 它们是**联动** → 合成**一个块**，**严格串行**，绝不并行。
- **不会**（动的是不相干的文件/子系统）→ **独立** → 各开**自己的块**，**并行**。

这正是保护真实开发的那条规则：把两个都改同一配置的任务并行，正是搞坏项目的典型路径；这个工具拒绝那样干。

## 怎么跑

- **`--run-windows`**（真实执行的主引擎）：拆解→每个**独立块**开自己的**真·可见交互式 Codex TUI 窗**（默认 Windows Terminal）**并行跑**；每个**联动块**留在**一个窗**里串行。执行前会 **SDK 预检**：与正在跑的窗冲突则**等待其关闭**再执行。每个窗执行完**自动关闭**（检测会话 `task_complete`），结果汇总到 `temp\win-summary.json`；与正在跑的窗（或本批已弹的其它块）冲突、且等待后仍冲突的块才**上锁不弹**。
- **`--spawn <标题> <提示或.md>`**：为单一任务弹一个**真·交互式** codex 窗；适合想盯着看并手动交互，手动 `/exit` 或 Ctrl+C 关闭。
- **`--run` / `--exec`**（Codex SDK，可靠、无窗）：拆解→每块一个 SDK 线程（独立块并发、联动块按块串行），**失败自动重调一次**，结果汇总到 `temp\win-summary.json`。**仅供纯自动化**，真实改动用 `--run-windows`（见 AGENTS.md）。
- **`--status`**：列出正在跑的窗（各自在干什么、冲突资源）、待解锁的锁；窗被手动关掉会自动释放锁。

## 冲突检测与上锁（稳定性，2026-08-24）

拆解时每块都会输出 **`conflictKeys`**（它碰到的资源：`file:<路径>`/`port:<端口>`/`service:<服务>`/`dir:<目录>`，**宁可多列别漏**）。`--run-windows` 发起新任务前，会拿新块的 `conflictKeys` 与**正在跑的窗**比对：

- **有重叠（可能冲突）→ 给新任务上锁**，不弹窗；等那个冲突窗被手动关闭后，锁自动释放，再执行。
- **无重叠 → 直接弹窗并行**，不锁。

（实际实现由 SDK 预检：冲突时先**等待**冲突窗关闭再执行，仅当等待超时仍冲突才落为本批锁并跳过。）

这让你能看着窗干活，就不容易发起和正在跑任务冲突的新任务，从根上避免撞车。

## 使用（Usage）

从 `scripts/` 目录运行：

```bash
# 只读拆解，打印块分类，执行前先看 plan
node orchestrate-sdk.mjs --plan "1. ... 2. ... 3. ..."

# 真实执行主引擎：独立块并行弹窗、联动块串行；冲突自动等待/上锁
node orchestrate-sdk.mjs --run-windows "1. ... 2. ... 3. ..."

# 单个任务弹一个真·交互式 codex 窗，手动 /exit 或 Ctrl+C 关闭
node orchestrate-sdk.mjs --spawn "任务标题" "./temp/my-task.md"

# 列出正在跑的窗与待解锁的锁
node orchestrate-sdk.mjs --status
```

## 安装

```bash
npm install @openai/codex-sdk
```

然后从 `scripts/` 运行。用 `CODEX_EXE` 指定 codex CLI 路径（会自动探测几个常见位置，并回退到 PATH 上的 `codex`）。

## 配置（环境变量，都可选）

| 变量 | 默认 | 说明 |
|------|------|------|
| `WORKSPACE_DIR` | `process.cwd()` | SDK 线程/弹窗的工作目录（你的仓库，如 `$WORKSPACE_DIR`）。 |
| `CODEX_EXE` | 自动探测 | codex CLI 可执行路径。 |
| `PYTHON` | `python` | 弹窗里前置到 PATH 的 Python（供模型/venv 脚本）。 |
| `ORCH_MODEL` | `deepseek-v4-flash-vision-exp` | 线程用的模型。 |
| `ORCH_EFFORT` | `high` | 推理强度。 |
| `ORCH_TIMEOUT_MS` | `420000` | 超时视作该块失败。 |
| `ORCH_RETRIES` | `2` | 重试次数。 |
| `ORCH_WAIT_MS` | `120000` | 等待冲突窗关闭的最长时间。 |
| `ORCH_CLOSE_DELAY_MS` | `1000` | 任务完成后自动关窗的缓冲（约 1 秒）。交互 launcher 自身还带 watchdog：检测到会话 rollout 出现 `task_complete` 即自关，auto-close 不再依赖 orchestrator 存活。 |
| `ORCH_TUI` | `wt` | 托管可见 codex 窗的终端：`wt`=Windows Terminal（对 CJK IME/输入法支持最好），`conhost`=经典控制台（可靠但 TUI 的 IME 支持有限）。 |

## 编码与 IME（血的教训）

所有文本读写**显式 UTF-8**。弹窗 launcher 设 `[Console]::OutputEncoding`/`$OutputEncoding=UTF8`、用 `-Encoding UTF8` 读 prompt，`.ps1` 以 **UTF-8 带 BOM** 写入。这是防止中文在中文 Windows（默认 GBK/936）变乱码的关键——别依赖系统教本页。

launcher 还额外执行 `chcp 65001` 并设 `[Console]::InputEncoding=UTF8`，把**输入**代码页也从默认 936/GBK 对齐到 UTF-8；否则微软拼音 IME 在 TUI 里会偶发失效。若想要最强的 IME/TSF 支持，用 `ORCH_TUI=wt` 把 TUI 托管到 Windows Terminal（conhost 虽可靠，但对全屏 TUI 的 IME 支持有限）。

`--run-windows` 的窗跑的是**交互式 TUI**（`codex --cd <workspace> -a never --sandbox danger-full-access <prompt>`），它不会自己退出；orchestrator 通过监听会话 rollout 的 `task_complete`（回合完成）来结束窗。`codex exec`（无窗）仍用于 `--run`/`--exec` 纯自动化。

## 依赖（@openai/codex-sdk）

- Node 18+（ESM）。
- `@openai/codex-sdk` —— 本工具驱动的 SDK，声明在 `scripts/package.json`（`"@openai/codex-sdk": "0.149.0"`）。
- 可用的 Codex CLI（OpenAI Codex 或兼容 provider，模型用 `ORCH_MODEL` 配）。

## 实现思路

1. **拆块**：把多步骤请求按「并发冲突」拆成 `linked`（联动→单窗串行）与 `independent`（独立→并行多窗）两类块。
2. **只读分析先过**：先 `--plan`（只读线程）打印块结构供审阅；真执行才 `--run-windows`。
3. **真实 TUI 窗执行**：`--run-windows` 为每个 independent 块弹真可见、可交互的 Codex TUI 窗并并行运行；linked 块单窗串行。
4. **冲突上锁**：执行前 SDK 预检与运行中窗口冲突，冲突则等待/上锁，完成后自动关窗并归档 `temp\win-summary.json`。
5. **强制门**：`codex-TUI-orchestrator-force.mjs` 做可检查门禁（`--assert`/`--status`/`--verify`），`codex-TUI-orchestrator-preflight.mjs` 做只读预检，禁止 headless 绕过弹窗。

## 效果

- 多步任务按冲突自动并行/串行，最大化并发又不冲突。
- 每次真实执行都有可见 TUI 窗，用户能看进程、能盯输出、能手动介入。
- 强制门禁保证真实执行只走 TUI 窗，headless 绕过被拒；结果自动汇总到 `win-summary.json`。

## 许可

以 [MIT 许可证](./LICENSE) 发布。完整条款与中文说明见根目录 `LICENSE` 文件（包含允许事项、唯一条件与免责声明）。

## 免责声明

本工具用于【自动拆解并编排执行真实任务】（写入 / 构建 / 安装 / 测试 / 重启 / 进程管理），可能修改项目文件、重启服务，伴随运维或数据风险。运行前请先用 `--plan` 审阅方案、按需备份。本工具按“现状（AS IS）”提供，【不附带任何担保】；版权持有人不对其使用产生的任何直接或间接损害负责。
