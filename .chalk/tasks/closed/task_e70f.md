---
id: task_e70f
title: Reframe docs as a complete product, not a build log
type: task
status: closed
priority: 2
labels: []
blocked_by: []
parent: null
remote_task_url: null
created_at: 2026-08-05T07:45:47Z
updated_at: 2026-08-07T03:37:07Z
---

Docs accumulated milestone/task-ID narration ("M8-D3 did X", "as of M7-1", "task_89c4")
throughout, appropriate for a repo being actively built but wrong now that Milestones 1-8 are
delivered and merged. Reframe the docs to describe the current product, moving build history
to an explicitly historical doc.

User decisions (via AskUserQuestion):
- Milestone roadmap content moves out of the architecture doc into a standalone HISTORY.md.
- PLAN.md renamed to ARCHITECTURE.md (no longer a forward-looking plan).

## Plan / what was done

- [x] HISTORY.md (new) — the milestone-by-milestone build order + notable deviations
      (LiteLLM->custom gateway, gVisor descope), extracted out of PLAN.md.
- [x] PLAN.md -> ARCHITECTURE.md (git mv, full rewrite) — current-state architecture only:
      decisions table, threat model, isolation tiers, a regenerated system diagram (the old
      one predated Design D/the tier ladder entirely), Components rewritten by concern instead
      of by milestone, repository layout tree brought current. No milestone/task-ID tags.
- [x] DISTRIBUTION.md reframed as current self-hosting architecture, not an in-flight proposal:
      dropped "out of scope this round"/roadmap section (all delivered), renumbered sections
      1-4 after removing the old problem-list §1, fixed pre-Podman "docker daemon/docker group"
      wording in the topology diagram and prose, shortened the isolation-tier subsection to
      cross-reference ARCHITECTURE.md's canonical version instead of duplicating it.
- [x] AGENTS.md (=CLAUDE.md) rewritten: replaced "Implemented so far (Milestones 1-8)" /
      "Remaining open work" with a brief product description + a "Where things live" component
      map. Along the way, documented two shipped-but-undocumented features:
      comment-command.ts (@magpie review on-demand trigger) and repo-config.ts/glob-match.ts
      (.magpie.toml). Fixed "7-milestone roadmap" (stale count).
- [x] Light-touch pass: README.md (added an "On-demand review" section, fixed PLAN.md/tag
      refs), INSTALL.md, QUICKSTART.md, docs/review-flow.md (also regenerated the mermaid
      diagram to add the issue_comment/@magpie-review trigger path and the per-repo-config
      resolution step, both missing since M6-A/M6-B shipped).
- [x] Follow-up sweep: renaming/renumbering broke external cross-references (§ numbers, PLAN.md
      path) in scripts/install.sh, scripts/pack-host.sh, scripts/setup-cloudflared.sh,
      systemd/*.service, config.example.toml, docker/reviewer/README.md,
      packages/gateway/README.md, docker/reviewer/entrypoint.sh (+ its paired test file's
      string marker, updated in lockstep). systemd/magpie.service's `Documentation=` also
      pointed at a file (`PLAN.md`) never actually shipped in the release tarball — fixed to
      point at `INSTALL.md`, which is.
- [x] Full test suite green after all edits (607 tests, gateway+orchestrator+review-extension),
      plus the standalone entrypoint-tier-memory.test.sh (marker-string coupled with
      entrypoint.sh, verified in lockstep).

## Explicitly out of scope (flagged, not done) — first pass

`docker/reviewer/README.md` and `packages/gateway/README.md` still carry substantial
milestone/task-ID narration beyond the broken-link fixes above (e.g. "As of M4-C...",
"Containerizing Pi (M3) bought..."). `docs/design/*.md` (decision briefs, rejected
alternatives, `shim-containerisation.md`) were deliberately left untouched — they're archival
decision records, not living docs, so milestone/task framing is appropriate there. A fuller
pass on the two package READMEs would be a similarly-sized follow-up if wanted.

## Round 2 — full sweep (docs + source comments), user-requested 2026-08-05

User asked to search the whole repo for milestone refs (`M[0-9]+(-[A-Za-z0-9]+)?`, "Milestone
N", and chalk IDs `task_xxxx`/`bug_xxxx`/`epic_xxxx`) and clean up ones that no longer make
sense now the build is done. Confirmed in scope: docs (finishing what round 1 flagged) AND
source code comments (400+ occurrences across nearly every file in
`packages/orchestrator/src` and `packages/gateway/src` — milestone/task IDs baked into inline
"why" comments). Still explicitly OUT of scope: `HISTORY.md`, `docs/design/*.md`, `spike/*` —
archival/historical records where the framing is correct.

Editing rule given to each subagent: if a comment is *purely* a milestone/task label (a title
tag, a trailing `(task_220f)`), delete just the tag. If the comment explains a real constraint
and *cites* an ID as part of that explanation, keep the substantive "why" and drop only the
ID/milestone framing, rewritten as a present-tense statement about how the system works now.
Comment-only changes — no logic edits. Each agent runs its package's test suite after editing.

- [x] Docs/config pass 2: `docker/reviewer/README.md`, `packages/gateway/README.md`,
      `config.example.toml`, `docs/repo-config.md`, `scripts/install.sh`,
      `packages/review-extension/src/index.ts`, `rust/*/Cargo.toml`, `rust/rust-toolchain.toml`
      ('.github/workflows/*.yml` slipped through this pass, caught in the mop-up below)
