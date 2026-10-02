# 0.9.29-rc.1 验收记录

## 2026-10-02 公开仓库准备与最终离线回归（core 1.4.4-rc.1）

- 工作树在 `codex/public-readiness` 分支完成公开发布审查：README 中英文版本、版本号、1000 MB 内存预留、自动 RC 递增说明和 Codex CLI 版本口径已同步。
- 最终串行离线回归为 535 项：532 通过、0 失败、3 项按配置跳过；跳过项只对应显式启用的真实 Codex 窗口验收、本机不可用的 UNC 管理共享和可选 pi CLI，不能据此宣称真实服务商或可见窗口已覆盖。
- 发布封印 `release-integrity.mjs --json` 通过（schema 2、core `1.4.4-rc.1`、31 个核心文件、73 个运行时文件）；源码与个人缓存的关键文件摘要一致，安装检查无问题或警告。
- 本轮把自动安装与文档中的固定原生 Codex CLI 从 `0.157.0` 更新到官方 `@openai/codex@0.160.0`，x64/arm64 可执行文件和完整 47 文件平台包摘要均已重新封存并通过安装器回归。
- 公开性审查未发现真实 API key、私钥或凭据；当前工作树和最新主线 tip 不含个人绝对路径。主线、旧的 `feat/exec-headless-status`、Dependabot 分支和 PR 只读 refs 仍保留历史验证快照；候选 v4 已清理文件内容，但还需清理提交者元数据。已关闭 PR #1 的正文仍含个人路径，公开前必须脱敏；PR #2–#4 仍开放。普通分支推送不能清除 `refs/pull/*` 或 GitHub 缓存，必要时须按 GitHub 官方流程处理 Support 请求。
- 本轮本地静态审查修复了未验证 Pi CLI、Windows shell 参数展开、插件安装路径越界、8.3/UNC 路径租约分叉、检查点命令注入候选、headless 身份快照失败导致的无界等待、旧 registry 损坏静默放行和 supervisor 中继模型漂移；新增 PowerShell 特殊路径、文件派生绑定和有限收尾回归通过。窗口注册表、registry lock 和启用标记已迁移到 controller-owned state，并统一物理工作区身份；升级时发现旧的损坏或非空 workspace registry 会 fail-closed。
- 官方 Codex Security 深度扫描在本会话未能启动，原因是宿主没有提供该扫描要求的托管文件权限配置；本节的结论来自本地静态审查、针对性回归和发布完整性检查，不替代官方扫描。

## 2026-09-29 0.9.29-rc.1 内存准入下限调整候选（core 1.4.4-rc.1）

本轮把动态内存准入的默认且不可降低的可用内存预留从 4000 MB 调整为 1000 MB。执行判据不变：每次开窗仍原子复检实时可用内存，预测峰值必须严格小于可用内存减去预留值；显式 `ORCH_MIN_AVAILABLE_MB` 只能把预留提高，不能低于 1000 MB。SessionStart、辅助窗口、headless 与可见窗口共用这一边界。由于预留降低会增加高峰期的系统压力，发布前必须重新跑离线边界回归、分发封印、安装缓存校验和本机真实双任务验收。

- 源码串行回归为 496 项：495 通过、0 失败、1 项按配置跳过；新增的 1000 MB 边界、低值钳制和高值覆盖测试全部通过。`git diff --check`、依赖封印和发行封印均通过（schema 2，31 个核心文件、72 个运行时文件）。
- 本轮分发已安装到 `<CODEX_HOME>\plugins\cache\personal\codex-tui-orchestrator\0.9.29-rc.1`；缓存 `release-integrity`、依赖封印、`--doctor` 和 `install-plugin --check --json` 均通过，doctor 继承发起会话的模型、推理级别、service tier 与工作区。
- 版本同步与自动递增聚焦测试通过：三个发行清单统一为 `0.9.29-rc.1`，`version:next` 夹具从 `rc.1` 正确生成 `rc.2`；Git 分发路径门禁 6/6 通过，畸形账本 fuzz 11/11 通过。
- 新缓存真实 headless 双任务 `mode-headless-27e5fcde-807a-4938-8910-99be9bd39d65` 和 visible 双任务 `mode-visible-30ef110c-df67-46f8-88fa-35d19ac6b566` 均 `passed=true`、2/2 `verified`、两个独立块实际重叠运行、启动器全部退出、core 未漂移。证据保留在本机临时运行目录，不把本机绝对路径写入仓库。
- 这两次真实运行把滚动窗口成本更新到约 2.5–2.6 GB；这验证了 1000 MB 只改变最低可用内存底线，实际并发仍由预测峰值、已有租约和实时可用内存共同决定。它也保留了首轮样本不足时估算偏低的架构风险，见下方剩余问题。

## 2026-09-28 本机完整测试后的修复候选（core 1.4.3-rc.1）

当前候选版本为 `0.5.0-rc.1+codex.20260928200041`。以下修复来自本机对已安装 `core 1.4.2-rc.1` 的完整测试；下节及更早记录均为对应旧快照的历史证据。

- `--tasks` 现在读取指定或最近更新的运行账本，返回 TodoList 与执行状态；空工作区返回明确的空状态。
- 确定性规划只把紧贴项目动作词的裸编号当作项目引用，避免把普通数字结果值 `42`、`84` 误拆成项目。
- Windows CLI 签名校验的有界等待延长至 30 秒；已有候选验签失败时直接报告 `CLI_UNTRUSTED`，不再误入自动安装。
- 可见启动器在会话发现前结束时，尝试账本保留会话、完成标志、汇报捕获与退出码等结构化诊断；安全重试规则不变。
- 真实双任务 smoke 验收默认给 Max 推理 10 分钟；先前本机 180 秒夹具时限在第二项写出结果、尚未写完检查点时触发，控制器正确停止并标为需核验。
- 最终源码离线回归为 495 项：494 通过、0 失败、1 项按设定跳过；核心与依赖封印均通过，分发仍为 115 个文件。
- 新缓存 `<CODEX_HOME>\plugins\cache\personal\codex-tui-orchestrator\0.5.0-rc.1+codex.20260928200041` 的 `release-integrity`、`--doctor` 和 `install-plugin --check --json` 均通过；doctor 实测继承发起会话的模型、推理级别、service tier 与工作区。
- 新缓存真实 headless 双任务通过：`passed=true`、2/2 verified、退出码 0、核心未变、父级收尾完成。证据为 `workspace/temp/mode-headless-2c0df496-53e8-4177-ab85-aa8dbbaf61a2/report.json` 与对应运行账本。
- 新缓存真实 visible 双任务通过：`passed=true`、2/2 verified、退出码 0、核心未变、两个 Windows Terminal 窗口最终关闭；B1 首窗后按安全重试规则再次启动并通过。证据为 `workspace/temp/mode-visible-590cf271-f526-4f51-84c2-b2a0cb78f666/report.json` 与对应运行账本。

## 2026-09-28 公开准备候选（core 1.4.2-rc.1，历史记录）

当前候选的插件版本为 `0.5.0-rc.1+codex.20260928152733`。本节只记录该候选实测过的内容；下方 `1.4.1-rc.1` 及更早记录均为历史证据。此候选尚未公开发布。

