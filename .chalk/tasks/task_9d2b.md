---
id: task_9d2b
title: GO-3: cross-language contract-test harness — TS integration tests as the boundary contract for Go binaries
type: task
status: open
priority: 2
labels: [go,testing]
blocked_by: [decision_aa2d]
parent: epic_6955
remote_task_url: null
created_at: 2026-07-19T22:54:38Z
updated_at: 2026-07-19T22:54:38Z
---
Make the "leverage the tests we have" half of the migration strategy concrete: the existing
TypeScript integration/e2e tests are the contract harness for every Node→Go swap.

Plan:
- [ ] Identify the tests that exercise each migrating boundary (forwarder relay tests, reviewer
      launch/e2e tests, entrypoint assertion tests) and make them runnable against either
      implementation via a binary-path env var/config knob.
- [ ] CI runs the boundary suites against the Go binaries (built by GO-2) — the swap PR must
      keep them green with zero test edits; test edits in a swap PR are a red flag by policy.
- [ ] Add golden-fixture tests for wire formats crossing the language boundary (vsock framing,
      forwarder handshake), checked in once, consumed by both Go unit tests and TS tests.
- [ ] Document the rule in docs/design/go-adoption.md: a migration PR may add Go unit tests but
      must not modify boundary contract tests.

Done when: each Go component's boundary suite runs in CI against the Go binary, and the policy
is documented.
