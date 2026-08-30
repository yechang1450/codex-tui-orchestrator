---
name: verify
description: "`--verify <file>` 冲突键归因诊断：1 个活窗+conflictKeys 命中文件→PASS；多活窗→INDETERMINATE；无命中→VIOLATION。Use to check whether a changed file was written inside a sanctioned window."
---
# Verify (attribution diagnostic)
- 职责：判断某个改动文件是否可归因到**窗内受权写入**：剥离 `file:/dir:/port:/service:` 前缀后做路径感知匹配。
- 触发：`codex-tui-orchestrator-force.mjs --verify <file>`。
- 运行时开关：无（只读诊断；fail-closed）。
- 关闭=不做归因复核（父进程难核实窗内真实性）。
