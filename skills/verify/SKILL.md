---
name: verify
description: "`--verify <file>` 冲突键归因诊断：1 个活窗+conflictKeys 命中文件→PASS；多活窗→INDETERMINATE；无命中→VIOLATION。Use to check whether a changed file was written inside a sanctioned window."
---
# Verify (attribution diagnostic)
- 职责：判断某个改动文件是否可归因到**窗内受权写入**：剥离 `file:/dir:/port:/service:` 前缀后做路径感知匹配。
- 触发：`codex-tui-orchestrator-force.mjs --verify <file>`。


- 恒启用：本能力没有用户可关闭的开关，始终生效（无需也不应关闭）。