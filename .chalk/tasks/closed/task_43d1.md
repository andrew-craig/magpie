---
id: task_43d1
title: Bump Pi to latest (1.1.0) + repeatable bump script
type: task
status: closed
priority: 2
labels: []
blocked_by: []
parent: null
remote_task_url: null
created_at: 2026-10-10T10:32:14Z
updated_at: 2026-10-11T02:22:16Z
---


## Context
Reviews were failing intermittently ("pi did not call report_findings") with `z-ai/glm-5.3`. Pi 0.80.3's model registry predates it, so it falls back to cloning `moonshotai/kimi-k2.6`'s compat/limits/cost. User direction (2026-10-10): bump Pi to **latest** (1.1.0 at time of writing), and make the bump **repeatable**.

## Plan
- [x] `scripts/bump-pi.sh [version|latest]`: resolves the version, rewrites every pin (packages/review-extension/package.json, docker/reviewer/extension-package.json incl. pi-tui + typebox matched to pi-coding-agent's own dep), refreshes package-lock, reports remaining stale version mentions in docs/comments
- [x] Run it → 1.1.0; review the 0.80.3 → 1.1.0 changelog for breaking changes affecting us (extension API/registerTool, `--mode json` events, models.json baseUrl override, CLI flags, --no-session etc.)
- [x] Fix any breakage in review-extension / entrypoint / reviewer.ts parsing (none needed — see Review below)
- [x] Update version-specific comments/docs (Dockerfile, README, entrypoint, config.ts, reviewer.ts, DISTRIBUTION.md, extension index.ts)
- [x] Typecheck + full test suite green; local reviewer image build; `pi --version` in image; extension loads
- [x] Document the bump procedure (docker/reviewer/README.md)
- [ ] Publish reviewer image + digest bump + live validation — CTO/user-gated, separate step

## Review

**Scripts/code changed:**
- `scripts/bump-pi.sh` (new) — resolves the target version via `npm view`, reads
  that version's own declared `pi-tui`/`typebox` deps, rewrites
  `packages/review-extension/package.json` (caret ranges) and
  `docker/reviewer/extension-package.json` (exact pins), runs `npm install`,
  and prints remaining stale-version mentions + follow-up steps. Idempotent
  (re-running at the same version is a no-op); fails closed if a version/dep
  can't be resolved. Ran it with `latest` → bumped to 1.1.0 (pi-tui 1.1.0,
  typebox 1.3.27, up from 0.80.3 / 0.80.3 / 1.1.38).
- `package-lock.json` — refreshed by the script's `npm install`.
- Version-specific comments/docs updated to 1.1.0 in: `docker/reviewer/Dockerfile`,
  `docker/reviewer/README.md` (incl. new "Bumping Pi" section + updated
  pinned-versions table/date), `docker/reviewer/entrypoint.sh`,
  `docs/DISTRIBUTION.md`, `packages/orchestrator/src/config.ts`,
  `packages/orchestrator/src/reviewer.ts`, `packages/review-extension/src/index.ts`.
  Kept the underlying *claims* accurate rather than just swapping digits — e.g.
  "Pi has no generic OPENAI_BASE_URL env override" was re-verified against
  1.1.0's own bundled docs, not just re-dated.
- No functional/behavioral code changes were needed anywhere (review-extension,
  reviewer.ts's NDJSON parsing, entrypoint.sh's flag set/models.json
  translation) — see breaking-change findings below.

**Breaking changes found between 0.80.3 → 1.1.0 (read the full CHANGELOG,
every "Breaking Changes" section in that range) and how each was handled:**
- Azure provider renamed `azure-openai-responses` → `azure` (1.0.3). Not used
  by Magpie (OpenRouter only) — no action.
- TypeBox bundled alias bumped to 1.3.x, removing deprecated APIs (`Type.Base`,
  `Type.Awaited`, `Type.Promise`, `Type.AsyncIterator`, `Type.Iterator`,
  `Type.Options`, `Value.Mutate`) — this landed well before 0.80.3 already, so
  not actually "new" in this bump, but re-verified: `review-extension/src/index.ts`
  only uses `Type.Object/String/Integer/Union/Literal/Array/Optional` and
  `Static`, none of which were removed — builds clean against typebox 1.3.27.
- No breaking change found to `defineTool`/`registerTool`/`ExtensionAPI`, the
  `--mode json` NDJSON event shapes (`message_end`/`agent_end`/`AssistantMessage`
  fields), the `--provider`/`--model`/`--no-session`/`--extension`/
  `--no-extensions`/`--append-system-prompt`/`--tools` CLI flags, or the
  `~/.pi/agent/models.json` provider `baseUrl` override mechanism
  `entrypoint.sh` relies on (its doc heading moved from "Overriding Built-in
  Providers" to `docs/custom-provider.md`/`docs/models.md`, but the mechanism
  — registering only `baseUrl` for an existing provider preserves its built-in
  models — is unchanged).
