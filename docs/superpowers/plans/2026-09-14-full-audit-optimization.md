# Full Plugin Audit and Execution Optimization Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish a complete, evidence-backed audit of codex-tui-orchestrator and optimize its user-facing execution flow without weakening receipts, recovery or publication gates.

**Architecture:** Keep the runtime package (`.codex-plugin`, `scripts`, `skills`, `repair.mjs`, `release.json`) stable and separately audit documentation/tests. Compare visible and headless through the same runner, acceptance ledger and final status contract. Treat provider and operating-system limits as environment evidence, never as simulated passes.

**Tech Stack:** Node.js 22+/24, PowerShell, Codex CLI, node:test, Git, Plugin Eval.

**Spec:** `docs/execution-contract.md`, `docs/release-policy.md`, `skills/codex-tui-orchestrator/SKILL.md`.

## Global Constraints

- Preserve every original task ID, checkpoint identity, independent acceptance result and bounded retry.
- Do not delete tests or historical evidence to improve static metrics.
- Keep all newly generated run evidence inside this repository's `temp/`; retain only compact, reproducible summaries.
- Keep the GitHub repository Private until all required publication gates are actually evidenced.

### Task 1: Static and packaging inventory

**Files:** `test/full-audit-current.json`, `test/plugin-eval-current.md`, `test/plugin-eval-skill-current.md`.

- [x] Enumerate every tracked runtime file and entry point; parse all JSON manifests, compile all `.mjs`, and parse all `.ps1`.
- [x] Run release seal and verification, Git index/casing checks, dependency lock checks, and package publication tests.
- [x] Run Plugin Eval for the plugin root and its skill; classify budget findings as runtime load versus repository audit material.

### Task 2: Runtime and failure matrix

**Files:** existing `test/*.test.mjs`; `test/full-audit-current.json`.

- [x] Run the complete serial source suite and inspect every failure, skip and warning.
- [x] Exercise planner, capacity, locks, headless worker, visible launcher, status events, checkpoint ledger, recovery, supervisor, network policy, reboot bridge, registration, package and public CLI paths.
- [x] Run real single-task headless and visible probes with the same acceptance contract; retain provider failures and compare normalized summaries.

### Task 3: Execution-flow optimization

**Files:** `skills/codex-tui-orchestrator/SKILL.md`, `README.md`, `README-zh.md`, `docs/execution-contract.md`, focused regression tests.

- [x] Reduce duplicated always-loaded guidance while retaining the complete safety and receipt contract in linked support documents.
- [x] Make the recommended flow explicit: preflight -> plan -> choose headless or visible -> durable checkpoints -> independent verification -> status readback -> scoped cleanup.
- [x] Ensure visible and headless failures expose the same final user-level status and actionable reconciliation path.
- [x] Re-seal, rerun focused tests, then rerun the complete suite and publication checks.

### Task 4: Release decision

**Files:** `test/private-readiness-validation.json`, `docs/rc-validation.md`, `docs/release-policy.md`.

- [x] Update evidence only from current hashes and real output.
- [x] List remaining provider, foreground, network, reboot and automatic-dispatch gates explicitly.
- [x] Commit and push only the verified changes; keep visibility Private until the release policy permits publication.

### 决定记录：静态评分不得用质量换（2026-09-22，用户明确口径）

- **决定**：不为 plugin-eval 的 `deferred_cost_tokens` / `invoke_cost_tokens` 两个静态预算警告删测试、删历史证据或砍技能规程文本。
- **依据**：本文件上文已写明 "Do not delete tests or historical evidence to improve static metrics"；用户 2026-09-22 再次确认"不需用质量换分"。
- **口径**：这两个指标会把插件根下所有文本文件计入（`deferred` 实测 286,959，其中 `test/` 占 14 万+），要脱离 heavy 段需 ≤124,783 / 砍约 47% 规程文本——属于用可交付质量换静态分数，不做。
- **允许的替代路径**（未来若确需改善该指标，任选其一并单独验收）：① 把评估目标从"开发仓库"改成"真正发布出去的那份"；② 修改分发契约，把 dev-only 的 `test/`、`.github/` 从干净分发里摘掉（属发布契约变更，需先拍板）。
- **留痕**：本次修复轮（commit `88841fa`）新增的 `test/lease-poison.test.mjs` 属于质量改进，不属换分行为。
