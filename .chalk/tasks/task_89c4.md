---
id: task_89c4
title: M8-B1: floor-invariant regression test — crun tier flags byte-for-byte vs today's hardened posture
type: task
status: open
priority: 1
labels: [security,testing,merge-blocker]
blocked_by: []
parent: epic_59b1
remote_task_url: null
created_at: 2026-07-19T22:53:22Z
updated_at: 2026-07-19T22:53:22Z
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
