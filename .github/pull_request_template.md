## Summary

<!-- Describe the behavior or security boundary changed. -->

## Verification

- [ ] `git diff --check`
- [ ] Relevant focused Node test files passed before sealing
- [ ] For a sealed-surface change, review completed before `node scripts/release-integrity.mjs --seal`
- [ ] `node scripts/release-integrity.mjs --json` passed before and after the final Windows regression run
- [ ] The final Windows regression suite passed on the sealed tree
- [ ] No real credentials or machine-specific paths are included

## Release impact

- [ ] Release manifests and changelog are synchronized
- [ ] Documentation and public metadata are synchronized
- [ ] Any remaining security or compatibility limits are documented
