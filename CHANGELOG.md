# Changelog

## 0.5.0-rc.1

- 按"第二台新机器"实测补上泛化边界（沙箱：全新 HOME + 全新 CODEX_HOME）：`--check` 与安装缓存发现改为**跟随 `CODEX_HOME`**，不再假设 `~/.codex`（此前 CODEX_HOME 在别处时会把另一份缓存当成已安装，甚至报 `ok`）；新增 `repair-plugin-registration.mjs --set-source` 与 `install-plugin.mjs --set-source`，把唯一条目的安装源改写到本机分发（保留其它条目、策略与分类，重复/远端/无匹配仍然停下），用于换机器或换克隆目录后条目仍指向旧路径的情况。
- 技能可见性验证改为**可降级**：`--verify-skills` 在宿主不提供该调试入口或返回非零时记为 `warnings`（`steps` 里是 `warning`），只有显式 `--strict-skills` 才当作安装失败；所有子进程加超时（`--timeout-ms`，默认 15 分钟），宿主 CLI 缺失时给出可执行提示而不是 ENOENT 堆栈。
- 输出与诊断面向非作者机器：`install`/`check` 的 JSON 增加 `codexHome`、`environment`（platform / node / hostCli）与 `warnings`；非 Windows 主机给出明确告警（执行核心仅 Windows），命令行提示改为中英双语。
- 本机安装补上"首次安装"这一段并提供一键入口：新增 `scripts/install-plugin.mjs`（重建干净分发 → 补齐个人 marketplace 条目 → `codex plugin add` → 对**当次安装返回的缓存路径**恢复依赖 → integrity + doctor；`--check` 只读复核注册、分发新鲜度、缓存依赖与宿主启用，`--verify-skills` 再用宿主渲染一次新会话上下文确认技能可见）。`repair-plugin-registration.mjs` 增加 `--ensure`：个人 marketplace 文件或本插件条目缺失时按规范补上，新建整份文件只允许发生在 `<home>/.agents/plugins/marketplace.json`，既有条目、其它插件与顶层元数据原样保留；重复、指向别处或远端仍然停下报错。
- 实测背景（2026-09-21，Windows）：从零安装时个人 marketplace 文件并不存在，`--check` 只报 `missing_entry`/`invalid_marketplace` 且不会创建；插件管理器建立的缓存里没有 `scripts/node_modules`，漏掉依赖恢复会得到"技能可见、运行时缺依赖"的半成品。README（中/英）据此把一键流程放到安装章节最前，手工步骤仍保留并标注每一步的作用。
- 版本 cachebuster 升到 `+codex.20260921125337`（`.codex-plugin/plugin.json`、`scripts/package.json`、`scripts/package-lock.json` 同步），保证重装会建立新缓存而不是复用旧目录。
- 本地安装改用**干净分发**：新增 `scripts/publish-dist.mjs`（删除旧分发 → 从封存工作树重建 → 分发自校验 → 打印安装命令），个人 marketplace 条目指向 `<工作树父目录>/dist/codex-tui-orchestrator`。此前安装源是开发工作树，管理器会把 `.git/` 和 `temp/`（本地运行状态与验收证据）一起复制进安装缓存（本机实测 20 MB / 1473 文件），运行时不受影响但安装体积与静态评估失真（Plugin Eval 评分 81/C，改分发后 95/A）。`repair-plugin-registration.mjs --check` 现在同时认识 checkout 与 dist 两种安装源，并要求分发的 core 清单与工作树一致，否则报 `stale_dist`（先重建再安装），因此重启健康检查里的 marketplace 校验仍然有效。
- 修掉真实验收入口的漂移：`test/live-execution-mode.mjs` 过去只发一个任务，而单任务请求按设计直接判 `out-of-scope`，导致这条"真实可见/headless 验收"实际跑不起来。现在发两个独立任务、各自独立验收，并在当前提交上从**已安装缓存入口**重跑通过（可见 + headless 双模式，证据见 `test/live-mode-validation-1.4.0-rc.1.json`）。
- 重启自动收集基线换成绑当前提交的一份：旧基线 `reboot-check-20260919`（`8ceae8c`）在冻结后又被多次提交改写，`release.json` 哈希已从 `76c4161…` 变为 `45413c1…`，收集器必然判 `releaseMatches=false`；已删掉该基线与对应启动项，重新 `prepare` 出 `reboot-check-20260919c`（绑 `8e16b41`，哈希与当前 `release.json` 一致）。之后只要不再有改动 `release.json` 的提交，下一次重启/注销登录就会自动留下三合一的 `collectionTrigger=StartupFolder` 回执。
- 私有源下的升级/回滚补上真实证据：仓库保持 private，"公网 GitHub 抓取"这条门槛按私有分发源重新定义——指向更高 cachebuster 的分发后 `codex plugin add` 完成升级（`+codex.20260919230000`），指回当前分发后再次 `add` 完成回滚（`+codex.20260919211020`），每次安装后 `release-integrity` 与 `--doctor` 都通过、管理器只留一个版本缓存，见 `test/manager-lifecycle-validation-private-source.json`。
- 重启恢复夹具修到可用并如实界定窗口：`test/live-reboot-recovery.mjs` 现在（1）两个任务各用独立探针、各占一块且第二块依赖第一块，顺序由控制器保证，不再依赖模型自觉按序；（2）执行工作区改用 `temp/reboot-recovery-<id>/ws`，避开"改编排器自己"的自引用守卫（此前它会被直接判 inline，跑不起来）；（3）预置拆块缓存（含依赖）用本地复刻的 cache key 计算，离线测试不再需要真实 Codex CLI；（4）边界等待放宽到 10 分钟。实测能在 `boundary: T001 completed; T002 started and waiting` 停下。**窗口硬约束**：探针与控制器的等待上限都是 30 分钟，所以这条门槛只在"临重启前 30 分钟内武装"有效；收尾时保持未武装，并清掉了历史遗留的 RunOnce 条目与失败尝试目录。
- 修复**全新工作区首次加锁失败**：注册表锁在 `STATE_DIR` 还不存在时用 `openSync(...,'wx')` 直接拿到 ENOENT，而建目录的 `mkdirSync` 在锁内，重试永远救不回来——结果是干净工作区里的规划静默退化成单串行块（单任务请求还会直接判 out-of-scope）。现在加锁前先补锁目录，并加了回归用例。
- 进程身份枚举加入**有界重试**：Windows CIM 查询在机器繁忙或互斥锁争用时会把一次枚举超时变成"整块任务失败"。身份不一致仍然立即失败，但"枚举本身取不到"最多重试 3 次（300/600ms 退避）；同时没有 pid 文件时不再做枚举，省掉一次昂贵查询。目标是不因为环境抖动破坏"一轮跑完"。
- 验收契约与账本绑定（修复 Codex Security 扫描的 `integrity.unbound-acceptance-contract`，CWE-345）：运行开始时把验收契约的规范化 SHA-256（键排序，忽略排版）写进 `manifest.json` 与 `summary.json`，`--verify-run` 和 `--resume-run` 重新读取契约后比对摘要，不一致直接拒绝且不触碰任何任务状态或窗口——此前执行窗（对工作区有写权限）可以在验收前改写 `<runDir>/acceptance.json` 给自己降低门槛，或让恢复把未完成的任务当成已验收。重绑定只写了一半账本（崩溃）时取最新记录继续，不锁死运行。确实要换契约（不确定结果后收紧检查等）必须显式 `--allow-acceptance-change`（放在 run ID 之后）或 `ORCH_ACCEPTANCE_OVERRIDE=1`，放行会打印告警、重新绑定并在账本 history 追加 `acceptanceRebound` 留痕；旧版本记录的运行没有摘要，仍按原方式可验收。审计残留：同目录哈希挡不住能同时改写两份账本并抹掉绑定的角色，进一步隔离需要把运行目录移出执行窗写路径。
- 主动清扫"代码 1"残留窗：Windows Terminal 会在窗内进程非 0 退出后把面板留在屏幕上，于是屏幕上会堆出错窗。识别口径**与工作区无关**（命令行里出现 `…\temp\win-launch-*.ps1` 即认领，覆盖编排器在任意盘/任意工作区留下的窗——此前只认本仓库 temp，实测漏掉过 `D:\temp\...` 的残留）；安全边界是"该窗 launcher 已死且没有任何活着的子进程"才强杀，活窗与普通终端一律不碰。清扫在**每个入口的收尾**都会跑：启动清理、每轮 `--run/--exec` 结束、`--spawn` 结束、`--selftest-close` 结束，保证编排器工作完成后不残留错误码终端窗。
- 运行途中也清扫错误窗：长任务执行期间每 30 秒扫一次（不止收尾），屏幕中途也不会一直挂着"代码 1"死窗。
- 自检窗收窗判据放宽：此前要求模型逐字输出 `__ORCH_DONE__ <token>`，模型偶尔漏写就只能等主控 20 秒兜底关窗（实测 20992ms，严格判据失败）。现在只要该 rollout 已被本窗 token 绑定，收到 `task_complete`（turn 为空或匹配）即收窗；任务是否真完成仍由主控按检查点/回执独立验收，关窗不作为成功证据。
- 容量改为**运行时内存预算**（默认 `dynamic`）：规划期按全部块同时运行的预估成本与可用内存判断，超预算就把同一并行层里最贵的两块合并（块内串行）；执行期每开窗前复检，不够先 `deferred` 暂缓、等已运行块结束后重检，全部跑完仍不够就降级硬跑（`degraded=hard-run`）保证一轮跑完。每窗默认 256 MB 并按实测滚动修正（钳制 160-600），底线默认 512 MB（`ORCH_MIN_AVAILABLE_MB`）。单任务请求不再进入编排。`ORCH_CAPACITY_MODE=formula` 可回退旧公式。

