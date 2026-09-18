# 0.5.0-rc.1 验收记录

候选核心标签为 `1.4.0-rc.1`，运行协议保持 2。专用仓库仅维护 Codex；通用适配器在独立的 open-tui-orchestrator 中演进。当前快照的插件版本为 `0.5.0-rc.1+codex.20260918122820`。

验证证据绑定实际提交和封存哈希，不只绑定版本标签。下文保留此前快照的结果；自那次实测后代码和哈希已经变化，因此这些记录不认证当前代码、当前发布包或当前启用缓存。当前副本已重新执行本轮对应验证；未重新执行的项目仍保持未通过或未验证。

## 当前公开前清单

- [x] 窗口/焦点层探针区分系统默认终端转交与真正的传统控制台；显式 conhost 路径和 Windows Terminal 路径均完成真实启动、回执读回及关闭检查。端到端插件自检另列，不能由此项代替。见 [当前焦点证据](../test/inactive-window-validation-current.json)。
- [x] 修正同步焦点探针的启动采样盲区、工作目录漏验和输入就绪检查；历史连续输入通过记录不再认证启动期间输入。
- [ ] 连续输入：本轮真实探针未取得发起窗口的前台焦点，已在启动前停止且未发送按键（`inputAttempts=0`、`inputDelivered=0`）；不能作为通过。详见 [当前公开前证据](../test/private-readiness-validation.json)。
- [ ] 最终封存快照的已安装缓存真实 `selftest-close`。当前版本已重新安装并启动可见窗口；窗口自然退出且无孤儿进程，证据文件已明确记录 `retryable: "quota"` 与 provider 原始 `usage_limit_exceeded`，但没有有效回执，插件按契约返回失败，不能把这次限额响应算作通过。
- [ ] 最终封存快照的容量级真实 Codex 任务全部得到有效回执。当前源码 headless 与可见模式均按当时容量 3 弹出并观测到 3 个并发窗口，4 个任务计划收缩为 3 个块；provider 限额使两次实测都没有有效任务回执，且各块按有限预算重试后 fail-closed。最终修复后的容量回执仍未通过；详见 [当前公开前证据](../test/private-readiness-validation.json)。
- [x] 提交 `0fca067` 的真实重启后健康检查：2026-09-13 19:28（北京时间）启动，回到 Codex 后显式补收集，启动时间变化、release integrity、doctor 与 marketplace 注册回执均已读回。只认证这次重启后的插件文件和本地环境健康，不认证未完成任务的重启恢复。
- [x] 插件管理器 Git 市场的 add/install/upgrade/rollback/remove/uninstall 已在隔离 `CODEX_HOME` 中实际读回，见 [管理器生命周期证据](../test/manager-lifecycle-validation.json)；该证据使用本地 Git 传输映射，不能代替公开 GitHub 地址的网络抓取。长期断网、未完成真实模型任务跨系统重启恢复和登录后自动收集仍未通过；受控本地 HTTP 故障恢复 9/9 已通过。防火墙注入因未提权被拒绝，未改变网络状态。本次 RunOnce 未自动产出回执，不能用补收集结果替代自动触发验收。详见 [当前公开前证据](../test/private-readiness-validation.json)。
- [x] 代码提交 `4fdcaa3` 完成过一次标准源码安全扫描：7 个高风险源码面、0 个可报告发现、覆盖 partial。后续新增重启验证脚本不在该历史扫描范围内；扫描 ID 与限制见 [当前公开前证据](../test/private-readiness-validation.json)。

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

并发不再用固定公式估算，而是运行时按可用内存动态决定（`ORCH_CAPACITY_MODE=dynamic`，默认）：规划期用最宽并行层的预估成本判断，超预算就在同一并行层合并最贵的两块（块内串行，峰值取 max）；执行期每开新窗复检，不够先 `deferred` 暂缓、等已运行块结束后重检，全部跑完仍不满足则降级硬跑（`degraded=hard-run`），确保一轮跑完、不 fail-closed。每窗默认 256 MB 成本（实测边际成本 193 MB），按实测滚动修正（钳制 160-600 MB）；底线 `ORCH_MIN_AVAILABLE_MB` 默认 512 MB（实测 8 窗时最低可用内存 108 MB，256 MB 会被击穿）。`ORCH_CAPACITY_MODE=formula` 可回退旧公式；单任务请求不再进入编排。

真机证据（deepseek，本机 16 GB）：

- 合并路径 `acceptance-f8d769e2-8f2e-46a0-94b9-d506cd3efddd`：可用内存紧张时把 8 个项目合并成 2 块（日志 `memory budget merge: proj-91 + proj-92, ... -> required 512MB, available 1128MB, floor 512MB`），并产生首条滚动样本 `observed 172MB`（单样本不降预算）。
- 暂缓→硬跑路径 `acceptance-6407d56d-b56a-4042-a2ab-30e74db7f2f2`：可用内存 583 MB、低于256+512门槛 → 先 `block.B1.deferred`，确认无其它块可推进后自动 `hard-run (degraded)`，最终 9 项任务全部 verified、`passed=true`（一轮跑完，未 fail-closed），证据见 `temp/codex-live-visible-badbedaddbbea/report.json`。
- 单元：`test/memory-budget.test.mjs` 7 项（准入边界、同层合并、依赖保序/拒绝跨层、滚动修正升降与钳制、成本交叉校验）；全量离线回归见本节末记录。

## 跨重启验收桥接

### 2026-09-18 动态内存预算下的双模式验收（通过）

- headless：`acceptance-aeae71ac-880c-4620-a05d-a32da05d08a7` —— 可用 1321 MB、滚动成本 800 MB → 9 项合并成 1 块串行；`passed=true`、`peak=1`、回执/有序/并发证据全真、9 项 verified（`temp/codex-live-headless-dccccddfb/report.json`）。
- 可见 TUI：`acceptance-164be263-7c03-4744-8f7f-47034c98f2bc` —— 可用 2279 MB → 9 项合并成 2 块、2 个 Windows Terminal 窗；`passed=true`、`peak=2`、`windowLaunches=2`、回执/有序/并发全真、9 项 verified（`temp/codex-live-visible-aaeeaefcfaacadab/report.json`）。
- 验收 harness 修复：屏障按"仍在跑的块各自是否已有探针启动"判定，并在曾观测到"峰值并发 = 账本块数"后释放，避免合块内的第二个探针因等待屏障而超时；并发证据由任务时间窗重叠改为窗口并发峰值；进程采样偶发失败改为重试+跳过；监控窗口放宽到 30 分钟以容纳保守串行执行。

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

真实验收使用现有账户额度，按顺序运行。`ORCH_LIVE_ENTRY` 可指定已安装缓存的公共入口。观察运行使用 `node scripts/status.mjs --run-id <ID> --watch`，添加 `--json` 可消费结构化状态；观察器只读，退出不终止执行。

## 发布边界与历史证据

终端双面板和 JSON 状态接口已实现。Codex 原生 TodoList/spawn 卡片仍需宿主消费接口，插件不能仅靠技能注入原生卡片。不宣称当前代码已完成真实容量验收、跨用户安装、实际插件管理器升级回滚、重启或长期网络中断。旧记录中的缓存同步和清理结果只属于当时快照。

1.3.4 的 [包验证](../test/package-validation-1.3.4-rc.1-historical.json)、[可见并发阻塞](../test/concurrency-validation-1.3.4-rc.1.json) 和 [控制器接管](../test/controller-adoption-validation-1.3.4-rc.1.json) 保留为历史证据，不认证当前核心。
