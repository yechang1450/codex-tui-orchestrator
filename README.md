# codex-TUI-orchestrator

Windows / Node 22+. Keeps conflict-based linked/independent grouping, dependency waves, resource reservations, visible interactive windows, completion watchdogs and result verification.

## Current support / 当前支持

Only the Codex CLI adapter is implemented. Unknown host, unsupported adapter or missing native CLI fails closed: no automatic install and no fallback to Codex.
目前仅接通 Codex；其它 agent 不能冒充 Codex 运行。接入新宿主必须同时实现规划、交互参数、会话输出解析和完成/清理协议，不能只添加一个命令名。

Plugin entry: `node scripts/orchestrate-sdk.mjs`. Dependencies: `npm ci --prefix scripts`. Tests: `node --test test/orchestrator.test.mjs`.

```powershell
node scripts/orchestrate-sdk.mjs --doctor
$env:WORKSPACE_DIR = 'D:\your-project'
node scripts/orchestrate-sdk.mjs --run-windows 'Your authorized multi-part task'
```

Run commands from this repository root. Use --plan for planning, --spawn <title> <prompt-or-file> for one visible window, and --status to inspect state. The existing single-block/read-only/self-modification inline routing remains intact.

## Host contract / 宿主契约

- Generic entry: --agent / ORCH_AGENT identifies the initiating agent. Codex session variables can identify Codex; a PATH entry alone cannot identify the host.
- --cli / ORCH_CLI (or CODEX_EXE) selects the native executable. An explicit invalid path fails instead of searching for a replacement. Otherwise inspect PATH and npm packaged native binaries, verify with --version.
- ORCH_MODEL / ORCH_EFFORT are explicit overrides. Otherwise the CLI owns model configuration. GUI conversation-only overrides are not automatically readable: callers must pass them.
- ORCH_SANDBOX / ORCH_APPROVAL pass the caller's authorized execution policy. Defaults are workspace-write / on-request, never implicit full access. Directory trust is never rewritten; an untrusted directory may require the user's confirmation.
- Windows Terminal is preferred; conhost is the terminal fallback, not an agent fallback. Interactive stdout is inherited, never piped through Tee-Object.
- WORKSPACE_DIR selects the task workspace. CODEX_HOME selects Codex configuration/session storage. ORCH_STATE_DIR defaults to CODEX_HOME/orchestrator so dedicated and generic Codex runs share resource locks; use the same state directory for shared resources.
- Task temporary artifacts remain under workspace/temp and are handled by the existing cleanup protocol. Do not delete active runtime state. ORCH_SESSION_DIR can override session discovery.

## Completion / 完成

The window checks real outputs before emitting its token-specific __ORCH_DONE__ marker. The watchdog only treats assistant output as completion evidence; the parent independently verifies outputs and collects every block's terminal state. Child windows must not recursively launch orchestration or subagents.

The authorization template supports the user's scope and host rules; it cannot grant permissions. Only use available skills. Failures and blockers must be reported, never converted to success.

## Verification scope / 验证边界

Automated tests exercise grouping, dependency waves, locks, native CLI selection, fail-closed errors, generated PowerShell launchers, watchdog auto-close and process-tree cleanup using controlled child processes. They do not establish real model/provider availability or prove that every future agent is supported. A real model-backed visible-window acceptance run is a separate check.
