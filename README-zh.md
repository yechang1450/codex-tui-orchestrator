# agent-tui-orchestrator

> 作者：**Yang Wenchàng**

把多部分请求按「并发冲突」拆成 **安全并行块**，并通过 **真实可见的 Codex TUI 窗** 执行——独立任务并发、会破坏的串行。

> 命名说明：插件 id、`name` 字段、目录、GitHub 仓库、显示名均为小写连字符 `agent-tui-orchestrator`，符合 Codex 插件清单规范。

## 能力结构（多合一）

插件只暴露 **一个 skill**（`skills/agent-tui-orchestrator/SKILL.md`），拆块分类、冲突锁、依赖排序、原型门禁（确定性）、注册表、窗口运行时、结果汇聚、执行门禁、拆块缓存、清洁、归因验证 **11 项能力全部内嵌其中**，恒启用、无开关；可调参数只有 `ORCH_*` 环境变量。

## 实现思路（从请求到落地，完整生命周期）

### 0. 核心判断轴

整个编排围绕一个保守问题：

> **同时跑这两个任务，会不会破坏东西？**

- 会（同文件/配置、同服务重启、同端口/库、一个依赖另一个输出、或互为前置）→ **linked** → 合并为单块，**严格串行**。
- 不会（改不相交文件/子系统）→ **independent** → 各自独立块，**并行**。

两个正交维度被**分开建模、各管各的**：
- **逻辑先后（依赖）** → `dependsOn` → 决定块**何时**跑（前置排序）。
- **资源重叠（冲突）** → `conflictKeys` → 决定两块**能否同时**开。

依赖管「先后」，冲突管「互斥」，二者不是一回事——这套分离是设计的骨架。

### 1. 生命周期

```
请求 → ①执行模式判定 → ②拆块(缓存/规则/LLM/兜底) → ③归一化 → ④按依赖分波
     → ⑤逐波：冲突检查+原型门禁+弹窗 → ⑥窗内授权执行+自验 → ⑦汇报捕获自动关窗
     → ⑧汇总win-summary → ⑨poll收尾 → ⑩清洁 + 父级复核
```

#### ① 执行模式判定（`classifyExecutionMode`）
只读 vs 真实检测。命中只读词且无真实动作词 → `inline`（留在主对话，不弹窗）；命中真实动作词且无只读词 → `execute`（必须弹窗）；歧义/都不命中 → 交 LLM 判，LLM 失败 → **fail-safe 判 `execute`**（绝不把真实执行误当只读而跳过）。

#### ② 两段式拆块（`decomposeSafely`，核心）
**LLM 只定性，分块/排序交给确定性代码。** LLM 只回答「这请求里有哪几个自然任务」，绝不负责怎么归组/排序/归位。路径顺序：

1. **缓存优先**（hints 感知）：键 = `sha1(请求文本 + 项目hints指纹)`——hints（模块→项目映射、折叠规则、尾块关键字）是项目相关配置，必须进键，否则同句话跨项目会串扰。永不自动失效，仅 `--clear-cache` 清。
2. **`genericProjectSplit`**：请求命名多个不同项目目录 → 拆成独立块（免 LLM、秒回、写缓存）。
3. **`trySingleBlock`**：明确单一动作 → 单块（免 LLM）。
4. **LLM 两段式**：
   - `classifyPrompt` → 扁平任务清单 `{tasks:[{id,summary,kind,project,hint,conflict_hints,depends_on,feasible,already_done}]}`（字段少、禁工具、纯 JSON）。
   - `extractTasks` → 解析 JSON（剥代码块、容错）。
   - `buildBlocksFromTasks` → 确定性分块引擎：按 project 分组、tool 独立、未知项归 linked、依赖映射（`i!==j` 挡自引用）、**可行性过滤**（`feasible=false`/`already_done=true` 的任务在此被剔除——这是「不白开窗」的保证）。
5. LLM 失败/超时重试，耗尽 → `fallbackPlan` 单串行窗（保证整批落地）。

