---
id: task_89c4
title: M8-B1: floor-invariant regression test — crun tier flags byte-for-byte vs today's hardened posture
type: task
status: closed
priority: 1
labels: [security,testing,merge-blocker]
blocked_by: []
parent: epic_59b1
remote_task_url: null
created_at: 2026-07-19T22:53:22Z
updated_at: 2026-07-22T21:02:13Z
---
CTO edit 3: the floor invariant gets a regression test, not just doc language. The last-resort
crun tier must be EXACTLY today's shipped hardened posture — seccomp profile, --cap-drop=ALL,
no-new-privileges, read-only rootfs, tmpfs mounts, pids cap, mem/cpu limits, --network none,
non-root uid, .git-stripped read-only /work — and CI must fail if it ever drifts.

Plan:
- [ ] Capture the golden flag set from today's docker invocation (reviewer.ts/container-mounts.ts)
      as a checked-in fixture: the fully-rendered container-run argv (normalised for per-job
      values like names, socket paths, workspace paths).
- [ ] Unit test: render the crun-tier launch argv and assert byte-for-byte equality with the
      fixture. Any intentional posture change must edit the fixture in the same PR (visible in
      review) — that is the point.
- [ ] Preflight assertion (runtime counterpart): before a crun-tier job runs, assert the same
      flag set is present; fail closed with a loud log if not.
- [ ] Wire into CI so it gates every PR touching the launcher.

This lands FIRST — before the docker→podman port — so the port (M8-B2) is written against the
golden posture from day one. It is a merge blocker for any launcher change in this epic.

Done when: CI fails on any single-flag drift of the crun tier from the fixture, and the fixture
matches what ships on main today.

---

## Review (2026-07-22) — delivered in PR #47 (branch `m8-crun-floor-test`)

Byte-for-byte crun-floor golden regression test landed (CTO binding edit #3). Behaviour-preserving
extraction of `buildReviewDockerArgs()` in `reviewer.ts` + an order-sensitive `toEqual` golden test
(`reviewer-crun-floor-argv.test.ts` + `__fixtures__/reviewer-crun-floor-argv.golden.json`); any
flag added/removed/reordered/renamed fails and forces a visible fixture diff. Tech-lead
verification: 248/248 orchestrator tests pass, tsc clean, deliberate `--cap-drop=ALL` removal fails
the test then reverted; Magpie self-review found no issues.

Plan items: [x] golden fixture, [x] byte-for-byte unit test, [x] wired into CI — this PR also adds
`.github/workflows/ci.yml` (the repo had NO PR-triggered TS test job before, only release-*
workflows, so the golden test would not otherwise have gated merges).

Deferred to follow-up (split out so it doesn't block this landing): the runtime **preflight**
assertion counterpart + extending the pin to the `.git`-strip / mount-prep posture in
`container-mounts.ts` (the argv golden doesn't cover mount prep). Tracked separately.

Done-condition met: CI (this workflow) fails on any single-flag drift from the fixture, and the
fixture matches what ships on main today.
