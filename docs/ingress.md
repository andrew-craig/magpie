# Webhook ingress options

Magpie only needs *some* public HTTPS URL forwarding to the orchestrator's
loopback webhook endpoint — by default `127.0.0.1:8787/webhook`
(`config.toml` `[server] host = "127.0.0.1"`, `port = 8787`). How that public
URL comes to exist is entirely up to you; this page documents three
supported ways to do it.

## Security note (read this first)

**HMAC signature verification makes the endpoint safe to expose regardless
of which ingress option you pick.** Every GitHub webhook delivery carries an
`X-Hub-Signature-256` header; the orchestrator verifies it against
`MAGPIE_WEBHOOK_SECRET` *before* parsing the payload
(`packages/orchestrator/src/server.ts`) and rejects anything unsigned or
mis-signed. There is no separate authentication layer to configure (no
Cloudflare Access, no basic auth, no IP allowlist) — the choice below is
purely operational (what's easiest to run given your network), not a
security decision.

Whichever option you choose, the orchestrator itself must stay bound to
`127.0.0.1` (never `0.0.0.0`) — the ingress mechanism, not the orchestrator's
bind address, is what makes it reachable from the internet.

## Option 1: Reverse proxy + your own TLS

For organisations that already run a public-facing server with a real TLS
certificate (e.g. via Let's Encrypt / ACME). Terminate TLS at your existing
reverse proxy and forward the `/webhook` path to the orchestrator's loopback
port. Nothing else on the host needs to listen publicly.

**Caddy** (`Caddyfile`):

```
magpie.example.com {
	reverse_proxy /webhook 127.0.0.1:8787
}
```

**nginx** (site config):

```nginx
server {
    listen 443 ssl;
    server_name magpie.example.com;

    # ... your existing ssl_certificate / ssl_certificate_key directives ...

    location /webhook {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Either way: the reverse proxy is the only public listener; the orchestrator
stays on `127.0.0.1:8787` and never sees a public IP directly. Point the
GitHub App's webhook URL at `https://magpie.example.com/webhook`.

## Option 2: Cloudflare Tunnel (dashboard-managed)

An outbound-only tunnel — no inbound port to open, no port-forward on your
router. Set it up entirely from the Cloudflare Zero Trust dashboard, following
[Cloudflare's own tunnel setup guide][cf-tunnel-setup]:

1. **Networking → Tunnels → Create a tunnel** (choose the "Cloudflared"
   connector type), and give it a name (e.g. `magpie`).
2. Pick your host's OS/architecture; the dashboard gives you a one-line
   install command containing a connector token
   (`cloudflared service install <TOKEN>`). Run it on the magpie host. This
   installs `cloudflared` **and** registers + starts its own systemd service
   — magpie ships no `cloudflared` unit or config of its own, and there is no
   local `config.yml` or credentials file to manage.
3. Back in the dashboard, confirm the tunnel shows **Healthy**, then add a
   **Public Hostname** route: pick a subdomain of a domain whose DNS is
   hosted on Cloudflare (free plan included — you don't need to have bought
   or registered the domain through Cloudflare, just have its nameservers
   pointed there), and set the **Service URL** to
   `http://localhost:8787` — the orchestrator's default loopback bind
   (`config.toml` `[server]`). Cloudflare creates the DNS record for you.
4. Point the GitHub App's webhook URL at `https://<your-hostname>/webhook`.

That's the whole setup — no scripts to run on the magpie host beyond the
one-line install command the dashboard gives you, and no ingress rules to
maintain in this repo (routing lives in the Cloudflare dashboard, not in a
committed config file). See [Cloudflare's tunnel routing docs][cf-routing]
if you need more than a single hostname/service mapping.

As with every ingress option on this page: do **not** put a Cloudflare
Access / Zero Trust login policy in front of the webhook hostname — it would
intercept and block GitHub's webhook deliveries before the orchestrator's own
HMAC check ever runs. The HMAC check is the auth gate, not Cloudflare Access.

[cf-tunnel-setup]: https://developers.cloudflare.com/tunnel/setup/
[cf-routing]: https://developers.cloudflare.com/tunnel/routing/

## Option 3: Other outbound tunnels

Any tool that punches an outbound tunnel to a public HTTPS URL and forwards
to a local port works, since the security boundary is the HMAC check, not
the tunnel mechanism. Two common options:

**Tailscale Funnel** (exposes a Tailscale node's local port to the public
internet over HTTPS):

```bash
tailscale funnel 8787
```

Tailscale prints the public `https://<host>.<tailnet>.ts.net` URL to point
the GitHub App's webhook at (append `/webhook`).

**ngrok**:

```bash
ngrok http 127.0.0.1:8787
```

ngrok prints a public `https://<random>.ngrok-free.app` forwarding URL
(append `/webhook` for the GitHub App's webhook URL). Free-tier URLs are
ephemeral (change on restart) — fine for evaluation, but prefer option 1 or 2
for a stable production URL.

## Choosing

All three are equally safe by design (HMAC verification is what actually
matters). Pick based on what you already operate:

| You have...                              | Use            |
|-------------------------------------------|----------------|
| A public server with a domain + TLS       | Option 1 (reverse proxy) |
| No public server, want a stable free setup | Option 2 (Cloudflare Tunnel) |
| An existing Tailscale/ngrok setup, or quick evaluation | Option 3 |

See also: `INSTALL.md` (host service install), `DISTRIBUTION.md` §2.3
(design rationale).
