# Changelog

## 0.9.29-rc.10

- Tighten public-release hygiene: reject local credential stores and private-key containers during source review and distribution export.
- Clarify the boundary between host-owned TodoList/spawn cards and plugin-emitted status events.
- Keep Windows helper validation independent of caller-controlled environment paths.
- Bind distribution registration to the sealed source release: an unverified distribution cannot register itself, rewrite a catalog, or have install checks execute its verifier.
- Skip host skill-visibility probes whenever registration or cache authentication has not succeeded; strict skills verification then fails closed instead.
- Keep live inactive-window probe receipts and reports in controller-owned storage instead of the initiating workspace.
- Keep distribution GitHub-only; this Codex plugin is not published to npm.

## Earlier release candidates

Earlier 0.9.29 release candidates established the current conservative execution model, Windows process and workspace protections, recovery checks, redaction, integrity sealing, and GitHub installation path. Historical validation records are intentionally excluded from the public source tree.