- 安全修复包括：验证外部 Codex CLI 与 Node 的签名、验证自动安装的原生 CLI 包与 npm 文件树、封存锁定 SDK 的逐文件摘要，并在自动恢复依赖前要求可信 npm。Node 启动 Windows PowerShell 时若继承 PowerShell 7 模块路径，现在按绝对路径加载系统安全与实用模块；相关回归已通过。
- 公开入口 `--plan-file` 曾在帮助中列出却返回 `Unknown mode`；本轮用真实入口复现，加入有界文件读取、路径/类型诊断和回归后通过。`--doctor` 从本机读取到 `gpt-6-sol`、`max`、`priority` 与工作区 `%USERPROFILE%\workspace`。
- 原始五目录请求的首次模型规划给出五个可并行块，但句内分号使原始清单变成十项，每块两项；改成每目录一项后，第二次模型规划两次请求均中止，安全退回 `autosafe-serialized`。这说明模型规划仍受提供方可用性影响，不能把首次成功当作稳定成功。执行前 `own-skills` 已不在工作区原位置，因此没有对其旧路径创建或执行清理任务。
- 对当时实际存在的 `build`、`memory`、`ops`、`temp` 四个顶层目录，使用显式项目号的确定性规划得到四个独立块，每块恰好一条原始任务，互无依赖。真实 headless 执行 `public-cleanup-20260928-a` 的首轮四个工作进程时间重叠（峰值 4），四块均由控制器确认退出；`build`、`memory`、`ops` 的专用演练标记实际删除并经父级分别验收为 `verified`。
- `temp` 的专用演练标记删除命令被宿主自动审批审查以 `blocked by policy` 拒绝，两次有界尝试后任务为 `failed`，目标仍存在；控制器没有伪造 `completed` 或 `verified`。因此这次整体运行 `success=false`，不能称作四目录清理全部通过。根工作区的 Git 状态条目在运行前后相同，未观察到本次运行遗留的 headless worker 进程。原始账本、验收报告和计划保存在本机 `workspace/temp/orchestrator/runs/public-cleanup-20260928-a/` 与 `workspace/temp/codex-tui-public-readiness-20260928/`。
- Node 24 的串行离线全量回归共 488 项：487 通过、0 失败、1 项按设定跳过（需显式启用真实模型）。之后修正 `--doctor`/`--tasks` 首次调用可能准备依赖的帮助与说明文字，重新封存，受影响的入口、自动依赖和分发 13 项测试通过。再用签名有效、SHA-256 与官方清单一致的 Node 22.23.3 重装锁定依赖，发现本机原生 Node/npm 探测约需 80 秒，超过 bootstrap 测试夹具原有的 30 秒外部等待上限；调整测试等待与实时输出用例隔离后，Node 22 对最终源码的串行全量回归同样为 488 项、487 通过、0 失败、1 跳过。最后修改的 bootstrap 组在 Node 24 下另行 7/7 通过。封存结果为 schema 2、31 个核心文件、72 个运行时文件。
- 最终干净分发为 115 个文件，安装器已从该分发更新本机 Codex 缓存；缓存的发行完整性、doctor 和 `install-plugin --check` 均通过，后者无问题或警告。隔离的原生 CLI 自动安装路径先以锁定包与签名实测通过，再用该 CLI 完成实际安装。缓存版 `--selftest-close` 在 Windows Terminal 真正弹窗、收到完成事件后自动关窗：`selftestPassed=true`、`launcherStillAlive=false`、`orphanChildren=false`。
- 当前源码的真实双模式两任务验收均通过：可见 TUI 与 headless 各自 `passed=true`、峰值并发 2，两项独立 `verified`，顺序、回执、时间重叠和退出检查均有效。证据分别在工作区 `temp/codex-live-visible-ddebddedbad/report.json` 与 `temp/codex-live-headless-bddcaddcab/report.json`。帮助文字修正不改变这两次运行的执行逻辑。
- Codex Security 最后一轮差异扫描 `b3d996c4-aa6a-4dd9-bef6-684c3290cdc4` 对帮助文字修正前的安全相关改动审查了 16 个源码/配置项，0 项可报告漏洞。npm 校验后的时间窗口被作为候选验证；旧版本原本没有该校验，且未建立普通已安装环境中的独立低信任写入者，因此未列为本差异漏洞。Plugin Eval 对最终源码与干净分发均评为 86/B；唯一失败项是整包延后文本量的静态估算（分发 182649 token），实际常驻/触发预算估计为 1218 token，尚无真实 token 用量样本。
- GitHub Windows CI 的 `Validate orchestrator` 工作流已重新启用；本轮远端作业在分配运行器前被账户级 Actions 运行资格阻断，没有执行任何测试步骤，不能把本地 Node 22 通过记作远端 CI 绿色。恢复运行资格后需重新运行 PR 检查。全新第二台 Windows 首次安装、公开后匿名 HTTPS 克隆仍需按 [干净机器清单](clean-machine-validation.md) 单独验收；模型规划提供方中止时仍会安全退回串行。上面的四目录演练有一次宿主策略拒绝，不能称作四目录全部清理成功。

## 2026-09-27 模型语义拆分与本机代理验收

当前封存核心为 `1.4.1-rc.1`，插件 cachebuster 为 `0.5.0-rc.1+codex.20260927090557`。模型给出的文件、目录和依赖提示只有逐项对应原始任务后才用于并发；编造、漏报、通配符或含糊目录均退回串行。Windows 已启用的用户代理只复制进编排器进程树，不改全局设置。

- 在本机未手动设置 `HTTP_PROXY`/`HTTPS_PROXY` 时，真实 `--plan` 约 18 秒完成：README.md 与 docs/quickstart.md 因共享 README.md 合成一个串行块，test/fixtures 保留为另一个独立块；未实际修改这些文件。`--doctor`、发行完整性校验和 `git diff --check` 退出码均为 0。
- 串行全量回归在修复锁文件第二个版本字段后从头重跑；再补通配符与含糊目录保护后又从头重跑。最终 476 项：475 通过、0 失败、1 项按设定跳过。封印 schema 2 包含 31 个核心文件与 70 个运行时文件。
- 修正文档对 `--plan` 缓存写入的描述后，最终全量回归再次从头通过：476 项中 475 通过、0 失败、1 项按设定跳过；发行完整性、`--doctor` 与 `git diff --check` 均通过。正式分发包为 112 个文件，Plugin Eval 给出 95/A、0 fail、1 项静态延迟文本体量警告；Codex Security 对本次变更的 6 个源文件做差异审查，0 项可报告发现。安装器更新 Codex 缓存后，`install-plugin --check` 返回 `ok=true` 且无问题或警告。
- 本次实机模型验收只覆盖不执行任务改动的语义规划；规划可能更新拆分缓存。双模式真实执行及并发窗口的历史证据仍属于下节 `1.4.0-rc.1` 快照；全新 Windows 首次安装仍需按 [干净机器清单](clean-machine-validation.md) 在隔离系统验收，不能据此宣称稳定版或 100% 无隐含资源冲突。

## 2026-09-27 隔离修复分支验收

本轮在独立工作树中修复控制端状态边界：协调租约、headless/可见启动文件、验收契约权威摘要、不可变运行计划摘要与 supervisor 权威摘要转到 Codex 状态目录；工作区仍保存任务账本和检查点。显式改写验收契约时，即使工作区里的两个摘要同步被改写，也必须与控制端摘要比较并留下 `acceptanceRebound` 记录。恢复可见窗时逐项验证块键、尝试序号、文件组和令牌；最终清理重新核对控制端 PID 文件与实际进程身份。成功完成的 headless 运行清理自己的控制端启动文件，失败运行保留诊断证据。插件版本为 `0.5.0-rc.1+codex.20260927035411`；先在隔离工作树完成源码验收，再更新 Codex 的已安装缓存。