#### ③ 归一化（`normalizePlan`，防过度合并/自冲突）
- `independent` 块带多个任务 → 拆成一块一任务（防模型过度塞进一个并行块）。
- 两块 `conflictKeys` 重叠（并行会打自己）→ 合并为一个 linked 块。
- **`blockBody` 串行兜底**：只要一个窗里塞了 >1 个任务，就**绝不**输出“互相独立、并行执行”，一律按“串行：先做第1个再做第2个”。曾因级联块（写 s.txt → 读它追加 z.txt）被误标 `independent` 而输出“并行”，误导窗内 agent 把有依赖的任务当独立处理、漏做后步，导致落盘缺失但 status=done；此兜底保证多任务窗必收到串行语义。

#### ④ 按依赖分波（`levelWaves`）
把每块 `dependsOn` 归一化到块 key，**剔除自引用与未知目标**，再按层排队：同层可并行、层间按先后。这让真实排序可靠——自引用（如 `task-2:["task-1","task-2"]`）原本会让依赖永不满足、串行失效，现已被剔除。

#### ⑤ 逐波 spawn（冲突锁 + 原型门禁 + 弹窗）
每块 spawn 前：
- **冲突检查** `conflictByKeys` 对照**运行中窗**（注册表 + `windowAlive`）。重叠 → `waitClear` 轮询等；仍冲突 → **上锁**（终态，不误窗）；释放 → 自动重跑（不静默丢弃）。
- **同批双保险**：与本波已 spawn 的块再查一次重叠。
- **原子占位**：真正弹窗前在注册表锁内先写 `pending` 占位（pid=0），其它进程立刻把它视为已占用，封死「两进程都检查通过后再同时弹同键窗」的竞态；弹窗成功后提交真实 pid，超过 120s 的死占位自动作废。
- **原型门禁** `runPrototypeGate`：L1 空/无动作 → 拒绝；L2 复杂度（多句/含分析/长→复杂，仅状态提示）。可行性已在拆块判过，不再单开 LLM（成本友好）。
- **注册表写入** `updateWindows`（独占锁内 load+mutate+save，只追加，防跨进程 lost-update；占位与活窗共用同一 conflictKey 空间）。
- **`writeInteractiveLauncher`**：prompt = `buildBlockPrompt(blockBody, token)` + `auth`；写 `win-launch-*.ps1`（UTF-8 带 BOM + `chcp 65001`）、`codex-win-*.md`、`window-*.pid`。
- **`spawnWindowWithRetry`**：弹真可见窗（优先 Windows Terminal，conhost 兜底）；弹窗检测用「pid 文件 + launcher(WT pane 宿主)进程存活」双重确认（上限 3 次）；真没弹出 → `popup-failed`，绝不当运行中。

#### ⑥ 窗内授权执行 + 自验
窗内 agent 收到全权指令，硬约束固化在 prompt：防嵌套（禁止再调 `--run-windows`/`--spawn`/另开窗）、防停顿（禁止以「需要授权/要我修吗」暂停问）、必须自验（读回 + UTF-8 无 BOM、跑回归、无残留临时/无乱码）、必须真实汇报。

#### ⑦ 获取执行结果：`done=做完了`（不等同于成功），主控去现场看，不信窗内自报

**设计思路来自一段童年记忆：** 小时候在厂子的办公室里，底下来人跟我爸爸汇报完就走了。我问爸爸，不怕那个人没有如实汇报吗？爸爸说，**每次汇报之后他都会亲自去看看活干得怎么样，而且时间还不固定**——正因为"会去现场抽查、且抽查时间不定"，下面的人没有一个敢骗他。亲临现场评估，比翻看汇报的纸面内容更稳妥、也更直接。后来我在"让 TUI 窗汇报结果然后自动关窗"上屡屡碰壁时，就想起了这件事，把这套思想移植了过来。

**落地到 orchestrator：**

