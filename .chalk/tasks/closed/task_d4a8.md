---
id: task_d4a8
title: smee.io dev relay setup
type: task
status: closed
priority: 2
labels: []
blocked_by: []
parent: epic_04f9
remote_task_url: null
created_at: 2026-07-05T22:57:14Z
updated_at: 2026-07-07T12:48:37Z
---
Let GitHub webhooks reach the local webhook server during development without a public inbound port or the Cloudflare Tunnel (which lands in a later milestone).

Context: smee.io gives a public channel URL that forwards deliveries to a localhost endpoint via an outbound client. Set the GitHub App webhook URL to the smee channel in dev; smee-client forwards to http://localhost:<port>/webhook.

Scope:
- Add smee-client (dev dependency) and a script (e.g. npm run dev:smee) that forwards a configurable smee channel URL to the local /webhook path/port.
- Document the dev setup: create a smee channel, set it as the App webhook URL, run the relay alongside the orchestrator.
- Keep this dev-only — no smee in production paths.

Acceptance criteria:
- Running the relay + orchestrator locally, a PR event on the test repo reaches the local /webhook and passes signature verification.
- The smee channel URL is configurable (env or config), not hard-coded.

Dependencies: task_9af4 (webhook server must exist to forward to).

## Design decision (tech-lead, 2026-07-07)

Relay = a small standalone Node script driven by `smee-client`'s programmatic
API, run via `npm run dev:smee` at the repo root (sibling to `dev`/`start`).
Channel URL from env `MAGPIE_SMEE_URL` (required, not hard-coded); target
`http://localhost:<port><path>` where port defaults to 8787 (matches
`config.server.port` default) and path defaults to `/webhook` (matches the
exported `WEBHOOK_PATH`), both env-overridable. Dev-only: no smee in any
production/runtime path.

Live end-to-end verification (a real PR event reaching /webhook past signature
check) is a MANUAL operator step — it needs a real smee channel + the App
webhook URL set + a running orchestrator, which a subagent can't do offline.
The subagent verifies everything short of that (see plan).

## Plan

- [x] Add `smee-client` as a **dev** dependency (root `package.json`
      `devDependencies`); run `npm install` so the lockfile updates.
- [x] `scripts/dev-smee.mjs` (or `.ts` via tsx): read `MAGPIE_SMEE_URL`
      (exit with a clear message if unset), build the target from
      `MAGPIE_SMEE_PORT`/`MAGPIE_SMEE_PATH` (defaults 8787 / `/webhook`), start
      a `SmeeClient` forwarding to it, log the source→target it's relaying.
- [x] Root `package.json`: add `"dev:smee"` script invoking that script (match
      the existing `--env-file-if-exists` pattern so a local `.env` with
      `MAGPIE_SMEE_URL` is picked up).
- [x] Docs: `docs/smee.md` (dev webhook relay) — create a smee channel, set it
      as the App webhook URL in dev, run `npm run dev:smee` alongside
      `npm run dev`; note it's the dev-only counterpart to `docs/cloudflared.md`
      (prod ingress). Add a one-line pointer from `README.md` if it has a dev
      section.
- [x] Verify short of live: `npm install` clean; `npm run dev:smee` with no
      `MAGPIE_SMEE_URL` exits with the helpful message (not a stack trace);
      with a dummy URL it starts and logs the target without crashing;
      `npm run build` + `npm test` still green.

## Notes

`smee-client` programmatic API: `new SmeeClient({ source, target, logger })`
then `.start()`. Keep the script standalone — do NOT import the full config
loader (it throws without `MAGPIE_WEBHOOK_SECRET` etc.); this relay only needs
the URL + port + path.

## Review (2026-07-07)

Implemented on branch `smee-dev-relay`, uncommitted per instructions — left
for tech-lead review/merge.

- `smee-client@5.0.0` installed as a root devDependency only (verified not
  present in `packages/orchestrator/package.json` dependencies).
  Export shape: `export { SmeeClient as default, SmeeClient }` — both a
  default and named export of the same class, so
  `import SmeeClient from "smee-client"` works as assumed. Constructor
  `{ source, target, logger, ... }`; `start()` is `async` and returns
  `Promise<EventSource>`, rejecting if the channel can't be reached — the
  script wraps it in try/catch so a bad channel logs a clean one-line error
  instead of an uncaught stack trace.
- `scripts/dev-smee.mjs`: standalone ESM, no import of
  `packages/orchestrator/src/config.ts`. Defaults 8787 / `/webhook` match
  `config.ts` and `server.ts` (`WEBHOOK_PATH`).
- Root `package.json` script: `"dev:smee": "node --env-file-if-exists=.env scripts/dev-smee.mjs"`.
- Verified: no-`MAGPIE_SMEE_URL` run exits 1 with the actionable message (no
  stack trace); dummy-URL run (`https://smee.io/dummychannel`) logged
  `relaying https://smee.io/dummychannel -> http://localhost:8787/webhook`
  and actually connected (smee.io lazily creates channels on first
  subscribe, so even a made-up channel id "works" — no crash either way);
  `npm run dev:smee` end-to-end with a real `.env` file also picked up
  `MAGPIE_SMEE_URL` correctly via the `--env-file-if-exists` pattern.
  `npm run build` (tsc) and `npm test` (vitest, 54 tests) both green,
  unaffected since no orchestrator source was touched.
- Touched only: root `package.json`, `package-lock.json`,
  `scripts/dev-smee.mjs` (new), `docs/smee.md` (new), `README.md` (one-line
  pointer added to existing "Webhook ingress (production)" section, mirrored
  as a new "Webhook ingress (development)" section). No orchestrator source
  or config changed.
- Live end-to-end (real GitHub App + real smee channel + redelivery reaching
  `/webhook` past signature verification) is unverified — that requires a
  human operator with real credentials, per the task's own note.
