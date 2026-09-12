# Contributing

感谢参与 `codex-tui-orchestrator`。这是一个面向 Codex CLI 的 Windows 优先插件，改动必须保留任务账本、独立验收和失败可见性。

## 提交前检查

```powershell
& {
  $ErrorActionPreference = 'Stop'
  npm ci --prefix scripts --omit=optional --ignore-scripts
  if ($LASTEXITCODE -ne 0) { throw '依赖安装失败。' }
  node --test --test-concurrency=1 test/*.test.mjs
  if ($LASTEXITCODE -ne 0) { throw '离线回归失败。' }
  node scripts/release-integrity.mjs
  if ($LASTEXITCODE -ne 0) { throw '发布完整性检查失败，请核对改动与封存清单。' }
}
```

从仓库根目录运行上述命令。涉及运行核心时，还要确认 `release.json`、`scripts/core/` 和公开入口的哈希同步；封存必须针对已经审查和验证的改动，不能用重新封存掩盖失败。不要提交 `scripts/node_modules/`、`temp/`、原始运行回执、账户凭据或本机私有路径。

源码 Git 副本、全新发布包和已启用插件缓存是三个独立验证对象。克隆或更新源码不会自动注册插件或同步已启用缓存。代码或封存哈希变化后，旧实测记录应保留为历史；版本号相同也不能把旧记录称为当前验收。记录可复核的提交、哈希、命令和结果，未完成的真实环境检查须明确列出。

## 提交方式

小范围改动请使用清晰的 commit，并在 Pull Request 中说明行为变化、验证命令和未覆盖的真实环境边界。真实模型或可见窗口验收不能伪装成普通离线测试结果。
