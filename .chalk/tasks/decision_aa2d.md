---
id: decision_aa2d
title: GO-1: decision — Go migration scope beyond the vsock client, and the strangler/test strategy
type: decision
status: open
priority: 1
labels: [go,decision]
blocked_by: []
parent: epic_6955
remote_task_url: null
created_at: 2026-07-19T22:54:20Z
updated_at: 2026-07-19T22:54:20Z
---
Ratify (with CTO visibility, since they asked) the answer to: "As we need Go for the vsock
client, what other code should be migrated to Go? How do we manage the migration and leverage
the tests we have?"

Proposed answer to ratify:

**Scope — Go where Node is the wrong tool, at process boundaries only:**
1. Guest-side vsock client (mandated by the CTO — static Go binary in the signed reviewer image).
2. Install-time KVM/tier preflight probe (open /dev/kvm + KVM_CREATE_VM ioctl; raw ioctls need a
   native addon in Node, and the installer preflight must run before Node is provisioned).
3. Host-side vsock↔gateway forwarder — conditional: only if the vsock spike (M8-A3) shows the
   VMM's host side is not a plain unix socket Node can serve; otherwise it stays TypeScript
   inside the orchestrator.
4. Candidate, not this round: the reviewer entrypoint's fail-closed confinement assertions as a
   static binary (today shell) — more robust in a minimal guest.

**Non-scope — stays TypeScript:** orchestrator business logic (webhook/HMAC, queue, GitHub App
auth, workspace/diff, findings/anchoring, publisher/rereview) and the gateway. Mature, tested,
Octokit-dependent; a rewrite is regression risk with no isolation gain — these are trusted
host-side processes in every design. Gateway-in-Go is the only plausible future candidate
(static-binary deployment win); explicitly deferred as its own future decision.

**Migration management — strangler at process boundaries:** every Go component is a separate
binary with a narrow contract (argv/env/exit codes, sockets, NDJSON) — no in-process rewrites,
no FFI. The existing TS integration/e2e tests exercise the pipeline THROUGH those boundaries, so
they serve unchanged as the cross-language contract harness; a Node→Go swap must keep them
green. Go unit tests cover Go-internal logic only; golden fixtures (e.g. the M8-B1 flag test)
pin cross-language behavior.

- [ ] Circulate this scope (incl. to the CTO, answering their question) and record the outcome.
- [ ] Land a short docs/design/go-adoption.md capturing scope, non-scope, and the boundary rule.

Done when: scope is ratified and documented; downstream Go tasks proceed against it.
