# magpie-reviewer (M3-A): containerized runtime for the Pi coding agent.
#
# Runs Pi headless over a mounted, read-only, `.git`-free PR worktree
# (`/work`) and writes structured findings to a mounted `/out`. No secrets are
# baked in. The runtime inputs are: the provider + model as trailing container
# ARGV (`docker run ... IMAGE --provider openrouter --model <id>`, forwarded to
# `pi` by entrypoint.sh) and the provider credential via `-e OPENROUTER_API_KEY`.
# The findings OUTPUT PATH is part of the image contract, not per-job config,
# so it's baked in as an ENV below (always /out/findings.json). See
# docker/reviewer/README.md for build/run instructions and the pinned-version
# record.
#
# PINNED VERSIONS (bump deliberately -- no floating tags/ranges anywhere in
# this file; see README.md for the "how to re-pin" checklist):
#   - Base image:  node:22.23.1-slim, pinned by BOTH tag and digest below.
#   - Rust builder: rust:1.97.1-alpine, pinned by BOTH tag and digest below
#                  (matches rust/rust-toolchain.toml's channel).
#   - Pi:          @earendil-works/pi-coding-agent@0.80.3 (matches the host's
#                  `pi --version` == 0.80.3 as of 2026-07-10; see
#                  docker/reviewer/extension-package.json).
#   - Extension's own runtime deps: @earendil-works/pi-tui@0.80.3,
#                  typebox@1.1.38 (must match packages/review-extension's
#                  resolved versions on the host -- see that package's
#                  package.json / the repo root package-lock.json).

# --- Builder stage: guest-side AF_VSOCK relay (M8-C1 / task_2d6c) ---------
#
# Compiles rust/vsock-client into a fully static musl binary baked into the
# final image below, so the image's digest pin + cosign signature (see
# .github/workflows/release-reviewer.yml) covers it -- no separate signing
# lane needed (rust.yml's own `sign` job is for binaries shipped OUTSIDE the
# image; see that workflow's SCOPE NOTE).
#
# No `--platform=$BUILDPLATFORM` override: `docker buildx build --platform
# linux/amd64,linux/arm64` (release-reviewer.yml) runs this whole Dockerfile
# once per target platform, so this stage builds NATIVELY for whichever arch
# is currently being produced -- the same no-cross-compile posture
# .github/workflows/rust.yml uses for the standalone rust/ build lane, and
# for the same reason (no musl cross-linker / prebuilt-binary supply-chain
# smell). `rust:*-alpine`'s default target is already the matching
# `*-unknown-linux-musl` triple, so no `rustup target add` /
# `--target` flag is needed here.
FROM rust:1.97.1-alpine@sha256:3c38f3f82c2f3d73da3b38e18d279393a04cb43ddded0e35088a8c3324d40900 AS vsock-builder
# musl-dev: static-libc headers/archives cargo's linker needs; not already
# present in the base rust:alpine image.
RUN apk add --no-cache musl-dev
WORKDIR /src
COPY rust/ ./rust/
WORKDIR /src/rust
# -p (not the whole workspace): magpie-microvm-launcher dynamically links a
# HOST-installed libkrun.so (see its own Cargo.toml doc comment) that this
# throwaway builder image doesn't have, so building the whole workspace here
# would fail; magpie-vsock-client (its only dependency is the `libc` crate --
# see rust/vsock-client/Cargo.toml) is all this stage needs.
RUN cargo build --release --locked -p magpie-vsock-client

FROM node:22.23.1-slim@sha256:53ada149d435c38b14476cb57e4a7da73c15595aba79bd6971b547ceb6d018bf

