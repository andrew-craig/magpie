# Milestone 1 end-to-end smoke test

A quick manual check that the full walking skeleton is wired up and reachable:
a GitHub `pull_request` webhook should travel all the way through the ingress
to the orchestrator and come back as a single review comment on the PR.

1. Confirm the webhook ingress is up (production uses a `cloudflared` tunnel —
   see [cloudflared.md](cloudflared.md)) and that the orchestrator is running
   and listening on `127.0.0.1:8787`.
2. Confirm the GitHub App's webhook URL points at `https://<hostname>/webhook`
   and that its secret matches `MAGPIE_WEBHOOK_SECRET`.
3. Open a non-draft pull request on an allowlisted repo.
4. Expect exactly one `## 🐦 Magpie review` comment to appear on the PR, and
   the per-job workspace to be cleaned up afterwards.

If no comment appears, trace the delivery in GitHub App settings → Advanced →
Recent Deliveries (a non-200 there points at ingress or HMAC), then the
orchestrator logs (mint-token → clone → diff → review → publish).

See also the README "Reproducing an end-to-end review" runbook.
