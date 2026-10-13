# Isolated acceptance security boundary

This document describes the narrow security property of a fresh, isolated acceptance run. It does not create an operating-system security boundary.

## Child authorization and Codex rules

The plugin does not treat a host environment variable, session file, local controller file, or inherited permission profile as a capability to grant a child. A hidden worker accepts one fixed shape only: `codex exec`, a bound initiating workspace, `read-only`, `approval_policy="never"`, no added writable roots, and the official bare `--ignore-rules` option. Any other sandbox, automatic approval, profile, remote target, additional directory, bypass switch, or unrecognized configuration is rejected before a child PID is written.

Write-capable work uses a visible Codex window with `on-request` approval. The interactive CLI has no supported counterpart to `exec --ignore-rules`. The plugin scans the active user rule directory (`CODEX_HOME/rules`) and every project `.codex/rules` directory from the workspace to the volume root before launcher creation, before opening the terminal, and once again inside the generated launcher immediately before it calls Codex. A relative `CODEX_HOME` is resolved from the visible child's workspace; rooted-but-drive-dependent Windows forms such as `\\rules` and `C:rules` are rejected rather than being guessed. It refuses visible execution if it finds a `.rules` file, a reparse point, an unreadable layer, or an invalid rule-directory shape. It does not rewrite `CODEX_HOME`, move rule files, change the daemon, or claim that an arbitrary same-user rule can be made safe.

The rule checks are pre-launch snapshots, not filesystem locks. A same-user process that can write the workspace can create or remove a rule between the final check and Codex loading its configuration. No supported interactive Codex option suppresses those user and project rules. The plugin therefore treats visible execution as unsuitable for a workspace with an untrusted concurrent same-user writer; use a separate Windows account or stronger machine/VM boundary for that threat.

`codex exec --ignore-rules` skips `.rules` files only from its User and Project layers. It does not suppress system-layer `.rules` or host-managed requirements or restrictions. The plugin does not attempt to bypass them; ordinary configuration precedence remains Codex-defined. Read-only headless execution uses `--ignore-rules` only for the user/project portion of the rule hierarchy.

## Workspace input reads

Plan files, acceptance contracts, file and JSON evidence, and absence checks use a Windows no-follow handle protocol. The reader binds the workspace root, rejects reparse points, alternate data streams, hard links, path redirection, oversized input, and invalid UTF-8, then hashes or reads the same opened handle. File and JSON checks therefore bind the bytes actually observed by that validation operation.

An absence check establishes only point-in-time absence. It holds no-follow handles on existing path components while it probes the first missing component, but a later authorized workspace write can recreate the path. These checks are not an immutable filesystem snapshot or an operating-system isolation boundary.

## What the file protocol protects

The controller creates a fresh controller root outside the initiating workspace. It binds each terminal record to the run ID, physical workspace identity, and a per-run token digest. Abort and finalization records also carry an HMAC authentication tag made with the raw per-run token. The normal task CLI receives neither that token nor the controller-root location.

Therefore, a workspace-controlled task that can only edit its workspace cannot forge an HMAC-authenticated terminal record. A copied digest, public record fields, or an invented `authTag` is rejected by the controller. Invalid, conflicting, missing, or unreadable terminal records fail closed; they do not establish successful acceptance.

## What it does not protect

This protocol does not protect against a malicious native process running as the same Windows user with `full-access`. Such a process can inspect a parent command line and other same-user process metadata, and it can delete or lock controller files. Either file action can cause a denial of service: the run can fail, stop, or require manual recovery. The protocol makes no availability guarantee against that actor.

The controller-owned cleanup marker establishes an ordering fence, not proof that an external cleanup hook completed: each phase is `pending`, then `inflight`, then `done`. An interruption after `inflight` deliberately becomes a manual-reconciliation case; a workspace-writable journal cannot cause the controller to replay that ambiguous external effect automatically.

Lease nonces bind freshness and attempt, not authentication against this actor. The lease helper receives its nonce on the command line, so a same-user `full-access` process can read it, forge a matching release marker, and affect coordination integrity as well as availability. The controller directory is not a trust boundary against that actor.

Reading a parent command line or the public terminal-record fields does not by itself enable that process to forge an HMAC-authenticated terminal record; the raw per-run token is required. A process that obtains the raw token from controller memory or environment is outside this boundary and can authenticate records. Do not use isolated acceptance as a defense against hostile native code under the same Windows account. Run such code under a separate Windows account or stronger machine/VM boundary.