- `--tools` gained `+name`/`-name` modifier syntax (1.1.0) and `*` glob
  patterns + MCP-aware filtering (1.0.4), but a list of plain names (what
  entrypoint.sh passes: `read,grep,find,ls,report_findings`) still **replaces
  the whole selection**, unchanged. `--no-extensions` still disables the
  built-in `mcp`/`codemode`/`tool_search` extensions (explicit `-e` paths,
  i.e. our own extension, still load) — so no MCP/codemode surface opens up
  in the sandboxed container despite `--tools`' MCP-aware changes landing in
  this range.
- No new default network/telemetry/auto-update behavior found that would
  affect the `--network none` sandboxed container.

**Verification (all commands run, all passed):**
- `npm run build` (orchestrator) — pass
- `npm run gateway:build` — pass
- `npm run build --workspace=@magpie/review-extension` — pass
- `npm run typecheck --workspace=@magpie/review-extension` — pass
- `npm test` (all 3 workspaces via `npm run test --workspaces --if-present`) —
  pass: gateway 75/75, orchestrator 540/540 (+4 skipped), review-extension
  11/11
- Local image build: `MAGPIE_REVIEWER_IMAGE_TAG=magpie-reviewer:pi-bump-local
  ./scripts/build-reviewer-image.sh` — built clean
- `docker run --rm --entrypoint pi magpie-reviewer:pi-bump-local --version` →
  `1.1.0`
- Extension-load + flag-set smoke test: ran `pi` inside the image with the
  **exact flag set `entrypoint.sh` execs**
  (`--extension .../review-extension/src/index.ts --no-extensions --tools
  read,grep,find,ls,report_findings --provider openrouter --model
  qwen/qwen3-coder --api-key <bogus> -p --mode json --no-session`) under
  `--network none`. Result: `report_findings` appeared correctly in the
  system prompt's tool list and in `toolsAdded` with its full typebox-derived
  JSON schema (proving the extension loaded with no error), and the run
  failed with `stopReason:"error"`, `errorMessage:"Connection error."` after
  3 auto-retries — a genuine network failure, not an extension/auth/flag
  error. This also exercised `reviewer.ts`'s NDJSON parsing logic
  (`message_end`/`agent_end`/`stopReason`/`errorMessage`) against REAL 1.1.0
  output, including a new-to-me-at-review-time auto-retry sequence
  (`auto_retry_start`/`entry_appended` context edits/repeated `agent_end`),
  and confirmed `agentEndMessages` (reassigned per `agent_end`, not
  accumulated) correctly ends up holding only the LAST attempt's messages —
  exactly the behavior `reviewer.ts`'s "no findings file" fallback path
  depends on.

**Not verified / punted:**
- `scripts/test-zero-egress.sh` (the fuller entrypoint+real-gateway harness)
  is currently broken independent of this bump — it shells out to
  `spike/m7-0/gateway-on-socket.mjs`, which PR #75 ("Repo cleanup: dead
  spike/...") deleted. Did not fix this (out of scope for a Pi version bump);
  flagging it as a pre-existing gap. The targeted smoke test above covers the
  same ground the entrypoint's own `pi` invocation needs (flags, extension
  load, NDJSON shape) but does not exercise entrypoint.sh's confinement
  checks/forwarder/models.json-write path end-to-end against a real gateway
  socket on 1.1.0.
- Publishing a new `reviewer-v*` image, bumping the live digest pin, and
  running a live scratch-PR review are explicitly CTO/user-gated follow-ups,
  not done here (per the task plan's last item).

## Release (2026-10-11)
- [x] PR #84 merged (92ea1be)
- [x] Tagged `reviewer-v0.4.0` on 92ea1be; `release-reviewer.yml` run 38081102056 succeeded
- [x] Image index digest `sha256:4c602b11d749ce6cd04aa768c43ebfa45acdbc229a23766847ed8aa57ae8d7d7` (amd64+arm64); anonymous pull OK; `pi --version` = 1.1.0; 1 GitHub attestation present
- [x] Digest pin bumped in config.ts (code default), config.test.ts, config.example.toml, QUICKSTART.md, docker/reviewer/README.md — branch `reviewer-v0.4.0-pin`; orchestrator tests 540/540
- [ ] Pin PR merged
- [x] Live host switched to reviewer-v0.4.0 (2026-10-11 06:58 AEST): image pre-pulled as `magpie` (pi 1.1.0), `/etc/magpie/config.toml` `container.image` updated (backup `config.toml.bak-pre-reviewer-0.4.0`), `systemctl restart magpie`; graceful drain let an in-flight #420 review finish on the old image; healthz ok, crun tier
- [x] Live glm-5.3 review on the new image succeeded (cairn-reader #420, 2026-10-11 13:20, 35 turns, outcome success) — after fixing an unrelated restart issue (bug_b774)
