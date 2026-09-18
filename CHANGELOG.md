# Changelog

## 0.5.0-rc.1

- 规划器与执行窗默认继承发起方的 Codex provider（含 CODEX_HOME 中的第三方 provider 与其凭据）；只有 `ORCH_PROVIDER=openai-https` 或显式配置中继地址时才改走 orchestrator-openai-https，`inherit` 之外的未知取值一律 fail-closed。此前无论本机配置如何都会强制 OpenAI HTTPS provider，导致第三方 provider 无法用于实际任务。
- `scripts/package.json` 与 `scripts/package-lock.json` 的版本字符串与 `.codex-plugin/plugin.json` 的 cachebuster 同步，消除版本漂移。
- provider 的账户配额错误现在只接受结构化 `error`/`turn.failed` 或 `task_complete.error`，立即 fail-closed；窗口关闭后的有界重扫会保留迟到的 provider 诊断，任务文本和工具输出不能触发重试。
- 弹窗/容量准入异常会释放自有协调器租约与预留；带 PID 文件的死亡窗口登记会在下一次预留时清理，避免后续窗口永久卡在 capacity waiting。
- 发布器会根据 manifest 已声明的隐私政策和服务条款链接，拒绝缺少对应文档的阶段包；活动文档与容量实现统一使用系统空闲内存 MB 除以 1000 后向下取整。
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
