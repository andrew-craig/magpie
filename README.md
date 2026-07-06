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
- `MAGPIE_LLM_API_KEY` — the LLM provider API key

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

Currently this only starts the placeholder orchestrator entrypoint
(`packages/orchestrator/src/index.ts`) — the webhook server, job queue, and reviewer
container described in PLAN.md are not implemented yet (see the chalk tasks under
`epic_04f9`).