# git: kept on PATH as defence-in-depth in case Pi or a future tool probes
# for it, even though the mounted worktree itself is `.git`-free (M3-B strips
# it host-side) and the read-only tool allowlist below never includes `bash`.
# util-linux: provides `mount`/`setpriv`, both needed ONLY under the M8-C3
# micro-VM tier's entrypoint.sh branch (mounting the /work and /out virtiofs
# devices, then dropping privileges before exec'ing pi -- see that file's
# own comments). node:22-slim's default package set doesn't guarantee
# either is present, so install explicitly rather than assume; harmless
# no-op cost under the docker/crun tier, which never reaches that branch.
# Minimal install, apt lists cleaned up in the same layer.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git util-linux \
    && rm -rf /var/lib/apt/lists/*

# --- Pi + review-extension, installed together at pinned exact versions ---
#
# The `pi` CLI and the report_findings extension's `import`s
# (@earendil-works/pi-coding-agent's ExtensionAPI, @earendil-works/pi-tui's
# Text, typebox's Type) are installed as ONE regular (non-global) npm
# dependency set at /opt/magpie/review-extension, so both resolve against the
# exact same on-disk copies -- no separate global install that could drift to
# a different version. `/opt/magpie/review-extension/node_modules/.bin/pi` is
# symlinked onto PATH below so `pi` is invocable normally.
WORKDIR /opt/magpie/review-extension
COPY docker/reviewer/extension-package.json ./package.json
RUN npm install --omit=dev \
    && ln -s /opt/magpie/review-extension/node_modules/.bin/pi /usr/local/bin/pi

# Bake in the extension SOURCE (Pi runs the .ts file directly -- no build
# step, see packages/review-extension's own doc comments) and the reviewer
# system prompt. Both are pinned to whatever this build's git checkout has;
# rebuild the image whenever either changes (see README.md).
COPY packages/review-extension/src ./src
COPY reviewer-prompt.md /opt/magpie/reviewer-prompt.md

# Non-root user, defence-in-depth only. The image must NOT depend on running
# as this user, and at runtime NEITHER TIER actually does -- both run as the
# host orchestrator's own uid, precisely so the mounted `/out` dir (owned by
# that host process) stays writable:
#   - crun:     M3-C's docker runner overrides with `--user <hostuid>:<hostgid>`
#               (see epic_a580 decision #4).
#   - micro-VM: entrypoint.sh's privilege drop targets the same host uid,
#               supplied as MAGPIE_MICROVM_REVIEWER_UID/_GID. It deliberately
#               does NOT drop to this baked account: uid 10001 has no relation
#               to the host uid owning the /out virtiofs, so Pi got EACCES on
#               findings.json and every micro-VM review silently failed
#               (M8-E5 / task_a749 -- see that block's comment).
# The account is kept as the image's own non-root default for anyone running
# it directly. uid/gid 10001 chosen to avoid the base image's existing `node`
# user (uid 1000) and common host uid ranges.
RUN groupadd --gid 10001 reviewer \
    && useradd --uid 10001 --gid reviewer --no-create-home --shell /usr/sbin/nologin reviewer

COPY docker/reviewer/entrypoint.sh /opt/magpie/entrypoint.sh
RUN chmod +x /opt/magpie/entrypoint.sh

# --- Relay to the gateway: TWO binaries, entrypoint.sh picks ONE at runtime -
#
# `http://127.0.0.1:4000/v1` is the address entrypoint.sh points Pi at
# (regardless of runtime); something must make that address real by relaying
# to wherever the gateway's per-job socket actually is. Which relay applies
# depends on how THIS container is being run, and both still need to ship
# today -- see entrypoint.sh's own comment on the /dev/vsock switch for why
# forwarder.mjs is NOT dead code yet (docker/crun is still the only live
# path in production -- task_2d6c's task file has the full investigation):
#
#   - forwarder.mjs (M7-1, Design D -- DISTRIBUTION.md §2.2/§2.3): TCP->unix
#     relay for the docker/crun `--network none` container, which has no
#     shared filesystem with the guest other than the bind-mounted
#     `/run/gw/gw.sock`. Holds no secret. Runs under the `node` already on
#     PATH in this base image -- no new dependency.
#   - magpie-vsock-client (M8-C1 / task_2d6c): TCP->AF_VSOCK relay for the
#     libkrun micro-VM path (task_76d6/task_b3f7), which has no bind-mounted
#     socket at all -- the guest's only channel out is the vsock device.
#     Compiled by the `vsock-builder` stage above; a static musl binary, so
#     it runs unmodified on this glibc-based final image. Also holds no
#     secret.
COPY docker/reviewer/forwarder.mjs /opt/magpie/forwarder.mjs
COPY --from=vsock-builder /src/rust/target/release/magpie-vsock-client /opt/magpie/vsock-client
RUN chmod +x /opt/magpie/vsock-client

# Findings output path is part of the image contract, not per-job config: the
# baked-in report_findings extension (packages/review-extension) reads
# MAGPIE_FINDINGS_PATH from its env, and in-container that is ALWAYS
# /out/findings.json (the mounted, writable output dir M3-C hands in). Baking
# it here means M3-C doesn't have to pass it and entrypoint.sh doesn't have to
# read it. This is a fixed PATH, not a secret. (NOTE: on the host subprocess,
# MAGPIE_FINDINGS_PATH is a per-run tmp path and MAGPIE_* is stripped from the
# child env -- that denylist logic is host-only; a container inherits nothing,
# so here the extension only sees exactly this baked value.)
ENV MAGPIE_FINDINGS_PATH=/out/findings.json

WORKDIR /work
ENTRYPOINT ["/opt/magpie/entrypoint.sh"]
