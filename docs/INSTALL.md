# Installing Magpie (host services)

This is the operator install guide for the **host-service release tarball** —
the packaged `@magpie/orchestrator` and `@magpie/gateway` (built by
`scripts/pack-host.sh`). It targets a systemd Linux host (the project runs on
a Raspberry Pi in production; any systemd distro works).

For the design behind this split (host services vs. the one container) see
[`DISTRIBUTION.md`](DISTRIBUTION.md) §1. The reviewer itself is **not** part
of this bundle — it's a published container image; see
[`docker/reviewer/README.md`](docker/reviewer/README.md).

## 1. Download the release

Grab the tarball and its checksum from the
[GitHub Releases page](https://github.com/andrew-craig/magpie/releases) (tag
`v<version>`, e.g. `v0.4.0`). The release ships **one tarball per
architecture** — each bundles the matching native `magpie-tier-probe` KVM
preflight binary — so choose `<arch>` = `amd64` or `arm64` to match your host
(`uname -m`: `x86_64` → amd64, `aarch64` → arm64):

```
curl -LO https://github.com/andrew-craig/magpie/releases/download/v<version>/magpie-<version>-<arch>.tar.gz
curl -LO https://github.com/andrew-craig/magpie/releases/download/v<version>/magpie-<version>-<arch>.tar.gz.sha256
```

## 2. Verify

Checksum (required):

```
sha256sum -c magpie-<version>-<arch>.tar.gz.sha256
```

