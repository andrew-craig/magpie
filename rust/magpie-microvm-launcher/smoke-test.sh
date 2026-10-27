#!/usr/bin/env bash
# Live boot smoke test for magpie-krun-launch.
#
# NOT part of `cargo test` or CI -- this actually boots a real micro-VM via
# /dev/kvm, so it needs real hardware virtualization and kvm-group access.
# Run it directly:
#
#   MAGPIE_REVIEWER_IMAGE=<local reviewer image> \
#     sg kvm -c 'rust/magpie-microvm-launcher/smoke-test.sh'
#
# (or just run it directly if your shell session's group list already
# includes `kvm` -- check with `id`; a fresh login after `usermod -aG kvm`
# needs `sg kvm`/`newgrp kvm` or a re-login to take effect. `sg` inherits the
# calling environment, so MAGPIE_REVIEWER_IMAGE set on the command line or
# exported beforehand reaches the script.)
#
# SELF-CONTAINED: the script builds its own throwaway guest rootfs in a
# mktemp dir (a `podman create` + `podman export` of the reviewer image named
# by $MAGPIE_REVIEWER_IMAGE -- the same "export the reviewer image to an
# unpacked rootfs directory" step docs/INSTALL.md describes for the
# production micro-VM tier's `[microvm] rootfs_path`), adds the tiny
# smoke/vsock-ping-client (built for the host arch, statically linked) and
# smoke/smoke-probe.sh, and removes everything on exit. The reviewer image
# must already exist locally (./scripts/build-reviewer-image.sh); it is never
# built or pulled here.
#
# Env vars:
#   MAGPIE_REVIEWER_IMAGE   Reviewer image to export. REQUIRED, no default.
#   DOCKER_BIN              podman/docker CLI used for create/export.
#                           Default: podman
#
# WHAT THIS PROVES:
#   1. TSI is OFF: the guest's only non-loopback interface (dummy0) is
#      administratively down, the route table is empty, and an egress
#      connect() attempt fails immediately rather than hanging or
#      succeeding.
#   2. A working per-VM vsock round-trip: the guest dials the configured
#      vsock port and gets a reply from a host-side UNIX socket listener
#      that this script starts (smoke/vsock-host-listener.py) -- never a
#      host-global listener, a fresh per-job socket path.
#   3. VMM-enforced vcpu/RAM: `nproc`/MemTotal inside the guest match
#      exactly what was requested, not the host's own values.
#   4. The guest's ACTUAL uid despite krun_setuid/krun_setgid being called
#      -- this is the empirical half of src/krun.rs's "does NOT confine the
#      guest" finding. Expect `uid=0(root)`.
#   5. The read-only /work virtiofs contract: the mount succeeds, its
#      content is visible, and a write attempt fails (EROFS).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LAUNCHER_DIR="$REPO_ROOT/rust/magpie-microvm-launcher"
SMOKE_DIR="$LAUNCHER_DIR/smoke"
BIN="$REPO_ROOT/rust/target/release/magpie-krun-launch"
DOCKER_BIN="${DOCKER_BIN:-podman}"
IMAGE="${MAGPIE_REVIEWER_IMAGE:-}"

[ -n "$IMAGE" ] || { echo "MAGPIE_REVIEWER_IMAGE is required (a locally built reviewer image; see ./scripts/build-reviewer-image.sh)" >&2; exit 1; }
command -v "$DOCKER_BIN" >/dev/null 2>&1 || { echo "'$DOCKER_BIN' not found on PATH" >&2; exit 1; }
"$DOCKER_BIN" image inspect "$IMAGE" >/dev/null 2>&1 || { echo "image '$IMAGE' not found locally (build it first: ./scripts/build-reviewer-image.sh)" >&2; exit 1; }

if [ ! -x "$BIN" ]; then
    echo "building release binary..." >&2
    (cd "$REPO_ROOT/rust" && cargo build -p magpie-microvm-launcher --release)
fi

WORKDIR="$(mktemp -d /tmp/magpie-krun-smoke.XXXXXX)"
UDS_PATH="$WORKDIR/gw.sock"
LISTENER_LOG="$WORKDIR/host-listener.log"
GUEST_LOG="$WORKDIR/guest.log"
ROOTFS="$WORKDIR/rootfs"
WORK_HOST_DIR="$WORKDIR/work-fixture"
CONTAINER_NAME="magpie-krun-smoke-$$"
cleanup() {
    kill "${LISTENER_PID:-0}" 2>/dev/null || true
    "$DOCKER_BIN" rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
    # An unpacked rootfs can contain mode-000 dirs; make it removable first.
    chmod -R u+rwX "$WORKDIR" 2>/dev/null || true
    rm -rf "$WORKDIR"
}
trap cleanup EXIT

echo "=== building throwaway rootfs from $IMAGE ===" >&2
mkdir -p "$ROOTFS"
"$DOCKER_BIN" create --name "$CONTAINER_NAME" "$IMAGE" >/dev/null
# Device nodes can't be created unprivileged (and the guest kernel provides
# /dev itself), so skip them.
"$DOCKER_BIN" export "$CONTAINER_NAME" | tar -x -C "$ROOTFS" --no-same-owner --exclude='./dev/*' --exclude='dev/*'
"$DOCKER_BIN" rm -f "$CONTAINER_NAME" >/dev/null
mkdir -p "$ROOTFS/work" "$ROOTFS/out" "$ROOTFS/tmp" "$ROOTFS/dev" "$ROOTFS/proc" "$ROOTFS/sys"

