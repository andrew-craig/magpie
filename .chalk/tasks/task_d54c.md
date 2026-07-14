---
id: task_d54c
title: M7-3: Package the host services (orchestrator + gateway) — release artifact; rework install.sh
type: task
status: in_progress
priority: 1
labels: [distribution]
blocked_by: []
parent: epic_0162
remote_task_url: null
created_at: 2026-07-12T13:07:14Z
updated_at: 2026-07-14T09:18:20Z
---
Package the orchestrator + gateway as host services for a clean, portable install (NO docker-compose/DooD — that model was rejected; see DISTRIBUTION.md §2). Deliverables: a versioned release artifact (tarball or npm package) with a committed lockfile and pinned deps so adopters don't build from a floating checkout; rework scripts/install.sh to drop the single-hardcoded-/opt/magpie-prefix and fixed /usr/bin/node assumptions (support common node locations / an explicit override cleanly); keep the existing systemd units (magpie.service, magpie-gateway.service) and their graceful-drain TimeoutStopSec. Note: magpie-firewall.service + setup-network.sh are DELETED by M7-1 (no reviewer network to lock down), so the boot ordering simplifies to gateway -> orchestrator. This is now the DEFAULT deployment path, packaged well.

---

## Plan (tech-lead) — 2026-07-14

