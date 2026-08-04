---
id: task_220f
title: M6-B: per-repo config — .magpie.toml read from the base branch only
type: task
status: closed
priority: 3
labels: []
blocked_by: []
parent: epic_3c41
remote_task_url: null
created_at: 2026-07-10T21:53:08Z
updated_at: 2026-08-04T21:03:20Z
---
PLAN.md milestone 6. Allow repos to tune magpie without touching the server config.

- Read .magpie.toml via the GitHub contents API from the repo's DEFAULT/base branch only — NEVER from the PR head — so PR authors cannot alter review behaviour (config stays out of attacker control; this constraint is explicit in PLAN.md).
- Sensible overridable subset only: e.g. model choice within an allowed set, diff-size cap (never above the server cap), extra reviewer guidance appended as clearly-untrusted repo preferences, path ignore globs. Security-relevant knobs (budgets, network, tool allowlist, allowlist membership) remain server-side only.
- Validate with zod; a malformed file falls back to server defaults with a logged warning, never a failed review.

Done when: an allowlisted repo with a valid .magpie.toml on its default branch gets its overrides applied, and the same file on a PR branch has no effect.

## Implementation plan (2026-08-04) — branch `m6-b-repo-config`

Recon of the current seams (tech lead, before dispatch):
- `config.ts` builds one immutable server `Config`; `pipeline.ts` passes that whole object
  to `runReview`, which reads `config.llm.model` (reviewer.ts:381, :924) and every container/
  tier/gateway knob from it. So per-repo overrides are cleanest as a **per-job effective
  `Config`** derived once in the pipeline — NOT as N new params threaded through call sites.
- `diff.ts` already takes `maxDiffLines` as an explicit param at all 4 call sites in
  `pipeline.ts`, so the diff-cap override needs no signature change, just a different value.
- `reviewer.ts:buildPromptPayload` wraps PR data in a nonce-tagged `<UNTRUSTED_PR_DATA>`
  block — repo guidance needs the same treatment (own clearly-labelled advisory block).

### Design decisions (binding)
1. **Ref = the base repo's DEFAULT branch** (`pr.base.repo.default_branch`), never
   `pr.base.ref` and never the head. Rationale: a PR can target a non-default branch, so
   `base.ref` is weaker than the default branch; the default branch is the unambiguous
   "repo owner controls this" surface. Document the why in the module doc comment.
2. **Overridable subset (exactly these four, nothing else):**
   - `llm.model` — only if it is a member of a NEW server-side `llm.allowed_models` array.
     Absent/empty allowed_models ⇒ model override is silently refused (logged). The server's
     configured model need not be listed for itself to keep working.
   - `limits.max_diff_lines` — clamped: effective = `min(repo, server)`. Never above.
   - `review.guidance` — free text, hard length cap (suggest 4 KB), appended to the prompt
     inside its own nonce-tagged, clearly-advisory block. It is repo-controlled input, not
     operator input: it must NOT be able to countermand the system prompt, and the block
     label must say so.
   - `review.ignore_paths` — glob list, applied to the changed-file list and the diff body.
3. **Never overridable** (assert this in a test): budgets, gateway, container/tier/image,
   tool allowlist, repo allowlist, timeouts, concurrency, workspace, telemetry. The merge
   function must construct the effective config field-by-field from the server config, so a
   new server field can never become repo-overridable by accident.
4. **Fail-soft, always.** Missing file (404), oversized file, malformed TOML, zod failure,
   API error, non-UTF8 — every one falls back to the pure server config with a logged
   warning. A repo config problem must never fail or skip a review.
5. Cap the fetched file size before parsing (contents API gives base64 + a `size`; reject
   over ~16 KB) — untrusted input hygiene, same posture as the diff cap.

### Steps
- [x] `config.ts`: add optional `llm.allowed_models` (array of non-empty strings, default `[]`)
      to the raw schema + `Config` interface + the mapper; document it in `config.example.toml`.
- [x] New `packages/orchestrator/src/repo-config.ts`:
      - `fetchRepoConfig({octokit, owner, repo, ref, logger})` → `RepoConfig | null`; contents
        API, size cap, base64 decode, `smol-toml` parse, strict zod schema (`.strict()` so an
        unknown key is a warning-and-fallback, not a silent no-op).
      - `applyRepoConfig(serverConfig, repoConfig, logger)` → effective `Config` +
        `{ guidance, ignorePaths }` sidecar for the bits that aren't `Config` fields.
      - Glob matching: use the existing dependency set if one already provides it (check
        `package.json` first — do NOT add a new runtime dep without flagging it); otherwise a
        small, well-tested internal matcher for `*`/`**`/`?` is acceptable.
- [x] `pipeline.ts`: fetch + apply after the PR is fetched and before the diff is computed;
      use the effective config for the rest of the job. Log one structured line naming which
      overrides were accepted/refused (operator observability).