- 本机串行完整离线回归覆盖 79 个测试文件。首次完整回归发现三份版本清单未同步；修正 `plugin.json`、`scripts/package.json`、`scripts/package-lock.json` 后从头重跑，退出码 0。新增的计划绑定、验收绑定、PID 身份、Pi 可见窗令牌、相邻块伪造、Windows 8.3/UNC 路径别名、直接 API 协调器和中文分号拆块测试均已覆盖。`release-integrity.mjs` schema 2 校验为 31 个核心文件、70 个运行时文件；`git diff --check` 通过。
- Plugin Eval 对只含发布文件的隔离副本评为 95/A、0 fail、1 项静态文本体量警告；直接扫描含本地测试 `temp/` 的开发工作树会把诊断数据计入预算，因此不能用该分数评价分发包。首次 Codex Security 差异扫描报告两项低危候选：可见窗跨块恢复属实并已修复，稳定 PID 伪造复核后不成立。第二次扫描发现 Windows 8.3 别名绕过控制端状态目录限制；本轮用真实 8.3 与 UNC 别名红/绿测试修复。最终安全结论以新补丁的完成扫描为准，历史报告不能证明零发现。
- 真实 `--doctor` 在发起工作区成功。当前补丁的真实双块 headless 运行 `mode-headless-a0ce3ffe-dc01-47f8-a189-7bccd76a5581` 和可见 Windows Terminal 运行 `mode-visible-dd72ac62-1134-4e47-a7dd-3874436fb907` 均 `passed=true`、退出码 0：各自的 T001/T002 独立 `verified`，回执与验收契约逐字段一致，两个块运行时间重叠，全部启动器退出，可见窗实际启动参数均为 `gpt-6-sol` / `max` / `priority`。本次通过确定性项目拆块验证真实执行器；此前两次模型规划请求超时并安全退回单串行块，不能把本次成功写成模型规划器已通过。证据分别位于本机工作区 `temp/mode-headless-a0ce3ffe-dc01-47f8-a189-7bccd76a5581/report.json` 与 `temp/mode-visible-dd72ac62-1134-4e47-a7dd-3874436fb907/report.json`。全新 Windows 首次安装仍待虚拟机或第二台实体机执行 [干净机器清单](clean-machine-validation.md)。
- 最终差异安全扫描 `14612131-cfe2-49c0-8d4a-7e8b0fd34c45` 绑定封存源码快照，11 个入口完整审查、0 项可报告发现；此结论只覆盖该差异，不证明全新系统安装或模型规划路径。安装器从正式目录发布 112 个文件并更新 Codex 缓存，`install-plugin --check`、缓存完整性与缓存 `--doctor` 均退出码 0；缓存版可见窗 `--selftest-close` 实际完成、自动关窗且无孤儿子进程，`selftestPassed=true`。

## 2026-09-26 基线快照验收

当前候选包含免预装 Node/npm 的 PowerShell 引导、受宿主信任控制的 SessionStart 环境准备、按当前任务数核查的多窗验收工具，以及按运行身份回收异常窗口的改动。本节下方的旧版本窗口数量、内存阈值及回归计数均为历史记录；当时契约固定预留 4000 MB，块数由依赖与冲突决定，执行时按预测峰值逐个准入，不在内存不足时合并独立块或硬跑。安装步骤见[环境准备](environment-setup.md)。

该快照版本为 `0.5.0-rc.1+codex.20260926211700`。2026-09-26 的串行全量回归覆盖 77 个测试文件，退出码 0；50 个源文件的行覆盖为 6306/7758（81.28%）。发布完整性封存采用 schema 2，包含 30 个核心文件与 69 个运行时文件。测试中的可选真实模型项单独由下述实机运行验收，不以离线测试代替。

- 已安装缓存入口的 headless+exec 四块验收：`acceptance-ad1127fe-3872-476c-a168-8a3838dcb3d6`，`passed=true`、`peak=4`、四项均独立 `verified`、四个启动器均退出。证据在本机 `%USERPROFILE%\workspace\temp\orch-final-live\temp\codex-live-headless-bdfcaddabe\report.json`；它使用修复会话钩子前的已安装缓存，因此只认证该快照的 headless 路径。
- 当前工作树可见 TUI 四块验收：`acceptance-95de3c1a-6103-4815-9b89-0dfc82b7a20d`，`passed=true`、`peak=4`、四项均独立 `verified`，四个 Windows Terminal 启动器均退出，父级验收队列 `maxConcurrency=1`。模型/推理力度/服务等级的四份继承证据均与本次发起窗口的 `gpt-6-sol` / `max` / `priority` 一致。证据在本机 `%USERPROFILE%\workspace\temp\orch-final-live\temp\codex-live-visible-cbcadbcdafbbee\report.json`。
- 首次可见窗实测被新安装的 SessionStart 钩子信任审查阻塞；子窗增加 `--disable hooks` 后，工作树 `--selftest-close` 通过，随后上述四窗验收通过。宿主仍负责钩子信任，子窗不会批准钩子。异常尝试的四个自有启动器已按身份关闭。
- Codex Security 对修复前快照的标准扫描登记四项发现（两项高危、两项中危）；当前代码分别补上发起会话权限边界、原生 CLI 包完整性验证、辅助窗 4000 MB 准入和恢复协调器路径绑定，并用红/绿回归验证。原扫描绑定旧快照，不能误写成当前快照零发现。Plugin Eval 对干净分发包评为 95/A、0 fail；其延后成本警告仍在，属于整包文本规模提示。

上述四窗运行证明本机该负载下可达到四并发，不能推出任意设备、模型或内存波动下的固定并发数，也不能以有限测试证明绝对没有缺陷。后续的已安装新缓存自检结果与提交哈希应与本节一起核对。

## 历史快照记录

候选核心标签为 `1.4.0-rc.1`，运行协议保持 2。专用仓库仅维护 Codex；通用适配器在独立的 open-tui-orchestrator 中演进。当前快照的插件版本为 `0.5.0-rc.1+codex.20260919200323`；最新一轮离线回归 304 项（303 通过、0 失败、1 跳过，跳过项是需显式开启的真实模型验收 `ORCH_REAL_CODEX_ACCEPTANCE=1`）。第二台机器的干净安装验收清单见 [干净机器安装与验收](clean-machine-validation.md)。

验证证据绑定实际提交和封存哈希，不只绑定版本标签。下文保留此前快照的结果；自那次实测后代码和哈希已经变化，因此这些记录不认证当前代码、当前发布包或当前启用缓存。当前副本已重新执行本轮对应验证；未重新执行的项目仍保持未通过或未验证。

## 当前公开前清单

