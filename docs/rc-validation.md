# 0.4.43-rc.1 验收记录

候选核心：`1.3.4-rc.1`。本记录区分候选包生成与完整 RC 验收；任何未完成项目都不能记为通过。

## 本次修复

- 隐藏辅助 PowerShell 使用 Windows 脱离控制台标志时，会返回 0 却不执行脚本。取消该标志，保留异步启动、隐藏辅助窗口和现有前台焦点保护。
- 辅助进程启动失败或非零退出会传给调度器，避免吞掉错误后只等待窗口超时。
- 控制器等待辅助进程启动期间保持进程引用，防止独立启动时因尚未完成的异步等待而提前退出。
- 显式使用 UTF-8 输出进程信息及协调器路径，使中文路径和参数保留原文，可用于进程身份核验。
- 历史验收测试不再依赖开发者的另一份源码、旧安装目录或安全报告绝对路径。当前发行包仍必须通过每次重新生成的包测试。
- 状态文件原子替换遇到 Windows 临时文件占用时，最多重试 1.5 秒；持续失败保留原状态并清理本次临时文件。真实文件锁测试覆盖了两种结果。
- Git 保留文件原始字节，避免自动换行转换破坏发行校验。真实 Git 检出测试在启用自动换行转换的环境下核验完整性。

## 可复现检查

```powershell
node --test test/*.test.mjs
node scripts/release-integrity.mjs
node scripts/orchestrate-sdk.mjs --doctor
node scripts/orchestrate-sdk.mjs --status --readonly
node test/live-concurrency.mjs
node test/live-recovery.mjs
```

最后两个命令会打开真实 Codex 窗口并使用现有账户额度。串行运行真实验收，不与其他编排任务混用。候选版沿用现有授权和配置规则。

## 当前验收状态

当前候选包已完成可重复的离线和发布前验收：源仓完整回归 `187/187`；现有全新发布包记录在锁文件依赖 `npm ci --omit=optional --ignore-scripts --no-audit --no-fund` 后回归 `180/180`，并通过 `release-integrity`（核心 20 文件、runtime 43 文件）、`doctor` 和只读 `status`，无活动窗口、预约或锁。当前包的机器可读记录见 [current-package-validation.json](../test/current-package-validation.json)，旧 `1.3.1` 记录已单独保留为历史证据。

doctor 已确认当前测试默认参数为 `gpt-5.3-codex-spark` 与 `xhigh`，15.64 GiB 按公式得到并发上限 12。宿主桌面配置已保存 `followUpQueueMode = "queue"`；插件本身没有 steer 参数，也不覆盖宿主设置。

当前核心连续输入焦点探针已通过，结果见 [1.3.4 连续输入证据](../test/inactive-window-validation-1.3.4-rc.1.json)：输入送达、无观察到的焦点丢失、目标窗口前台采样为 0，并已自动关闭。

当前核心的控制器中断接管也已通过：第一任务只执行一次，测试控制器中断后由 `--resume-run` 接管同一窗口，代数推进到 2，结果见 [1.3.4 控制器接管证据](../test/controller-adoption-validation-1.3.4-rc.1.json)。

同一验收在已安装缓存中也已发起，但 provider 窗口未产生任务检查点，安全尝试预算耗尽后按失败收束；该结果保留在 [缓存接管阻塞证据](../test/controller-adoption-validation-1.3.4-rc.1-cache.json)，不能用源仓成功结果替代缓存包验收。

当前核心的真实模型驱动容量验收已在修复后重新执行：规划器正确产出 12 个容量块（13 个任务的最后 2 个串行溢出），但本机 Windows Terminal/模型启动实际峰值为 6；其余窗口经历三次启动尝试仍未确认，barrier 未释放，因此没有完整有效收据，运行进入 `needs-reconciliation`。这已排除原先的两项代码根因（未知三位项目编号触发单块回退、runner 将窗口重试硬编码为 1），但宿主启动容量仍未通过当前 RC 门槛。结果保留在 [当前容量验收阻塞证据](../test/concurrency-validation-1.3.4-rc.1.json)，不能标记为通过。

以下项目仍未完成，因此本候选包还不能标记为完整 RC 验收通过：当前核心的有效模型驱动容量任务与收据、已安装缓存的控制器接管，以及真实插件管理器激活/回滚。额度不足时保留 `blocked by provider capacity`，不把历史核心的窗口证据升级为当前核心证据。

## 稳定版边界

新 Windows 用户账户、插件管理器实际升级/回滚、长期供应商网络中断、操作系统重启及所有前台焦点变化尚需专门验收。本机测试不能替代这些环境。历史安全扫描只代表它记录的核心哈希，不能认证本次改动。

## 架构限制

执行引擎仍在一份较大的脚本中生成 PowerShell 生命周期逻辑，后续修改必须保留真实进程测试。协调器只能依据进程身份和持久检查点判断恢复状态；没有可独立核验结果的外部副作用必须进入 `needs-reconciliation`（需要主控核对结果的状态），不能盲目重试。
