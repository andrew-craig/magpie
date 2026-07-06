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

## Running

```bash
npm run dev     # run the orchestrator directly from TypeScript source (tsx)
npm run start   # run the compiled output (after `npm run build`)
```

Currently this only starts the placeholder orchestrator entrypoint
(`packages/orchestrator/src/index.ts`) — the webhook server, job queue, and reviewer
container described in PLAN.md are not implemented yet (see the chalk tasks under
`epic_04f9`).