- [x] 窗口/焦点层探针区分系统默认终端转交与真正的传统控制台；显式 conhost 路径和 Windows Terminal 路径均完成真实启动、回执读回及关闭检查。端到端插件自检另列，不能由此项代替。见 [当前焦点证据](../test/inactive-window-validation-current.json)。
- [x] 修正同步焦点探针的启动采样盲区、工作目录漏验和输入就绪检查；历史连续输入通过记录不再认证启动期间输入。
- [x] 连续输入：**当前快照已通过**（2026-09-19 空闲桌面实测）：`inputAttempts=60`、`inputDelivered=60`、`inputDuringLaunch=59`、`inputLostFocus=false`、`lossHwnd=null`、`targetForegroundEvents=0`、`foregroundSamples=0`、`receiptValid=true`、`closed=true`、`passed=true`。旧快照那条"未取得前台焦点"的记录已作废。
- [x] 已安装缓存真实 `selftest-close`：**当前快照已通过**。修复"启动器只认 ASCII 结束标记"后，缓存路径实测 `elapsedAfterDetectMs=0`、无孤儿、`selftestPassed=true`；随后又发现该判据依赖模型逐字回标记（一次实跑退化为兜底关窗 20992ms），已把 watchdog 放宽为"rollout 被本窗 token 绑定后，收到 task_complete（turn 为空或匹配）即收窗"——放宽后仓库路径连续两次 0ms/1ms 秒关、无孤儿、`selftestPassed=true`。缓存副本会在管理器下次同步后自动带上同一修复。
- [x] 容量级真实 Codex 任务全部得到有效回执（2026-09-18 动态内存预算快照重跑）：headless `acceptance-aeae71ac-880c-4620-a05d-a32da05d08a7` 与可见 TUI `acceptance-164be263-7c03-4744-8f7f-47034c98f2bc` 均 `passed=true`、9 项全 `verified`、回执/有序/并发证据齐全，见文末"动态内存预算下的双模式验收"。
- [x] 重启验收按拆分证据收口（2026-09-19）：两次真实重启回执均证明"重启后健康"（见下节），自动收集机制已实现并离线端到端验证。
- [x] 提交 `0fca067` 的真实重启后健康检查：2026-09-13 19:28（北京时间）启动，回到 Codex 后显式补收集，启动时间变化、release integrity、doctor 与 marketplace 注册回执均已读回。只认证这次重启后的插件文件和本地环境健康，不认证未完成任务的重启恢复。
- [x] 插件管理器 Git 市场的 add/install/upgrade/rollback/remove/uninstall 已在隔离 `CODEX_HOME` 中实际读回，见 [管理器生命周期证据](../test/manager-lifecycle-validation.json)；该证据使用本地 Git 传输映射，不能代替公开 GitHub 地址的网络抓取。长期断网、未完成真实模型任务跨系统重启恢复和登录后自动收集仍未通过；受控本地 HTTP 故障恢复 9/9 已通过。防火墙注入因未提权被拒绝，未改变网络状态。本次 RunOnce 未自动产出回执，不能用补收集结果替代自动触发验收。详见 [当前公开前证据](../test/private-readiness-validation.json)。
- [x] 私有源下的**升级/回滚**已在本机真实安装上演练（2026-09-19）：把注册源指向更高 cachebuster 的分发 → `codex plugin add` 升到 `0.5.0-rc.1+codex.20260919230000`；再指回当前分发 → `codex plugin add` 回滚到 `0.5.0-rc.1+codex.20260919211020`，每次安装后 `release-integrity` 与 `--doctor` 都通过，管理器每次只留一个版本缓存。仓库保持 private，"公网 GitHub 抓取"这条门槛按私有分发源重新定义；证据见 [私有源管理器生命周期证据](../test/manager-lifecycle-validation-private-source.json)。
- [x] 代码提交 `4fdcaa3` 完成过一次标准源码安全扫描：7 个高风险源码面、0 个可报告发现、覆盖 partial。后续新增重启验证脚本不在该历史扫描范围内；扫描 ID 与限制见 [当前公开前证据](../test/private-readiness-validation.json)。
- [x] 本地安装默认回到**单一 checkout**（2026-10-01）：个人 marketplace 条目指向工作树本身，不再自动创建或依赖 `dist` 目录；`install-plugin.mjs` 只有显式 `--source dist --dist-root <目录>` 才导出干净包。`repair-plugin-registration.mjs --check` 同时接受 checkout 与显式 dist 源，并要求分发核心与工作树一致，否则报 `stale_dist`。干净发布包仍可用来做静态评估，但不再是本机默认安装源。
- [x] 真实双模式验收在当前提交重跑通过（2026-09-19，两任务、默认动态内存预算路径、**从已安装缓存入口**运行）：可见 TUI `runId=mode-visible-bbf3d786-959e-4a8b-b1ce-5e7c6ca98a24`、headless `runId=mode-headless-afbf3afd-e221-477b-930f-762b1dfbdc8f`，两项都是 `passed=true`、`exitCode=0`、`closed=true`、`coreUnchanged=true`、T001/T002 全 `verified`、回执 `nonce/cwd/answer` 校验通过，见 [证据](../test/live-mode-validation-1.4.0-rc.1.json)。顺带修掉一个真实漂移：`test/live-execution-mode.mjs` 过去只发单任务，而单任务按设计直接 `out-of-scope`，已改为两个独立任务并各自独立验收。

### 2026-09-18 provider 继承修复与未完成的实机门槛

发起方把原生 Codex 切到第三方 provider（deepseek-flash）后暴露出一个旧缺陷：规划 SDK 与两种执行模式此前无条件注入 `model_provider="orchestrator-openai-https"`（`requires_openai_auth=true`），第三方 provider 配置与凭据无法生效；本机已无 OpenAI 登录凭据时，规划与窗口都会失败。本轮改为默认继承发起方 Codex 配置（模型、provider、凭据），只有显式 `ORCH_PROVIDER=openai-https` 或配置了中继地址时才注入 OpenAI HTTPS provider，其它取值在启动前 fail-closed。

同一轮还收紧了一个窗内契约缺陷：可见窗此前出现过「先做块内第 2 项、跳过第 1 项就收尾」，导致块失败并额外重开一窗。runner 现在要求严格按序执行本块全部任务、等待型命令必须等其结束、每项都写 completed 后才允许输出结束标记。

离线范围：provider 选择、argv 生成、规划器选项与 supervisor 选项的单元/契约回归，窗内顺序提示的 launcher/runner 回归，以及文档一致性；当前快照完整离线回归为 286 项（285 通过、0 失败、1 跳过，跳过项是需要真实模型的可选验收）。

实机范围（当轮容量公式仍按空闲内存计算；本轮已改为按机器物理内存、每块 2 GB 预算，本机 16 GB → 容量 8）：

- 单任务通道：原生 `codex exec` 直接以 deepseek 返回 `turn.completed`，确认 CLI 与第三方 provider 通路正常。
- headless 容量验收 `acceptance-ec4d0557-98b2-4f25-819c-fe090cd74f50`：`passed=true`、`peak=2`、`windowLaunches=2`、`receiptsValid/ordered/overlap=true`，证据见 `temp/codex-live-headless-cbcfdabbcffdb/report.json`。
- 可见 TUI 容量验收（修复前）`acceptance-0a44205d-f36b-46af-9e47-81bbd89b1b49`：引擎最终 `success=true` 且三项全部 `verified`，但窗内顺序违例导致 `ordered=false`、多开一窗（`windowLaunches=3`），本机按契约判为未通过，证据见 `temp/codex-live-visible-eefdcfcaaeddbd/report.json`。
- 可见 TUI 容量验收（顺序契约收紧后）`acceptance-02d01574-7c42-4cf6-a8e6-d2d343829dce`：`passed=true`、`peak=2`、`windowLaunches=2`、`uniqueLaunchers=2`、`terminal=wt`、`ordered/overlap=true`，三项任务全部 `verified`，证据见 `temp/codex-live-visible-fdfafa/report.json`。

仍未通过或未执行的门槛：容量公式本轮改为「机器物理内存 MB / 2000」（16 GB 机器 → 容量 8）后，8 并发验收已具备运行条件，结果见下一节；真实前台连续输入、已安装缓存 `selftest-close`、长断网、未完成任务跨重启与 RunOnce 自动收集也仍未在本快照上执行。`docs/rc-validation.md` 中 2026-09-15 及更早的记录、容量回执与限额结论都绑定在旧快照上，不能证明当前快照，也不能再引用 OpenAI 账户额度作为通过条件。

### 2026-09-18 环境（WSL）修复与功能测试台

宿主把 Codex 切到 WSL 后暴露了一个真实环境缺陷：WSL 启动的 Windows 进程没有 `PATHEXT`，PowerShell 因此解析不到 `chcp`，窗口启动器在首行中止（`INACTIVE_WINDOW_LAUNCH_FAILED`）。修复方式：入口补齐 `PATHEXT`（子进程继承），启动器把 `chcp` 包进非致命兜底；回归夹具改成与父进程类型无关（`Start-Process -Wait`、`cmd.exe /c` 包裹）。同时确认一条需要使用者知道的 WSL 事实：WSL 不会把自定义环境变量传给 Windows 进程，`ORCH_*` 必须用 `WSLENV` 转发或在 Windows shell 里设置。

