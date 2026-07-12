---
id: task_624f
title: M7-5: Pluggable ingress — reverse-proxy + Cloudflare-Tunnel (multi-arch host binary) + tunnel docs
type: task
status: open
priority: 2
labels: [distribution]
blocked_by: []
parent: epic_0162
remote_task_url: null
created_at: 2026-07-12T13:07:35Z
updated_at: 2026-07-12T13:34:30Z
---
Magpie needs only some public HTTPS URL forwarded to the orchestrator's loopback webhook. Make ingress pluggable and documented as a 3-option matrix rather than Cloudflare-only: (1) reverse proxy + own TLS (Caddy/nginx/Traefik) for orgs with a public server; (2) Cloudflare Tunnel; (3) other outbound tunnels (tailscale funnel/ngrok). Fix setup-cloudflared.sh to drop the arm64/apt-only assumption (the official cloudflared binary is multi-arch; install per-arch or document the binary/host-service install) and don't hard-assume a Cloudflare-managed domain in the docs. cloudflared runs as a host service (consistent with the host-service deployment; no compose). HMAC verification keeps the endpoint safe regardless of ingress. When publishing a port to a host reverse proxy, document binding 127.0.0.1 explicitly.
