# Installing Magpie (host services)

This is the operator install guide for the **host-service release tarball** —
the packaged `@magpie/orchestrator` and `@magpie/gateway` (M7-3,
`scripts/pack-host.sh`). It targets a systemd Linux host (the project runs on
a Raspberry Pi in production; any systemd distro works).

For the design behind this split (host services vs. the one container) see
[`DISTRIBUTION.md`](DISTRIBUTION.md) §2. The reviewer itself is **not** part
of this bundle — it's a published container image; see
[`docker/reviewer/README.md`](docker/reviewer/README.md).

## 1. Download the release

Grab the tarball and its checksum from the
[GitHub Releases page](https://github.com/andrew-craig/magpie/releases) (tag
`v<version>`, e.g. `v0.3.0`):

```
curl -LO https://github.com/andrew-craig/magpie/releases/download/v<version>/magpie-<version>.tar.gz
curl -LO https://github.com/andrew-craig/magpie/releases/download/v<version>/magpie-<version>.tar.gz.sha256
```

## 2. Verify

Checksum (required):

```
sha256sum -c magpie-<version>.tar.gz.sha256
```

SLSA build provenance (optional, recommended — proves the tarball was built
by this repo's release workflow, not hand-assembled):

```
gh attestation verify magpie-<version>.tar.gz --repo andrew-craig/magpie
```

## 3. Unpack

Unpack to `/opt/magpie` — the documented prefix, and required unless you
relax the systemd units' `ProtectHome=true` (see `scripts/install.sh`, which
refuses a `/home/*` prefix by default):

```
sudo mkdir -p /opt/magpie
sudo tar xzf magpie-<version>.tar.gz --strip-components=1 -C /opt/magpie
cd /opt/magpie
```

(To install elsewhere, set `MAGPIE_PREFIX` to that path in step 4 instead.)

## 4. Install units + scaffolding

```
sudo ./scripts/install.sh
```

This creates the `magpie` / `magpie-gateway` system users, `/etc/magpie`,
`/etc/magpie-gateway`, `/var/lib/magpie`, seeds (empty) secret env-file
templates and `config.toml`, and installs the two systemd units — rewritten
to your prefix and resolved `node` path. It does **not** build anything and
does **not** start the services. Safe to re-run (idempotent; never
overwrites an existing secret or config file).

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
`repo_allowlist`, LLM model) — it was seeded from `config.example.toml`.

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
webhook port — see `DISTRIBUTION.md` §3.3 for the supported ingress options
(reverse proxy, Cloudflare Tunnel, other tunnels). The existing Cloudflare
Tunnel path is documented separately in `docs/cloudflared.md`.

## Upgrading

Repeat steps 1–5 for the new tarball into the same prefix, then
`sudo systemctl restart magpie-gateway magpie`. `install.sh` never
overwrites your secrets or `config.toml`.