- **TUI 窗不做长篇汇报，只输出唯一一行结束识别码 `__ORCH_DONE__ <本窗token>`**。它只代表"我停止动手了"（`done` = 做完了），**不代表"成功了"**。
- **launcher 内置 watchdog 只认这一行结束符**（且必须是 `agent_message` / `"role":"assistant"` 消息，绝不匹配被注入的提示词行——那行词里原文就教它"最后输出 `__ORCH_DONE__ <token>`"，若不过滤 role/type，窗会在刚拿到任务、还没干活时就把这条提示词误判成完成而提前自关、丢任务）。命中即写 `.self-closed` 强标记并杀 codex 树 → `exit 0` 自动关窗。
- **`Write-Result` 不再依赖"捕获到汇报文本"**：只要 codex 执行结束就写 result + `.self-closed`；汇报文本尽力带出（有则记，无则标记需外部核对落盘）。
- **父进程完成判定 = 执行结束即 `done`**，不再因缺 token/缺汇报文本判 `uncaptured`/失败/二次执行。
- **真正判断"活干得成不成"，是主控关窗后按 prompt 去核对真实落盘状态**（读文件/状态层面），而非分析窗内自报。这正是"爸爸亲自去现场看"：报告不可信，现场不会撒谎。
- watchdog 观察上限默认=父进程轮询上限+10 分钟（`ORCH_WATCHDOG_MAX_MIN` 覆盖），长任务在父进程意外退出后仍能"执行结束即自关"。

#### ⑧ 汇总 → `win-summary.json`
每块写结果。`status` 以「执行结束=done」为准（识别码/`.self-closed`/codex 退出即 done），**不再因缺汇报文本判未决**；`result` 字段尽力带出窗内文本（有则记，无则提示"请按任务提示词核对真实落盘状态"）。真正的"成败"由主控关窗后读现场判断，而不是看 summary 的自报文本。

#### ⑨ poll 收尾契约（`poll-windows.mjs --require-all-success`）
`--run-windows` 之后**必须**轮询到全部块 ∈ 成功集（`done/ok/completed/done-retried/done-on-disk` + 被正确拦截的 `preflight-failed/locked/unlocked`）且无活窗 → exit 0；否则轮询到超时 exit 1（对 `timeout`/`popup-failed`/`preflight-failed` 等未执行结束的不装成功）。防竞态：summary 需「新鲜（mtime）+ 连续 2 cycle 稳定」；零窗但完整 summary 也收尾（堵住「窗关太快 summary 未刷新」竞态）。

#### ⑩ 清洁 + 父级复核
- `ORCH_KEEP_TEMP!=1` → 用完即弃：删 `win-launch-*`/`codex-win-*`/`window-*.pid`/`win-*.result.json` 及 `.self-closed` 标记；清理按 pid 存活态保护活窗文件，绝不误删正在运行的窗口；**绝不删** `win-summary.json`。
- 父进程用 `--verify`/读回独立复核真实落盘，不信窗内自报；不一致以盘面为准并纠正。

### 2. 执行门禁（真执行必走窗）

`force.mjs` 把「真执行必须走可见 TUI 窗」立为可校验不变量：
- **armed**：写 `.orchestrator-enabled`（时间戳）；一旦 armed，非窗上下文的真实 kind 一律拒绝。
- **`--assert <kind>`**：0(ok)/1(refused)。窗内设 `CODEX_ORCH_WINDOW=1`，但该 env 单独不可信，必须配套活窗（注册表 + pid + tasklist + 命令行命中 `win-launch-*.ps1`/`orchestrate-sdk`）才放行；只读类放行；未知 kind **fail-closed 拒绝**。
- **`--verify <file>`**：按 `conflictKeys` 做**路径感知匹配**归因（剥 `file:/dir:/port:/service:` 前缀；精确/目录前缀/文件名/路径段）。无活窗 → VIOLATION；多活窗 → INDETERMINATE；恰一窗且命中 → PASS。
- **`preflight.mjs`**：执行前一次性裁决，复用 force 的 `armed`/`liveWindows`（只读→ok；真实且非窗→REFUSED）。

### 3. 跨进程注册表与并发安全

- **`withRegistryLock`**：`openSync('wx')` 原子独占锁串行化注册表写；**陈旧锁年龄清理**（>30s 视为持有者已死，删除重试）；仍拿不到才告警。
- **`saveJson`**：`tmp + rename`；Windows `renameSync` 不覆盖 → 先 `rm` 再 `rename`，不留半写；读侧短暂重试桥接「rm→rename」瞬时空窗。
- **`updateWindows`/`updateLocks`**：`load+mutate+save` 整体在锁内 → 无跨进程 lost-update。
- **`windowAlive`**：pidFile 存在 + tasklist 命中 + result 无 `__EXIT__`（避免把已完成但 launcher 残留的窗当运行中，防误锁）。

