---
name: registry
description: 跨进程 windows/locks 状态库 + 互斥锁 + 全事务写（updateWindows/updateLocks 锁内追加）。Use when the cross-process state store for live windows and locks.
---
# Registry
- 职责：共享 `temp/orchestrator-windows.json` / `orchestrator-locks.json`；`withRegistryLock`（独占锁文件）串行写；`updateWindows/updateLocks` 锁内 load+mutate+save，只追加不整表覆盖。
- 触发：所有读活窗/锁、写新窗口/锁、done-and-close 清理、`--status`。


- 恒启用：本能力没有用户可关闭的开关，始终生效（无需也不应关闭）。