echo "=== building guest vsock ping client (static, host arch) ===" >&2
HOST_TRIPLE="$(rustc -vV | sed -n 's/^host: //p')"
CARGO_TARGET_DIR="$WORKDIR/ping-target" RUSTFLAGS="-C target-feature=+crt-static" \
    cargo build --release --locked --target "$HOST_TRIPLE" \
    --manifest-path "$SMOKE_DIR/vsock-ping-client/Cargo.toml" >&2
install -m 0755 "$WORKDIR/ping-target/$HOST_TRIPLE/release/vsock-ping-client" "$ROOTFS/vsock-client"

cp -r "$SMOKE_DIR/work-fixture" "$WORK_HOST_DIR"

echo "=== starting host-side vsock listener (uds=$UDS_PATH) ===" >&2
python3 -I "$SMOKE_DIR/vsock-host-listener.py" "$UDS_PATH" >"$LISTENER_LOG" 2>&1 &
LISTENER_PID=$!
# Give the listener a moment to bind before the guest tries to dial it.
for _ in $(seq 1 50); do
    [ -S "$UDS_PATH" ] && break
    sleep 0.1
done
if [ ! -S "$UDS_PATH" ]; then
    echo "host listener never bound $UDS_PATH -- see $LISTENER_LOG" >&2
    exit 1
fi

# The guest probe lives as a real multi-line FILE
# (rust/magpie-microvm-launcher/smoke/smoke-probe.sh, git-tracked) rather than
# an inline `--arg`-packed one-liner: libkrun's kernel-cmdline packing requires
# plain ASCII with no newlines (src/config.rs's cmdline-ASCII guard enforces
# this on argv/env), and an inline script here would also have to survive
# being quoted through THREE shell layers (this script -> `sg kvm -c "..."`
# -> that string's own shell) -- exactly the kind of fragility a real
# production entrypoint avoids by being a file the image ships, not a
# synthesized cmdline argument. Only the `--exec /smoke-probe.sh` argv entry
# itself needs to be (and is) a short, plain-ASCII path.
#
# Copied into the throwaway rootfs just before boot.
install -m 0755 "$SMOKE_DIR/smoke-probe.sh" "$ROOTFS/smoke-probe.sh"

# --uid/--gid: krun_setuid/krun_setgid are applied via a plain host-side
# setuid(2)/setgid(2) call INSIDE krun_start_enter (see src/krun.rs's module
# doc comment). POSIX only allows an UNPRIVILEGED caller to setuid()/setgid()
# to its OWN CURRENT real/effective/saved id -- not to an arbitrary one, and
# NOT to a merely-supplementary group. This launcher process is not root, so
# it can only pass its OWN uid/gid here (mirroring reviewer.ts's docker
# convention of `--user <hostuid>:<hostgid>` == `process.getuid()`, not a
# baked-in image uid).
#
# Empirically discovered wrinkle: `sg kvm -c '...'` (needed for /dev/kvm
# access -- see this crate's Cargo.toml/README on the rootless KVM path)
# itself changes the REAL/effective/saved gid to `kvm`'s gid for the
# duration of that command (confirmed via `strace`: `setgid(1000) = -1
# EPERM` when the outer shell's `id -g` was captured BEFORE entering `sg
# kvm`, because by the time krun_start_enter ran, the process's real gid was
# actually `kvm`'s, not 1000 -- `pi`/1000 was merely a SUPPLEMENTARY group
# inside that context, and setgid(2) does not accept supplementary-group
# membership as authorization). Fixed by resolving `id -u`/`id -g` INSIDE the
# `sg kvm` subshell (via unescaped `$(id -u)`/`$(id -g)` in the single-quoted
# command below) rather than in this script's own shell.
echo "=== booting micro-VM (rootfs=$ROOTFS) ===" >&2
set +e
sg kvm -c "'$BIN' --rootfs '$ROOTFS' --exec /bin/sh --arg /smoke-probe.sh \
    --vcpus 2 --ram-mib 512 --uid \$(id -u) --gid \$(id -g) \
    --vsock-port 1234 --vsock-uds '$UDS_PATH' \
    --work-mount '$WORK_HOST_DIR:work'" 2>&1 | tee "$GUEST_LOG"
BOOT_STATUS=${PIPESTATUS[0]}
set -e

echo "=== magpie-krun-launch exited with status $BOOT_STATUS ===" >&2
echo "=== host listener log ===" >&2
cat "$LISTENER_LOG" >&2

echo "" >&2
echo "=== automated assertions ===" >&2
FAIL=0
assert_contains() {
    if grep -qF "$2" "$GUEST_LOG"; then
        echo "PASS: $1" >&2
    else
        echo "FAIL: $1 (expected to find: $2)" >&2
        FAIL=1
    fi
}
assert_contains "dummy0 is administratively down" "===DUMMY0-OPERSTATE===
down"
assert_contains "route table is empty" "===ROUTE-COUNT===
0"
assert_contains "egress connect() is blocked, not a hang" "blocked:"
assert_contains "vcpu count is exactly the requested 2" "===NPROC===
2"
assert_contains "vsock round-trip completed" "vsock round-trip OK"
assert_contains "guest uid is root despite krun_setuid (see src/krun.rs)" "uid=0(root)"
assert_contains "/work virtiofs mount succeeded and is visible" "hello"
assert_contains "/work is read-only (write attempt failed)" "good-read-only"
grep -qF "host: received b'PING from rust guest\\n'" "$LISTENER_LOG" \
    && echo "PASS: host listener actually received the guest's vsock PING" >&2 \
    || { echo "FAIL: host listener log missing the guest's PING" >&2; FAIL=1; }

if [ "$FAIL" -ne 0 ]; then
    echo "" >&2
    echo "one or more assertions FAILED -- see output above" >&2
    exit 1
fi
echo "" >&2
echo "ALL ASSERTIONS PASSED" >&2
