# magpie

Self-hosted GitHub code-review bot. See [PLAN.md](PLAN.md) for the full design and
[CLAUDE.md](CLAUDE.md) for project/task-tracking conventions.

## Prerequisites

- **Node.js 22+** and npm (workspaces are used, so a recent npm is required)
- **Docker** — the review agent runs in a container; the user running the orchestrator
  needs permission to use the Docker daemon (e.g. membership in the `docker` group) since
  later milestones assume rootless/no-`sudo` `docker run`
- **git**

## Setup

```bash
npm install
npm run build
```

### Configuration

Non-secret settings live in `config.toml` at the repo root — copy
`config.example.toml` to `config.toml` and fill it in (it is git-ignored).

Secrets are kept **out** of `config.toml` and read from the environment. Copy
`.env.example` to `.env` (also git-ignored) and set:

- `MAGPIE_WEBHOOK_SECRET` — the GitHub App webhook secret
- `MAGPIE_GATEWAY_MASTER_KEY` — bearer token authenticating this orchestrator to the
  LLM gateway's (`packages/gateway`) management plane when minting/revoking each job's
  short-lived virtual key. As of M4-C there is no separate LLM provider API key here —
  the real key lives only in the gateway process's own environment; see
  `packages/gateway/README.md`.

The GitHub App private key stays a `.pem` file on disk; point
`github.private_key_path` in `config.toml` at it (don't put it in `.env`).

The `dev` and `start` scripts load `.env` automatically via Node's built-in
`--env-file-if-exists`, so no dotenv dependency is required and the file is
optional — in production, supply these vars via a systemd `EnvironmentFile=`
instead.

## Running

```bash
npm run dev     # run the orchestrator directly from TypeScript source (tsx)
npm run start   # run the compiled output (after `npm run build`)
```

Both scripts now boot the full Milestone 1 pipeline
(`packages/orchestrator/src/index.ts`): a webhook server (`server.ts`) verifies and
forwards `pull_request` deliveries through the repo-allowlist/event filter (`filter.ts`)
into an in-process job queue (`queue.ts`), which runs each accepted PR through the review
pipeline (`pipeline.ts`) — mint a GitHub App installation token, clone the PR head
credential-free (`workspace.ts`), fetch the diff (`diff.ts`), run the Pi reviewer on the
host (`reviewer.ts`), and publish exactly one summary comment back to the PR
(`publisher.ts`). The process shuts down gracefully on `SIGINT`/`SIGTERM`. The container
sandbox, `report_findings` inline comments, and the credential-injecting LLM gateway
described in PLAN.md §5 (now `packages/gateway` — see its README) are later milestones.

### Reproducing an end-to-end review

1. Configure `.env` (`MAGPIE_WEBHOOK_SECRET`, `MAGPIE_GATEWAY_MASTER_KEY`) and
   `config.toml` (add the test repo to `repo_allowlist`) as described above, and start
   `packages/gateway` (see its README) with the real provider key.
2. Expose the webhook endpoint and point the GitHub App's webhook URL at it, using
   whichever ingress you run: a `cloudflared` tunnel for the real/production path
   (see [docs/cloudflared.md](docs/cloudflared.md)) or a smee.io channel for local dev
   (set `MAGPIE_SMEE_URL` in `.env`; see [docs/smee.md](docs/smee.md)).
3. Start the orchestrator with `npm run dev`. For the smee path, also run `npm run dev:smee`
   in a second shell; the `cloudflared` tunnel needs no local relay process.
4. Open a non-draft pull request on the allowlisted repo (or push a commit to an existing
   one).
5. Magpie mints an installation token, clones the PR head, runs the reviewer, and posts one
   `## 🐦 Magpie review` comment on the PR.

## Webhook ingress (production)

For exposing the orchestrator's webhook endpoint to GitHub via an
outbound-only Cloudflare Tunnel (no inbound ports), see
[docs/cloudflared.md](docs/cloudflared.md) and `scripts/setup-cloudflared.sh`.

## Webhook ingress (development)

For receiving real GitHub webhook deliveries locally during development,
without a public inbound port, see [docs/smee.md](docs/smee.md) and
`npm run dev:smee`.