- [x] `packages/orchestrator/src/reviewer.ts` + `reviewer.test.ts` + `reviewer-*.test.ts` +
      `__fixtures__/reviewer-*.json` (109/109 reviewer tests pass)
- [x] `packages/orchestrator/src/pipeline.ts` + `pipeline.test.ts` (60/60 pipeline tests pass;
      also fixed 2 stray dangling `PLAN.md` pointers)
- [x] `packages/orchestrator/src/{config,diff,tier-ladder,index,server}.ts` + their `.test.ts`
      (102 targeted tests pass; also fixed 6 stale `PLAN.md`→`ARCHITECTURE.md` pointers, incl.
      dropping a tag from a thrown-error message string — text only, no test asserts it)
- [x] `packages/orchestrator/src/{gateway,publisher,telemetry,queue,workspace,docker,
      docker-image-config-drift,orphan-cleanup,container-mounts,microvm-vsock,comment-command,
      glob-match,rereview,repo-config}.ts` + their `.test.ts` (full orchestrator suite green;
      also fixed 7 stale `PLAN.md` pointers)
- [x] `packages/gateway/src/*` (all files incl. tests) — 75/75 gateway tests pass

### Mop-up — a repo-wide re-grep after the above found stragglers nothing had claimed:
- [x] `anchor.ts`, `github.ts`, `findings.ts` — zero milestone-code hits so never assigned to a
      group, but had dangling `PLAN.md`/`Milestone 2` refs; repointed to ARCHITECTURE.md/CLAUDE.md
- [x] `cgroup-preflight.ts`, `orphan-cleanup.test.ts`, `relay-boundary.test.ts` — missed because
      they weren't in any group's original file list (new/overlooked files)
- [x] `docker/reviewer/entrypoint.sh` + `entrypoint-tier-memory.test.sh` — ~65 refs, handled as a
      coupled pair since the test parses literal comment strings out of entrypoint.sh as section
      markers; the one marker line touched (`# M4-E: fail-closed startup...`) was updated in both
      files in lockstep and verified via the standalone bash test (22/22 pass)
- [x] `systemd/*.service`, `scripts/{build-reviewer-image,pack-host,test-zero-egress}.sh`,
      `.github/workflows/*.yml`, `rust/magpie-microvm-launcher/smoke-{probe,test}.sh` — ~52 refs;
      never scoped into any original group
- [x] Final: full monorepo test suite green (gateway 75/75, orchestrator 521/525 [4 pre-existing
      skips], review-extension 11/11 = 607 total), standalone entrypoint bash test 22/22,
      repo-wide re-grep for `M[0-9]+`/`Milestone N`/`task_`/`bug_`/`epic_`/`decision_` (4-hex) and
      `PLAN\.md` outside `HISTORY.md`/`docs/design/*`/`spike/*`/`.chalk/*` returns zero hits
      (one legitimate exception left as-is: AGENTS.md's chalk-usage examples `epic_0c4d`/
      `bug_5cc8`, which are illustrative ID syntax, not stale references to real work).
      81 files changed, comment/test-title/doc-text only — no logic, assertions, or config
      values touched. Not committed yet — left for the user to review/commit.
