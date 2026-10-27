---
id: task_d8d6
title: Dependency review + version bumps (2026-10)
type: task
status: closed
priority: 2
labels: []
blocked_by: []
parent: null
remote_task_url: null
created_at: 2026-10-25T05:20:04Z
updated_at: 2026-10-25T05:38:54Z
---


## Survey (2026-10-25, from origin/main e95e181)

| Area | Current | Latest | Plan |
|---|---|---|---|
| zod | 4.4.3 | 4.6.7 | bump (minor) |
| smol-toml | 1.7.0 | 1.9.1 | bump (minor) |
| tsx | 4.23.0 | 4.23.15 | bump (patch) |
| @types/node | 22.20.0 | 22.20.5 (26.x latest) | bump within 22 (matches Node 22 runtime target) |
| vitest | 4.1.9 | 4.1.12 / 5.0.5 | evaluate 5; fallback 4.1.12 |
| typescript | 5.9.3 | 6.0.3 / 7.0.2 | evaluate 6.0.3; 7 (native rewrite) deferred |
| @octokit/rest | 21.1.1 | 22.0.1 | evaluate major |
| @octokit/auth-app | 7.2.2 | 8.3.1 | evaluate major |
| p-queue | 8.1.1 | 10.0.0 | evaluate major |
| Pi (+pi-tui, typebox) | 1.1.0 / 1.3.27 | 1.4.0 | scripts/bump-pi.sh; changelog review; rebuild image; local live validation |
| libc (cargo) | 0.2.189 | 0.2.191 | cargo update |
| Rust toolchain + rust:alpine | 1.97.1 | 1.99.1 | bump toolchain + image tag/digest |
| node:22-slim base | 22.23.1 | 22.23.4 | bump tag/digest |
| CI npm pin | 11.17.0 | 11.21.1 (12.2.1) | bump within 11 |
| GH Actions | checkout@v4 etc. | v7/v8/v4... | evaluate majors |
| Node 22 → 24 runtime | — | — | out of scope; flag for decision |

## Plan
- [x] Patch/minor npm bumps + lockfile; build + test
- [x] Majors (octokit, p-queue, vitest, TS 6) each evaluated; adopt if green, else document hold
- [x] Pi 1.4.0 via bump-pi.sh + changelog review + prose updates
- [x] Rust toolchain/libc/base image digests
- [x] CI action majors + npm pin
- [x] Local validation: build reviewer image locally (live-host run left to tech lead)

## Results (2026-10-25, branch deps-bump-2026-10)

| Dependency | Old -> New | Notes |
|---|---|---|
| zod | 4.4.3 -> 4.6.7 | no code changes |
| smol-toml | 1.7.0 -> 1.9.1 | |
| tsx | 4.23.0 -> 4.23.15 | |
| @types/node | 22.20.0 -> 22.20.5 | stayed on 22 |
| @octokit/rest | 21.1.1 -> 22.0.1 | major only drops Node 18; no call-site changes |
| @octokit/auth-app | 7.2.2 -> 8.3.1 | same; @octokit/webhooks 14.2.0 unchanged and compatible |
| p-queue | 8.1.1 -> 10.0.0 | queue.ts only uses add/size/pending/onIdle + concurrency; v9/v10 breaks (EventTarget, clear() rejects, timeout/throwOnTimeout) do not apply |
| vitest | 4.1.9 -> 5.0.5 | all 3 packages green, no config files |
| typescript | 5.9.3 -> 6.0.3 | tsconfigs needed `"types": ["node"]` (TS6 no longer auto-includes @types); no ignoreDeprecations |
| Pi coding agent / pi-tui | 1.1.0 -> 1.4.0 | typebox stays 1.3.27 (Pi 1.4.0 pins 1.3.27); prose updated; stub-gateway end-to-end container run OK |
| Rust toolchain | 1.97.1 -> 1.99.1 | fmt/clippy/test clean; launcher also builds+clippy+tests natively |
| libc | 0.2.189 -> 0.2.191 | |
| rust:alpine | 1.97.1 -> 1.99.1 | index digest b1d5dd5a... |
| node base image | 22.23.1 -> 22.23.4-slim | index digest de170b39... |
| CI npm pin | 11.17.0 -> 11.21.1 | |
| GH Actions | checkout v7, setup-node v7, upload-artifact v7, download-artifact v8, attest-build-provenance v4, setup-qemu v4, setup-buildx v4, login v4, metadata v6, build-push v7 | no input changes needed |
| sigstore/cosign-installer | v3 -> v4.1.2 (no floating v4 tag) | **cosign itself pinned to v2.6.5** (HELD on cosign v3): v3 sign-blob needs --bundle and new bundle format, which would break the documented .sig/.pem + `cosign verify` adopter contract; not locally validatable |
| Node 22 -> 24 runtime | out of scope | note: this host's `node` is v24.17 |

Local image: localhost/magpie-reviewer:deps-bump-test (id 1273263e4191); pi --version 1.4.0, node v22.23.4; entrypoint-tier-memory.test.sh 22/22; stub-gateway full-entrypoint run (--network none, read-only, user 1000) produced valid findings.json. scripts/test-zero-egress.sh is broken pre-existing (needs spike/m7-0/gateway-on-socket.mjs which was stripped).

## Validation (tech lead, 2026-10-25)
- Clean `npm ci` + build + tests re-run: 75 / 546 (+4 skipped) / 11 pass; cargo clippy -D warnings + tests pass (incl. launcher, native libkrun).
- Base-image digests re-checked independently against registry manifest-list digests: match.
- **Real-model e2e on this host:** built orchestrator `runReview` + local image `localhost/magpie-reviewer:deps-bump-test` (Pi 1.4.0) against the LIVE gateway (minted + revoked a per-job key; production service/config untouched), crun tier, real OpenRouter model `z-ai/glm-5.3`, this branch's diff → `ok: true`, `report_findings` called, 1 finding, 27 turns, 211s, gateway spend $0.145.
- **octokit 22 / auth-app 8:** read-only live GitHub API check via `createInstallationOctokit` (App JWT → installation token → pulls.list/listFiles/listReviews + GraphQL reviewThreads) — all OK.

## Follow-ups opened
- Pi 1.4 print mode exits 1 on output-limit truncation (bypasses the #89 length diagnostics); `agent_end.willRetry` may undercount usage on retries.
- `scripts/test-zero-egress.sh` broken on main (stripped spike path).
- cosign v3 migration (held at cosign 2.6.5 via installer v4.1.2).
- Node 22→24 + TypeScript 7 decision.
- Release: after merge, tag `reviewer-v0.5.0` + host `v*`, bump digest pin (5 live places incl. config.ts default), reinstall host.
