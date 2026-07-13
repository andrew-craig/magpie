---
id: task_00d0
title: M7-2: Publish magpie-reviewer image to GHCR — multi-arch, digest-pinned, signed + release CI
type: task
status: open
priority: 1
labels: [distribution]
blocked_by: []
parent: epic_0162
remote_task_url: null
created_at: 2026-07-12T13:07:14Z
updated_at: 2026-07-13T13:23:18Z
---
Publish the magpie-reviewer image ONLY (under Design D it is the sole container in the product; orchestrator + gateway are host services, see M7-3). Build multi-arch (amd64+arm64), pin by digest, sign (cosign/provenance), on tagged releases via CI. Removes the adopter's build-reviewer-image.sh + Pi-version re-pin dance. Orchestrator's default container.image points at the published, digest-pinned reviewer tag. Keep the reviewer image's existing pinned-version discipline. Supply-chain note: the reviewer is the least-privileged component (no secret, no docker socket, no network), so a compromised reviewer image is far less catastrophic than a pulled orchestrator image would have been under the rejected compose model — still sign + digest-pin. Blocked by M7-0/M7-1 (the image must ship the in-container forwarder + updated entrypoint).
