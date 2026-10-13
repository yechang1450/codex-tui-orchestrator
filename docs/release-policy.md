# Release policy

> **Maintainer-only source note.** This file documents release engineering and
> is excluded from installed plugin artifacts. It is not an installation guide.
> The project is distributed as a GitHub-hosted Codex plugin and is never
> published to npm.

The dedicated Codex plugin ships a physical, versioned core snapshot. Its installed `scripts/core` must not be a junction into another checkout. Generic changes are not automatically promoted into this plugin.

Plugin package versions use `MAJOR.MINOR.PATCH-rc.N`. Run `node scripts/bump-version.mjs --next-rc` from a source checkout for the next release candidate; it increments only `N` and synchronizes `.codex-plugin/plugin.json`, `scripts/package.json`, and `scripts/package-lock.json`. The execution-core version is a separate sealed contract in `scripts/core/contracts.mjs` and `release.json`.

`scripts/codex-entry.mjs` verifies `release.json` at public execution and polling entry points. Schema 2 seals core hashes together with runtime scripts, plugin metadata, and skills. Additions, removals, mismatches, and directory links fail verification. The seal detects accidental drift; it is not a security boundary against a party that can modify both source and manifest.

## Maintainer procedure

1. Finish or recover active runs before changing runtime code.
2. Review the dedicated source tree and run the complete serial regression suite.
3. Verify the installed dependency tree with `node scripts/dependency-integrity.mjs --verify`, then reseal dependencies and the release manifest with `node scripts/dependency-integrity.mjs --seal` and `node scripts/release-integrity.mjs --seal`.
4. Verify the source seal with `node scripts/release-integrity.mjs --verify-source` and then verify a newly created distribution artifact.
5. Run clean-machine and remote marketplace acceptance against the final immutable ref before claiming those routes are validated.

For a local source-coverage report, run `node scripts/coverage.mjs --test 'test/*.test.mjs'`. It writes ignored evidence beneath `.plugin-eval/` and is excluded from the installable plugin package.

Use `node scripts/publish-dist.mjs --target <fresh-parent>` only for an explicit clean artifact. The destination must be new. The copied package must pass integrity verification before activation. The plugin manager owns version activation and rollback; do not replace a running core.

## Checkout install

A checkout install registers the sealed source tree as local catalog `yechang1450-codex-tui-orchestrator`. The installer and read-only checker can repair an explicitly selected local catalog entry. `--set-source` only changes that selected local entry; it does not replace a host-global marketplace with the same name.

A local checkout and an exported distribution have different purposes. A checkout is convenient for development. An explicit distribution excludes development-only state and is the artifact to inspect before release.

## GitHub marketplace catalog and official directory

A GitHub marketplace catalog is separate from an official public plugin-directory listing. Install a reviewed immutable ref with:

```powershell
$ref = '<final-commit-or-tag>'
codex plugin marketplace add yechang1450/codex-tui-orchestrator --ref $ref
codex plugin add codex-tui-orchestrator@yechang1450-codex-tui-orchestrator
```

Remote GitHub marketplace acceptance remains an open gate for the current candidate. A checkout install or local Git fixture does not establish remote GitHub reachability.

The current package contains lifecycle hooks, so it is not eligible for the official public plugin directory. A future directory submission needs a separate hook-free submission package and the directory's review process.

## Legacy catalog migration

`codex-tui-orchestrator-local` is a legacy catalog name. After confirming its old checkout is unused, remove it before adding the current catalog:

```powershell
codex plugin marketplace remove codex-tui-orchestrator-local
codex plugin marketplace add yechang1450/codex-tui-orchestrator --ref <tag-or-commit>
codex plugin add codex-tui-orchestrator@yechang1450-codex-tui-orchestrator
```

## Candidate configuration

Current candidate: core 1.4.4-rc.1, plugin 0.9.29-rc.10.

The planner and both execution modes inherit the initiating Codex provider and credentials by default. The canonical values are `ORCH_PROVIDER=inherit` and `ORCH_PROVIDER=openai-https`, which selects the hardened OpenAI HTTPS provider. `native` and `relay` are legacy aliases for `inherit` and `openai-https` respectively. Other values fail closed.

Candidate labels describe a package and sealed-core pairing. They do not certify installed-cache, publication, external marketplace, or cross-machine compatibility for a later revision.

## Earlier validation

Earlier local rollout records were tied to older revisions and machine environments. They are historical design context only and are deliberately excluded from current release evidence. Re-run the applicable validation against the final sealed revision.
