# Magpie — Project History

Magpie was built as a sequence of milestones, from a host-subprocess walking skeleton to a
self-hostable product with a ranked, auditable isolation-tier ladder. This document preserves
that build history and the significant course corrections along the way. It is a historical
record, not a description of current behavior — see [ARCHITECTURE.md](ARCHITECTURE.md) for how
the system actually works today, and [README.md](README.md) for how to run it.

## Milestones

1. **Walking skeleton.** Webhook server with a `smee.io` relay for local dev, GitHub App auth,
   clone on PR open, Pi run directly on the host against a diff, a single summary comment
   posted back. Proved the end-to-end loop on a test repo.
2. **Structured findings + inline comments.** A Pi extension (`report_findings`) for
   structured output, diff-hunk anchoring, a single review with inline comments, and an
   out-of-diff fallback to the summary.
3. **Containerize.** Reviewer image, hardened `docker run`, read-only workspace handoff,
   credential stripping, findings read back via a mounted output directory.
4. **Network lockdown + credential-injecting gateway.** A host-side gateway process holding
   the real provider key, reached over a dedicated bridge network that only it could answer
   on; per-job budget-capped virtual keys minted/revoked around each run.
5. **Production hardening.** Cloudflare Tunnel ingress, systemd units, timeouts/concurrency/
   diff-size caps, incremental re-review with comment minimization, cost logging,
   `synchronize` dedup.
6. **Nice-to-haves.** `@magpie review` PR-comment command for on-demand re-review and
   per-repo `.magpie.toml` config (read from the base branch only, to keep config out of
   attacker control) both shipped. Multi-provider support beyond OpenRouter did not — it's a
   standalone backlog task, no longer tied to a milestone (see `chalk ready`).
7. **Distribution / self-hosting.** Made Magpie installable by an organisation other than the
   original deployment. The core change was "Design D": the reviewer container runs
   `--network none` and reaches the host gateway over a bind-mounted per-job unix socket via a
   tiny in-container TCP→unix forwarder — provable, daemon-config-independent egress isolation
   that deleted the host-`iptables`/pinned-subnet apparatus from milestone 4 entirely. Around
   that: the reviewer image published to GHCR (multi-arch, digest-pinned, signed, release CI),
   a versioned host-service release tarball, portable config (no pinned IPs), pluggable
   ingress, and `QUICKSTART.md` onboarding. See [DISTRIBUTION.md](DISTRIBUTION.md) for the
   full design and the alternatives it rejected.
8. **Isolation-tier ladder.** Replaced the single hardened-container assumption with a ranked,
   auditable ladder resolved at startup by probing the host, never silently degraded without an
   explicit operator acknowledgement. The ladder was originally scoped as three tiers —
   micro-VM (KVM) > gVisor > hardened crun — with gVisor as a coverage/density tier for
   no-KVM or high-density hosts. gVisor was never implemented: on 2026-08-05 it was
   permanently descoped before shipping (its arm64 build doesn't support the 16 KB page size
   this project's Raspberry Pi host runs), and the ladder collapsed to the two tiers it has
   today — micro-VM > hardened crun. This milestone also moved the reviewer-launching
   substrate to rootless Podman (no root daemon).

## Notable deviations from the original plan

- **Gateway implementation (milestone 4).** The plan originally specified LiteLLM as the
  gateway. The team decided against it and against running Postgres or any database for it:
  LiteLLM's virtual-key/budget features assume a DB-backed deployment for anything beyond the
  simplest setups, which is more operational surface than a single-provider, single-host
  deployment needs. Magpie instead implements a small, purpose-built TypeScript proxy
  (`packages/gateway`) that speaks only to OpenRouter and keeps virtual keys in an in-memory
  map — losing all keys on a gateway restart is an accepted property, not a gap, since keys are
  minted per-job immediately before a review and revoked on cleanup.
- **gVisor (milestone 8).** Scoped as the ladder's middle tier, then permanently descoped
  before implementation — see milestone 8 above.
