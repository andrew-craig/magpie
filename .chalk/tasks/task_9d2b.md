---
id: task_9d2b
title: RUST-3: cross-language contract-test harness — TS integration tests as the boundary contract for Rust binaries
type: task
status: open
priority: 2
labels: [rust,testing]
blocked_by: [decision_aa2d]
parent: epic_6955
remote_task_url: null
created_at: 2026-07-19T22:54:38Z
updated_at: 2026-07-21T21:32:05Z
---
Make the "leverage the tests we have" half of the migration strategy concrete: the existing
TypeScript integration/e2e tests are the contract harness for every Node→Rust swap.

Plan:
- [ ] Identify the tests that exercise each migrating boundary (forwarder relay tests, reviewer
      launch/e2e tests, entrypoint assertion tests) and make them runnable against either
      implementation via a binary-path env var/config knob.
- [ ] CI runs the boundary suites against the Rust binaries (built by RUST-2) — the swap PR must
      keep them green with zero test edits; test edits in a swap PR are a red flag by policy.
- [ ] Add golden-fixture tests for wire formats crossing the language boundary (vsock framing,
      forwarder handshake), checked in once, consumed by both Rust unit tests and TS tests.
- [ ] Document the rule in docs/design/rust-adoption.md: a migration PR may add Rust unit tests but
      must not modify boundary contract tests.

Done when: each Rust component's boundary suite runs in CI against the Rust binary, and the policy
is documented.
