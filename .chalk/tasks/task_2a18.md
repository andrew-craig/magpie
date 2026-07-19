---
id: task_2a18
title: GO-2: Go build + signing pipeline — module layout, static cross-arch builds, cosign coverage in release CI
type: task
status: open
priority: 1
labels: [go,supply-chain,ci]
blocked_by: [decision_aa2d]
parent: epic_6955
remote_task_url: null
created_at: 2026-07-19T22:54:29Z
updated_at: 2026-07-19T22:54:29Z
---
CTO edit 4 names the supply chain explicitly: the vsock client is a new compiled binary inside
the signed reviewer image — new supply-chain surface — so it must be built in OUR CI and covered
by the same cosign signing as the image.

Plan:
- [ ] Single Go module (go/ at repo root alongside the npm workspaces), one go.mod, shared
      internal packages (vsock framing, confinement assertions) across binaries.
- [ ] Reproducible static builds: CGO_ENABLED=0, -trimpath, pinned toolchain via go.mod
      toolchain directive; linux/amd64 + linux/arm64.
- [ ] Release CI builds the binaries, embeds them in the reviewer image build (so the image
      digest pin + cosign signature covers them), and additionally cosign-signs any binary
      shipped outside the image (e.g. the installer preflight probe in the host tarball —
      extend scripts/pack-host.sh + release workflow).
- [ ] No pre-built third-party binaries fetched at image build time; everything compiled from
      pinned sources in CI.
- [ ] go vet + staticcheck + gofmt gate in CI next to the existing TS lint/test jobs.

Done when: CI produces signed, reproducible Go binaries for both arches and the reviewer image
build consumes them; documented in the release process.