### 4. 正确性不变量

1. **防嵌套**：窗内禁再调编排/另开窗。
2. **防白窗**：可行性在拆块判 + spawn 前确定性 L1/L2 门禁。
3. **防虚报**：TUI 窗只输出 `__ORCH_DONE__ <token>` 识别码，无需自撰"成功汇报"；是否达标由主控去现场核对真实落盘状态，现场不会撒谎。
4. **防丢任务**：`done`=执行结束（识别码/`.self-closed`/codex 退出），不因缺汇报文本误判未完成/二次执行；window 冷启动后 `warmupWindow` 等 codex 子进程真正拉起，避免父进程过早去等 session rollout 而漏匹配。
5. **防串行失效**：`levelWaves` 剔除自引用/未知依赖。
6. **防跨项目串扰**：缓存键含项目 hints 指纹。
7. **防伪造/误放行**：门禁 fail-closed + 命令行动态核对 + 活窗背书。
8. **防污染**：用完即弃、显式 UTF-8、`.ps1` 带 BOM、源==缓存（一家人一致）。
9. **fail-safe 执行**：歧义 → execute；LLM 失败 → 串行兜底。
10. **成本友好**：确定性快路径免 LLM；可行性不重复调；拆块缓存命中即复用。

### 5. 初始环境检测

真实执行前先验：codex CLI（探测/安装）+ **工作区磁盘空间**（`statfsSync`）。剩余空间低于 `ORCH_MIN_FREE_MB`（默认 12000MB≈12GB）告警；低于 `ORCH_MIN_FREE_HARD_MB`（默认 3600MB≈3.6GB）直接拒绝（fail-closed）——磁盘空间过低时连 launcher/temp 都写不了，与其半路失败不如一开始就拦。若 `ORCH_MIN_FREE_HARD_MB` 设得比 `ORCH_MIN_FREE_MB` 还高，硬下限会被钳制到告警阈值。

磁盘检查**严格**用于真实执行入口（`--run-windows`/`--spawn`），**只告警不拦截**用于只读的 `--plan`（绝不拦计划输出），`--status` **不调用**（它看运行态，与磁盘无关，且会在 poll 循环里被高频调用）。

## 用法

```bash
node orchestrate-sdk.mjs --plan "1. ... 2. ... 3. ..."
node orchestrate-sdk.mjs --run-windows "1. ... 2. ... 3. ..."
node orchestrate-sdk.mjs --spawn "My Task" "./temp/my-task.md"
```

## 拆块缓存（越用越快）

相同请求缓存 **永久**（`orchestrator-decompose-cache.json`）且**永不自动失效**——仅手动 `--clear-cache`（或删除缓存文件）才会重置。缓存键含「请求文本 + 项目 hints 指纹」，避免跨项目/配置串扰。首次请求走规则+LLM 拆块，之后相同请求立即命中缓存。完全可移植——对**任意用户**有效，**无硬编码路径**。

## 配置（环境变量，全部可选）