同一轮的功能测试台结果（都是真实 deepseek 运行）：

- 窗口自检：`--selftest-close` 从 WSL 发起也通过（窗口正常弹出、约 0.6 秒自动关、无孤儿进程、`selftestPassed=true`）。
- 离线回归：Windows 原生 286 项（285 通过、0 失败、1 跳过）；修复夹具后 WSL 直接调用同样可用（`recovery`/`native-argv`/`inactive-window` 等此前的假失败消失）。
- 可见 TUI 容量验收 `acceptance-0bae3626-870e-4f97-91f3-d0ddb87897cd`（当时公式给出的容量为 2）：`passed=true`、容量 2、两块（B1=[T001]、B2=[T002,T003]）、`peak=2`、`ordered=true`、`overlap=true`，证据见 `temp/codex-live-visible-ccfadefaaeeb/report.json`。
- 断电恢复验收 `powerloss-26777d24-4138-465a-b203-e4875d77b173`：T001 检查点完成后、T002 执行中时用 `taskkill /F /T` 强杀整棵控制器进程树，再用 `--resume-run` 续跑；最终 `success=true`、generation 2、T001 尝试次数仍为 1（不可重复副作用只执行一次，`counter.json` 计数 = 1）、T002 作为 `retrySafe` 任务重试后 `verified`。证据见 `temp/powerloss-26777d24-413/report.json` 与同 run 的 `events.jsonl`（含 `run.resumed` 事件）。
- 状态面：`status.mjs` 只读面板同时给出 TodoList（逐任务）与 Execution（逐块 + 尝试次数 + PID），`goal.json` 派生镜像包含 tasks/blocks/status，可直接被宿主或脚本消费。

用例已固化为 `test/live-powerloss.mjs`（可选真机验收，默认不进离线套件）。

### 2026-09-18 容量公式与 8 并发验收

容量公式改为按机器检测到的物理内存、每块 2 GB 预算：`floor(机器内存MB / 1000) / 2` 向下取整（等价 `floor(机器内存MB / 2000)`）。本机 16,011 MB → 容量 8，且不再随运行时空闲内存波动（此前 2.3 GB 空闲时容量只有 2）。

- 8 并发容量验收 `acceptance-02e54e78-e1d4-4c2f-bbfa-cf350d280642`（headless）：`passed=true`、`capacity=8`、9 个任务切成 8 块、`peak=8`、`receiptsValid/ordered/overlap=true`、全部 9 项 `verified`，证据见 `temp/codex-live-headless-beabdfccfccdfef/report.json`。
- 8 窗可见 TUI 容量验收 `acceptance-12dc2988-16a5-439f-aead-1893ddbfea45`（Windows Terminal，非 headless）：`passed=true`、`capacity=8`、8 个窗全部弹出（`windowLaunches=8`、`uniqueLaunchers=8`、`terminal=wt`）、`peak=8`、9 个任务切 8 块（B1–B7 各 1 项，B8 串行 T008+T009）、`receiptsValid/ordered/overlap=true`、窗口全部关闭、引擎与轮询退出码 0，证据见 `temp/codex-live-visible-cbecfff/report.json`。
- 长断网验收 `outage-d7d0424a-9281-45cb-8787-4f38adc65aa6`：进程级 CONNECT 代理（只影响本次运行自己的子进程，全程未改系统代理或防火墙），放行域名按当前 provider 配置推导（deepseek → api.deepseek.com）；5 分钟中断期间 41 次连接被真实阻断，恢复后重连成功，两项任务回执有效、整轮 `verified`，证据见 `temp/outage-d7d0424a-9281-45cb-8787-4f38adc65aa6/report.json`。
- 真实前台连续输入：探针本轮两次运行都未能通过，原因是**桌面不空闲**——第一次尾部有一次按键落在正在销毁的输入框上（已在探针里加目标窗退出即停发守卫修掉），第二次修好后 64/64 按键全部投递、无丢焦点、无按键外泄，但目标窗被系统激活过一次（`targetForegroundEvents=1`、`foregroundSamples=5`），严格判据（目标窗全程不得进入前台）不成立。该项需要在无人使用的桌面上重跑。

### 2026-09-15 本轮修复和证据边界

本轮修复了已验收任务被容量处理覆盖、任意任务文本误触发容量重试、待对账/待验收状态被覆盖、命令行选项边界、JSON 键顺序误判、网络地址在规划器与执行器之间不一致、连接恢复后仍被标为失败、窗口正常退出被误记超时、任务文本抢占启动器归属标识，以及 UUID 数字污染确定性项目拆分。规划器和两种执行模式默认继承原生 Codex 配置，调用方仍能显式覆盖。明确的失败退出显示为 `failed`，不会冒充轮询超时。Windows 版本刷新脚本曾写出 CRLF，封存检查已拦截并在重新生成包前正规化为 LF。

同一中间快照的单任务 headless 与可见 TUI 都得到 `answer:42` 回执、`verified` 状态、退出码 0 和已关闭进程。五分钟的进程范围代理断网也曾观察到 43 次被阻断连接，恢复后两项回执有效且副作用各一次。这些通过记录均保留哈希；后续核心修复使它们成为历史证据。当前版本的新一轮容量 headless/可见实测均达到计算出的 3 窗并发峰值，但真实 provider 返回 `usage_limit_exceeded`，因此没有进入有效回执或长断网阶段，不能登记为通过。

当前版本源码离线回归为 284 项（283 通过、0 失败、1 跳过）；同一套 284 项从 plugin manager 安装缓存自身目录重跑也为 283 通过、0 失败、1 跳过。静态检查、安装副本与发布完整性结果统一记录在 [公开前账本](../test/private-readiness-validation.json)。仓库继续保持 Private。真实前台连续输入、当前容量验收、当前长断网、未完成任务跨系统重启与 RunOnce 自动调度仍是独立门槛。

### 2026-09-14 较早一轮全量离线与双模式审计（历史快照）

本轮对当前工作树重新执行了 248 项离线回归（247 通过、1 跳过、0 失败），并对 39 个 JavaScript、35 个 JSON、4 个 PowerShell 文件完成语法/解析检查；release integrity 当前为 schema 2、24 个核心文件与 50 个运行时文件，均已重新 seal 并验证。汇总账本见 [full-audit-current.json](../test/full-audit-current.json)。

同一单任务分别以 `exec + headless` 与可见 Windows Terminal TUI 实跑：两次都生成 `answer: 42` 回执，最终都在 provider `429`/不确定副作用下 fail-closed 为 `needs-reconciliation`，退出码均为 1，用户可感知的最终状态一致。该证据只证明单任务模式契约与失败收敛，不替代容量级并发回执、连续前台输入、长期断网、未完成任务跨重启和 RunOnce 自动收集；这些门槛继续保持未通过，computer-use 阶段尚未开始。


### 2026-09-18 动态内存预算（替换固定容量公式）

