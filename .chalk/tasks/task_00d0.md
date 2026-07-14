---
id: task_00d0
title: M7-2: Publish magpie-reviewer image to GHCR — multi-arch, digest-pinned, signed + release CI
type: task
status: in_progress
priority: 1
labels: [distribution]
blocked_by: []
parent: epic_0162
remote_task_url: null
created_at: 2026-07-12T13:07:14Z
updated_at: 2026-07-14T08:20:56Z
---
Publish the magpie-reviewer image ONLY (under Design D it is the sole container in the product; orchestrator + gateway are host services, see M7-3). Build multi-arch (amd64+arm64), pin by digest, sign (cosign/provenance), on tagged releases via CI. Removes the adopter's build-reviewer-image.sh + Pi-version re-pin dance. Orchestrator's default container.image points at the published, digest-pinned reviewer tag. Keep the reviewer image's existing pinned-version discipline. Supply-chain note: the reviewer is the least-privileged component (no secret, no docker socket, no network), so a compromised reviewer image is far less catastrophic than a pulled orchestrator image would have been under the rejected compose model — still sign + digest-pin. Blocked by M7-0/M7-1 (the image must ship the in-container forwarder + updated entrypoint).

---

## Tech-lead plan (2026-07-14)

Built on branch `m7-0-spike` (all M7 work stacks here; M7 PR is a later CTO gate).

**CTO decisions (this session):**
- **Publish a real image now** — cut a real release tag so CI publishes the first multi-arch signed image, then pin the orchestrator default to the concrete `@sha256:` digest that publish returns.
- **Image path:** `ghcr.io/andrew-craig/magpie/reviewer` (nested under repo name).

Tech-lead calls (within remit): first release tag = **`reviewer-v0.2.0`** (dedicated `reviewer-v*` tag namespace so future host-service `v*` releases in M7-3 don't accidentally re-publish the reviewer; 0.2.0 because the Design-D reviewer — forwarder + `--network none` + reworked entrypoint — materially differs from the pre-M7 local `magpie-reviewer:0.1.0`).

### Wave A — subagent (sonnet): CI + wiring code (no publish)
Files:
- **`.github/workflows/release-reviewer.yml`** (NEW, repo's first CI): trigger `push` tags `reviewer-v*` (+ `workflow_dispatch`). Permissions `contents:read packages:write id-token:write attestations:write`. Steps: checkout → setup-qemu → setup-buildx → GHCR login (GITHUB_TOKEN) → metadata-action (semver tags from `reviewer-v*`, OCI labels) → build-push-action (`context:.`, `file:docker/reviewer/Dockerfile`, `platforms:linux/amd64,linux/arm64`, `push:true`, `provenance:true`, `sbom:true`) → cosign keyless sign the digest → `attest-build-provenance`. Emit the digest to the job summary.
- **`packages/orchestrator/src/config.ts`**: `container.image` default → GHCR tag ref `ghcr.io/andrew-craig/magpie/reviewer:0.2.0` (tech lead appends `@sha256:` after publish); update the doc comment (currently M3-A local build) to reflect the pulled, digest-pinned GHCR image.
- **`packages/orchestrator/src/config.test.ts`** + any fixtures asserting `magpie-reviewer:0.1.0` → new default.
- **`config.example.toml`** `[container] image` default + comment → GHCR ref, note digest-pinning.
- **`docker/reviewer/README.md`**: add "Published image / pulling" section (multi-arch, digest-pinned, cosign-signed; `cosign verify` example); keep local-build section for dev + re-pin discipline. `scripts/build-reviewer-image.sh` stays for local dev (add a one-line note prod pulls from GHCR).

Subagent verification (cannot publish): `npm run build` + orchestrator unit tests green; workflow YAML parses (+ actionlint if available); best-effort LOCAL `docker buildx build --platform linux/amd64,linux/arm64 -f docker/reviewer/Dockerfile .` (no push) to prove the Dockerfile builds multi-arch (arm64 native on this Pi, amd64 via QEMU) — report if QEMU unavailable.

### Wave B — tech lead: real publish + digest pin (outward-facing, CTO-authorized)
1. Review Wave A code.
2. Push branch `m7-0-spike` + tag `reviewer-v0.2.0` → CI runs → publishes multi-arch signed image; capture `@sha256:` digest.
3. Make the GHCR package public (adopters must `pull`); verify `cosign verify` + `docker manifest inspect` shows both arches.
4. Pin `config.ts` default (and example/docs) to the concrete digest; commit.
5. Task review section + memory update.

### Checklist
- [ ] release-reviewer.yml written (multi-arch, sign, provenance, sbom)
- [ ] config.ts default → GHCR ref (+ tests/example/README)
- [ ] Wave A builds + tests green; local multi-arch buildx smoke
- [ ] tech-lead review
- [ ] tag pushed, image published, digest captured, package public
- [ ] config pinned to digest, committed
- [ ] task review + memory
