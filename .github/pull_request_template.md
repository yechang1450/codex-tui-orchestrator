## Summary

<!-- Describe the behavior or security boundary changed. -->

## Verification

- [ ] `git diff --check`
- [ ] `node scripts/release-integrity.mjs --json`
- [ ] Relevant Node test files pass on Windows
- [ ] No real credentials or machine-specific paths are included

## Release impact

- [ ] Release manifests and changelog are synchronized
- [ ] Documentation and public metadata are synchronized
- [ ] Any remaining security or compatibility limits are documented
