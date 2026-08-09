---
id: task_be2f
title: Opt-in Magpie APPROVE reviews (per-repo .magpie.toml + server gate)
type: task
status: in_progress
priority: 2
labels: []
blocked_by: []
parent: null
remote_task_url: null
created_at: 2026-08-09T12:55:20Z
updated_at: 2026-08-09T12:58:15Z
---

## Goal

Let Magpie post a GitHub `APPROVE` review (instead of always `COMMENT`) as an
informational "tick" — never auto-merge, never `REQUEST_CHANGES`. This is a
deliberate, narrow reversal of the "Magpie never approves" line currently
stated in CLAUDE.md/ARCHITECTURE.md/review-flow.md, so it must ship gated and
well documented, not as a silent default-on behavior change.

## Research already done (don't re-derive)

- No new GitHub App permission needed. `pulls.createReview({event:"APPROVE"})`
  is covered by the `Pull requests: Read and write` permission the App
  already requires (docs/QUICKSTART.md step 6, ARCHITECTURE.md's permission
  table).
- The LLM-authored `verdict: "approve"|"comment"` already exists end-to-end:
  `review-extension/src/index.ts` → `reviewer.ts` → `pipeline.ts` →
  `publisher.ts`'s `PublishReviewWithFindingsParams.verdict`, which today is
  explicitly documented as "ACCEPTED BUT IGNORED" and hardcoded to
  `event: "COMMENT"`. `publisher.test.ts:352` pins this down
  (`"always uses event: COMMENT, even when verdict: 'approve' is passed"`).
- **Branch-protection risk (must be documented, not engineered around — no
  GitHub API exists to make an APPROVE "not count"):** a bot APPROVE with
  write access counts toward a repo's "required approving reviews" branch
  protection by default. Enabling this could let a PR merge with zero human
  sign-off if a repo requires only 1 approval.
- **Prompt-injection risk, specific to this feature:** `verdict` is authored
  by the Pi agent from PR-supplied (attacker-influenced) diff/title/body —
  Magpie's own named threat model is indirect prompt injection against the
  review agent. Today a manipulated verdict/summary is low-stakes (a human
  reads a COMMENT). Once verdict can drive a real GitHub APPROVE, a
  sufficiently crafted PR becomes a higher-stakes target. This must be called
  out in the same doc warning as the branch-protection risk.

## Decisions (confirmed with user)

1. **Opt-in per repo**, via `.magpie.toml`'s `[review]` section — not
   default-on.
2. **Approve condition:** `verdict == "approve"` **AND** zero findings
   (`inline.length === 0 && other.length === 0`) — not verdict alone.
3. **Document the branch-protection/merge-gate risk prominently** in
   `docs/repo-config.md` next to the new key (fold the prompt-injection risk
   into the same warning — see above).
4. **Tech-lead call (new, apply the codebase's existing double-gate
   pattern):** mirror `llm.allowed_models`'s precedent — a repo-level
   `.magpie.toml` opt-in alone isn't enough for something with a real
   security consequence; add a **server-side gate too**
   (`config.toml`'s `[review] allow_approve`, default `false`, following the
   exact shape of `llm.allowed_models` in `config.ts`). A repo can only get
   `APPROVE` reviews if BOTH the operator's `config.toml` and the repo's
   `.magpie.toml` opt in. Flag this addition to the user in the PR
   description since it wasn't one of the three things explicitly asked
   about, but it's a direct application of an existing, documented codebase
   convention (see `repo-config.ts`'s SECURITY doc comment on `llm.model`'s
   gating).

## Implementation checklist

### `packages/orchestrator/src/config.ts`
- [x] Add `review: { allowApprove: boolean }` to the `Config` interface,
      alongside `llm.allowedModels` (same section style).
