---
id: task_56ad
title: M5-A: systemd units + install script — magpie, gateway, firewall oneshot
type: task
status: closed
priority: 2
labels: []
blocked_by: []
parent: epic_d6c1
remote_task_url: null
created_at: 2026-07-10T21:51:55Z
updated_at: 2026-07-12T03:52:09Z
---
Wave 1. Production service management per PLAN.md repository layout.

- systemd/magpie.service — the orchestrator, run as a dedicated unprivileged magpie user, with systemd hardening (NoNewPrivileges, ProtectSystem=strict with a writable /var/lib/magpie, PrivateTmp, etc.), env secrets via EnvironmentFile with tight perms, Restart=on-failure. Must gracefully drain on stop (the SIGTERM shutdown path already exists).
- systemd/magpie-gateway.service — the custom TypeScript gateway from M4-A (`packages/gateway`, `@magpie/gateway` — a purpose-built OpenRouter-only proxy, NOT LiteLLM; see PLAN.md §5 deviation box) under its own user, started Before= the orchestrator. Runs the built `packages/gateway` Node entrypoint; env secrets (MAGPIE_GATEWAY_OPENROUTER_KEY, MAGPIE_GATEWAY_MASTER_KEY) via EnvironmentFile with tight perms. In-memory key store means keys are lost on restart by design (per-job ephemeral), so no DB/state dir is needed for the gateway.
- systemd/magpie-firewall.service — oneshot wrapping scripts/setup-network.sh from M4-D, run before the gateway/orchestrator at boot.
- scripts/install.sh — idempotent: users, dirs (/var/lib/magpie/work), unit installation, notes on cloudflared (its unit already exists from M1).
- Sanity-check production defaults for the existing limits (concurrency 2, 10-min job timeout, ~4k-line diff cap) in config.example.toml — these are built; just confirm and document.

Done when: a reboot brings up firewall → gateway → orchestrator in order with no manual steps and a PR review works immediately after.

## Plan

Deployment model: code checked out to an install prefix (default `/opt/magpie`,
built with `npm ci && npm run build` for both workspaces); config at
`/etc/magpie/config.toml`; per-service env files at `/etc/magpie/magpie.env`
(orchestrator) and `/etc/magpie-gateway/gateway.env` (gateway), each chmod 600
owned by that service's user. Two unprivileged users: `magpie` (orchestrator,
in the `docker` group so it can `docker run`) and `magpie-gateway` (gateway,
NO docker access, holds the real OpenRouter key). Boot order enforced by
systemd ordering: `magpie-firewall` (creates br-magpie + iptables) →
`magpie-gateway` (binds 172.31.99.1:4000, which only exists after the bridge) →
`magpie` (orchestrator).

- [x] `systemd/magpie-firewall.service` — Type=oneshot, RemainAfterExit=yes,
      ExecStart wraps `scripts/setup-network.sh`; Requires/After=docker.service,
      After=network-online.target; Before=gateway+orchestrator; runs as root,
      intentionally un-sandboxed (needs CAP_NET_ADMIN + module autoload).
- [x] `systemd/magpie-gateway.service` — User/Group=magpie-gateway,
      Requires/After=magpie-firewall.service (bridge IP must exist first),
      Before=magpie.service, EnvironmentFile=/etc/magpie-gateway/gateway.env,
      ExecStart=node dist/index.js, full hardening (NoNewPrivileges,
      ProtectSystem=strict, ProtectHome, PrivateTmp/Devices, kernel+namespace
      restrictions, CapabilityBoundingSet= empty, RestrictAddressFamilies,
      SystemCallFilter=@system-service; NO MemoryDenyWriteExecute for V8 JIT),
      no writable paths (in-memory store), Restart=on-failure. No docker group.
- [x] `systemd/magpie.service` — User/Group=magpie, SupplementaryGroups=docker,
      Requires/After=docker, After+Wants=magpie-gateway, After=firewall,
      EnvironmentFile=/etc/magpie/magpie.env (sets MAGPIE_CONFIG + secrets),
      StateDirectory=magpie (0750) for /var/lib/magpie, same hardening set as
      gateway minus PrivateDevices (kept conservative for docker CLI),
      Restart=on-failure, KillSignal=SIGTERM, TimeoutStopSec=660s (> job_timeout
      600s) so the existing SIGTERM drain path finishes.
- [x] `scripts/install.sh` — idempotent: creates the two users (+docker group
      for magpie), dirs (/var/lib/magpie/work, /etc/magpie 0750,
      /etc/magpie-gateway 0700), seeds env-file templates (0600, never
      overwritten) + config.toml from the example (never overwritten), installs
      the three units rewriting the /opt/magpie prefix and /usr/bin/node
      interpreter to the actual install prefix + resolved node path,
      daemon-reload, optional --enable, prints next-steps incl. cloudflared
      (M1) note and a built-dist presence check.
- [x] Confirmed production limit defaults in config.example.toml (concurrency 2,
      job_timeout 600s, max_diff_lines 4000) — present and well-documented; no
      change needed. magpie.service's TimeoutStopSec comment cross-references
      job_timeout_seconds.
- [x] Verified: `bash -n` + `shellcheck` clean on install.sh; `bash -n` clean
      on setup-network.sh; `systemd-analyze verify` parses all three units with
      no directive errors (only expected "file not found" for the
      not-yet-on-this-host ExecStart paths); `npm run build` + `npm run
      gateway:build` succeed and produce the exact dist entrypoints the units
      reference; unit prefix/node rewrite rendered and checked.

## Review

Delivered three systemd units + an idempotent installer implementing the
firewall → gateway → orchestrator boot chain with capability separation:

- **Two users, split privilege.** `magpie` (orchestrator) is in `docker` so it
  can launch review containers; `magpie-gateway` holds the real OpenRouter key
  and has NO docker access — a compromise of one never yields the other's
  secret, matching CLAUDE.md's capability-separation principle and
  packages/gateway/README.md's provisioning note.
- **Boot ordering is load-bearing, not cosmetic.** The gateway binds the
  magpie-net bridge IP (172.31.99.1), which does not exist until the firewall
  oneshot creates br-magpie — hence Requires/After=magpie-firewall on the
  gateway, and After+Wants=magpie-gateway on the orchestrator so a webhook right
  after boot can mint a virtual key.
- **Graceful drain preserved.** magpie.service uses KillSignal=SIGTERM +
  TimeoutStopSec=660s (> the 600s job timeout) so the existing shutdown.ts drain
  runs each job's cleanup (workspace rm, container kill, key revoke) instead of
  being SIGKILLed mid-review.
- **Installer never clobbers secrets/config** and rewrites both the code prefix
  and the node interpreter path so hosts without /opt/magpie or /usr/bin/node
  (e.g. nvm) still get working units.

Not run end-to-end here: `install.sh` creates real system users and writes
under /etc + /var on the host, so it was validated by static analysis
(shellcheck, systemd-analyze, rendered substitution, successful builds) rather
than executed on this dev box. A reboot test belongs on the target server.
