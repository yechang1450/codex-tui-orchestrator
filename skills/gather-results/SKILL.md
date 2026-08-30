---
name: gather-results
description: 窗口外 GUI 契约：调用 poll-windows --require-all-success，只有全部块 status ∈ 成功集才返回 0；主窗口必须以 0 为唯一可收尾条件。Use after --run-windows to wait for all results before ending the turn.
---
# Gather Results (GUI contract)
- 职责：在 `--run-windows` 之后，主对话必须运行 `node scripts/poll-windows.mjs --require-all-success --timeoutMs <T>`，仅当全部块成功集（done/ok/completed/done-retried）+被正确拦截(preflight-failed/locked/unlocked) 时返回 0；非 0=仍有未成功→继续等/重试/如实上报。
- 触发：每次 `--run-windows` 之后。
- 运行时开关：无（常开契约，保证不提前收尾）。
- 关闭=放弃「全部成功才收尾」保证（会提前结束本轮，违反 AGENTS 铁律）。