**CTO decisions:** (1) artifact form = **compiled dist + pinned lockfile**, host runs `npm ci --omit=dev` (no TS build on the adopter host); (2) **cut a real `v*` release now** (first public host-services GitHub Release, parallel to M7-2's reviewer image).

**Prior art already in tree:** install.sh already drops the hardcoded /opt prefix (MAGPIE_PREFIX default = repo root, units rewritten on install) and the fixed /usr/bin/node (MAGPIE_NODE_BIN + PATH resolution) — landed with M7-1. Host services are pure JS (octokit, p-queue, smol-toml, zod — no native deps ⇒ arch-independent tarball). `review-extension` is NOT a host service (it's the in-container Pi tool; pulls heavy @earendil-works/pi-* deps) — it MUST be excluded from the host artifact.

### Deliverables
- [ ] `scripts/pack-host.sh` — assembles the release staging tree + `magpie-<version>.tar.gz` + `.sha256`. Callable locally AND by CI (single code path). Staging layout mirrors the repo so install.sh works unchanged:
      `packages/orchestrator/{dist,package.json}`, `packages/gateway/{dist,package.json}`, a root `package.json` whose `workspaces` = ONLY `["packages/orchestrator","packages/gateway"]` (review-extension excluded), a **pruned lockfile** matching that host-only workspace set, `systemd/{magpie.service,magpie-gateway.service}`, `scripts/install.sh`, `config.example.toml`, `LICENSE`, and an `INSTALL.md`. Version from `$1`/git tag; stamp into staged root package.json.
- [ ] `.github/workflows/release-host.yml` — trigger `push: tags: ['v*']` + workflow_dispatch. `permissions: contents:write, id-token:write, attestations:write`. Steps: checkout → setup-node@22 → `npm ci` → build both (`npm run build` + `npm run gateway:build`) → `bash scripts/pack-host.sh <version-from-tag>` → `actions/attest-build-provenance@v2` on the tarball → `gh release create <tag>` attaching tarball + `.sha256`. (`v*` does NOT clash with `reviewer-v*`.)
- [ ] `scripts/install.sh` — adapt the "next steps" to the prebuilt flow: when `packages/orchestrator/dist/index.js` is present (tarball path) instruct `npm ci --omit=dev` (deps only, no build); when absent (git checkout) keep the full `npm ci && build`. Update header/usage to document unpack-tarball → `sudo ./scripts/install.sh` → `npm ci --omit=dev`. Keep ALL existing prefix/node-override + ProtectHome-guard logic.
- [ ] `INSTALL.md` (repo root) — the tarball install flow (download release, verify sha256/provenance, unpack to /opt/magpie, run install.sh, `npm ci --omit=dev`, fill secrets, enable). Referenced from DISTRIBUTION.md/README as needed.

### Acceptance / verification (on this Pi — it is the LIVE PROD HOST; magpie+gateway are `active`)
- MUST NOT execute the mutating install.sh path as root here (it would rewrite /etc/systemd/system units + daemon-reload and disrupt prod). Verify install.sh via `bash -n`, `shellcheck`, `--help`, and reading only.
- Build the tarball: `bash scripts/pack-host.sh 0.3.0`; assert contents = both dist/index.js present, host-only root package.json (no review-extension), pruned lockfile present, systemd units + install.sh + config.example.toml + LICENSE + INSTALL.md present; `.sha256` verifies.
- Unpack in a /tmp dir and run `npm ci --omit=dev`: MUST succeed against the pruned lockfile, and resulting node_modules MUST contain octokit/p-queue/smol-toml/zod at the SAME versions as the repo's committed package-lock.json and MUST NOT contain `@earendil-works/pi-*`. Then `node -e` load-check both dist entrypoints (or `node packages/gateway/dist/index.js` smoke that it starts/exits cleanly without secrets).
- `shellcheck scripts/pack-host.sh scripts/install.sh` clean (or only pre-existing warnings).
- Do NOT commit, do NOT push, do NOT push any tag — tech lead does git + the real `v0.3.0` tag after review.

### Tag: `v0.3.0` (first host-services release; monotonic after reviewer-v0.2.0; host bundle & reviewer image version independently).

---

## Review / results — 2026-07-14

Implemented by a sonnet subagent against the contract above; tech-lead reviewed the code and independently re-ran verification on this host (the LIVE prod host — both services stayed `active` throughout; no root install.sh, no systemctl, no writes to /etc/magpie*|/var/lib/magpie|/etc/systemd/system).

**Shipped:**
- `scripts/pack-host.sh` (new) — single code path (local + CI) that stages orchestrator+gateway `dist/` + package.json, a root package.json with `workspaces` pruned to those two (review-extension excluded, devDeps dropped, only `start`/`gateway:start` scripts, version stamped), a **pruned `package-lock.json`** (derived from the committed lockfile via `npm install --package-lock-only --omit=dev`), systemd units, install.sh, config.example.toml, LICENSE, INSTALL.md → `dist-release/magpie-<ver>.tar.gz` + `.sha256`. Has two built-in guards that REFUSE to ship: (a) any `@earendil-works`/`review-extension` leakage in the pruned lockfile, (b) any version drift of an orchestrator/gateway dep vs the source lockfile.
- `.github/workflows/release-host.yml` (new) — repo's 2nd CI. Trigger `push: tags: ['v*']` (+ workflow_dispatch dry-run) — disjoint from `reviewer-v*`. `permissions: contents:write, id-token:write, attestations:write`. checkout → setup-node@22(cache) → `npm ci` → build both → derive VERSION from tag → `pack-host.sh` → `attest-build-provenance@v2` (SLSA) → `gh release create` (guarded on `refs/tags/`) attaching tarball + sha256 → job summary.
- `scripts/install.sh` (modified, minimal) — "next steps" step 4 now conditional: `npm ci --omit=dev` when prebuilt dist/ present (tarball path), full `npm ci && build` when absent (git checkout). Header/usage document the tarball flow; `--help` sed range widened for the grown header. ALL prior logic (prefix/node override, ProtectHome guard, users/dirs/secrets/units) untouched.
- `INSTALL.md` (new) — operator tarball flow: download → `sha256sum -c` + `gh attestation verify` → unpack to /opt/magpie → `sudo ./scripts/install.sh` → `npm ci --omit=dev` → secrets/config/PEM → `systemctl enable --now` (gateway→orchestrator) → upgrade note. Valid cross-refs to DISTRIBUTION.md §2/§3.1/§3.3.
- `.gitignore` — `dist-release/`.

**Verification evidence:** `bash -n` + `shellcheck` clean on both scripts; workflow YAML parses; `pack-host.sh 0.3.0` reproducible, `sha256sum -c` OK, tarball contents correct (both dist/index.js, host-only root package.json workspaces=`["packages/orchestrator","packages/gateway"]`, pruned lockfile, units+install.sh+config.example.toml+LICENSE+INSTALL.md); `npm ci --omit=dev` in a /tmp unpack succeeds (40 pkgs, 0 vuln), node_modules has @octokit/p-queue/smol-toml/zod at versions IDENTICAL to committed lockfile and NO `@earendil-works`; both dist entrypoints `node --check` + import clean; orch 246/246 + gw 65/65 unit tests pass.

**Remaining (tech-lead):** commit to m7-0-spike, push branch, cut+push real `v0.3.0` tag → CI publishes the first host GitHub Release; then anonymously verify the published release + provenance (as done for M7-2's image).