并发不再用固定公式估算，而是运行时按可用内存动态决定（`ORCH_CAPACITY_MODE=dynamic`，默认）：规划期用最宽并行层的预估成本判断，超预算就在同一并行层合并最贵的两块（块内串行，峰值取 max）；执行期每开新窗复检，不够先 `deferred` 暂缓、等已运行块结束后重检，全部跑完仍不满足则降级硬跑（`degraded=hard-run`），确保一轮跑完、不 fail-closed。每窗默认 256 MB 成本（实测边际成本 193 MB，标定原始数据见 `temp/calib/report-8.json`），按实测滚动修正（钳制 160-600 MB）；底线 `ORCH_MIN_AVAILABLE_MB` 默认 512 MB（实测 8 窗时最低可用内存 108 MB，256 MB 会被击穿）。`ORCH_CAPACITY_MODE=formula` 可回退旧公式；单任务请求不再进入编排。

真机证据（deepseek，本机 16 GB）：

- 合并路径 `acceptance-f8d769e2-8f2e-46a0-94b9-d506cd3efddd`：可用内存紧张时把 8 个项目合并成 2 块（日志 `memory budget merge: proj-91 + proj-92, ... -> required 512MB, available 1128MB, floor 512MB`），并产生首条滚动样本 `observed 172MB`（单样本不降预算）。
- 暂缓→硬跑路径 `acceptance-6407d56d-b56a-4042-a2ab-30e74db7f2f2`：可用内存 583 MB、低于256+512门槛 → 先 `block.B1.deferred`，确认无其它块可推进后自动 `hard-run (degraded)`，最终 9 项任务全部 verified、`passed=true`（一轮跑完，未 fail-closed），证据见 `temp/codex-live-visible-badbedaddbbea/report.json`。
- 单元：`test/memory-budget.test.mjs` 7 项（准入边界、同层合并、依赖保序/拒绝跨层、滚动修正升降与钳制、成本交叉校验）；全量离线回归见本节末记录。


### 2026-09-19 自动收集触发器（启动文件夹）

RunOnce 在本机连续两次真实登录都未被执行（条目原样留存），而在非提权环境下创建 ONLOGON 计划任务被系统拒绝（实测 "拒绝访问"）。现改为第三种、无需提权的机制：prepare 时在用户启动文件夹写入 `CodexTuiOrchestrator-RebootValidation-<id>.cmd`（内含完整 powershell.exe 路径 + 收集器 + id），登录即自动执行；`collect -Trigger StartupFolder` 结束后只删除自己那一个文件。外部命令的错误文本一律先消毒为可打印 ASCII 再写入 JSON——此前把 `schtasks` 的 GBK 报错原文写进基线，直接让 JSON 变成"未终止的字符串"，收集中断在 read-baseline 阶段。

离线验证：bridge 测试 9/9；夹具级端到端（prepare → 启动项落地 → 执行 → `collectionTrigger=StartupFolder`、三项检查全跑、bootChanged=false 正确判失败 → 启动项自动删除）全部通过。真实重启认证见下一次重启的 `post-reboot.json`。

## 跨重启验收桥接

### 2026-09-19 重启验收收口（拆分证据，不再要求额外重启）


用户已明确不再为验收重启机器，因此该门槛按其可独立证明的两半收口：

1. **重启后健康：已通过（两次真实重启）**。`temp/reboot-validation-reboot-check-20260918/post-reboot.json` 与 `temp/reboot-validation-reboot-check-20260918b/post-reboot.json` 都记录 `bootChanged=true`、`sourceClean=true`，且 `release-integrity` / `doctor` / `marketplace-registration` 三项检查全部有效。两次唯一为 false 的字段是 `commitMatches`——原因是基线冻结之后又产生了提交（记账漂移），与插件在重启后的健康无关；`releaseMatches` 随同一原因变化。
2. **自动收集机制：已实现并离线端到端验证**。prepare 在用户启动文件夹写入 `CodexTuiOrchestrator-RebootValidation-<id>.cmd`（无需提权），`collect -Trigger StartupFolder` 执行三项检查并在结束后只删除自己那个文件；夹具级端到端（落地 → 执行 → `collectionTrigger=StartupFolder` → 三项检查全跑 → 自动清理）通过，bridge 回归 9/9。

**如实标注的残余缺口**：没有取得"同一次回执里同时满足 启动时间变化 + 提交/发布哈希一致 + 自动触发"的记录。原因是我在每次重启后又提交了代码（前两次）。当前有一份绑当前提交的冻结基线 `reboot-check-20260919c`（绑定 `8e16b41`，`releaseSha256=45413c1c7490`，与当前 `release.json` 实测一致）在册：将来任何一次重启或注销登录，启动项都会自动执行收集并留下 `collectionTrigger=StartupFolder` 的回执；届时只需读回 `temp/reboot-validation-reboot-check-20260919c/post-reboot.json` 即可补齐这条证据，不需要改代码。

上一份基线 `reboot-check-20260919`（绑定 `8ceae8c`）已在 2026-09-19 作废并删除：它在冻结之后又被多次提交改写，`release.json` 哈希从 `76c4161…` 变成 `45413c1…`，收集器必然报 `releaseMatches=false`；对应的启动项 `.cmd` 也一并移除，避免下次登录产生一条注定失败的回执。**注意：任何之后改动 `release.json` 的提交都会同样作废当前基线**，所以这条门槛的收口时机应选在代码定稿之后。

还剩的这条门槛可以在**一次登录里一起收口**，但必须"临重启前再武装"：`node test/live-reboot-recovery.mjs prepare <id>` 会（1）启动一次真实 headless 运行，留下"一项已完成、一项幂等等待"的账本（执行工作区是 `temp/reboot-recovery-<id>/ws`，独立于插件仓库；两个任务落在各自块里、第二块依赖第一块，所以顺序由控制器保证而不是靠模型自觉），并（2）自己调用 `test/reboot-validation.ps1 -Mode prepare -Id <id> -RecoveryId <id>`，把健康检查与任务恢复写进同一份基线（记录当时的 `commit` 与 `release.json` 哈希）。重启或注销登录后启动项自动收集，一次回执同时覆盖：启动时间变化、发布哈希一致、`collectionTrigger=StartupFolder`、未完成任务跨重启后的 `task-recovery` 检查。

**硬约束（实测）**：等待中的探针自己上限 30 分钟，控制器的轮询上限也是 `ORCH_MAX_POLL_MS=1800000`（30 分钟），所以这份"武装"状态只在一个半小时窗口内有效；超时后运行会失败、基线作废。因此收尾时的处理是**不预先武装**（避免留下挂起窗口、失败账本和 RunOnce 残留），也不再有 `release.json` 变化的提交；等真的打算重启时，在重启前 30 分钟内跑上面那条 `prepare` 命令即可，收尾时验证过它能在 10 分钟等待窗口内正常到达边界（`boundary: T001 completed; T002 started and waiting`）。之后若仍有改动 `release.json` 的提交，删掉 `temp/reboot-recovery-<id>`、`temp/reboot-validation-<id>`、启动项与 RunOnce 条目后重新 prepare 即可。

**结论**：该门槛不再阻塞发布；文档明确区分"已证明"与"未观测到合并回执"两种情况。

### 2026-09-19 规模化验收（12 任务 / 动态预算）与首轮余量

### 2026-09-19 长断网验收（30 分钟）

- 机制：进程级 CONNECT 代理（只作用于本次运行拉起的子进程，不动系统代理/防火墙/全局网络），放行域名按当前 provider 配置推导（deepseek → api.deepseek.com）。
- 结果：30 分钟窗口内 **161 次连接被真实阻断**，恢复后重连成功；两项任务回执有效、整轮 `success=true`，证据见 `temp/outage-529ce29b-d504-4716-b00c-612753a299bb/report.json`（runId `outage-529ce29b-d504-4716-b00c-612753a299bb`）。此前 5 分钟版本同样通过；本项补齐到发布级时长。

