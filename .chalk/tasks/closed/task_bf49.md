---
id: task_bf49
title: Reviewer image: scope vsock-builder COPY so unrelated rust/ changes don't bust the cache
type: task
status: closed
priority: 2
labels: []
blocked_by: []
parent: null
remote_task_url: null
created_at: 2026-09-06T12:38:52Z
updated_at: 2026-09-06T12:41:23Z
---

## Problem

`docker/reviewer/Dockerfile`'s `vsock-builder` stage does `COPY rust/ ./rust/`
and then `cargo build --release --locked -p magpie-vsock-client`. Because the
whole `rust/` tree lands in one layer, ANY change under `rust/` invalidates
that layer and forces a full cargo rebuild from scratch (recompiling `libc`
+ `magpie-vsock-client`) — even changes to crates the reviewer image never
ships (`magpie-microvm-launcher`, `magpie-tier-probe`) or a `rust/Cargo.lock`
bump for a dependency only those crates use.

`magpie-vsock-client`'s only dependency is `libc`; the stage needs just the
workspace manifests + that one crate's source.

## Plan

- [x] Replace `COPY rust/ ./rust/` with scoped copies:
  - workspace root: `rust/Cargo.toml`, `rust/Cargo.lock`, `rust/rust-toolchain.toml`
  - sibling crate manifests (needed for `[workspace]` member resolution):
    `magpie-microvm-launcher/Cargo.toml` (+ its `build.rs`, referenced by
    `build =`), `magpie-tier-probe/Cargo.toml`
  - the built crate in full: `rust/vsock-client/`
- [x] Update the stage's doc comment to explain the scoping.
- [x] Verify `cargo build --release --locked -p magpie-vsock-client` still
      succeeds with only those paths present (done locally: builds clean).
- [x] Verify a full `docker build` of the reviewer image still succeeds and
      that touching an unrelated `rust/` file no longer busts the vsock layer.
- [x] Check `docker/reviewer/README.md` for anything that needs updating.

## Review

Implemented on branch `reviewer-image-cache-scope`.
