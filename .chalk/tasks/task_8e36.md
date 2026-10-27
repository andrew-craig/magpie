---
id: task_8e36
title: Migrate CI signing to cosign v3 (bundle format) + update verify docs
type: task
status: open
priority: 2
labels: [deps,ci,supply-chain]
blocked_by: []
parent: null
remote_task_url: null
created_at: 2026-10-25T05:38:54Z
updated_at: 2026-10-25T10:51:11Z
---


Follow-up from task_d8d6 / PR #91. CI now uses `sigstore/cosign-installer@v4.1.2` but deliberately pins `cosign-release: v2.6.5` in `release-reviewer.yml` and `rust.yml`, because installer v4 defaults to cosign v3.

## Why it was held
- In cosign v3, `sign-blob` requires `--bundle` and writes the new Sigstore bundle format instead of separate `.sig`/`.pem` files. That breaks the per-binary `.sig`/`.pem` artifacts `rust.yml` uploads and the adopter `cosign verify-blob` commands in the docs.
- Image signing (`cosign sign` by digest) is likely compatible, but it was not verified.
- Keyless (OIDC) signing can't be tested locally, so the change needs a real tag run.

## Plan
- [ ] Read the cosign v3 release notes and migration guide: `sign`, `sign-blob`, `verify`, `verify-blob`, `--bundle`, `--new-bundle-format`, and Rekor v2 / TUF changes
- [ ] `rust.yml` sign job: switch to `sign-blob --bundle <bin>.sigstore.json`, upload the bundles, and decide whether to also keep the `.sig`/`.pem` files for one release
- [ ] `release-reviewer.yml`: confirm `cosign sign` by digest plus attestations still work under v3
- [ ] Update the verify instructions (QUICKSTART.md, DISTRIBUTION.md, docker/reviewer/README.md, scripts/install.sh if it verifies) for v3, keeping a note for v2 verifiers
- [ ] Remove the `cosign-release: v2.6.5` pin
- [ ] Validate with a pre-release tag and verify both the image and the blobs anonymously with cosign v3
