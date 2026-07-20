#!/usr/bin/env bash
# M8-A1 spike (task_1fdc) — provisioning steps actually required to get a krun-capable
# runtime onto a Debian bookworm / Raspberry Pi OS arm64 host (16 KB pages).
#
# THIS IS A SPIKE RECORD, NOT A PRODUCTION INSTALLER. It documents what had to be done
# to the host so that (a) the steps are auditable/reversible and (b) task_67aa (M8-D3
# installer) inherits a factual list rather than a guess.
#
# Host this was derived from:
#   Raspberry Pi 5 Model B Rev 1.0, aarch64, PAGESIZE=16384,
#   kernel 6.12.93+rpt-rpi-2712, Debian bookworm, podman 4.3.1, crun 1.8.1
set -euo pipefail

SPIKE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---------------------------------------------------------------------------
# 1. Build dependencies
# ---------------------------------------------------------------------------
# NOTE: `acl` is only needed for the /dev/kvm setfacl FALLBACK (crun #1894). The
# preferred path is kvm-group membership; see step 3.
sudo apt-get update
sudo apt-get install -y \
    acl build-essential python3-pyelftools patchelf libglib2.0-dev \
    pkg-config git cargo rustc \
    flex bison libelf-dev bc libssl-dev

# ---------------------------------------------------------------------------
# 2. Modern Rust toolchain
# ---------------------------------------------------------------------------
# FINDING: libkrun's crates declare `edition = "2024"`, which needs rustc >= 1.85.
# Debian bookworm ships rustc 1.63 — far too old. The distro toolchain installed
# above is therefore NOT sufficient and rustup is mandatory on this platform.
# This is a real distribution burden for self-hosters (see spike writeup risk #3).
if ! command -v rustup >/dev/null 2>&1; then
    curl -sSf https://sh.rustup.rs -o /tmp/rustup-init.sh
    sh /tmp/rustup-init.sh -y --default-toolchain stable --profile minimal
fi
export PATH="$HOME/.cargo/bin:$PATH"
rustc --version   # spike observed: 1.97.1

# ---------------------------------------------------------------------------
# 3. KVM access
# ---------------------------------------------------------------------------
# /dev/kvm on this host is `crw-rw---- root:kvm`, and the service user was NOT in
# the kvm group. Preferred: group membership. Requires re-login / newgrp to take
# effect in the current session.
#
#   sudo usermod -aG kvm "$(id -un)"
#
# ONLY if krun still cannot open /dev/kvm (crun #1894), fall back to an ACL scoped
# to the single service user:
#
#   sudo setfacl -m "u:$(id -un):rw" /dev/kvm
#
# World-0666 on /dev/kvm is NOT an acceptable outcome — per the task checklist it is
# recorded as a FAIL on that gate item, not as a workaround.

# ---------------------------------------------------------------------------
# 4. libkrunfw — bundles the guest kernel into a shared library
# ---------------------------------------------------------------------------
# FINDING: this compiles a full Linux kernel (6.12.91 at spike time) from source.
# On a Pi 5 this is a long build. The resulting guest kernel is the thing whose
# page-size config (CONFIG_ARM64_4K_PAGES=y) the 16 KB-host question is about.
cd "$SPIKE_DIR/libkrunfw"
make -j"$(nproc)"
sudo make install

# ---------------------------------------------------------------------------
# 5. libkrun
# ---------------------------------------------------------------------------
cd "$SPIKE_DIR/libkrun"
make -j"$(nproc)"
sudo make install
sudo ldconfig

# ---------------------------------------------------------------------------
# 6. crun with the libkrun handler, installed as `krun`
# ---------------------------------------------------------------------------
# FINDING: Debian's stock crun 1.8.1 reports feature flags
#   +SYSTEMD +SELINUX +APPARMOR +CAP +SECCOMP +EBPF +YAJL
# with NO krun handler, so the distro binary cannot drive libkrun and a source
# build of crun --with-libkrun is required.
cd "$SPIKE_DIR"
[ -d crun ] || git clone --depth 1 https://github.com/containers/crun.git
cd crun
./autogen.sh
./configure --with-libkrun
make -j"$(nproc)"
sudo make install

echo "provisioning complete; verify with: podman --runtime krun run --rm <image> true"
