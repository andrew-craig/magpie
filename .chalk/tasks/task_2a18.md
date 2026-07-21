---
id: task_2a18
title: RUST-2: Rust build + signing pipeline — cargo workspace, static cross-arch builds, cosign coverage in release CI
type: task
status: open
priority: 1
labels: [rust,supply-chain,ci]
blocked_by: [decision_aa2d]
parent: epic_6955
remote_task_url: null
created_at: 2026-07-19T22:54:29Z
updated_at: 2026-07-21T21:32:05Z
---
CTO edit 4 names the supply chain explicitly: the vsock client is a new compiled binary inside
the signed reviewer image — new supply-chain surface — so it must be built in OUR CI and covered
by the same cosign signing as the image.

Language is Rust per RUST-1 (`decision_aa2d`). Note the launcher binary additionally links
libkrun's C ABI (not pure-Rust like the guest client), so the pipeline must handle a crate that
links a system library, not only fully-static musl binaries — confirm the launcher's linking
story separately from the guest client's.

Plan:
- [ ] Single cargo workspace (`rust/` at repo root alongside the npm workspaces), one
      `Cargo.toml` workspace, shared crates (vsock framing, confinement assertions) across binaries.
- [ ] Reproducible static builds: `--target {aarch64,x86_64}-unknown-linux-musl`, pinned toolchain
      (rust-toolchain.toml), `Cargo.lock` committed; linux/amd64 + linux/arm64. (The guest client
      is fully static musl — proven in the spike, 389 KB. The libkrun-linking launcher may not be
      fully static; decide its link mode here.)
- [ ] Release CI builds the binaries, embeds them in the reviewer image build (so the image
      digest pin + cosign signature covers them), and additionally cosign-signs any binary
      shipped outside the image (e.g. the installer preflight probe in the host tarball —
      extend scripts/pack-host.sh + release workflow).
- [ ] No pre-built third-party binaries fetched at image build time; everything compiled from
      pinned sources in CI.
- [ ] `cargo clippy` + `cargo fmt --check` gate in CI next to the existing TS lint/test jobs.

Done when: CI produces signed, reproducible Rust binaries for both arches and the reviewer image
build consumes them; documented in the release process.
