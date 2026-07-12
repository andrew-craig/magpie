---
id: task_624f
title: M7-5: Pluggable ingress — cloudflared-as-container profile + reverse-proxy docs
type: task
status: open
priority: 2
labels: [distribution]
blocked_by: []
parent: epic_0162
remote_task_url: null
created_at: 2026-07-12T13:07:35Z
updated_at: 2026-07-12T13:07:35Z
---
Magpie needs only some public HTTPS URL forwarded to the orchestrator's loopback webhook. Add cloudflared as an OPTIONAL compose profile using the official cloudflare/cloudflared image (drops the arm64/apt install + Cloudflare-domain assumption in setup-cloudflared.sh). Document a 3-option ingress matrix: reverse proxy + own TLS (Caddy/nginx/Traefik), Cloudflare Tunnel, other tunnels (tailscale funnel/ngrok). HMAC verification keeps the endpoint safe regardless. Keep systemd cloudflared as the advanced path.