- [x] `diff.ts` (or the pipeline call sites): drop ignored paths from `changedFiles` and from
      the unified diff body BEFORE the `maxDiffLines` sum, so ignoring vendored dirs actually
      lets a big PR through. Keep the filtering surgical and unit-tested.
- [x] `reviewer.ts`: thread `guidance` into `buildPromptPayload` as its own nonce-tagged
      advisory block; belt-and-braces, drop findings whose path is ignored.
- [x] Tests (new `repo-config.test.ts` + extensions to `pipeline.test.ts`, `diff.test.ts`,
      `reviewer.test.ts`): valid override applied; each malformed/missing/oversized case falls
      back cleanly; model outside `allowed_models` refused; `max_diff_lines` above the server
      cap clamped down; **a security test asserting the effective config is identical to the
      server config for every non-overridable field given a hostile `.magpie.toml` that sets
      every knob it can name**; ignore-globs filter both the file list and the diff.
- [x] Docs: `config.example.toml` (`allowed_models`), and a `.magpie.toml` section in
      `INSTALL.md` or `docs/` covering the exact overridable subset + the base-branch rule.

## Review (2026-08-04)

Implemented exactly per the binding design decisions. Summary of what was built:

- `packages/orchestrator/src/config.ts` — new `llm.allowed_models: string[]`
  (default `[]`) in the raw schema, `Config` interface, and mapper.
- `packages/orchestrator/src/glob-match.ts` (new) — hand-rolled `*`/`**`/`?`
  glob matcher (`matchesGlob`/`matchesAnyGlob`/`globToRegExp`), since
  `packages/orchestrator/package.json` had no glob dependency. No new runtime
  dependency added. 11 unit tests in `glob-match.test.ts`.
- `packages/orchestrator/src/repo-config.ts` (new) — `fetchRepoConfig`
  (contents API, 16 KiB cap checked before decode, base64 decode, non-UTF8
  detection, `smol-toml` parse, `.strict()` zod schema at every level so an
  unrecognized key anywhere invalidates the WHOLE file) and `applyRepoConfig`
  (builds the effective `Config` by explicitly enumerating every top-level
  `Config` field — not a spread/deep-merge — so a future new `Config` field
  is a compile error here until explicitly accounted for). 27 unit tests in
  `repo-config.test.ts`, including the hostile-config security test and a
  same-content-different-ref test documenting the ref-pinning contract.
- `packages/orchestrator/src/diff.ts` — `ignorePaths?: string[]` added to
  `computePrDiff`/`computeIncrementalDiff`/`listPrChangedFiles`; filtering
  happens on the file list BEFORE the `maxDiffLines` sum (so ignoring a
  vendored dir actually lets an oversized PR through), and a new
  `filterUnifiedDiff` strips the corresponding hunks from the fetched diff
  body too. 10 new tests added to `diff.test.ts`.
- `packages/orchestrator/src/reviewer.ts` — `RunReviewParams.guidance`/
  `.ignorePaths` added; `buildPromptPayload` renders guidance in its own
  `<REPO_REVIEW_GUIDANCE nonce="...">` block (reusing the same per-call nonce
  as `<UNTRUSTED_PR_DATA>`), explicitly labelled advisory-only/unable to
  override the system prompt; `runReview` belt-and-braces filters any
  finding whose path matches `ignorePaths` before returning. 8 new tests
  added to `reviewer.test.ts` (fence rendering, injection-in-guidance
  resistance, stdin capture, findings filtering).
- `packages/orchestrator/src/pipeline.ts` — new step 2y: after the M5-C dedup
  check, before minting the gateway virtual key (the key is scoped to
  `llm.model`, so the effective model must be known first), resolves the
  base repo's default branch via `octokit.rest.repos.get`, calls
  `fetchRepoConfig`/`applyRepoConfig`, and uses the resulting
  `effectiveConfig`/`guidance`/`ignorePaths` for the rest of the job
  (gateway key mint, workspace, both diff-computation branches, and
  `runReview`). Fails soft on any `repos.get` error (repo-config.ts's own
  fetch/parse/validate path already fails soft internally). 6 new
  integration tests added to `pipeline.test.ts`, incl. the ref-pinning test
  (same file content served for `main` vs. the PR head SHA) and a
  pipeline-level hostile-config test comparing argv byte-for-byte (modulo
  mkdtemp paths) against a no-`.magpie.toml` baseline.
- Docs: `config.example.toml` documents `allowed_models`; new
  `docs/repo-config.md` is the `.magpie.toml` reference (chosen over
  `INSTALL.md` since this is repo-owner-facing, not host-install-facing);
  linked from `README.md`'s Configuration section and briefly from
  `INSTALL.md`'s config-editing step (since `allowed_models` itself IS an
  operator/`config.toml` knob).

**Deviations from the plan (both believed to be within its spirit, flagging
for tech-lead review):**