- 容量公式改为每块按 2 GB 预算、取机器检测到的物理内存：`floor(机器内存MB / 1000) / 2` 向下取整（等价 `floor(机器内存MB / 2000)`，16 GB 机器 → 容量 8）。容量不再随运行时空闲内存波动，单块预算固定 2 GB。
- 修复从 WSL 发起时可见窗启动失败：WSL 启动的进程没有 `PATHEXT`，PowerShell 因此解析不到 `chcp`，窗口启动器在首行就中止。入口现在补齐 `PATHEXT`，启动器把 `chcp` 包在非致命兜底里；回归夹具改为与父进程类型无关（`Start-Process -Wait`、`cmd.exe /c` 包裹），WSL 与 Windows 原生两种方式都能跑绿。
- 新增可选真机用例 `test/live-powerloss.mjs`：强杀控制器进程树（模拟断电）后用 `--resume-run` 续跑，校验不可重复的副作用恰好执行一次、`retrySafe` 任务安全重试、整轮最终 `verified`。
- 规划器与执行窗默认继承发起方的 Codex provider（含 CODEX_HOME 中的第三方 provider 与其凭据）；只有 `ORCH_PROVIDER=openai-https` 或显式配置中继地址时才改走 orchestrator-openai-https，`inherit` 之外的未知取值一律 fail-closed。此前无论本机配置如何都会强制 OpenAI HTTPS provider，导致第三方 provider 无法用于实际任务。
- `scripts/package.json` 与 `scripts/package-lock.json` 的版本字符串与 `.codex-plugin/plugin.json` 的 cachebuster 同步，消除版本漂移。
- provider 的账户配额错误现在只接受结构化 `error`/`turn.failed` 或 `task_complete.error`，立即 fail-closed；窗口关闭后的有界重扫会保留迟到的 provider 诊断，任务文本和工具输出不能触发重试。
- 弹窗/容量准入异常会释放自有协调器租约与预留；带 PID 文件的死亡窗口登记会在下一次预留时清理，避免后续窗口永久卡在 capacity waiting。
- 发布器会根据 manifest 已声明的隐私政策和服务条款链接，拒绝缺少对应文档的阶段包；活动文档与容量实现统一使用 `floor(系统空闲内存MB / 1000) / 2`（每块 2 GB）后向下取整。
- 控制台备用路径显式使用 conhost：隐藏初始化后仅显示自有窗口，避免默认终端转交；真实焦点探针增加窗口类型、启动期间采样和回执工作目录校验。
- 连续输入探针先确认前台就绪，观察到失焦即停止后续按键；旧同步探针结果不再作为启动期间输入连续性的证明。
- 新增个人 marketplace 名称大小写检查与受限修复命令；仅修复已确认指向当前插件的唯一条目，默认只读。
- 低层 `--spawn` 只有捕获到本窗结果报告才返回成功；窗口自闭、结果缺失或写入竞态会明确返回未捕获并保留失败状态。
- 补充当前 core 的真实流程证据与个人 marketplace 注册边界，避免把外部注册失败误判为仓库运行时成功。
- 发现并修复 rollout 原始 token 搜索会误选父会话的问题；真实安装 selftest-close 已重新验证，结果以 RC 清单和回执为准。
- GitHub 安装/更新示例显式拒绝脏副本，并在每条原生命令失败时停止，避免后续成功掩盖前面的失败。
- 公共入口校验 `--workspace`、`--agent` 和 `--cli` 参数；专用入口默认 Codex，显式非 Codex 值会被拒绝。
- 检查点核对运行、令牌与任务身份；普通验收要求 completed，只有 started 的任务须经显式 `--verify-run` 对账。
- 监督器拒绝缺失或损坏的恢复状态，并识别失败终态事件，避免把失败会话当作完成。
- 公开入口示例提供运行 ID、独立验收文件和结果回读，说明缺少验收不会返回任务成功。
- 区分脚本副本与插件管理器注册、会话恢复与任务验收，并将旧快照的实测和缓存同步记录标为历史。
- 默认使用无弹窗 `exec`，可显式选择可见 TUI。
- 任务与执行块状态使用同一持久账本，并保留独立验收。
- 发行核心通过 `release.json` 做路径和哈希完整性校验。
- 当前版本仍是候选版，真实模型、插件管理器升级/回滚和跨机器兼容性不作稳定版保证。