| 变量 | 默认 | 含义 |
|-----|------|------|
| `WORKSPACE_DIR` | `process.cwd()` | 工作目录（自动探测，从不硬编码）。 |
| `CODEX_HOME` | `~/.codex` | 权威 Codex 家目录。**跨用户/跨设备/跨宿主**适配点：所有 `.codex` 路径都由它推导，绝不硬编码 `C:\Users\<user>\.codex`。 |
| `ORCH_STATE_DIR` | `$CODEX_HOME/orchestrator` | 稳定运行/状态目录（registry、锁）。**不能**放在会被插件升级清掉的目录。 |
| `ORCH_SESSION_DIR` | `$CODEX_HOME/sessions` | 会话 rollout 目录。 |
| `ORCH_SUPERPOWERS_CACHE_DIR` | 自动探测 | 覆盖 superpowers 插件缓存路径（不同宿主/市场布局）。 |
| `ORCH_AGENT` | `codex` | 选 agent：`codex`\|`claude`\|`opencode`\|`cursor`\|`qwen`\|`pi`\|`zcode`\|`aider`\|`codebuddy`\|`openclaw`；对应 CLI 未装则自动回退 `codex`。 |
| `CODEX_EXE` | 自动检测 | `codex` CLI 路径。 |
| `PYTHON` | `python` | 预制到弹窗 PATH 的 Python。 |
| `ORCH_MODEL` | `auto (config.toml)` | 线程用模型；自动读取宿主 config.toml 的 `model`（主对话模型），读不到则回退 `deepseek-v4-flash`。 |
| `ORCH_EFFORT` | `xhigh` | 推理档位，默认 `xhigh`（low/medium/high/xhigh/max，通用）。 |
| `ORCH_TIMEOUT_MS` | `21600000` | 等全部窗完成的总时长上限（默认 6 小时）。 |
| `ORCH_DECOMPOSE_TIMEOUT_MS` | `60000` | 只读 LLM 拆块超时（毫秒）。 |
| `ORCH_DECOMPOSE_RETRIES` | `2` | LLM 拆块失败重试次数，重试耗尽后走确定性兜底单窗。 |
| `ORCH_WAIT_MS` | `120000` | 等待冲突窗关闭的最长时间。 |
| `ORCH_WATCHDOG_MAX_MIN` | `轮询上限 + 10 分钟` | 窗内 watchdog「完成即自关」观察上限（分钟）。 |
| `ORCH_CLOSE_DELAY_MS` | `1000` | 窗完成后自动关窗的读缓冲。 |
| `ORCH_TUI` | `wt` | `wt`=Windows Terminal（最佳 CJK 输入法），`conhost`=经典控制台。 |
| `ORCH_MIN_FREE_MB` | `12000` | 工作区所在盘剩余空间（MB）低于此值则告警（≈12GB）。 |
| `ORCH_MIN_FREE_HARD_MB` | `3600` | 硬下限（MB），低于此值直接拒绝执行（fail-closed，≈3.6GB）；若设得比 `ORCH_MIN_FREE_MB` 高则钳到告警阈值。 |

### 通用化（跨设备 / 跨 agent / 跨用户适配）

本插件已做**通用化设计**：宿主只需注入 `CODEX_HOME`（及可选 `ORCH_STATE_DIR`/`ORCH_SESSION_DIR`/`ORCH_AGENT`），同一份代码即可在**任意用户的 Windows 设备**与**任意主流 agent** 上运行，无需改源码。
- **不同用户/设备**：所有 `.codex` 路径来自 `CODEX_HOME`（非 `C:\Users\<user>\.codex`）；agent 缓存与临时产物落在稳定家目录，绝不在会被插件升级清掉的插件脚本目录。
- **不同 agent**：`agent.mjs` 内置 `codex/claude/opencode/cursor/qwen/pi/zcode/aider/codebuddy/openclaw` 表，探测对应 CLI，`ORCH_AGENT` 选择；launcher/Watchdog 对它们都用通用结束标记 `__ORCH_DONE__ <token>` 收尾。
- **不同用户**：只读能力探测（superpowers/config/CLI）失败一律降级不报错；无权限写（如 hosts）输出可复制的提权指令而非硬写。
- **跨平台窗口**：优先 Windows Terminal（`wt`），不可用回退 `conhost`（`cmd /c start`）。

## 编码与输入法

所有文本读写**显式 UTF-8**；启动器设 `[Console]::OutputEncoding`/`$OutputEncoding = UTF-8` 并用 `-Encoding UTF8` 读提示词。`.ps1` 启动器**UTF-8 带 BOM** + `chcp 65001`，防止中文在中文 Windows（默认 GBK/936）上乱码。

> **TUI 渲染重叠修复**：窗内提示词（如「三遍检查」「现场自验」）原用 `①②③` 序号，在 Windows Terminal 的 CJK 宽度判定下会与相邻文字重叠。已统一改为 `1)`/`2)`/`3)`（纯 ASCII 宽度）避免重叠。

## 依赖

- Node 18+（ESM）。
- `@openai/codex-sdk`（见 `scripts/package.json`）。
- 可用的 Codex CLI（模型可经 `ORCH_MODEL` 配置）。

## 许可证

MIT——见 `LICENSE`。

## 免责声明

本工具会执行真实改动（写/建/装/测/重启/进程管理）。请先看 `--plan` 并做好备份。按"AS IS"提供，无任何保证；版权持有者不承担使用带来的损害。
