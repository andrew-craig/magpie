---
id: task_9d2b
title: RUST-3: cross-language contract-test harness — TS integration tests as the boundary contract for Rust binaries
type: task
status: closed
priority: 2
labels: [rust,testing]
blocked_by: []
parent: epic_6955
remote_task_url: null
created_at: 2026-07-19T22:54:38Z
updated_at: 2026-07-26T02:54:12Z
---
Make the "leverage the tests we have" half of the migration strategy concrete: the existing
TypeScript integration/e2e tests are the contract harness for every Node→Rust swap.

Plan:
- [x] Identify the tests that exercise each migrating boundary. As-built reality (see M8-C1/task_2d6c
      on the base branch): the relay boundary now has TWO live implementations sharing one TCP-facing
      contract — `docker/reviewer/forwarder.mjs` (TCP->unix, docker/crun path) and
      `rust/vsock-client` / `magpie-vsock-client` (TCP->AF_VSOCK, micro-VM path), selected at runtime
      by `docker/reviewer/entrypoint.sh` testing `[ -c /dev/vsock ]`. There is no custom wire format on
      this path (raw byte relay; `vsock-framing` was deliberately NOT used — see main.rs's doc
      comment) — no golden framing fixture to add here. `reviewer.test.ts` already covers the
      docker-argv/launch contract with a fake-docker seam; it does not currently exercise the relay
      byte-stream behavior at all.
- [x] Add a new relay-boundary TS suite (`packages/orchestrator/src/relay-boundary.test.ts`) exercising
      the TCP-facing byte-relay contract (bidirectional relay, half-close/EOF propagation, teardown-race
      tolerance) against the REAL `forwarder.mjs` subprocess + a real unix-socket destination stub —
      always runs in CI. Parameterize impl selection via `MAGPIE_RELAY_IMPL` (`node`, default, or
      `rust`) + `MAGPIE_VSOCK_CLIENT_BIN` env vars so the same test bodies are structured to drive
      either binary; the `rust` path exercises what's actually verifiable without real vsock hardware
      (binary-exists check, fail-closed-without-/dev/vsock behavior) and skips the deeper
      byte-relay assertions with a clear, loud reason (not a silent no-op) when no AF_VSOCK transport
      is available — cross-referencing rust/vsock-client's own `relay()` unit tests
      (`relay_copies_bytes_in_both_directions` / `relay_propagates_half_close` /
      `relay_tolerates_peer_already_gone`) as the transport-agnostic proof of the same contract on the
      Rust side.
- [x] Wire a CI job (in `.github/workflows/rust.yml`, after the existing `build` job) that downloads the
      `rust-binaries-<target>` artifact, runs the new suite with `MAGPIE_RELAY_IMPL=rust` against the
      real compiled binary — so a future swap PR must keep this green with zero test edits.
- [x] No golden wire-format fixtures added: confirm and document why (raw byte relay, no framing on
      this boundary; `vsock-framing` remains unused scaffolding for a hypothetical future consumer).
- [x] Document the "don't edit boundary contract tests in a swap PR" policy concretely in
      `docs/design/rust-adoption.md`, naming the actual boundary suite(s) that are now load-bearing.
- [x] Verify: TS suite green (`npm test`), Rust suite green (`cargo fmt --check`, `cargo clippy
      --workspace --exclude magpie-microvm-launcher --all-targets -- -D warnings`, `cargo test
      --workspace --exclude magpie-microvm-launcher`).
- [x] `chalk close task_9d2b` on this branch, commit the file move.

Done when: the relay-boundary suite runs against the real Rust binary in CI, the policy is documented,
and nothing above requires editing reviewer.test.ts or reviewer-crun-floor-argv.test.ts (the existing
launch-contract boundary tests) at all.

## Review

Built `packages/orchestrator/src/relay-boundary.test.ts`, a new boundary-contract suite for the
relay leg (`docker/reviewer/forwarder.mjs` <-> `rust/vsock-client`'s `magpie-vsock-client`), plus:
- `.github/workflows/rust.yml`: new `boundary-contract` job (needs `build`) that downloads the
  `rust-binaries-x86_64-unknown-linux-musl` artifact and runs the suite with `MAGPIE_RELAY_IMPL=rust`
  against the real compiled binary on a matching-arch runner (no cross-arch emulation); path filters
  extended to also trigger on changes to the new test file or `forwarder.mjs`.
- `docs/design/rust-adoption.md`: new "The boundary contract suites, concretely" subsection under
  the migration rule, naming both load-bearing suites (`reviewer.test.ts` +
  `reviewer-crun-floor-argv.test.ts` for the launch/argv contract; `relay-boundary.test.ts` for the
  relay contract) and explaining the impl-selection mechanism and why no golden wire-format fixture
  applies here.

No golden fixtures added: confirmed via `rust/vsock-client/src/main.rs`'s own doc comment ("Why not
the vsock-framing crate") that the relay boundary is a raw, unframed byte pipe — Pi's HTTP traffic is
already self-delimiting. `vsock-framing` remains unused scaffolding; nothing on the relay path needs
a checked-in wire-format fixture.

Verified locally: `npm run build`/`npm test` green (all workspaces); `relay-boundary.test.ts` run
standalone 3x each in `MAGPIE_RELAY_IMPL=node` (4 pass/4 skip) and `=rust` (1 pass/7 skip, skip
reasons visible in test titles) — 100% reliable across repeated runs. `cargo fmt --check`, `cargo
clippy --workspace --exclude magpie-microvm-launcher --all-targets -- -D warnings`, and `cargo test
--workspace --exclude magpie-microvm-launcher` all green (19 Rust tests total, including the 3
`relay()` unit tests this suite's doc comments point to as the rust-side equivalent coverage).

Could not verify locally (documented as such, not silently skipped): a live `AF_VSOCK` round-trip —
this sandbox has no `/dev/vsock` and lacks permission to load `vsock_loopback`
(`modprobe: Operation not permitted`) — and cross-arch (`aarch64-unknown-linux-musl`) execution of
the CI job, since this sandbox is itself aarch64 and the `boundary-contract` job intentionally only
exercises the `x86_64-unknown-linux-musl` leg (the one native to its `ubuntu-24.04` runner).

Observed and NOT caused by this change: `reviewer.test.ts`'s AbortSignal-timing test
("kills the container and resolves ok:false/aborted promptly...") is flaky under full-workspace
`npm test` parallel load on this modest ARM sandbox — reproduced the same flake on the base branch
(`m8-c1-vsock-client`, before any of this task's changes) with 1/3 full-suite runs failing; the same
test passes 100% reliably in isolation. Pre-existing timing sensitivity, out of scope here.