- [x] Add `review: z.object({ allow_approve: z.boolean().default(false) }).strict().default({})`
      (or equivalent) to the config schema, mirroring `llm.allowed_models`'s
      `.default([])` pattern at config.ts:52.
      (Used `.strict().prefault({})` instead of `.strict().default({})` —
      matches every other object-shaped section in this schema, e.g.
      `server`/`limits`/`gateway`/`telemetry`, none of which use
      `.default({})`. Behaviourally equivalent for this case; chosen for
      consistency with the existing convention.)
- [x] Wire the loader (`review: { allowApprove: data.review.allow_approve }`),
      mirroring config.ts:616.
- [x] `config.example.toml`: add a commented `[review] allow_approve = false`
      block near the `allowed_models` example, with a one-line comment
      pointing at docs/repo-config.md for the full explanation.

### `packages/orchestrator/src/repo-config.ts`
- [x] Add `allow_approve: z.boolean().optional()` to the `review` section of
      `repoConfigSchema` (repo-config.ts:180-193).
- [x] Add `allowApprove?: boolean` to `RepoConfig.review` (repo-config.ts:201)
      and thread it through `mapRepoConfig`.
- [x] Add `allowApprove: boolean` to `RepoConfigOverrideResult`
      (repo-config.ts:339-350) — a sidecar value, NOT a `Config` field, same
      treatment as `guidance`/`ignorePaths`.
