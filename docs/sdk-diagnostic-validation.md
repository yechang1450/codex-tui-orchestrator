# SDK load diagnostics

Current setup: the bootstrap restores a missing SDK from the lockfile before validation. Damaged or incompatible installed SDKs still fail validation with a repair diagnostic; validation does not silently replace them. See [environment preparation](environment-setup.md). The results below describe the original 1.2.3 diagnostic change, not current release acceptance.

The public orchestration entry now waits for dependency validation to finish before importing the execution engine. Previously the static engine re-export could load a damaged SDK and surface a raw JavaScript exception before a useful dependency diagnostic.

Validation retains the existing locked-version, entry-file and package-metadata checks. It also imports the SDK and checks its `Codex`, `startThread` and `resumeThread` interfaces. Syntax damage, missing exports/interfaces and missing internal runtime modules produce `RELEASE_DEPENDENCY_DAMAGED` with the installation's `npm ci --prefix` repair command. Validation does not automatically reinstall dependencies or change global configuration.

Package integration tests inject all four load failures and then restore the SDK fixture and require doctor to succeed. An export-parity regression compares every public entry export against the execution engine, preventing the explicit delayed exports from silently dropping APIs. Existing missing-SDK polling tests remain applicable: polling does not import this SDK validator.

The SDK validator, public entry and their release-manifest hashes changed; execution core 1.2.3 did not. This turn's source and installed regression evidence is recorded in [diagnostic validation results](../test/sdk-diagnostic-1.2.3.json). Previous visible-window evidence identifies the earlier wrapper snapshot; this change was validated through public-entry/package regressions and doctor, not a new eight-window model run. Doctor is a local dependency and CLI check, not authentication, network-reachability or end-to-end task certification.
