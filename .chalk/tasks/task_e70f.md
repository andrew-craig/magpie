---
id: task_e70f
title: Reframe docs as a complete product, not a build log
type: task
status: open
priority: 2
labels: []
blocked_by: []
parent: null
remote_task_url: null
created_at: 2026-08-05T07:45:47Z
updated_at: 2026-08-05T07:45:47Z
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

## Explicitly out of scope (flagged, not done)

`docker/reviewer/README.md` and `packages/gateway/README.md` still carry substantial
milestone/task-ID narration beyond the broken-link fixes above (e.g. "As of M4-C...",
"Containerizing Pi (M3) bought..."). `docs/design/*.md` (decision briefs, rejected
alternatives, `shim-containerisation.md`) were deliberately left untouched — they're archival
decision records, not living docs, so milestone/task framing is appropriate there. A fuller
pass on the two package READMEs would be a similarly-sized follow-up if wanted.