- [x] In `applyRepoConfig`: gate on BOTH `serverConfig.review.allowApprove`
      being `true` AND `repoConfig?.review?.allowApprove` being `true`. If the
      repo requests it but the server hasn't enabled it, push a `refused`
      entry (mirror the `llm.model`/`allowedModels` refusal message style at
      repo-config.ts:377-383) so it's visible in the
      `event: "repo-config-overrides"` operator log line. Update the
      function's field-by-field `Config` construction is UNAFFECTED (this
      isn't a `Config` field), but do update the module's top-of-file SECURITY
      doc comment listing "exactly four knobs" → five, with the same
      rationale style as the existing four.
      (Note: `Config.review` itself — the operator's own gate value — IS a
      new `Config` field, so it's copied verbatim into the field-by-field
      `config` object like every other non-overridable field; only the
      repo's *request* to flip it is never a `Config` field.)

### `packages/orchestrator/src/publisher.ts`
- [x] Add `allowApprove?: boolean` (default `false`) to
      `PublishReviewWithFindingsParams`.
- [x] Replace the hardcoded `event: "COMMENT"` in `publishReviewWithFindings`
      (both the primary `pulls.createReview` call AND its 422-retry — note
      the retry path only ever runs when `inline` was non-empty pre-fold, so
      it's already naturally COMMENT-only, but keep the logic driven by the
      same computed `event` value rather than assuming that) with:
      `verdict === "approve" && allowApprove && inline.length === 0 && other.length === 0 ? "APPROVE" : "COMMENT"`.
- [x] Rewrite the doc comments currently describing `verdict` as "ACCEPTED BUT
      IGNORED" (publisher.ts:282-289, :308) to describe the real conditional
      behavior and point at repo-config.md for the opt-in mechanism.
      (Also widened `MinimalIssuesClient.pulls.createReview`'s `event` type
      from the literal `"COMMENT"` to `"COMMENT" | "APPROVE"` — required for
      the conditional value to typecheck; `"REQUEST_CHANGES"` is still not
      part of the type at all.)

### `packages/orchestrator/src/pipeline.ts`
- [x] Thread `allowApprove` through exactly like `guidance`/`ignorePaths`:
      declare alongside them (~pipeline.ts:459-460), assign from
      `applied.allowApprove` in the `applyRepoConfig` call (~line 476-479),
      and pass `allowApprove` into the `publishReviewWithFindings` call
      (~line 817-828).

### Tests
- [x] `publisher.test.ts`: replace the single "always COMMENT" test
      (line 352) with cases: (a) allowApprove=true + verdict=approve + zero
      findings → `event: "APPROVE"`; (b) allowApprove=true + verdict=approve +
      nonzero findings → `event: "COMMENT"`; (c) allowApprove=false +
      verdict=approve + zero findings → `event: "COMMENT"`; (d)
      verdict=comment → `event: "COMMENT"` regardless of the other two.
      (Also added a dedicated 422-retry regression test — verdict=approve +
      allowApprove=true + nonzero inline findings — asserting BOTH the
      primary attempt and the retry stay `event: "COMMENT"`, satisfying the
      Verification section's "re-read the 422-retry path" requirement.)
- [x] `repo-config.test.ts`: parsing/gating cases for `review.allow_approve` —
      repo requests it + server allows → accepted sidecar `true`; repo
      requests it + server default (false) → refused, sidecar `false`; repo
      doesn't set it → sidecar `false`, nothing logged. Also updated the
      "hostile RepoConfig" SECURITY test (four→five typed fields) to include
      `allowApprove` and assert `config.review` is still copied verbatim.
- [x] `pipeline.test.ts`: if there's an existing threading test for
      `guidance`/`ignorePaths` reaching the publish call, add the same
      shape for `allowApprove`.
      (Added two tests: one where server+repo both opt in → `event:
      "APPROVE"`, one where only the repo opts in → still `event: "COMMENT"`,
      proving the double-gate end-to-end through the real pipeline.)
- [x] `config.test.ts`: default `review.allowApprove` is `false` when unset;
      loads `true` when set.

### Docs
- [ ] `docs/repo-config.md`: add `review.allow_approve` as a 5th key in the
      "exactly four keys" section (retitle to five, keep the same "nothing
      outside this list has any effect" framing). Immediately below the
      example, add a clearly-marked warning covering BOTH: (1) a Magpie
      APPROVE counts toward GitHub's required-approving-reviews branch
      protection — enabling this can let a PR merge without any human
      approval if the repo only requires one; (2) the verdict driving this is
      LLM-authored from PR-supplied content under Magpie's own indirect
      prompt-injection threat model — this is a materially higher-stakes
      target once it can produce a real approval, not just a comment. Add a
      new "## Enabling the approve tick (operator side)" section mirroring
      the existing "## Enabling the model override (operator side)" section,
      documenting the `config.toml` `[review] allow_approve` gate.
- [ ] `docs/ARCHITECTURE.md`: update the "Review posture: `COMMENT` only —
      Magpie never approves or requests changes." line (~line 271) and the
      `event: COMMENT` mention (~line 209-210) to state the accurate default
      (COMMENT-only, never `REQUEST_CHANGES`, never merges) plus the narrow
      opt-in exception and point at repo-config.md.
- [ ] `docs/review-flow.md`: update the diagram text at line 77
      (`event: COMMENT (never approves or blocks)`) to match.
- [ ] `CLAUDE.md` (repo root): the opening description says "it never
      approves or blocks; a human always decides." Reword precisely — do NOT
      weaken the actual capability-separation security claims elsewhere in
      that paragraph. Suggested replacement for just that clause: "it never
      auto-merges and never requests changes — by default it posts a
      `COMMENT` review, and only when a repo opts in via `.magpie.toml` (and
      the operator has enabled it server-side) may it post a plain `APPROVE`
      tick on a fully clean review; a human always makes the merge decision."
      Get this wording right; it's the single most load-bearing sentence in
      the file.

## Verification
- [ ] `npm run build && npm test` (or workspace-scoped equivalents) green
      across `packages/orchestrator`.
- [ ] `npm run lint`/typecheck clean.
- [ ] Re-read the final `publisher.ts` diff to confirm the 422-retry path
      still can't accidentally end up `APPROVE` after findings get folded
      into the body (it must always recompute/reuse the COMMENT-forcing
      condition, not the pre-fold `event`).

## Out of scope
- No change to `REQUEST_CHANGES` — still never used, not being added.
- No auto-merge capability of any kind.
- No change to the `@magpie review` comment-command trigger path — same
  pipeline, same gating, nothing command-specific.