1. The plan's step list said "fetch + apply after the PR is fetched and
   before the diff is computed." I resolve the default branch via a
   dedicated `octokit.rest.repos.get` call rather than reusing the existing
   later `octokit.rest.pulls.get` (which pipeline.ts already uses for
   title/body and the HEAD VERIFY race check) — and I placed it BEFORE
   minting the gateway virtual key (step 2a), not just before the diff.
   Reason: `mintGatewayKeyFromConfig` scopes the minted key to
   `config.llm.model`; if repo-config resolution ran after that mint (or
   even just after it but before the diff), a repo's model override would
   never actually reach the LLM call — the key would already be scoped to
   the wrong model. Keeping the existing `pulls.get` call site's placement
   and race-window semantics untouched (it still runs where it always did,
   for HEAD VERIFY) also avoids touching a already-carefully-reasoned-about
   invariant. Net effect: one extra `repos.get` API call per job (cheap,
   repo-level, no PR number needed), and repo-config resolution happens
   slightly earlier than "just before the diff" — but still after the M5-C
   dedup check, so an already-reviewed job doesn't pay for it.
2. `RepoConfigLogger` was drafted as `{debug, info, warn}` in the doc-comment
   sketch but shipped as `{info, error}` to exactly match the existing
   `PipelineLogger`/`RereviewLogger` convention already used throughout this
   codebase (`gateway.ts`'s `GatewayLogger` is `{error}` only) — this lets
   pipeline.ts pass its own `logger` straight through with zero adapter
   code. A 404 ("no `.magpie.toml`") logs at `info`; every other
   fetch/parse/validation failure logs at `error`, mirroring how
   `rereview.ts` already logs its own swallowed-but-notable
   `review-state-read-failed`.

**Verification:** `npm run build` (tsc, root) and `npm test` (vitest across
all 3 workspaces) both green — orchestrator: 33 files / 517 passed / 4
skipped (pre-existing skips, unrelated); gateway: 8/75; review-extension:
1/11. No existing test's assertions were changed to make it pass — 11
existing test files needed only a mechanical `allowedModels: []` added to
their `testConfig()`/`Config` literals (a new interface field) via a
one-line `perl` substitution, verified individually afterward.

**For the tech lead to check:** whether the `repos.get` extra API call
(deviation #1) is acceptable, or whether you'd rather I thread the default
branch through the LATER `pulls.get()` call instead (which would require
moving gateway-key minting to AFTER the diff/PR-title fetch — a bigger
reshuffle I avoided on purpose to keep the diff blast radius small for a
security-sensitive change).

## Tech-lead review follow-ups (2026-08-05)

Design decisions all held on review (both deviations above accepted as-is;
`llm.allowed_models` shape confirmed correct). Three small fixes requested
and applied, all confined to `repo-config.ts` (+ its test file) — no other
seam touched:

1. **Dead try/catch removed.** `Buffer.from(str, "base64")` never throws (it
   silently skips out-of-alphabet characters rather than raising), so the
   `try`/`catch` around the base64 decode and its unreachable
   `repo-config-decode-failed` branch were removed. Replaced with a plain
   assignment plus a comment noting that garbage/truncated base64 degrades
   to garbage bytes, which the strict UTF-8 decode (see #2) or the
   downstream TOML/schema checks are what actually catch and reject it.
2. **UTF-8 validation tightened.** The old `text.includes("�")` check
   (after a lossy `Buffer#toString("utf-8")`) would have wrongly rejected a
   file whose `review.guidance` legitimately contains a literal U+FFFD
   character. Replaced with a strict decode —
   `new TextDecoder("utf-8", { fatal: true }).decode(decoded)` inside a
   try/catch — which throws ONLY on genuinely invalid UTF-8 byte sequences.
   Added a test asserting a legitimate U+FFFD-containing guidance string is
   now accepted (previously this exact case wasn't tested and would have
   failed); the existing invalid-byte-sequence test (`0xff 0xfe 0xfd 0xfc`)
   still passes unchanged since those bytes are genuinely invalid UTF-8.
3. **`review.ignore_paths` capped.** Added `IGNORE_PATHS_MAX_ENTRIES = 100`
   and `IGNORE_PATH_MAX_CHARS = 256` (both exported), enforced directly in
   `repoConfigSchema` via `.max(100)` on the array and `.max(256)` on each
   string element — an oversized list fails the whole file, same fail-soft
   posture as every other schema violation, rather than being silently
   truncated. `glob-match.ts` compiles each pattern into its own `RegExp`
   and tests it per changed file per job, so an unbounded list was avoidable
   per-job CPU. Added 4 tests: over-the-entry-cap and over-the-length-cap
   both fall back to server config; exactly-at-cap for both is accepted.

**Re-verification after these fixes:** `npm run build` (root) and `npm test`
(all 3 workspaces) both green — orchestrator: 33 files / 522 passed / 4
skipped (same pre-existing, unrelated skips as before); gateway: 8/75;
review-extension: 1/11. Net +5 orchestrator tests (1 legitimate-U+FFFD test +
4 ignore_paths cap tests) versus the previous verification pass.

Still not committed — left for the tech lead per instructions.