- 验收规模：`ORCH_LIVE_TASKS=12`（公式容量 8 的 1.5 倍）→ 动态预算把 12 个任务合并成 **2 块**（`required 1600MB`、可用 `2727MB`、底线 `512MB`、滚动成本 `800MB`），**2 窗并发**、屏障正常释放。
- 结果：`passed=true`、`peak=2`、`receiptsValid/ordered/overlap=true`、12 项全部 `verified`，证据见 `temp/codex-live-headless-bacaaffcdefedfec/report.json`（runId `acceptance-c3ef4abe-8bbc-4e27-be6d-684d063359df`）。
- 首轮余量防护：新增 `ORCH_FIRST_RUN_HEADROOM`（默认 1.25）——样本不足 3 个时，规划与"开窗前准入"都按放大后的成本判断（宁可少开一块，也不把机器挤到 starvation）；样本够了自动回到 1。单测覆盖（含 65 任务无损合并、依赖保序、余量收紧），全量离线回归 294 项（293 通过 / 0 失败 / 1 跳过）。

### 2026-09-18 动态内存预算下的双模式验收（通过）

- headless：`acceptance-aeae71ac-880c-4620-a05d-a32da05d08a7` —— 可用 1321 MB、滚动成本 800 MB → 9 项合并成 1 块串行；`passed=true`、`peak=1`、回执/有序/并发证据全真、9 项 verified（`temp/codex-live-headless-dccccddfb/report.json`）。
- 可见 TUI：`acceptance-164be263-7c03-4744-8f7f-47034c98f2bc` —— 可用 2279 MB → 9 项合并成 2 块、2 个 Windows Terminal 窗；`passed=true`、`peak=2`、`windowLaunches=2`、回执/有序/并发全真、9 项 verified（`temp/codex-live-visible-aaeeaefcfaacadab/report.json`）。
- 验收 harness 修复：屏障按"仍在跑的块各自是否已有探针启动"判定，并在曾观测到"峰值并发 = 账本块数"后释放，避免合块内的第二个探针因等待屏障而超时；并发证据由任务时间窗重叠改为窗口并发峰值；进程采样偶发失败改为重试+跳过；监控窗口放宽到 30 分钟以容纳保守串行执行。

### 2026-09-18 缓存路径自检闭环（已修复并通过）

