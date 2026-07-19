---
id: task_2d6c
title: M8-C1: guest-side vsock client — static Go binary in the signed reviewer image (replaces forwarder.mjs)
type: task
status: open
priority: 1
labels: [go,vsock,supply-chain]
blocked_by: [task_a163,task_2a18]
parent: epic_59b1
remote_task_url: null
created_at: 2026-07-19T22:54:48Z
updated_at: 2026-07-19T22:54:48Z
---
CTO edit 4: the guest-side vsock client is a named, owned deliverable — a static Go binary,
built in our CI (GO-2 pipeline), covered by the same cosign signing as the reviewer image. It
replaces docker/reviewer/forwarder.mjs (today's TCP→unix relay) inside the guest.

Plan:
- [ ] Go binary: listens on the guest loopback TCP port Pi already targets, relays to AF_VSOCK
      toward the host-side per-job socket. Same observable contract as forwarder.mjs (Pi config
      unchanged).
- [ ] CGO_ENABLED=0 static build for amd64+arm64 via GO-2; baked into the reviewer image build
      so the image digest pin + cosign signature covers it.
- [ ] Fail-closed behavior: refuse to start (and exit the entrypoint) if the vsock device is
      absent or the expected port doesn't connect — consistent with the entrypoint's existing
      confinement-assertion pattern.
- [ ] Unit tests in Go for framing/relay; boundary behavior covered by the GO-3 contract suite
      (existing forwarder tests run against the new binary where applicable).
- [ ] Remove forwarder.mjs from the image in the same PR (no dual path lingering).

Done when: reviewer image ships the signed Go client, an end-to-end guest→gateway LLM call works
through it, and forwarder.mjs is gone.
