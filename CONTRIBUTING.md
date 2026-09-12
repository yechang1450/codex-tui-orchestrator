# Contributing

感谢参与 `codex-tui-orchestrator`。这是一个面向 Codex CLI 的 Windows 优先插件，改动必须保留任务账本、独立验收和失败可见性。

## 提交前检查

```powershell
npm ci --prefix scripts
node --test --test-concurrency=1 test/*.test.mjs
node scripts/release-integrity.mjs
```

涉及运行核心时，还要确认 `release.json`、`scripts/core/` 和公开入口的哈希同步。不要提交 `scripts/node_modules/`、`temp/`、运行回执、账户凭据或本机私有路径。

## 提交方式

小范围改动请使用清晰的 commit，并在 Pull Request 中说明行为变化、验证命令和未覆盖的真实环境边界。真实模型或可见窗口验收不能伪装成普通离线测试结果。
