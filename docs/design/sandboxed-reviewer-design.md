# Design: Sandboxed Execution for the PR Reviewer

**Status:** Draft
**Author:** Andrew
**Date:** July 2026

## Summary

The PR review bot executes untrusted code from arbitrary repositories. This doc describes how the orchestrator runs each review job in an isolated, ephemeral sandbox without requiring root or a Docker daemon, while still allowing the reviewer to call the project's LLM gateway.

Core decisions:

1. **Rootless Podman** (daemonless, fork-exec) launched directly by the orchestrator as an unprivileged user.
2. **gVisor (`runsc`)** as the container runtime where it works; fall back to `crun` with hardened flags.
3. **No network in the sandbox.** LLM access goes through a Unix-socket proxy owned by the orchestrator, which injects credentials.
4. **Ephemeral by construction:** read-only rootfs, tmpfs writes, `--rm`, per-job directories deleted after the run.

## Goals

- Untrusted repo code cannot read orchestrator state, credentials, or other jobs.
- No root privileges and no Docker socket anywhere in the system.
- The reviewer can call the LLM gateway; it cannot reach anything else.
- A job leaves no residual state or processes after completion or timeout.

## Non-goals

- Defending against kernel 0-days when running under the `crun` fallback (accepted residual risk; mitigated by gVisor where available and by the dedicated-user blast radius).
- Multi-node scheduling. This is a single-host design; scale out by running more hosts.

## Architecture

```
host (unprivileged user: reviewer-svc)
├── orchestrator (Go, long-lived)
│   ├── job manager: creates /jobs/<id>/, launches podman, enforces deadline
│   └── LLM proxy: per-job Unix socket → gateway (injects auth)
└── per job (ephemeral)
    └── podman run (rootless, runtime=runsc or crun)
        └── reviewer container
            ├── /input   (repo code, read-only bind mount)
            ├── /output  (writable bind mount, results)
            └── /run/llm.sock (bind-mounted proxy socket)
```

### Job lifecycle

1. Orchestrator creates `/jobs/<id>/{input,output}`, checks out the PR into `input/`, and starts a proxy listener on `/jobs/<id>/llm.sock`.
2. Launch:

   ```bash
   podman run --rm \
     --runtime=runsc \
     --network=none \
     --cap-drop=all --security-opt=no-new-privileges \
     --read-only --tmpfs /tmp \
     --memory=512m --pids-limit=256 \
     --timeout=<job-timeout-s> \
     -v /jobs/$ID/input:/input:ro \
     -v /jobs/$ID/output:/output \
     -v /jobs/$ID/llm.sock:/run/llm.sock \
     reviewer-image /run-review.sh
   ```

   Invoked from Go via `exec.CommandContext` with a context deadline as a second layer over `--timeout`.
3. On exit (or kill), orchestrator reads `/output`, closes the proxy socket, and removes `/jobs/<id>`. The container's PID namespace guarantees no orphan processes.

### LLM access

- The sandbox has **no network namespace interfaces** (`--network=none`).
- The reviewer speaks plain HTTP over the bind-mounted Unix socket (base-URL / custom dialer change in the client).
- The orchestrator's proxy (a small `httputil.ReverseProxy`):
  - injects the gateway auth header; strips any client-supplied auth headers
  - allowlists only the completions path prefix
  - caps request size and rate per job; logs with job ID
  - uses a per-job scoped token / spend cap if the gateway supports it
- Result: credentials never enter the sandbox, and egress is structurally limited to the gateway.

Dependencies the reviewer needs (linters, toolchains) are baked into `reviewer-image`; repo dependencies are vendored/staged into `/input` by the orchestrator before launch, not fetched at runtime.

## Host requirements

- podman, crun, runsc, slirp4netns/pasta installed
- `reviewer-svc` user with `/etc/subuid` + `/etc/subgid` ranges and `loginctl enable-linger` (runs as a systemd user service)
- Unprivileged user namespaces enabled in the kernel
- Nothing else in `reviewer-svc`'s home; no membership in docker or sudo groups

## Security notes

- **Runtime choice:** runsc under rootless Podman provides a userspace kernel between untrusted code and the host. If it proves incompatible with the workload, the crun fallback relies on user namespaces + seccomp + dropped caps; a kernel escape then lands in the throwaway `reviewer-svc` account.
- **Output is untrusted.** Repo content can prompt-inject the LLM, so review output is rendered as data only. The orchestrator never executes instructions found in reviewer output or grants follow-up permissions based on it.
- **Proxy is attack surface.** Hostile code talks to it directly; it is minimal, has no filesystem access beyond the socket, and enforces the limits above.

## Open questions

- Does the gateway support per-job scoped tokens? If not, add spend accounting in the proxy.
- Confirm runsc rootless compatibility with the actual reviewer toolchain (known rough edges around networking are moot given `--network=none`, but filesystem-heavy workloads should be benchmarked).
- Concurrency limit per host (memory-bound; start with N = host_mem / 1GB and tune).