现象：同一个 `--selftest-close`，从仓库目录跑是 0 秒自查关窗、通过；从管理器缓存路径（`...\.codex\plugins\cache\personal\codex-TUI-orchestrator\<版本>\`）跑，两次都是自查不触发、靠编排器 15 秒兜底关窗，被判 `forcedClose` 不通过。

根因：启动器 watchdog 只认**独立一行的 ASCII 完成标记** `__ORCH_DONE__ <token>`（普通块窗都带这行）；而自检提示词只要求模型输出中文完成行，从未要求该 ASCII 标记，因此自查路径永远不触发，只能等编排器兜底。修复后自查立刻命中，又暴露出第二个竞态：刚被 watchdog 杀掉的子进程还在退出中就被判成"孤儿"。

修复：自检提示词同时要求两行（中文完成行 + `__ORCH_DONE__ selftest-<rid>`）；孤儿检查增加最多 5 秒的收敛窗口。

验证（提交 `8abbd10`，插件版本 `0.5.0-rc.1+codex.20260918212733`）：仓库路径 `elapsedAfterDetectMs=1`、缓存路径 `elapsedAfterDetectMs=0`，两次都是 `orphanChildren=false`、`selftestPassed=true`。

需要验证未完成任务恢复时，使用 `node test/live-reboot-recovery.mjs prepare <唯一ID>`。该脚本要求已提交的干净源码，实际运行两个 headless 任务：第一项完成并保存不可重复写入的回执，第二项进入可安全重试的幂等等待。只有读到第一项 `completed`、第二项 `started` 且原执行进程仍存活，才保存基线并交给下述收集器注册；脚本自身不重启 Windows。

真实重启后，收集器仅在启动时间增加、源码提交和封存哈希相同、健康检查通过时执行 `collect <同一ID>`。它续接原运行，验证第一项回执字节未变、两项副作用各一次、全部任务 `verified` 和执行进程已退出。可用 `--manual-only` 只准备显式收集。离线样本只验证拒绝同次启动、身份错配、重复副作用、失败状态和收集顺序，不算真实重启证据。

真实重启会中断当前 Codex 对话，证据保存在仓库 `temp/reboot-validation-<ID>/`。`prepare` 要求已跟踪文件没有未提交修改，保存原始提交、启动时间、release.json 哈希以及 Node/Git 绝对路径；Node 会解析到真实安装位置，避免保存版本管理器的临时会话入口。它同时尝试注册 RunOnce（登录时尝试执行一次的启动项）。注册只表示请求已保存，不能保证系统已执行；`-ManualOnly` 可只准备基线，由 Codex 在重启后补收集。

在仓库目录执行（将 ID 换为本次唯一值）：

```powershell
powershell.exe -NoProfile -File .\test\reboot-validation.ps1 -Mode prepare -Id reboot-check-001
```

重启登录后，先读 `post-reboot.json`。如果文件缺失，先记录原 RunOnce 项是否仍存在，再用同一个 ID 补收集；不需要重复重启或重复 prepare：

```powershell
powershell.exe -NoProfile -File .\test\reboot-validation.ps1 -Mode collect -Id reboot-check-001
```

新回执区分 `collectionTrigger=Manual/RunOnce`；触发参数本身不是 Windows 登录调度的独立证据，因此不会自动认证 `automaticCollectionPassed`。通过还要求启动时间向前变化、提交和发布清单未变、工作区没有已跟踪文件修改，以及三项检查的 JSON 内容、工作目录与退出码全部符合约定。每项检查有 30 秒上限；检查失败、依赖消失等会留下失败阶段和诊断。既有基线和结果禁止覆盖，缺少基线时不创建伪回执，清理只触及本次自有 RunOnce 项。

收集器还会在有效基线目录写入首次 `dispatch.json`（记录收集器开始执行的时间与触发方式）。它帮助区分“未启动收集器”和“收集器启动后健康检查失败”，仍不能单独证明 Windows 登录自动调度已经成功。当前脚本沿用系统执行策略。

本次实际重启记录绑定旧版脚本提交 `0fca067`，原始前后文件哈希及显式补收集方式已存入公开前证据。新增桥接回归用隔离样本覆盖无重启、补收集、失败回执、提交变化和注册命令执行，不将样本中模拟的启动时间当成新的真实重启。

仓库保持 Private。静态评分不替代上述运行和安装证据。

## 此前实现与根因记录

- 默认 `--exec` / `--headless` 不弹窗；`--run` 和裸请求默认采用 headless，可由 `ORCH_EXEC_MODE` 覆盖；`--run-windows` / `--visible` 明确选择可见 TUI。
- 两种模式统一进入 runner。旧 headless 分支绕过任务账本和独立验收的问题已消除；独立 supervisor 保留单任务恢复用途。
- 隐藏 worker（独立持有执行进程及日志的进程）在容量和注册准入完成后才执行。主控退出后，worker 继续保存输出；恢复接管原 PID，不重复已验证任务。
- 主控同步协调可能让就绪等待超过计时器；以前会遗漏已写好的 PID，误报启动失败。现在先复查持久 PID，再判断超时，并为批量启动保留有限的就绪时间。
- 批量退出不再逐块重复完整 CIM（Windows 进程信息查询）扫描；先用轻量 PID 存活检查证明进程已退出。无法证明退出时仍保留租约。
- 普通失败与 provider 容量失败分别计数，容量重试不会解除普通失败预算。日志写入异常会先收尾自有子进程，再保存失败结果。
- Codex 默认协调器改用独立的 HKCU `Software/CodexTuiOrchestrator` 与 `temp/orchestrator/codex-coordinator` 命名空间；恢复先校验账本/镜像，再沿用账本中的旧协调器。这样旧通用 open-tui-orchestrator 的容量和身份清理不会改写 Codex 租约。
- TodoList（原始任务状态）只在该任务写入 started 后进入 running；completed 后等待独立验收。Execution（执行块状态，也称 spawn 状态）独立记录块模式、PID、尝试、等待及重试原因。
- 原子 summary、递增事件序号和 goal 镜像保持一致；恢复重建落后的派生镜像，重新验收也发布双状态。读者忽略不完整的事件尾行，完整损坏行会报错。
- 历史 Git 检出回归覆盖当时的 48 个 runtime 文件，并统一文本换行，避免检出后封存校验失效。
- GitHub 全新下载暴露了 Git 索引仍使用大写 `skills/codex-TUI-orchestrator`、封存清单使用小写目录的差异。Windows 本地路径匹配掩盖了该问题；现已通过 Git 重命名统一小写，增加索引精确路径回归。原有从工作区复制后再建 Git 的回归无法覆盖索引与本地目录名不一致。

## 此前快照的历史验证

| 检查 | 结果 |
| --- | --- |
| 当时源码完整回归 | 213 项通过、1 项真实环境跳过（专项测试加入后） |
| 当时全新发布包完整回归 | 213 项通过、1 项真实环境跳过 |
| 历史 GitHub 克隆重装（目录大小写修复后） | 提交 `6c82982`；独立 npm ci、48 个 runtime 文件校验、doctor、只读 status 通过；完整回归 214 项通过、1 项真实模型用例未启用 |
| 文档、模式、事件流与完整 Git 检出追加校验 | 9/9，通过 |
| 锁文件依赖安装 | npm ci --omit=optional --ignore-scripts，通过 |
| 历史发行封存快照 | schema 2，24 个核心文件、48 个 runtime 文件；当前封存为 24/50 |
| 发布包与源码 | runtime 哈希及 release.json 一致 |
| 当时已启用缓存 | 当时修复了封存不一致，逐项匹配及 doctor 通过；不代表当前缓存已同步 |
| 真实 headless 单任务 | 回执有效、独立验收成功、进程已退出 |
| 已安装缓存的真实可见单任务 | 回执有效、窗口自动关闭 |
| 已安装缓存的 12 块 / 13 任务 headless | 容量 12、峰值 11、19 次尝试；provider 429 导致 4 项无有效回执，严格未通过 |
| exec/TUI 状态专项验收 | 离线 5/5，通过；真实 headless + 可见 TUI 2/2，通过；覆盖 model/effort、TodoList、spawn 群及宿主边界 |

历史汇总在 `test/exec-headless-validation-1.4.0-rc.1.json`，生成时间为 2026-09-11。它没有记录本次修改后的封存哈希，不能单独证明当前快照通过。当前 core 1.4.0-rc.1 的历史流程逐项记录在 [当前流程证据](../test/live-process-validation-current.json)：headless、可见 TUI、控制器中断后恢复接管、监督器、低层 `--spawn` 结果捕获、`--verify-run`、受控网络恢复和发行包流程均有实际结果；Legacy 控制台焦点保护、连续输入探针和个人 marketplace 注册及官方安装已通过；当前隔离官方 Git 管理器生命周期见 [管理器证据](../test/manager-lifecycle-validation.json)。这些证据不替代容量级多任务验收。提交 `dea90f4a3d5e482b70e4cc9bea694133ad82615a` 还完成了覆盖 162 个文件的离线安全审计，报告项为 0；审计范围是当前源代码、PowerShell 启动器、清单、CI、文档、测试和已跟踪证据，限制是未进行外部部署或恶意多用户运行。仓库中的进程级回归覆盖主控崩溃接管、未完成副作用不重放、启动准入失败、日志故障、输出截断、非零退出和任务逐项状态。

历史 GitHub 重装检查直接使用远端全新克隆与锁文件依赖安装，没有复制旧 SDK 或运行档案；沿用本机已安装的 Codex CLI。它只验证所记提交的分发与脚本安装，不替代插件管理器注册/重新启用、跨用户安装或真实模型服务验收。验证副本与临时运行记录不纳入 Git。

README 与 README-zh 的安装块会显式检查 `git status --porcelain`，拒绝本地改动，并在 clone、pull、npm ci、完整性检查或 doctor 任一步失败时停止。命令块只管理源码脚本副本；自动加载技能仍要求在宿主支持的流程中注册并启用插件。个人 marketplace 注册、官方安装及 cache hash/doctor 已读回通过；实际升级/回滚、跨用户安装仍需分别验证。

两个 README 的执行示例先准备唯一运行 ID 和只读验收 JSON，再从发起工作区调用绝对入口。缺少任务验收条件时结果为 `awaiting-verification`，不返回任务成功。独立 supervisor 仅判断 Codex 会话完成，不运行这套任务验收。

此前诊断出现过就绪误判、探针位置参数遗漏，以及修订探针时的重复导入错误。相关失败未记为通过；生成的探针应先经 Node 语法检查，再调用模型执行。容量数、启动块数和实测峰值分别记录，任何一个都不能代替有效任务回执。

## 复现

从发起工作区调用插件脚本的绝对路径；以下相对路径示例从源码根目录运行。

```powershell
& {
  $ErrorActionPreference = 'Stop'
  node --test --test-concurrency=1 test/*.test.mjs
  if ($LASTEXITCODE -ne 0) { throw '离线回归失败。' }
  node scripts/release-integrity.mjs
  if ($LASTEXITCODE -ne 0) { throw '完整性检查失败。' }
  node scripts/orchestrate-sdk.mjs --doctor
  if ($LASTEXITCODE -ne 0) { throw '安装诊断失败。' }
  node scripts/orchestrate-sdk.mjs --status --readonly
  if ($LASTEXITCODE -ne 0) { throw '只读状态检查失败。' }
}
```

以下为真实验收入口，会使用已配置模型的额度并可能打开可见窗口；它们不属于离线回归。每项单独运行并读回新结果，不用旧文件代替：

```powershell
$env:ORCH_LIVE_MODE = 'headless'
node test/live-codex.mjs
if ($LASTEXITCODE -ne 0) { throw '真实 headless 验收未通过。' }
```

```powershell
$env:ORCH_LIVE_MODE = 'visible'
node test/live-execution-mode.mjs
if ($LASTEXITCODE -ne 0) { throw '真实可见执行验收未通过。' }
```

真实验收使用现有账户额度，按顺序运行。`ORCH_LIVE_ENTRY` 可指定已安装缓存的公共入口。`test/live-execution-mode.mjs` 发的是**两个独立任务**（单任务请求按设计直接 `out-of-scope`，不进编排），因此它的通过同时覆盖"每项各自写检查点 + 主控分别独立验收"。观察运行使用 `node scripts/status.mjs --run-id <ID> --watch`，添加 `--json` 可消费结构化状态；观察器只读，退出不终止执行。

## 发布边界与历史证据

终端双面板和 JSON 状态接口已实现。Codex 原生 TodoList/spawn 卡片仍需宿主消费接口，插件不能仅靠技能注入原生卡片。不宣称当前代码已完成真实容量验收、跨用户安装、实际插件管理器升级回滚、重启或长期网络中断。旧记录中的缓存同步和清理结果只属于当时快照。

1.3.4 的 [包验证](../test/package-validation-1.3.4-rc.1-historical.json)、[可见并发阻塞](../test/concurrency-validation-1.3.4-rc.1.json) 和 [控制器接管](../test/controller-adoption-validation-1.3.4-rc.1.json) 保留为历史证据，不认证当前核心。
