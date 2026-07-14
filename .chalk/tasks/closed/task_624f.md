---
id: task_624f
title: M7-5: Pluggable ingress — reverse-proxy + Cloudflare-Tunnel (multi-arch host binary) + tunnel docs
type: task
status: closed
priority: 2
labels: [distribution]
blocked_by: []
parent: epic_0162
remote_task_url: null
created_at: 2026-07-12T13:07:35Z
updated_at: 2026-07-14T22:13:28Z
---
Magpie needs only some public HTTPS URL forwarded to the orchestrator's loopback webhook. Make ingress pluggable and documented as a 3-option matrix rather than Cloudflare-only: (1) reverse proxy + own TLS (Caddy/nginx/Traefik) for orgs with a public server; (2) Cloudflare Tunnel; (3) other outbound tunnels (tailscale funnel/ngrok). Fix setup-cloudflared.sh to drop the arm64/apt-only assumption (the official cloudflared binary is multi-arch; install per-arch or document the binary/host-service install) and don't hard-assume a Cloudflare-managed domain in the docs. cloudflared runs as a host service (consistent with the host-service deployment; no compose). HMAC verification keeps the endpoint safe regardless of ingress. When publishing a port to a host reverse proxy, document binding 127.0.0.1 explicitly.

## Review / results (2026-07-15)

Implemented by sonnet subagent, tech-lead reviewed line-by-line. Pluggable ingress per DISTRIBUTION.md §3.3.

**Changes:**
- `scripts/setup-cloudflared.sh` §1 install step reworked into 3 idempotent branches: (a) already-on-PATH skip; (b) Debian-family (dpkg+apt-get) → existing Cloudflare apt repo, arch case generalized to `amd64|arm64|armhf|armel|i386` (no more Pi-only assumption); (c) fallback → download official static `cloudflared-linux-<arch>` (x86_64→amd64, aarch64/arm64→arm64, armv7l→arm) + SHA256SUMS from Cloudflare GitHub releases, checksum-verify, install to /usr/local/bin (0755). Fails closed on unknown arch / missing-or-mismatched checksum. All install actions go through `run()` so `--dry-run` stays no-op.
- `systemd/cloudflared.service`: `ExecStart=/usr/bin/cloudflared` → bare `cloudflared` (systemd resolves via default PATH incl. /usr/local/bin, covering both install locations); rationale commented.
- `docs/ingress.md` (NEW): 3-option matrix — (1) reverse proxy + own TLS with Caddy + nginx snippets (both path-preserving, forward `/webhook`→127.0.0.1:8787, orchestrator stays on 127.0.0.1); (2) Cloudflare Tunnel (multi-arch, DNS-hosted-not-purchased domain); (3) Tailscale Funnel / ngrok. Opens with the HMAC-makes-ingress-choice-purely-operational security note (server.ts verifies X-Hub-Signature-256 before parsing). Closing "which to choose" table + cross-links.
- `docs/cloudflared.md`: de-Cloudflare-lock-in — cross-link to ingress.md, "DNS hosted not purchased" domain wording, arch-agnostic prerequisite/install text.

**Verification (no host mutation — LIVE PROD host):** `bash -n` OK; `shellcheck` clean except pre-existing SC2088 (line 120 header text, not introduced here); `--dry-run` from a /tmp copy no-ops (exercised already-installed branch on this host); checksum + arch-map logic unit-tested in isolation; systemd default PATH confirmed via `systemd-path search-binaries-default`. No apt/systemctl/sudo-mutate/`/etc` writes; running cloudflared untouched.
