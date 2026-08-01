---
id: task_46c1
title: "M8-F: clean reinstall of magpie on the Pi host from fresh v0.3.1 releases"
type: task
status: closed
priority: 2
labels: []
blocked_by: []
parent: epic_59b1
remote_task_url: null
created_at: 2026-08-01T03:55:27Z
updated_at: 2026-08-01T04:29:29Z
---

Repeated test installs had accumulated on the Pi host. Uninstall the debris,
cut fresh `v0.3.1` releases for both the reviewer image and the host services,
and reinstall from those published artifacts.

## Starting state (2026-08-01)

`/opt/magpie` was at `0.3.0-137-g4255195`, built 2026-07-30 — **18 commits behind
`main`**, predating the merged M8-D tier ladder (PR #59) and every M8-E micro-VM
fix (PR #62, #67). Live `config.toml` still pinned the **0.2.0** reviewer image.

Debris found:

- `/opt/magpie.pre-m8.bak` — 330 MB pre-M8 checkout, no `.git`, no secrets
- `/opt/magpie-gateway` — orphaned 2026-07-11 gateway install, referenced by no unit
- `/etc/systemd/user/magpie.service`, `magpie-podman-warmup.service` — leftovers
  from the **retired M6-E rootless-docker direction**; disabled, shadowed by the
  system unit, still on disk
- 5 × `/etc/magpie/config.toml.bak-*` variants
- `/tmp/magpie-work` (7 stale `magpie-out-*` dirs), `/tmp/magpie-telemetry-test.jsonl`,
  `/tmp/magpie-config.migrated.toml`, `/tmp/magpie-pull-030.log`
- 2 superseded reviewer images in magpie's rootless podman store

## Plan

- [x] Back up every secret/config/unit before touching anything
- [x] Remove the stale installs, retired user units, config variants, `/tmp` debris
- [x] Cut `reviewer-v0.3.1` (7 commits since `reviewer-v0.3.0` touched `docker/reviewer`)
- [x] Bump every live digest pin to the new image (PR #68) — prerequisite for the host tag
- [x] Cut `v0.3.1` host release (per-arch tarballs)
- [x] Reinstall `/opt/magpie` from the published arm64 artifact
- [x] Restore config, update the live image pin, restart, verify
- [x] Live end-to-end review to confirm the reinstall posts findings

## Review

### Releases cut

**`reviewer-v0.3.1`** — run 30682931605, multi-arch (amd64+arm64), cosign-signed
keyless, SLSA provenance + SBOM.
Digest `sha256:6c84639bde2879043188eaeb3c72b7bcb032c4b803d5a3e79d32fc0b4de04a29`.
Warranted because 7 commits since `reviewer-v0.3.0` changed the image
(`entrypoint.sh` +358 lines, `Dockerfile`): the M8-E2..E7 guest fixes. `0.3.0`
predates all of them.

**`v0.3.1`** (host services) — run 30683329117, tagged on `e369b8b`. 155 commits
since `v0.3.0` (2026-07-14): the first host release carrying the whole M8 ladder
(B rootless Podman, C libkrun launcher + vsock, D tier ladder, E guest fixes,
F the 0.3.1 pin). Assets: `magpie-0.3.1-{amd64,arm64}.tar.gz` + `.sha256`.

Note: `release-reviewer.yml` and `release-host.yml` both fail on a bare
`workflow_dispatch` against a branch — they derive the version from the tag
(`ERROR: failed to build: tag is needed when pushing to registry`). Two such
failed dispatch runs predate this work; only the tag-triggered runs are real.

### PR #68 — the pin bump

The digest was pinned in 5 **live** places, including the orchestrator's own code
default (`config.ts:96`), so this had to land before the host tag or `v0.3.1`
would have shipped a default pointing at `0.3.0`. `npm run build` clean;
`npm test` 75 + 416 (4 skipped) + 11 passing. Squash-merged as `e369b8b`.
The digest in `.chalk/tasks/closed/task_1709.md` was deliberately left — it
records what M8-E1 published, it is not a live pin.

### Install

arm64 tarball verified (`sha256sum -c` OK; a signed SLSA provenance attestation
exists for that exact digest via the attestations API — the host's `gh` 2.23.0
predates `gh attestation verify`, so it was checked through the API instead).
`/opt/magpie` removed wholesale, unpacked fresh, `npm ci --omit=dev` (40 pkgs,
0 vulnerabilities), `sudo ./scripts/install.sh`.

**No secret was touched** — `magpie.env`, `gateway.env` and the GitHub App key
kept their original 2026-07-12 / 2026-07-06 mtimes and modes. The installer is
genuinely idempotent on secrets, as documented.

Live `config.toml` needed no schema migration: zero keys in the v0.3.1
`config.example.toml` were absent from it, and the section lists are identical.
Only the image pin was updated (0.2.0 → 0.3.1).

### Verification

`magpie`, `magpie-gateway`, `cloudflared` all active. Tier resolved cleanly with
no degradation:

```
tier-resolved  resolvedTier=crun requestedTier=crun degraded=false
  kvm: available (KVM_CREATE_VM succeeded)
  microvm launcher (magpie-krun-launch): present
  microvm.rootfs_path configured: false
  crun runtime (podman): present
```

`GET /healthz` reports the same. Reviewer image smoke-tested under
`--network none --cap-drop=ALL --read-only`: `pi` 0.80.3, plus `/opt/magpie/`
carrying `vsock-client` (micro-VM egress), `forwarder.mjs` (crun-floor egress),
`review-extension`, `reviewer-prompt.md`.

Note the ladder confirms KVM *is* available and the launcher *is* installed —
the host resolves to the crun floor purely because `microvm.rootfs_path` is
unset. `container.tier` is a floor, not a ceiling.

Backup of everything removed: `/home/operator/magpie-reinstall-backup-20260801-135613/`
(mode 0700) — all five config variants, both env files, the App key, the
cloudflared config, all three prior unit files, and `telemetry.jsonl`.

### Live end-to-end review — PASS

Scratch PR **#69** (`scratch/live-review-v031`, since closed and both branches
deleted) carried one throwaway file, `scratch/retry-budget.ts` — deliberately
flawed standalone code placed outside every workspace and every `tsconfig`
`include`, so CI never compiled it.

Full pipeline ran clean, job `24a9dd29`:

```
start → minting-token → reading-review-state → minting-gateway-key →
computing-diff → running-review (tier=crun) → publishing-review resultOk=true →
gateway-key-revoked → job-telemetry outcome=success → finish
```

`durationMs=70269`, `costUsd=0.0299426`, gateway `spentUsd=0.0299` against a
`budgetUsd=0.5` cap, key `a8dd4c1115dbfe14` minted and revoked. Exactly one
telemetry record written. `turns=2 tokens=22030`.

Posted **one `COMMENT` review** (never approve/block) with the
`<!-- magpie:reviewed:<sha> -->` marker and **3 correctly diff-anchored inline
comments**, all genuine planted defects:

| Line | Severity | Finding |
|---|---|---|
| 68 | Blocking | `sleep(delay)` not awaited — backoff never applied, `budgetMs` check meaningless |
| 51 | Important | `i <= o.maxAttempts` runs `maxAttempts + 1` attempts |
| 79 | Important | `summarise` dereferences `attemptLog.get()` without a null guard |

Two planted defects went unreported (the `attemptLog` map is never `forget`-ed
on the success path, so it grows unbounded; `lastError` is read possibly-unassigned).
Not a regression — the reviewer surfaced the three highest-severity ones.

Two structural properties confirmed by this run:

- **Tier silence holds.** Grepping the published review body + all inline
  comments for `crun|microvm|isolation tier|podman|libkrun` → **0 matches**. The
  resolved tier stayed operator-only (`/healthz` + logs), as designed.
- **Untrusted-input handling holds.** The PR body said "throwaway, do not merge".
  The reviewer neither suppressed findings nor was steered by it — it explicitly
  flagged the framing and reviewed the diff on its merits anyway.

### Conclusion

The v0.3.1 reinstall is proven end to end. Nothing outstanding.
