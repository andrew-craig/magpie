---
id: task_3b48
title: M8-C4: no-network-by-construction — TSI/passt built off + fail-closed in-guest assertion
type: task
status: open
priority: 1
labels: [security,microvm]
blocked_by: [task_39ff]
parent: epic_59b1
remote_task_url: null
created_at: 2026-07-19T22:55:21Z
updated_at: 2026-07-19T22:55:21Z
---
Brief §5 caveat + §7.2. libkrun's TSI/passt transport can give a guest egress with NO virtio-net
device visible in a config audit — the VMM analog of Proposal C's fail-open netns. "No network"
is therefore a mandated invariant asserted at three layers, not a launch flag:

- [ ] Construction: the reviewer VM is launched with network transport disabled (no TSI/passt,
      no virtio-net); document the exact krun knobs and pin them in the launch code.
- [ ] Install preflight: assert the launch configuration has no network transport enabled
      (pairs with the M8-D1 tier preflight).
- [ ] In-guest, fail-closed at startup: extend docker/reviewer/entrypoint.sh's existing
      confinement assertions — verify no non-lo interface, empty route table, AND an actual
      egress attempt to a known-external address fails (catches the TSI case where no interface
      exists to inspect). Abort the review on any assertion failure.
- [ ] The only permitted channel out is the vsock port to the per-job gateway socket — assert
      the allowed port explicitly.
- [ ] Negative test in CI/e2e: a deliberately mis-launched VM (TSI on) must be caught by the
      in-guest assertion.

Done when: all three layers assert and a TSI-enabled mis-launch is provably caught.
