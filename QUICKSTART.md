# Quickstart: zero to your first automated review

A linear path from nothing to Magpie posting its first review comment on a
pull request. Each step links to the detailed doc it summarizes — this page
doesn't duplicate those, it stitches them together and fills in the one gap
none of them cover: registering the GitHub App.

## 1. What you'll end up with

Magpie runs as two host **systemd services** — the orchestrator (webhook
listener + git/GitHub orchestration) and the gateway (holds the real LLM
provider key, mints short-lived per-job credentials) — plus a **reviewer
container**, the one container in the product, pulled from GHCR and run
`--network none` per review job. On each pull request against a repo you've
allow-listed, Magpie clones the PR head, runs the Pi coding agent over the
diff inside the isolated reviewer container, and posts exactly one `COMMENT`
review back to the PR — it never approves or blocks; a human still decides.
See [`DISTRIBUTION.md`](DISTRIBUTION.md) for the full architecture and threat
model.

## 2. Prerequisites

- A Linux host with **systemd**, **amd64 or arm64** (a Raspberry Pi works;
  so does any cloud VM).
- **Docker**, to run the reviewer image per review job. Your user (or the
  `magpie` system user `install.sh` creates) needs access to the Docker
  daemon.
- The kernel's **cgroup v2 `memory` controller** enabled, so the per-review
  `--memory` limit is actually enforced. Check with
  `cat /sys/fs/cgroup/cgroup.controllers` — the list must include `memory`.
  Magpie refuses to start otherwise (by default). **On a Raspberry Pi** the
  firmware disables it: append `cgroup_enable=memory cgroup_memory=1` to
  `/boot/firmware/cmdline.txt` (one line, older images use `/boot/cmdline.txt`)
  and reboot. See [`INSTALL.md`](INSTALL.md) §6a (and the
  `require_memory_limit` escape hatch if you can't enable it).
- **Node.js 22** and **git**. The host-service release tarball ships
  prebuilt `dist/**`, so Node is only needed to run it (`npm ci --omit=dev`
  for dependencies), not to compile TypeScript.
- An **OpenRouter API key** (the gateway's only supported LLM provider today).
- A **GitHub org or personal account** you can register a GitHub App on, and
  at least one repo to review.

## 3. Install the host services

Download the release tarball, verify its checksum (and optionally its SLSA
provenance), unpack it to `/opt/magpie`, run the install script, and
materialize dependencies:

```bash
curl -LO https://github.com/andrew-craig/magpie/releases/download/v<version>/magpie-<version>.tar.gz
curl -LO https://github.com/andrew-craig/magpie/releases/download/v<version>/magpie-<version>.tar.gz.sha256
sha256sum -c magpie-<version>.tar.gz.sha256

sudo mkdir -p /opt/magpie
sudo tar xzf magpie-<version>.tar.gz --strip-components=1 -C /opt/magpie
cd /opt/magpie
sudo ./scripts/install.sh
npm ci --omit=dev
```

`install.sh` creates the `magpie` / `magpie-gateway` system users, the
`/etc/magpie` and `/etc/magpie-gateway` config/secret directories, seeds
empty secret env-file templates and `config.toml`, and installs the two
systemd units. It does not start anything yet. Full detail, including the
`/opt/magpie` prefix requirement and how to relocate it: **[`INSTALL.md`](INSTALL.md)**.

## 4. Pull the reviewer image

The reviewer is a published, multi-arch, signed GHCR image — the only thing
in the product you don't build yourself:

```bash
docker pull ghcr.io/andrew-craig/magpie/reviewer:0.2.0@sha256:e6a6e118ce46392dffaf172afa35af2ff6c8ff375d37dd403e9d6ac77c1f3aed
```

Optionally verify it was signed by this repo's release workflow before
trusting it:

```bash
cosign verify \
  --certificate-identity-regexp '^https://github.com/andrew-craig/magpie' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/andrew-craig/magpie/reviewer@sha256:e6a6e118ce46392dffaf172afa35af2ff6c8ff375d37dd403e9d6ac77c1f3aed
```

`config.example.toml`'s `[container].image` is already pinned to this exact
digest, so if you installed from the release tarball there's nothing further
to configure here — this step just gets the image onto the host in advance
of the first review job. Details, re-pinning, and local-build instructions:
**[`docker/reviewer/README.md`](docker/reviewer/README.md)**.

## 5. Generate secrets & fill config

Magpie deliberately keeps secrets split across files rather than one
world-of-one config: the webhook secret, the gateway's shared master key, the
real OpenRouter key, and the GitHub App's private key must **not** all be
co-readable by the same compromise. Fewer files than four processes, not
"all secrets in one file."

Generate the one secret that's shared between the two services — the gateway
master key — once, and use the identical value in both env files:

```bash
openssl rand -hex 32
```

```bash
sudoedit /etc/magpie-gateway/gateway.env
#   MAGPIE_GATEWAY_OPENROUTER_KEY=<your real OpenRouter key>   # gateway ONLY — never the orchestrator
#   MAGPIE_GATEWAY_MASTER_KEY=<the openssl rand value above>

sudoedit /etc/magpie/magpie.env
#   MAGPIE_WEBHOOK_SECRET=<pick a value; you'll paste the same one into the GitHub App in step 6>
#   MAGPIE_GATEWAY_MASTER_KEY=<the SAME openssl rand value as above>
```

The real OpenRouter key lives **only** in `gateway.env` / the gateway
process's environment — the orchestrator never holds it, only a short-lived,
budget-capped virtual key minted per job. Full rationale and the exact keys
each file needs: **[`INSTALL.md`](INSTALL.md) §6**.

Then edit the non-secret orchestrator config, seeded from
`config.example.toml` to `/etc/magpie/config.toml`:

```bash
sudoedit /etc/magpie/config.toml
```

Set `repo_allowlist`, `[github].app_id`, and `[llm].model` — you'll get the
App ID in the next step. Leave `[container].image` and `[gateway]` at their
defaults unless you have a reason to change them.

## 6. Register the GitHub App

This is the one step no other doc walks through end to end. A GitHub App (org
or personal account both work):

1. Go to **Settings → Developer settings → GitHub Apps → New GitHub App**
   (org: your org's Settings; personal: your user Settings).
2. Under **Repository permissions**, grant exactly two, nothing else:
   - **Contents: Read-only**
   - **Pull requests: Read and write**
3. Under **Subscribe to events**, check **Pull request**.
4. Under **Webhook**, set:
   - **Webhook URL**: `https://<your-ingress-host>/webhook` (see step 7 if
     you haven't set up ingress yet — you can come back and fill this in
     after).
   - **Webhook secret**: the same value you set as `MAGPIE_WEBHOOK_SECRET` in
     `/etc/magpie/magpie.env` in step 5.
5. Under **Where can this GitHub App be installed?**, "Only on this account"
   is fine for a single org/personal setup.
6. Click **Create GitHub App**.
7. On the app's settings page, note the **App ID** (top of the page) and set
   it as `[github].app_id` in `/etc/magpie/config.toml`.
8. Scroll to **Private keys** and click **Generate a private key** — this
   downloads a `.pem` file. Install it where `config.toml`'s
   `private_key_path` points (default
   `/etc/magpie/github-app.private-key.pem`), owned by `magpie` only:

   ```bash
   sudo install -o magpie -g magpie -m 0600 ~/Downloads/*.pem /etc/magpie/github-app.private-key.pem
   ```

9. Click **Install App** (left sidebar) and install it on the repo(s) you
   listed in `config.toml`'s `repo_allowlist` — Magpie only reviews repos
   both the App is installed on *and* the allowlist names.

## 7. Point the webhook at your ingress

Magpie only needs some public HTTPS URL forwarding to the orchestrator's
loopback webhook endpoint (`127.0.0.1:8787/webhook` by default). Three
supported ways to get one — reverse proxy with your own TLS, Cloudflare
Tunnel, or another outbound tunnel (Tailscale Funnel, ngrok) — are documented
in **[`docs/ingress.md`](docs/ingress.md)**; pick whichever matches what you
already operate. Whichever you choose, the URL to put in the GitHub App's
webhook field (step 6) is `https://<that-host>/webhook`. If you registered
the App before setting up ingress, go back and edit the App's Webhook URL now
— nothing else about the App needs to change.

## 8. Start & verify

```bash
sudo systemctl enable --now magpie-gateway.service magpie.service
sudo systemctl status magpie-gateway magpie
```

The units already encode boot ordering (gateway before orchestrator, since it
mints per-job keys), so enabling both together is safe.

Then, on the GitHub App's settings page, go to **Advanced → Recent
Deliveries**, pick a delivery (or trigger one — opening/updating a PR sends
one), and click **Redeliver**. Expect an **HTTP 200** response. Full
start/verify detail: **[`INSTALL.md`](INSTALL.md) §7**.

## 9. Open a PR

Open a (non-draft) pull request — or push a new commit to one, or mark a
draft ready for review — on a repo in your `repo_allowlist`. Within a few
minutes Magpie clones the PR head, runs the review, and posts a single
`COMMENT`-type review summarizing what it found. It never approves or
requests changes; that's still on you.
