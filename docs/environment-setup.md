# Automatic environment preparation

## Entry points

Windows PowerShell 5.1 can run the bootstrap before Node/npm exist:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File '<plugin-root>\scripts\bootstrap.ps1' -Action prepare -Json
if ($LASTEXITCODE -ne 0) { throw 'Environment preparation failed.' }
```

`-ExecutionPolicy Bypass` sets the policy only for this child PowerShell process. It does not change a machine or user setting, and a `MachinePolicy` or `UserPolicy` set by an organization can still take precedence.

`prepare` checks runtime prerequisites without calling a model or registering the plugin. `install` prepares them and invokes the existing installer. `doctor` prepares and runs installation diagnostics. `run --exec '<authorized request>'` prepares and forwards argument boundaries to the orchestration entry. With `powershell.exe -File`, place forwarded options directly after the known bootstrap options; Windows PowerShell cannot reliably bind `-Arguments @(...)` as an array through `-File`. The preparation deadline does not terminate long-running orchestration, whose task deadlines are managed by the controller. Live execution output is forwarded as it arrives.

`-NodePath <absolute node.exe>` selects a verified native runtime. `-NoDownload` allows existing candidates only. Preparation failures return a nonzero exit status; the wrapper never marks a failed child invocation successful.

## Runtime ownership and verification

The runtime home is `PLUGIN_DATA/runtime`, or `<plugin-root>/temp/runtime` for direct use. The bootstrap first probes local native Node 22+ and its matching npm entry. Missing runtimes are downloaded as a pinned portable Windows package. Candidate mirrors must contain the exact file; measured response latency selects among available candidates. The expected SHA-256 is pinned from the official Node release. No downloaded Node binary runs before that check and archive path validation succeed.

A runtime lock prevents simultaneous installers publishing partial trees. Download, extraction and npm cache staging stay beneath the same runtime home and are removed after use. Reparse points and traversal paths are rejected. Persistent Node and private CLI files are reusable dependencies, not disposable test artifacts.

The existing locked SDK installer restores missing SDK dependencies. The bootstrap owns a private CLI prefix and, by default, installs or reuses only the release-pinned 0.162.1 Windows x64/arm64 binary there; a desktop or PATH CLI cannot suppress that step. It checks the binary SHA-256 and the complete platform package tree before executing it, and repeats those checks when reusing the private installation. An explicitly configured `ORCH_CLI` or `CODEX_EXE` remains authoritative, and an invalid explicit path fails instead of being replaced silently. Set `ORCH_AUTO_INSTALL_CLI=0` only when that explicit override or a verified private installation already exists. Temporary PATH, npm prefix/cache and CLI environment overrides are restored on return. No system PATH or account credentials are changed.

## Automatic session preparation

`hooks/hooks.json` is discovered by the host. After the host trusts this definition, the SessionStart command performs bounded preparation on startup/resume/clear. Compact notifications and orchestrated child sessions are skipped. Available memory at or below 1000 MB, or an unreadable memory measurement, leaves execution in the original conversation. A process lock prevents duplicate concurrent preparation; failures have a ten-minute cooldown to avoid repeated downloads in every new session. The hook allows 110 seconds for preparation within the host's 120-second command limit; explicit `prepare` offers a longer default budget. Small state and lock files live under `PLUGIN_DATA/session-start`, or the plugin `temp/session-start` fallback. A healthy session is probed afresh rather than assumed healthy from cached success.

Installation and hook trust are separate host operations. Installing/enabling a plugin does not grant hook trust. The installer does not modify that trust. A direct bootstrap installation prepares immediately; a plugin-manager installation prepares when its trusted hook next runs. Do not rerun `install` from the host-managed plugin cache: use `prepare`, `doctor`, or `run` there. If the hook reports a timeout, rerun the process-scoped command above with the longer preparation budget and inspect the diagnostic before retrying a task.

Orchestrated Codex child sessions pass `--disable hooks`: environment preparation belongs to the initiating host session, and a fresh hook review prompt would otherwise stop every visible worker before its task starts. This does not trust or execute an unreviewed hook. The initiating host still applies its normal hook trust decision.

Official host contracts: [plugin hooks](https://developers.openai.com/plugins/build/plugins) and [hook lifecycle and trust](https://learn.chatgpt.com/docs/hooks).

## Scope of automatic setup

Windows is required. Login, service availability and an authorized task remain prerequisites for actual model execution. Git is only needed for cloning/pulling a repository. Windows Terminal is used when the initiating policy selects visible execution; a console fallback remains available. A disabled/untrusted hook or missing login is reported honestly; these conditions cannot be represented as successful automatic preparation.

Fresh-machine validation is a maintainer release check. Isolated missing-runtime probes on one machine do not establish support for every fresh Windows installation.
