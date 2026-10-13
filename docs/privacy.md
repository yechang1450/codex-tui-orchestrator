# Privacy

`codex-tui-orchestrator` runs locally in the workspace selected by the
initiating Codex conversation. It adds no telemetry, account collection, or
plugin-operated service for task content. The Codex CLI may contact its configured provider;
credentials, model selection, provider requests, and provider retention remain
governed by Codex and that provider.

Do not put passwords, API keys, tokens, connection strings, or other secrets
in task prompts. Visible-TUI rejection, the protected headless worker path,
and credential-shaped redaction are defense-in-depth controls for accidental
exposure. They cover recognized forms only; they are not a secret manager,
secret store, or supported secret-delivery interface. Use approved
secret-management tooling or a provider-supported credential mechanism.

When a Windows machine lacks the required Node runtime, first-time preparation
may contact the official Node download site or its configured public mirrors to
fetch a SHA-256-pinned archive. It may also contact the npm registry for the
release-pinned Codex CLI and SDK dependencies. Those requests carry ordinary
network metadata needed to download packages; the plugin does not send task
content or credentials as part of that preparation.

## Public run evidence

The initiating workspace's `temp` directory holds run ledgers, checkpoints,
receipts, status events, and verification evidence. Public controller
artifacts such as coordinator state, immutable plan bindings, and ordinary
launch files live under `CODEX_HOME/state/plugins/codex-tui-orchestrator` by
default. These public artifacts are operational records, not a secret store.

Before a record crosses a durable public boundary, the plugin applies its
credential-shaped redaction projection. This covers workspace manifests,
summaries, goal mirrors, status events, verification reports, captured
headless output, and auxiliary spawn/self-test reports. The projection is a
guard against values that match its credential rules; it is not a general
classifier for every kind of confidential text.

The deterministic decomposition cache never reads, writes, repairs, evicts,
or migrates a credential-shaped request. Older cache schemas that might contain
such text are discarded before an ordinary request can use them. The
runner also rejects credential-shaped content in a persisted
acceptance contract before it creates run state; acceptance checks must use
non-secret evidence.

Lease conflict keys preserve scheduling semantics without retaining protected
path fragments. Each credential-shaped fragment is replaced with a
coordinator-scoped HMAC-SHA-256 opaque marker whose random key is protected by
CurrentUser-DPAPI and bound to the physical coordinator identity. Legacy,
malformed, and cross-coordinator markers fail closed. An unavailable key also
fails closed rather than silently migrating or reusing state. These markers are
scheduling labels, not authorization credentials.

## Protected recovery and headless prompts

When a request, task inventory, or plan changes under the public projection,
its original recovery fields are retained only in a controller-owned
CurrentUser-DPAPI private-state record. Current private state uses format v2
and is bound to the run ID, physical workspace identity, and public projection
digest. Resume and verification fail closed if it is absent, unreadable, or
does not match the public ledger. A v1 or otherwise legacy private-state
record is not upgraded in place: it cannot recover the run, and a new run must
be started.

If credential-shaped text nevertheless reaches a headless prompt, the readable
controller prompt is the redacted projection. The original is stored in a
separate CurrentUser-DPAPI file and is decrypted only when the worker writes
the prompt to the owned Codex child's standard input. This containment behavior
does not authorize placing secrets in prompts or using headless execution as
secret storage. A successfully finalized headless run removes its launch
files; unfinished or failed work retains the protected recovery record for
reconciliation.

## Visible TUI boundary

The documented interactive Codex CLI accepts its initial prompt as a positional
process argument and has no supported stdin prompt channel for the TUI. A
visible Codex launch therefore rejects credential-shaped task text, title, or
suffix before it creates a launcher artifact or starts a child. Do not redirect
such text to headless mode; supply sensitive values through approved credential
management or provider-supported mechanisms. Ordinary visible prompts remain
ordinary controller launch artifacts and can be visible to local processes
permitted to inspect them.

This package supports Codex as its host only.

## Process identity records

The live operating-system check compares a process's PID, creation time,
executable name, and exact command line. Durable lease, run-owner, window
registry, and coordinator process-snapshot-cache records retain only a
SHA-256 binding of that command line. A legacy durable identity that contains
a raw command line, or does not contain a valid binding, is rejected rather
than used to authorize recovery or process cleanup.

## Boundary of this protection

CurrentUser-DPAPI protects data at rest from other Windows users. It does not
create an operating-system security boundary against another process running as
the same Windows user, which can use that user's DPAPI context. The plugin also
cannot retrospectively remove task text from the initiating Codex conversation,
host-managed session/rollout records, terminal scrollback, tools, or the
configured provider. Treat those systems according to their own retention and
access policies.

The controller location is derived from `CODEX_HOME` unless an explicit
`ORCH_CONTROLLER_ROOT` or `ORCH_COORDINATOR_DIR` outside the initiating
workspace is supplied. Those overrides, and a direct API coordinator, must be
local non-UNC directories writable only by the current Windows user, `SYSTEM`,
and `Administrators`. New runs do not use the former
`HKCU\\Software\\CodexTuiOrchestrator\\CoordinatorRoot` locator.

Questions about this policy can be raised in the project repository:
<https://github.com/yechang1450/codex-tui-orchestrator>.