SLSA build provenance (optional, recommended — proves the tarball was built
by this repo's release workflow, not hand-assembled):

```
gh attestation verify magpie-<version>-<arch>.tar.gz --repo andrew-craig/magpie
```

## 3. Unpack

Unpack to `/opt/magpie` — the documented prefix (`scripts/install.sh` refuses a
`/home/*` prefix by default as a convention; deploy outside `/home`):

```
sudo mkdir -p /opt/magpie
sudo tar xzf magpie-<version>-<arch>.tar.gz --strip-components=1 -C /opt/magpie
cd /opt/magpie
```

(To install elsewhere, set `MAGPIE_PREFIX` to that path in step 4 instead.)

## 4. Install units + scaffolding

```
sudo ./scripts/install.sh
```

This creates the `magpie` / `magpie-gateway` system users, `/etc/magpie`,
`/etc/magpie-gateway`, `/var/lib/magpie`, provisions the **rootless-podman
substrate** for the `magpie` user (subuid/subgid ranges in `/etc/subuid`,
`/etc/subgid` + `loginctl enable-linger magpie` — the latter is what actually
enforces each review's `--memory` cap), installs the bundled
`magpie-tier-probe` to `/usr/local/bin` and runs the **KVM tier preflight**,
seeds (empty) secret env-file templates and `config.toml`, and installs the two
systemd units — rewritten to your prefix, resolved `node` path, and the numeric
`magpie` uid. It does **not** build anything and does **not** start the
services. Safe to re-run (idempotent; never overwrites an existing secret or
config file).

**Rootless — no root daemon anywhere.** There is no Docker daemon and no
`docker` group: the reviewer runs under rootless Podman as the unprivileged
`magpie` user. Install `podman` first (`sudo apt install podman` or your
distro's package) — `install.sh` does the rest of the rootless wiring.

**Tier preflight (`MAGPIE_INSTALL_TIER` / `MAGPIE_ACK_TIER`).** By default the
installer targets the hardened **crun floor** (`MAGPIE_INSTALL_TIER=crun`) and
just reports whether the stronger micro-VM tier is *also* reachable. If you
intend to run the micro-VM tier, run `sudo MAGPIE_INSTALL_TIER=microvm
./scripts/install.sh`: the preflight opens `/dev/kvm` and issues a real
`KVM_CREATE_VM`, and **fails loud** if KVM is unreachable rather than silently
installing a weaker posture. To proceed on the floor anyway, acknowledge it
explicitly with `MAGPIE_ACK_TIER=crun` (the same env var the orchestrator honors
at runtime).

## 5. Install production dependencies

The tarball ships **prebuilt** `dist/` for both services — there is no
TypeScript build step on the adopter host. Just materialize `node_modules`
from the pinned, pruned lockfile:

```
npm ci --omit=dev
```

Run this as your normal (non-root) user from the install directory
(`/opt/magpie` by default).

## 6. Fill in secrets and config

Edit the two seeded env files. `MAGPIE_GATEWAY_MASTER_KEY` **must be
identical** in both — generate it once with `openssl rand -hex 32`:

```
sudoedit /etc/magpie-gateway/gateway.env   # MAGPIE_GATEWAY_OPENROUTER_KEY, MAGPIE_GATEWAY_MASTER_KEY
sudoedit /etc/magpie/magpie.env            # MAGPIE_WEBHOOK_SECRET, MAGPIE_GATEWAY_MASTER_KEY (same value)
```

Edit `/etc/magpie/config.toml` (GitHub App id, `private_key_path`,
`repo_allowlist`, LLM model) — it was seeded from `config.example.toml`. If
you want allowlisted repos to be able to switch models for themselves via
their own `.magpie.toml` (see [`docs/repo-config.md`](docs/repo-config.md)),
set `llm.allowed_models` here too — it's empty (no repo-level model override
possible) by default.

Place the GitHub App private key where `config.toml`'s `private_key_path`
points (default `/etc/magpie/github-app.private-key.pem`), readable by
`magpie` only:

```
sudo install -o magpie -g magpie -m 0600 app.pem /etc/magpie/github-app.private-key.pem
```

## 6a. Host requirement: cgroup v2 memory controller

Every review runs in a container launched with `--memory` (see
`config.toml`'s `[container] memory`) so a single, possibly prompt-injected
review job can't exhaust host RAM. That limit is only real if your kernel's
cgroup v2 **`memory` controller** is enabled. Check:

```
cat /sys/fs/cgroup/cgroup.controllers   # the list must include `memory`
```

If `memory` is missing, the limit would be silently unenforced (rootful
Docker accepts `--memory` and discards it with only a warning; rootless
podman/crun instead fails every job at container creation). Magpie therefore
**refuses to start** in that state by default (`[container]
require_memory_limit = true`), and the reviewer container re-checks it per
job — see the bug this closes and `config.example.toml`.

> **cgroup v2 required.** Magpie assumes the **cgroup v2 unified hierarchy**
> (its default rootless-Podman runtime requires it anyway). On a legacy
> cgroup v1 host `/sys/fs/cgroup/cgroup.controllers` won't exist and the
> memory ceiling is verified differently (`memory.limit_in_bytes`), which
> Magpie does **not** check — so a v1 host is reported as unverifiable and,
> by default, fails the same startup/per-job guard. Run on a v2 host, or use
> the `require_memory_limit = false` escape hatch below at your own risk.

**Raspberry Pi caveat.** Pi firmware boots with `cgroup_disable=memory` on
the kernel command line by default, which turns the controller off. To enable
it, append `cgroup_enable=memory cgroup_memory=1` to the single line in
`/boot/firmware/cmdline.txt` (Raspberry Pi OS Bookworm; older images use
`/boot/cmdline.txt`) — a later `cgroup_enable=memory` overrides the
firmware's `cgroup_disable=memory` — then reboot and re-check the command
above. If you must run without an enforced ceiling (e.g. you can't reboot
right now), set `[container] require_memory_limit = false` in
`/etc/magpie/config.toml`, accepting that a runaway review can OOM the host.

## 7. Start

Boot order matters: the gateway must be up before the orchestrator (it mints
per-job virtual keys). The systemd units already encode this ordering
(`magpie.service` has `After=`/`Wants=magpie-gateway.service`), so enabling
both together is safe:

```
sudo systemctl enable --now magpie-gateway.service magpie.service
sudo systemctl status magpie-gateway magpie
```

You'll also need a public HTTPS endpoint forwarding to the orchestrator's
webhook port — see `docs/ingress.md` for the supported ingress options
(reverse proxy, Cloudflare Tunnel, other tunnels). The Cloudflare Tunnel
option is set up entirely from the Cloudflare dashboard (no unit or config
shipped by this repo) — see `docs/ingress.md`'s Option 2.

### Checking the active isolation tier

Magpie runs review jobs at the strongest isolation tier this host can
actually deliver (micro-VM > the hardened crun floor — see
[`ARCHITECTURE.md`](ARCHITECTURE.md)'s "Isolation tiers" section). You can see which tier is active,
and why, in two operator-only places:

- **`GET /healthz`** — returns JSON including the resolved tier, whether it's
  degraded from what `config.toml`'s `container.tier` requested, and probe
  details (KVM availability, container-runtime/launcher binary + version).
  This is a liveness endpoint (always `200`, unauthenticated) meant for your
  own monitoring — `curl localhost:<port>/healthz` on the host.
- **The orchestrator's startup log** — a `tier-resolved` JSON log line at
  every boot, and a `tier` field on each job's `running-review` log line.

The active tier is **deliberately not surfaced anywhere in the PR itself**
(the review comment/summary GitHub shows). This is intentional, not an
oversight: publishing the tier on a PR would let anyone who can open a pull
request against your repo learn, before submitting anything malicious,
whether your deployment runs the weaker crun floor rather than the micro-VM
tier — free reconnaissance for an attacker. Isolation posture stays strictly
operator-facing information (`/healthz` + logs), never public.

## Opt into the micro-VM tier (optional, strongest isolation)

The default install runs the hardened **crun floor** — today's rootless-Podman
posture, and no operator is worse off than before. The strongest tier runs each
review inside a **rootless KVM micro-VM** (libkrun), which the installer's
preflight will tell you is reachable when `/dev/kvm` is usable. To actually
switch to it there are three host-side steps the release tarball intentionally
does **not** automate (the launcher links host-specific `libkrun.so`, so it is
built on the host, not shipped prebuilt):

1. **Host virtualization + `/dev/kvm`.** You need hardware virtualization
   (bare metal, or a nested-virt-enabled VM) and the `magpie` user in the `kvm`
   group — `install.sh` adds it (re-run after installing KVM if needed). If
   `krun` still can't open `/dev/kvm` after group membership (crun #1894),
   re-run the installer with `MAGPIE_KVM_SETFACL=1` for a `magpie`-scoped ACL
   (never world-`0666`).

2. **Install libkrun and build the launcher.** Install `libkrun` +
   `libkrunfw` (your distro's packages, or from source per the libkrun README),
   then build the launcher from source and put it on `PATH`:

   ```
   cd /opt/magpie/rust        # or your repo checkout
   cargo build --release -p magpie-microvm-launcher
   sudo install -m 0755 target/release/magpie-krun-launch /usr/local/bin/
   ```

   (`magpie-krun-launch` is `config.toml`'s default `[microvm] launcher_bin`.)

3. **Prepare a guest rootfs and point config at it.** Export the reviewer
   image to an unpacked rootfs directory readable by `magpie`, then set, in
   `/etc/magpie/config.toml`:

   ```toml
   [container]
   tier = "microvm"

   [microvm]
   rootfs_path = "/var/lib/magpie/reviewer-rootfs"   # absolute; required for microvm
   ```

Restart the services. The orchestrator re-probes KVM + the launcher + the rootfs
at startup and **fails closed** (unless `MAGPIE_ACK_TIER` acknowledges a weaker
tier) if any is missing — it never silently downgrades. Confirm the active tier
on `/healthz` (see below). No root daemon is involved at any tier.

## Upgrading

Repeat steps 1–5 for the new tarball into the same prefix, then
`sudo systemctl restart magpie-gateway magpie`. `install.sh` never
overwrites your secrets or `config.toml`.
