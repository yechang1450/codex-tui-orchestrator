---
name: decompose-cache
description: 相同请求拆块结果缓存（永不自动失效，仅 --clear-cache / 删缓存文件重置）→ 越用越快。Use when reuse identical-request decomposition plans.
---
# Decompose Cache
- 职责：`temp/orchestrator-decompose-cache.json` 按请求 hash 缓存 block plan；命中即复用（越用越快）。
- 触发：`decomposeSafely` 每次拆块。
- 清理：`node orchestrate-sdk.mjs --clear-cache` 或删除缓存文件。


- 恒启用：本能力没有用户可关闭的开关，始终生效（无需也不应关闭）。