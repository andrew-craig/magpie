#!/usr/bin/env bash
set -euo pipefail

# magpie-reviewer entrypoint (M3-A; gateway wiring added M4-C; fail-closed
# startup confinement assertions added M4-E; Design D `--network none` +
# in-container forwarder added M7-1 -- see DISTRIBUTION.md §2).
#
# Runs Pi headless over the mounted /work worktree using the extension +
# system prompt baked into the image at /opt/magpie (see
# docker/reviewer/Dockerfile). The `pi` FLAG SET (the `exec pi ...` invocation
# below) MUST mirror packages/orchestrator/src/reviewer.ts's `pi` invocation
# EXACTLY (flag-for-flag, same order) -- if reviewer.ts's args array changes,
# update this script to match and vice versa. As of M3-A, reviewer.ts spawns:
#
#   pi -p --mode json --no-session --tools read,grep,find,ls,report_findings
#      --extension <review-extension> --no-extensions --provider openrouter
#      --model <config.llm.model> --append-system-prompt <reviewer-prompt.md>
#
# with the PR title/body/changed-files/diff prompt payload piped on stdin
# (see reviewer.ts's buildPromptPayload) -- this container must be run
# attached (`docker run -i`) so that reaches Pi.
#
# Runtime inputs (a container inherits NO ambient host env -- unlike the M1/M2
# host subprocess, which inherited process.env and had MAGPIE_* stripped from
# it -- so M3-C/M4-C pass ONLY what's needed, explicitly):
#
#   `--provider <name> --model <id>` etc. as trailing ARGV. The baked flags
#     below are the fixed part of the invocation; everything the caller varies
#     per job (currently just provider + model, both non-secret and already
#     CLI flags in reviewer.ts's host spawn) arrives as `"$@"` appended after
#     them. reviewer.ts invokes: `docker run ... IMAGE --provider openrouter
#     --model <config.llm.model>`.
#   OPENROUTER_API_KEY (env, `-e OPENROUTER_API_KEY`, name-only): provider
#     credential; pi-ai reads it directly from the environment. Required --
#     the one input that legitimately comes via env because it's a secret, so
#     we fail-fast if it's missing (`:?` below) rather than letting Pi fail
#     later with a confusing provider-auth error. As of M4-C this is ALWAYS a
#     short-lived, budget-capped GATEWAY VIRTUAL key minted per job
#     (packages/gateway, via packages/orchestrator/src/gateway.ts) -- the
#     orchestrator no longer holds a real, long-lived OpenRouter key to inject
#     at all (see config.ts: `secrets.llmApiKey` was removed). Never echoed to
#     logs/stdout/stderr here.
#   OPENAI_BASE_URL (env, `-e OPENAI_BASE_URL=<url>`, inline since it's not a
#     secret): the container-facing PROXY/data plane
#     (config.gateway.containerBaseUrl). As of M7-1 (Design D) this is ALWAYS
#     `http://127.0.0.1:4000/v1` -- an address INSIDE this container's own
#     `--network none` network namespace, served by the in-container
#     forwarder started below, which relays to the gateway's real unix socket
#     bind-mounted read-only at `/run/gw/gw.sock`. There is no bridge IP any
#     more (the pre-M7-1 magpie-net design pointed this at a fixed bridge
#     address instead; that apparatus is deleted -- see DISTRIBUTION.md §2.4).
#     Required as of M4-C -- there is no direct-to-OpenRouter fallback any
#     more. IMPORTANT: Pi 0.80.3 does NOT read this env var itself (verified
#     empirically against a stub HTTP server during M4-C: a plain
#     OPENAI_BASE_URL was silently ignored and Pi's request still went to the
#     real api.openrouter.ai). The mechanism that actually redirects Pi's
#     OpenRouter traffic is a `~/.pi/agent/models.json` provider `baseUrl`
#     override (see Pi's docs/models.md, "Overriding Built-in Providers") --
#     so THIS SCRIPT translates OPENAI_BASE_URL into that file below, before
#     exec'ing `pi`. `pi`'s own invocation is otherwise unaffected: the
#     `--provider openrouter` flag stays exactly as before, and the resolved
#     credential (OPENROUTER_API_KEY above) still flows through Pi's normal
#     OpenRouter provider -- only its baseUrl changes.
#
# NOT a runtime input: MAGPIE_FINDINGS_PATH. The output path is part of the
# image contract (always /out/findings.json, the mounted output dir) and is
# baked into the Dockerfile via `ENV MAGPIE_FINDINGS_PATH=/out/findings.json`,
# so the baked-in report_findings extension already sees it -- this script
# neither reads nor requires it.

: "${OPENROUTER_API_KEY:?OPENROUTER_API_KEY must be set (-e OPENROUTER_API_KEY=...) -- see docker/reviewer/README.md}"
: "${OPENAI_BASE_URL:?OPENAI_BASE_URL must be set (-e OPENAI_BASE_URL=<gateway proxy URL>) -- see docker/reviewer/README.md}"
# Non-secret operator config choice (see reviewer.ts's buildReviewDockerArgs
# and packages/orchestrator/src/config.ts's container.require_memory_limit),
# always set by reviewer.ts as of bug_df2d -- default to the fail-closed
# value if somehow unset (e.g. an older orchestrator, or this image run by
# hand) so an *absent* env var can never accidentally mean "run unconfined".
: "${MAGPIE_REQUIRE_MEMORY_LIMIT:=true}"

# ---------------------------------------------------------------------------
# M8-E3 (task_2541): early, cheap tier detection.
#
# MUST run before the memory-ceiling assertion just below, because that
# check's correct MEANING differs by tier (see that section's comment for
# the full story): the crun tier enforces RAM via a cgroup v2 `memory.max`
# ceiling, which is readable from inside the container; the micro-VM tier
# enforces RAM via libkrun's `--ram-mib` at the VMM level, so the guest never
# has a `/sys/fs/cgroup/memory.max` to read AT ALL -- not a misconfiguration,
# a structurally different (and equally valid) enforcement mechanism. Without
# knowing the tier first, the memory check can't tell "cgroup absent because
# this is a micro-VM guest" from "cgroup absent because a crun-tier host
# misconfigured cgroups" (the real bug_df2d scenario it exists to catch).
#
# This is the SAME `/dev/vsock` probe the relay-selection block further down
# this script uses (a plain char-device present iff the launcher attached a
# vsock device, which only happens under the micro-VM tier -- see that
# block's own doc comment for the full rationale). Factored out here, ahead
# of everything that depends on it, and REUSED (not re-probed) down there --
# a single source of truth for which tier this run is, set once, this early.
if [ -c /dev/vsock ]; then
  MAGPIE_IS_MICROVM=1
else
  MAGPIE_IS_MICROVM=0
fi

# ---------------------------------------------------------------------------
# M8-E4 (task_4c37): give the micro-VM guest a PATH -- MICRO-VM TIER ONLY.
#
# The crun tier inherits PATH for free from the image's OCI config: the
# node:22.23.1-slim base sets it, `docker/reviewer/Dockerfile` symlinks
# `/opt/magpie/review-extension/node_modules/.bin/pi` onto `/usr/local/bin/pi`,
# and `podman run` exports the resulting PATH into the container. A micro-VM
# guest gets NONE of that: the launcher boots a BARE EXPORTED ROOTFS, which
# carries no OCI config at all, and rust/magpie-microvm-launcher's `cli.rs`
# builds the guest environment from an initially-EMPTY vec populated only by
# explicit `--env` flags (the `PATH=` strings visible in that crate's cli.rs/
# config.rs are TEST FIXTURES, not runtime defaults). So the guest has
# historically booted with PATH genuinely unset.
#
# WHY THAT STAYED HIDDEN until the M8-E2/E3 fixes cleared the earlier
# blockers, and WHY `export` (not a value default) is the operative fix --
# this is subtle, and getting it wrong yields a no-op:
#
#   When PATH is absent from its environment, `bash` does NOT run without one.
#   It assigns its own compiled-in default to the PATH SHELL VARIABLE at
#   startup (empirically, on this image's bash:
#   `/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin:.`). That is
#   why every bare command this script runs (mount, chown, setpriv, timeout,
#   seq, awk ...) resolved fine all along. But that variable is NOT MARKED FOR
#   EXPORT, so it is still absent from the environment handed to child
#   processes. `setpriv`, at the very bottom of this script, `execvp`s `pi`
#   ITSELF -- and glibc's execvp with no PATH in the environment falls back to
#   confstr(_CS_PATH) == "/bin:/usr/bin", which does NOT include
#   /usr/local/bin, so `pi` was not found:
#
#     setpriv: failed to execute pi: No such file or directory
#
#   Consequently a `PATH="${PATH:-...}"` style default would be DEAD CODE
#   here (bash already made PATH non-empty); it is the `export` that actually
#   fixes anything. `docker/reviewer/entrypoint-tier-memory.test.sh`'s
#   task_4c37 cases pin exactly this, running the script with PATH genuinely
#   absent from the environment.
#
# Set UNCONDITIONALLY (within the micro-VM branch) to an explicit literal
# rather than re-exporting whatever bash happened to invent: bash's built-in
# default is an implementation detail that varies by build and is not
# something a fail-closed security script should depend on for finding the
# binary it is about to hand control to. /usr/local/bin is listed first --
# that is where the Dockerfile symlinks `pi`. Placed right after tier
# detection, ahead of everything that could need it, so any later addition to
# this script inherits a sane PATH too. Guarded on MAGPIE_IS_MICROVM so the
# crun tier's environment -- which already gets a correct, exported PATH from
# the image's OCI config -- is untouched, byte for byte.
if [ "${MAGPIE_IS_MICROVM}" = "1" ]; then
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
fi

# ---------------------------------------------------------------------------
# bug_df2d: fail-closed in-container memory-ceiling assertion. reviewer.ts
# passes `--memory=<config.container.memory>` on every `docker/podman run` of
# this image -- the hard cap bounding how much host RAM a single, possibly
# prompt-injected review job can consume. That flag only does anything if the
# kernel's cgroup v2 `memory` controller was actually available and delegated
# when the container was created; some hosts don't have it (e.g. Raspberry Pi
# firmware defaults boot with `cgroup_disable=memory`), in which case Docker
# silently ACCEPTS the flag and discards it (a stderr warning on the HOST,
# invisible from in here) instead of erroring. packages/orchestrator/src/
# cgroup-preflight.ts already checks this on the HOST at orchestrator
# startup, before any container is even launched -- this is the
# defence-in-depth backstop that checks the ACTUAL enforced state from
# INSIDE the container that matters, per job, in case that startup check was
# ever wrong (or the controller was revoked/un-delegated after startup).
#
# Cgroup v2's per-cgroup memory ceiling is exposed at /sys/fs/cgroup/memory.max
# inside the container's own cgroup namespace (visible regardless of the
# --read-only root filesystem, since /sys/fs/cgroup is never part of it). Its
# value is either a finite byte count (the limit is enforced) or the literal
# string "max" (no limit -- i.e. NOT enforced, whether because --memory was
# never passed or because the host silently discarded it). A cgroup v1 host
# (or any host where this file doesn't exist at all) can't be verified this
# way either, so it is conservatively treated the exact same way: unverifiable
# is not enforced. NOTE: Magpie requires the cgroup v2 unified hierarchy (its
# default rootless-Podman runtime does too) -- on a legacy cgroup v1 host the
# per-container ceiling lives elsewhere (memory.limit_in_bytes) and is NOT read
# here, so v1 is intentionally reported as unverifiable; see INSTALL.md.
#
# CGROUPNS ASSUMPTION: this reads the container's OWN cgroup's memory.max, which
# is only what /sys/fs/cgroup/memory.max resolves to under a PRIVATE cgroup
# namespace -- the cgroup v2 default for both docker and podman, and what Magpie
# uses (it never passes --cgroupns=host). Under --cgroupns=host this would read
# the host ROOT cgroup's memory.max ("max") and false-positive; don't add that
# flag without revisiting this check.
#
# M8-E3 (task_2541): this whole cgroup-based check is CRUN-TIER ONLY --
# MAGPIE_IS_MICROVM was decided above, before this block, precisely so this
# branch can be taken. The micro-VM tier's equivalent verification (a
# positive check that libkrun's --ram-mib ceiling actually applied, since
# there is no cgroup to read at all in that guest) lives in the `else`
# branch below -- see its own comment for the full rationale and the chosen
# tolerance.
if [ "${MAGPIE_IS_MICROVM}" = "1" ]; then
  # ---------------------------------------------------------------------------
  # M8-E3 (task_2541): micro-VM tier memory-ceiling verification.
  #
  # RAM here is enforced by libkrun's `--ram-mib` at the VMM level
  # (rust/magpie-microvm-launcher's krun_set_vm_config) -- the guest kernel
  # boots knowing only about that much memory in the first place, so there is
  # no cgroup memory.max to read inside the guest at all (a structural fact
  # about this tier, not a misconfiguration -- see task_2541's background:
  # this is exactly what made the crun-tier check above false-fail here,
  # forcing operators to globally set require_memory_limit=false and thereby
  # ALSO weaken the crun tier's real protection, which is the bug this task
  # fixes).
  #
  # So instead of skipping verification, this proves SOME ceiling was really
  # applied: reviewer.ts injects the exact ram-mib value the launcher was
  # told to boot this guest with as a non-secret inline env var,
  # MAGPIE_MICROVM_RAM_MIB (see buildMicrovmLaunchArgs's `env` map / the
  # runReview call site) -- this script cross-checks the guest's OWN view of
  # its memory (/proc/meminfo's MemTotal) against that expected value.
  #
  # TOLERANCE: a guest's MemTotal is always somewhat LESS than the configured
  # ram-mib (firmware/kernel-reserved regions -- a few MiB, never more). The
  # failure mode this check defends against is the OPPOSITE direction:
  # MemTotal being far LARGER than configured, which would mean the ram-mib
  # ceiling silently didn't apply (e.g. a launcher regression that dropped
  # --ram-mib) and the guest actually sees ~all host RAM. So a 5% headroom
  # above the configured ram-mib (rounding/reporting slop only -- MemTotal is
  # never expected to exceed ram-mib by more than that) is accepted; anything
  # above that is treated as an unenforced ceiling and aborts. Fail closed if
  # MAGPIE_MICROVM_RAM_MIB is unset/non-numeric/non-positive, or if
  # /proc/meminfo's MemTotal can't be read/parsed -- exactly the same
  # "unverifiable is not enforced" posture as the crun-tier check above.
  case "${MAGPIE_MICROVM_RAM_MIB:-}" in
    ''|*[!0-9]*)
      echo "magpie-reviewer: refusing to run: MAGPIE_MICROVM_RAM_MIB is unset or non-numeric (${MAGPIE_MICROVM_RAM_MIB:-unset}) -- cannot verify the micro-VM's memory ceiling was actually enforced. Aborting before Pi starts." >&2
      exit 1
      ;;
  esac
  if [ "${MAGPIE_MICROVM_RAM_MIB}" -le 0 ]; then
    echo "magpie-reviewer: refusing to run: MAGPIE_MICROVM_RAM_MIB (${MAGPIE_MICROVM_RAM_MIB}) is not a positive value -- cannot verify the micro-VM's memory ceiling was actually enforced. Aborting before Pi starts." >&2
    exit 1
  fi

  magpie_mem_total_kib=""
  if [ -r /proc/meminfo ]; then
    magpie_mem_total_kib="$(awk '/^MemTotal:/ { print $2 }' /proc/meminfo)"
  fi
  case "${magpie_mem_total_kib:-}" in
    ''|*[!0-9]*)
      echo "magpie-reviewer: refusing to run: /proc/meminfo's MemTotal is missing or unparsable (${magpie_mem_total_kib:-absent}) -- cannot verify the micro-VM's memory ceiling was actually enforced. Aborting before Pi starts." >&2
      exit 1
      ;;
  esac

  # Compare in KiB throughout (MemTotal's own unit) to avoid fractional-MiB
  # arithmetic in POSIX integer shell math: ram_mib MiB * 1.05 headroom,
  # expressed directly in KiB as ram_mib * 1024 * 105 / 100.
  magpie_mem_ceiling_kib=$(( MAGPIE_MICROVM_RAM_MIB * 1024 * 105 / 100 ))
  if [ "${magpie_mem_total_kib}" -gt "${magpie_mem_ceiling_kib}" ]; then
    echo "magpie-reviewer: refusing to run: guest MemTotal (${magpie_mem_total_kib} KiB) exceeds what MAGPIE_MICROVM_RAM_MIB=${MAGPIE_MICROVM_RAM_MIB} should allow (expected at most ~${magpie_mem_ceiling_kib} KiB) -- the VMM-level memory ceiling does not appear to have been enforced. Aborting before Pi starts." >&2
    exit 1
  fi
  echo "magpie-reviewer: micro-VM memory ceiling verified -- guest MemTotal ${magpie_mem_total_kib} KiB is within the expected bound for MAGPIE_MICROVM_RAM_MIB=${MAGPIE_MICROVM_RAM_MIB}" >&2
else
  magpie_memory_max_raw=""
  if [ -r /sys/fs/cgroup/memory.max ]; then
    magpie_memory_max_raw="$(cat /sys/fs/cgroup/memory.max 2>/dev/null || true)"
  fi

  if [ -z "${magpie_memory_max_raw}" ] || [ "${magpie_memory_max_raw}" = "max" ]; then
    magpie_memory_unenforced_detail="could not verify an enforced memory ceiling: /sys/fs/cgroup/memory.max is ${magpie_memory_max_raw:-absent/unreadable} (expected a finite byte count). The --memory limit this container was launched with is either unenforced (the host silently discarded it) or unverifiable here (e.g. a legacy cgroup v1 host -- Magpie requires the cgroup v2 unified hierarchy)"
    if [ "${MAGPIE_REQUIRE_MEMORY_LIMIT}" = "false" ]; then
      echo "magpie-reviewer: WARNING: ${magpie_memory_unenforced_detail}. MAGPIE_REQUIRE_MEMORY_LIMIT=false, so continuing anyway with an UNENFORCED memory ceiling -- this review job could consume unbounded host memory." >&2
    else
      echo "magpie-reviewer: refusing to run: ${magpie_memory_unenforced_detail}. Set [container] require_memory_limit = false in the orchestrator's config.toml if you understand the risk and want to run anyway (see INSTALL.md/QUICKSTART.md for how to enable the memory controller on your host instead). Aborting before Pi starts." >&2
      exit 1
    fi
  fi
fi

# ---------------------------------------------------------------------------
# M4-E: fail-closed startup confinement assertions. PLAN.md milestone 4's
# explicit acceptance check requires this script to verify its OWN
# confinement before `exec pi` below, and abort non-zero (surfaced by
# reviewer.ts/pipeline.ts as a review-failure comment, never a silent hang)
# if either invariant is violated. Both checks are cheap and bounded so a
# healthy run pays only a few seconds of extra startup latency.
#
# RECONCILING the two checks against how the M4-E task was originally
# written (see chalk task_1ffd's description) vs. what M4-C actually built:
#
#   1. "no long-lived provider key in the container env" -- the task text
#      says to fail if OPENROUTER_API_KEY (or any real-key variable) is
#      PRESENT. That predates M4-C: as of M4-C this container legitimately
#      ALWAYS holds OPENROUTER_API_KEY, because it's how Pi's OpenRouter
#      provider resolves its credential (see the doc comment above) -- the
#      var can no longer be "absent" as the bar for safety, the `:?` above
#      already requires it to be set. What actually changed under M4 is
#      *what kind of value* is allowed to be in it: a short-lived,
#      budget-capped GATEWAY VIRTUAL key (packages/gateway/src/keystore.ts's
#      `KeyStore.mint`), never a real, long-lived OpenRouter key. Virtual
#      keys are minted with a fixed, unambiguous prefix (`KEY_PREFIX =
#      "sk-magpie-"` in that file); real OpenRouter keys look like
#      `sk-or-v1-...` and are never supposed to reach this container at all
#      once the gateway is wired up. So the as-built, meaningful version of
#      this check is: OPENROUTER_API_KEY must look like a magpie virtual
#      key, not merely be non-empty. Keep this prefix in sync with
#      packages/gateway/src/keystore.ts's KEY_PREFIX if that ever changes.
#   2. "no host but the gateway is reachable" is unchanged from the task
#      text (now sharpened by `--network none`, M7-1) and is implemented as
#      a set of cheap reachability probes below.
#
# M8-C4 (task_3b48) extends check 2 with an interface/route-table
# enumeration (defense-in-depth, catches a plainly wrong launch) AND an
# explicit micro-VM-tier vsock-channel/port assertion -- see "no network by
# construction" as a THREE-layer invariant: this script's checks are Layer 3
# (in-guest, fail-closed at startup); Layer 1 is
# rust/magpie-microvm-launcher/src/krun.rs's construction-time TSI-off pin;
# Layer 2 is packages/orchestrator/src/reviewer.ts's
# findMicrovmNetworkTransportViolations launch-argv preflight. No single
# layer is trusted alone -- libkrun's TSI backend can give a guest real
# egress via syscall interception with NO virtio-net device ever attached,
# which is exactly why the ACTIVE egress canary below (not just the
# interface/route check) is retained as the thing that actually proves no
# hijacked path exists.
# ---------------------------------------------------------------------------

# --- 1. Virtual-key-only assertion -----------------------------------------
#
# Deliberately does NOT print (or substring-match-log) the key value itself
# -- only ever the fact that its shape was wrong -- so a real key accidentally
# injected here never ends up echoed into container logs by the very check
# meant to catch it. Runs before the forwarder/network work below since it's
# a pure string check with no dependency on the gateway being reachable yet.
case "${OPENROUTER_API_KEY}" in
  sk-magpie-*)
    ;;
  *)
    echo "magpie-reviewer: refusing to run: OPENROUTER_API_KEY is not a magpie gateway virtual key (expected the sk-magpie- prefix minted by packages/gateway). A real/long-lived provider key must never be injected into this container -- aborting before Pi starts." >&2
    exit 1
    ;;
esac

# ---------------------------------------------------------------------------
# M7-1 / M8-C1: start the in-container relay to the gateway. Something must
# make `http://127.0.0.1:4000/v1` (where `OPENAI_BASE_URL`, and transitively
# the `~/.pi/agent/models.json` baseUrl override below, points Pi -- so Pi's
# own invocation is unaffected by any of this) real, by listening on this
# container's/guest's OWN loopback and relaying each connection out to
# wherever the gateway's per-job socket actually is. WHICH relay applies
# depends on how this image is being run, detected here rather than via a
# new env var (see docker/reviewer/Dockerfile's "Relay to the gateway"
# comment for why both binaries still ship):
#
#   - docker/crun, `--network none` (Design D -- DISTRIBUTION.md §2.2/§2.3,
#     the ONLY path live in production today -- see task_2d6c's task file
#     for the investigation confirming this): no `/dev/vsock` device, no
#     shared filesystem with the host other than the bind-mounted
#     `/run/gw/gw.sock` -- `forwarder.mjs` relays TCP -> that unix socket.
#   - libkrun micro-VM guest (M8-C0/C1/C2 -- task_76d6/task_2d6c/task_b3f7,
#     not yet wired into the orchestrator): the launcher's `krun_add_vsock`
#     call unconditionally attaches a `/dev/vsock` character device to every
#     guest it boots, which a plain container never has -- a reliable,
#     zero-config signal. `magpie-vsock-client` relays TCP -> `AF_VSOCK`
#     toward the host per-job gateway socket instead.
#
# Backgrounded, then bounded-waited-for below: nothing downstream (the
# gateway /healthz probe just below, then Pi itself) may attempt
# 127.0.0.1:4000 before the relay is actually listening. That wait loop is
# transport-agnostic (a plain TCP connect probe), so it needs no change for
# whichever relay was started. Mirrors the wait loop proven in the M7-0
# feasibility spike (spike/m7-0/spike-entrypoint.sh).
# ---------------------------------------------------------------------------

# M8-C4 (task_3b48) Layer 3, single-sourced: the fixed vsock port the guest
# dials under the micro-VM tier -- MUST match
# packages/orchestrator/src/microvm-vsock.ts's MICROVM_VSOCK_PORT and
# rust/vsock-client's own DEFAULT_VSOCK_PORT (both 1234; see that crate's
# module doc comment's "Vsock port convention"). Declared here, ahead of
# starting vsock-client, and passed to it EXPLICITLY via MAGPIE_VSOCK_PORT
# below rather than relying on its built-in default -- so the "only
# permitted egress port" this script later asserts (see the network-
# confinement block) is a value THIS script chose and named, not an
# implicit fact about a binary it doesn't control the source of.
readonly MAGPIE_EXPECTED_VSOCK_PORT=1234

# MAGPIE_IS_MICROVM was already decided (M8-E3, task_2541) via a cheap `[ -c
# /dev/vsock ]` probe near the top of this script, ahead of the memory-
# ceiling check above (which needs the tier to pick its verification
# strategy) -- REUSED here, not re-derived, and further reused below (the
# virtiofs-mount and privilege-drop steps -- M8-C3/task_39ff) so there is
# exactly one `[ -c /dev/vsock ]` probe in the whole script.
if [ "${MAGPIE_IS_MICROVM}" = "1" ]; then
  echo "magpie-reviewer: /dev/vsock present -- starting vsock-client (127.0.0.1:4000 -> AF_VSOCK host port ${MAGPIE_EXPECTED_VSOCK_PORT})" >&2
  # `export` (not a one-shot `VAR=value cmd` prefix) so MAGPIE_VSOCK_PORT is
  # BOTH inherited by the backgrounded vsock-client below AND still readable
  # by THIS script's own later re-assertion (a `VAR=value cmd &` prefix only
  # sets the variable in the child's environment, not the calling shell's --
  # the earlier version of this line got that wrong and made the later
  # re-check always see "unset").
  export MAGPIE_VSOCK_PORT="${MAGPIE_EXPECTED_VSOCK_PORT}"
  /opt/magpie/vsock-client &
  MAGPIE_FORWARDER_PID=$!
else
  echo "magpie-reviewer: starting forwarder.mjs (127.0.0.1:4000 -> /run/gw/gw.sock)" >&2
  node /opt/magpie/forwarder.mjs /run/gw/gw.sock &
  MAGPIE_FORWARDER_PID=$!
fi

# ---------------------------------------------------------------------------
# M8-C3 (task_39ff): in-guest virtiofs mounts -- MICRO-VM TIER ONLY.
#
# Under the docker/crun tier, `/work` (read-only) and `/out` (writable) are
# already present as bind mounts the runtime set up before this entrypoint
# ran -- there is nothing to do, and this whole block is SKIPPED (guarded on
# MAGPIE_IS_MICROVM), so the crun path is byte-for-byte unaffected.
#
# Under the micro-VM tier the launcher (rust/magpie-microvm-launcher) only
# ATTACHES the two virtiofs DEVICES (`krun_add_virtiofs3`, tags `work`
# read-only and `out` writable -- see reviewer.ts's buildMicrovmLaunchArgs
# --work-mount/--out-mount); mounting them inside the guest is the guest
# workload's job (that crate's own doc comments are explicit about this
# split). The guest boots as root (krun_setuid/krun_setgid confine only the
# HOST VMM process, not the guest -- see that crate's src/krun.rs), so this
# script still has the privilege to mount here, BEFORE it drops to the
# unprivileged reviewer uid for `exec pi` at the very end.
#
# Fail-closed: a mount that doesn't succeed means Pi would either see no PR
# content (/work) or be unable to hand findings back (/out), so abort loudly
# rather than run a review that can't work. The `-o ro` on /work is
# defence-in-depth over the device's own read-only attachment (the launcher
# passes read_only=true to krun_add_virtiofs3) -- the same "the PR checkout
# is never guest-writable" invariant the crun tier gets from its `:ro` bind
# mount.
#
# M8-E2 (task_76b8): this block ALSO mounts a guest-LOCAL tmpfs at /tmp,
# mirroring the crun tier's own `--tmpfs /tmp` (see reviewer.ts's
# buildReviewDockerArgs). Without this, `/tmp` here resolves to whatever the
# guest's ROOT filesystem is -- served over rootless virtiofs the same way
# `/work`/`/out` are attached as devices above -- and rootless virtiofs maps
# guest-root's uid back to the unprivileged HOST user that launched the
# micro-VM, so guest-root does not actually have chown authority over paths
# living on it. That surfaced as the privilege-drop step below (its
# `chown -R … "$HOME/.pi"`, which at the time targeted the baked-in 10001
# account) failing with EPERM on `/tmp/.pi` -- not a Magpie
# logic bug, a known category of rootless-VMM limitation. Mounting a plain
# guest-local tmpfs here makes `/tmp` a normal in-guest filesystem again,
# where chown-by-guest-root works exactly like it does under the crun
# tier's own `--tmpfs /tmp`.
#
# ORDERING: this MUST happen before anything writes under `/tmp` -- in
# particular before `$HOME/.pi/agent/models.json` is written and before the
# chown/privilege-drop below, both much further down this script -- so the
# tmpfs is empty and freshly mounted the first time either happens. It does
# NOT need to happen before /work or /out are mounted (no ordering
# dependency between the three), so it's placed last in this block purely
# for readability. Fail-closed like the two mounts above: if `/tmp` can't be
# made a normal writable filesystem here, the privilege drop (and anything
# else that writes under HOME=/tmp) would fail later anyway, so abort now
# with a clear cause rather than a confusing chown error mid-script.
# ---------------------------------------------------------------------------
if [ "${MAGPIE_IS_MICROVM}" = "1" ]; then
  echo "magpie-reviewer: micro-VM tier -- mounting /work + /out virtiofs devices" >&2
  mkdir -p /work /out
  if ! mount -t virtiofs -o ro work /work; then
    echo "magpie-reviewer: refusing to run: failed to mount the read-only /work virtiofs device (tag 'work') -- the reviewer has no PR content to review. Aborting before Pi starts." >&2
    exit 1
  fi
  if ! mount -t virtiofs out /out; then
    echo "magpie-reviewer: refusing to run: failed to mount the writable /out virtiofs device (tag 'out') -- the reviewer would have nowhere to write findings.json. Aborting before Pi starts." >&2
    exit 1
  fi
  echo "magpie-reviewer: micro-VM tier -- mounting guest-local tmpfs at /tmp (mirrors the crun tier's --tmpfs /tmp; see task_76b8)" >&2
  mkdir -p /tmp
  if ! mount -t tmpfs tmpfs /tmp; then
    echo "magpie-reviewer: refusing to run: failed to mount a guest-local tmpfs at /tmp -- HOME=/tmp below would remain on the virtiofs-backed root, where guest-root's remapped uid cannot chown the state Pi writes there before the privilege drop. Aborting before Pi starts." >&2
    exit 1
  fi
fi

readonly MAGPIE_FORWARDER_WAIT_ATTEMPTS=50
readonly MAGPIE_FORWARDER_WAIT_SLEEP=0.2

magpie_forwarder_ready=""
for _ in $(seq 1 "${MAGPIE_FORWARDER_WAIT_ATTEMPTS}"); do
  if timeout 1 bash -c 'exec 3<>/dev/tcp/127.0.0.1/4000' 2>/dev/null; then
    magpie_forwarder_ready=1
    break
  fi
  # Also bail early if the forwarder process itself has already died, rather
  # than burning the full wait budget on a listener that will never appear.
  if ! kill -0 "${MAGPIE_FORWARDER_PID}" 2>/dev/null; then
    break
  fi
  sleep "${MAGPIE_FORWARDER_WAIT_SLEEP}"
done

if [ -z "${magpie_forwarder_ready}" ]; then
  echo "magpie-reviewer: refusing to run: the in-container relay (forwarder.mjs or vsock-client) never came up on 127.0.0.1:4000 -- this container's only permitted egress path is unavailable, so no review can be attempted. Aborting before Pi starts." >&2
  kill "${MAGPIE_FORWARDER_PID}" 2>/dev/null || true
  exit 1
fi
echo "magpie-reviewer: relay is up" >&2

# --- 2. Network confinement assertion ---------------------------------------
#
# This container runs `--network none` (M7-1, Design D): it has NO network
# interfaces except its own loopback -- no veth, no bridge, no route to the
# host, to other containers, to the internet, to DNS, or to the cloud-
# metadata IP. That is a property of the network namespace itself, not of any
# iptables/nftables rule (see DISTRIBUTION.md §2.3), so unlike the deleted
# magpie-net/setup-network.sh bridge model it does not depend on the host's
# daemon.json, Docker version, or IPv6 settings. The canaries below therefore
# MUST be unreachable unconditionally; this probe is a cheap belt-and-
# suspenders assertion that catches a mis-launch (e.g. the orchestrator
# accidentally passing `--network bridge`) rather than a daemon-config drift
# there is no longer any config to drift.
#
# The gateway reachability probe, in contrast, now transits the forwarder
# started above -> the mounted `/run/gw/gw.sock` -> the real gateway process,
# so it doubles as confirmation that BOTH the forwarder came up AND the
# gateway's per-job socket is present and bound (DISTRIBUTION.md §2.6 point
# 3's "the gateway socket is present" half of the fail-closed assertion).
#
# Implementation notes:
#   - Uses bash's built-in `/dev/tcp/<host>/<port>` pseudo-device for a raw
#     TCP connect test -- no curl/wget/nc needed, so no new image
#     dependency (see docker/reviewer/Dockerfile; deliberately unchanged by
#     M4-E). `timeout` (coreutils, already in the base image) bounds each
#     probe so a filtered/blackholed connection attempt can't hang the job.
#   - `/dev/tcp` name resolution failures (expected for the DNS-based canary
#     below, since `--network none` has no resolver -- no interfaces at all,
#     let alone a DNS one) exit non-zero from the inner bash, same as a
#     refused/timed-out connection -- both count as "unreachable", which is
#     exactly the property being asserted.
#   - Every probe is read-only against the network and writes nothing to
#     disk, so it's safe under the `--read-only` root filesystem regardless
#     of HOME/tmp state at this point in the script.
readonly MAGPIE_PROBE_TIMEOUT_SECONDS=3

# Raw TCP connect test: exit 0 iff <host>:<port> accepts a connection within
# the timeout. Host/port are passed as positional args to the inner `bash -c`
# (not string-interpolated into its script) so there's no quoting/injection
# hazard even though these values are only ever internal, non-attacker-
# controlled constants/config in practice.
magpie_tcp_reachable() {
  # shellcheck disable=SC2016 # intentional: $1/$2 are the INNER bash -c's
  # own positional params (bound from the "_" "$1" "$2" args below), not the
  # outer shell's -- single quotes are required to keep them literal here.
  timeout "${MAGPIE_PROBE_TIMEOUT_SECONDS}" bash -c 'exec 3<>"/dev/tcp/$1/$2"' _ "$1" "$2" 2>/dev/null
}

# Raw HTTP/1.0 GET over the same `/dev/tcp` mechanism, used only for the
# gateway's /healthz check below (see proxy-server.ts: unauthenticated,
# always `200 "ok"` on success). Deliberately not a general HTTP client --
# just enough to read a status line back.
magpie_http_get_200() {
  local host="$1" port="$2" path="$3" response first_line
  # shellcheck disable=SC2016 # same as magpie_tcp_reachable above: $1/$2/$3
  # here belong to the inner bash -c, bound from the "_" "$host" "$port"
  # "$path" args passed to it, not this outer function's own variables.
  response=$(timeout "${MAGPIE_PROBE_TIMEOUT_SECONDS}" bash -c '
    exec 3<>"/dev/tcp/$1/$2" || exit 1
    printf "GET %s HTTP/1.0\r\nHost: %s\r\nConnection: close\r\n\r\n" "$3" "$1" >&3
    cat <&3
  ' _ "$host" "$port" "$path" 2>/dev/null) || return 1
  first_line="${response%%$'\r'*}"
  case "${first_line}" in
    "HTTP/1.1 200"* | "HTTP/1.0 200"*) return 0 ;;
    *) return 1 ;;
  esac
}

# --- 2a. Interface / route-table assertion (M8-C4, task_3b48) --------------
#
# Defense-in-depth AHEAD OF the active-egress canaries below, not a
# replacement for them. `--network none` (crun tier) and TSI-off (micro-VM
# tier -- see rust/magpie-microvm-launcher/src/krun.rs's "LAYER 1 PIN") are
# both expected to leave this process/guest with exactly one network device
# (`lo`) and an empty route table. This is a STATIC, structural property --
# checkable without attempting any connection -- so it's cheap and catches
# a plainly wrong launch (e.g. `--network bridge`, or a virtio-net device
# somehow attached) immediately.
#
# IMPORTANT -- this check is NOT sufficient on its own to catch a TSI-hijack
# mis-launch: libkrun's TSI backend gives a guest real egress via syscall
# interception, which does not fundamentally need a routable device at all.
# The ACTUAL TSI-catching mechanism is the active egress canary loop just
# below this block, which is why it is retained unchanged regardless of
# anything found here.
#
# KNOWN, EMPIRICALLY-CONFIRMED ARTIFACT of the installed libkrun (v1.19.4,
# see rust/magpie-microvm-launcher/src/krun.rs's ABI pin) on THIS host: every
# micro-VM guest -- TSI on or off -- has a `dummy0` interface in addition to
# `lo` (also documented, independently, by
# rust/magpie-microvm-launcher/smoke-test.sh's own "dummy0 is administratively
# down" assertion). task_3b48's own negative-test harness
# (spike/m8-c4/run-negative-test.sh) proved the two states are DISTINGUISHABLE
# by operstate, not by mere presence:
#   - TSI OFF  (production posture): dummy0 operstate=`down`, carrier absent,
#     NO route table entry -- confirmed inert.
#   - TSI ON   (the mis-launch this task defends against): dummy0 operstate=
#     `unknown`, carrier=1 (up), AND a real route appears in
#     /proc/net/route -- i.e. libkrun's TSI-INET hijack actually DHCP-configures
#     this interface for real, which both the operstate check below AND the
#     IPv4-route-count check further down independently catch. (A future
#     libkrun version could in principle make TSI's egress fully invisible to
#     both checks -- this is exactly why the active egress canary below is
#     never treated as optional.)
# So: tolerate `dummy0` ONLY when it is administratively `down`; any other
# non-lo interface, or a `dummy0` that is anything but `down`, aborts here.
magpie_non_lo_ifaces=""
for magpie_iface_path in /sys/class/net/*; do
  [ -e "${magpie_iface_path}" ] || continue
  magpie_iface="$(basename "${magpie_iface_path}")"
  [ "${magpie_iface}" = "lo" ] && continue
  magpie_iface_operstate="unreadable"
  if [ -r "${magpie_iface_path}/operstate" ]; then
    magpie_iface_operstate="$(cat "${magpie_iface_path}/operstate" 2>/dev/null || echo unreadable)"
  fi
  if [ "${magpie_iface}" = "dummy0" ] && [ "${magpie_iface_operstate}" = "down" ]; then
    continue
  fi
  magpie_non_lo_ifaces="${magpie_non_lo_ifaces}${magpie_iface}(${magpie_iface_operstate}) "
done
if [ -n "${magpie_non_lo_ifaces}" ]; then
  echo "magpie-reviewer: refusing to run: non-loopback network interface(s) present and not administratively down (${magpie_non_lo_ifaces}) -- this reviewer must have no network transport beyond the gateway forwarder/vsock channel. Aborting before Pi starts." >&2
  exit 1
fi

# Confirmed empirically (`docker run --network none`, this task): the IPv4
# route table (/proc/net/route) is genuinely empty (header line only), but
# the IPv6 route table (/proc/net/ipv6_route) is NOT -- it carries two
# routes intrinsic to having a loopback device at all (::1/128, ff00::/8
# multicast), both via `lo`. So the IPv6 check below only rejects a route
# whose OUTPUT DEVICE (the last whitespace-separated field of each
# /proc/net/ipv6_route line) is something other than `lo`, rather than
# requiring literal emptiness.

magpie_route_count=0
if [ -r /proc/net/route ]; then
  # Subtract 1 for the header line; a route-free table is exactly 1 line.
  magpie_route_count=$(( $(wc -l < /proc/net/route) - 1 ))
fi
if [ "${magpie_route_count}" -gt 0 ]; then
  echo "magpie-reviewer: refusing to run: IPv4 route table is not empty (${magpie_route_count} route(s)) -- this reviewer must have no route out of itself beyond the gateway forwarder/vsock channel. Aborting before Pi starts." >&2
  exit 1
fi

if [ -r /proc/net/ipv6_route ]; then
  magpie_non_lo_v6_routes="$(awk '$NF != "lo" { print }' /proc/net/ipv6_route)"
  if [ -n "${magpie_non_lo_v6_routes}" ]; then
    echo "magpie-reviewer: refusing to run: IPv6 route table has a route not scoped to lo -- this reviewer must have no route out of itself beyond the gateway forwarder/vsock channel. Aborting before Pi starts." >&2
    exit 1
  fi
fi

# Canaries that MUST be unreachable from this container. A raw public IP
# (not just a hostname) is included deliberately -- it tests actual routing
# (or rather, the total absence of any route -- `--network none` gives this
# container no interfaces to route out of at all), not merely the (already-
# absent) DNS resolver; a name-based canary is included too since it's still
# a meaningful signal (failing at resolution counts as unreachable, per the
# note above).
readonly MAGPIE_NETWORK_CANARIES=(
  "1.1.1.1:443"     # raw public IP -- must be unroutable with no interfaces
  "github.com:443"  # name-based -- must fail to resolve at all
)

for canary in "${MAGPIE_NETWORK_CANARIES[@]}"; do
  canary_host="${canary%%:*}"
  canary_port="${canary##*:}"
  if magpie_tcp_reachable "${canary_host}" "${canary_port}"; then
    echo "magpie-reviewer: refusing to run: network canary ${canary} is REACHABLE from this container, but must not be -- confinement to the gateway-only network is broken. Aborting before Pi starts." >&2
    exit 1
  fi
done

# The gateway itself MUST be reachable -- derive host/port from
# OPENAI_BASE_URL (config.gateway.containerBaseUrl, as of M7-1 always
# "http://127.0.0.1:4000/v1" -- this container's OWN loopback, served by the
# forwarder started above) rather than hardcoding a second copy of the
# address here, so this check can never silently drift from what Pi is
# actually configured to talk to (see the models.json translation below).
# This probe transits forwarder -> /run/gw/gw.sock -> gateway, so a pass here
# proves the ENTIRE permitted path is up end-to-end, not just the forwarder's
# own listener.
magpie_gateway_authority="${OPENAI_BASE_URL#*://}"
magpie_gateway_authority="${magpie_gateway_authority%%/*}"
magpie_gateway_host="${magpie_gateway_authority%%:*}"
magpie_gateway_port="${magpie_gateway_authority##*:}"
if [ "${magpie_gateway_host}" = "${magpie_gateway_port}" ]; then
  # No explicit ":port" in OPENAI_BASE_URL -- fall back to the scheme default.
  case "${OPENAI_BASE_URL}" in
    https://*) magpie_gateway_port=443 ;;
    *) magpie_gateway_port=80 ;;
  esac
fi

if ! magpie_http_get_200 "${magpie_gateway_host}" "${magpie_gateway_port}" "/healthz"; then
  echo "magpie-reviewer: refusing to run: gateway proxy plane at ${magpie_gateway_host}:${magpie_gateway_port}/healthz (derived from OPENAI_BASE_URL) is NOT reachable -- this container's only permitted egress is unavailable, so no review can be attempted. Aborting before Pi starts." >&2
  exit 1
fi

# --- 3. Micro-VM tier: explicit allowed-egress-channel assertion ------------
# (M8-C4, task_3b48 Layer 3's "assert the allowed port explicitly"
# requirement.) Belt-and-suspenders alongside magpie-vsock-client's own
# `/dev/vsock` presence check (rust/vsock-client's
# `assert_char_device_present`, which already ran before this script's wait
# loop above ever observed the relay as up): re-assert, from THIS script's
# own perspective, that the micro-VM tier's egress channel is exactly
# `/dev/vsock` at the fixed port this script itself chose and named
# (`MAGPIE_EXPECTED_VSOCK_PORT`, passed to vsock-client via
# `MAGPIE_VSOCK_PORT` above) -- not whatever the vsock-client binary's own
# built-in default happens to be. A future change that silently drifted this
# port between this script and rust/vsock-client (or
# packages/orchestrator/src/microvm-vsock.ts's MICROVM_VSOCK_PORT, the
# host-side counterpart) would otherwise only surface as a confusing
# "review failed" with no clear cause.
if [ "${MAGPIE_IS_MICROVM}" = "1" ]; then
  if [ ! -c /dev/vsock ]; then
    echo "magpie-reviewer: refusing to run: /dev/vsock is missing -- the micro-VM tier's only permitted egress path is gone. Aborting before Pi starts." >&2
    exit 1
  fi
  if [ "${MAGPIE_VSOCK_PORT:-}" != "${MAGPIE_EXPECTED_VSOCK_PORT}" ]; then
    echo "magpie-reviewer: refusing to run: this script's own MAGPIE_VSOCK_PORT (${MAGPIE_VSOCK_PORT:-unset}) does not match the expected gateway vsock port (${MAGPIE_EXPECTED_VSOCK_PORT}) -- refusing to trust an unverified egress channel. Aborting before Pi starts." >&2
    exit 1
  fi
  echo "magpie-reviewer: micro-VM egress channel confirmed -- /dev/vsock present, port ${MAGPIE_EXPECTED_VSOCK_PORT}" >&2
fi

echo "magpie-reviewer: network confinement verified -- no non-lo interface, empty route table, canaries unreachable, gateway reachable only via the permitted forwarder/vsock channel" >&2

# HOME: the container's root filesystem is `--read-only` (see reviewer.ts's
# dockerArgs) with only `/tmp` writable (`--tmpfs /tmp`). reviewer.ts runs
# this container as an arbitrary HOST `--user <uid>:<gid>`, and the base image
# (node:22-slim) happens to bake in its own `node` account at uid 1000 -- so
# whenever the host uid this runs as collides with 1000 (a common first-
# non-root-user uid on many Linux distros; confirmed empirically during M4-C
# verification), the container runtime resolves THAT passwd entry and sets
# HOME=/home/node for us even though no `-e HOME` was ever passed -- and
# `/home/node` is on the read-only root filesystem, so writing there fails.
# A plain `: "${HOME:=/tmp}"` (default-if-unset) does NOT fix this, because
# HOME is already set (just to the wrong, unwritable path) -- so this
# unconditionally OVERRIDES it to the one location guaranteed writable
# regardless of uid (`/tmp`, torn down with the container on exit -- never
# persisted, which is fine since models.json below holds no secret).
export HOME=/tmp

# Translate OPENAI_BASE_URL into the provider-baseUrl override Pi actually
# reads (see the doc comment above). Preserves every built-in `openrouter`
# model and the normal OPENROUTER_API_KEY-env credential resolution -- only
# the endpoint moves, from api.openrouter.ai to the gateway's proxy plane.
# `mkdir -p` is safe to re-run; this file is not a secret (a fixed,
# deployment-wide URL, not a per-job credential) so no special permissions are
# needed beyond the tmpfs's own.
mkdir -p "$HOME/.pi/agent"
cat > "$HOME/.pi/agent/models.json" <<EOF
{
  "providers": {
    "openrouter": {
      "baseUrl": "${OPENAI_BASE_URL}"
    }
  }
}
EOF

# ---------------------------------------------------------------------------
# Baked review flags -- SINGLE-SOURCED. The fixed `pi` argument set (most
# importantly the read-only `--tools read,grep,find,ls,report_findings`
# allowlist -- the flag that keeps a compromised reviewer from writing or
# running anything) must be defined in EXACTLY ONE place, so the two tier
# exec paths below (crun: plain `exec pi`; micro-VM: `exec setpriv ... pi`)
# can never drift apart on a security-critical flag. `set --` prepends these
# baked flags ahead of the caller's trailing args (`--provider`/`--model`,
# already sitting in "$@" -- see line 30), reproducing the identical
# `pi <baked flags> <trailing>` argv both tiers used before this was
# de-duplicated.
# ---------------------------------------------------------------------------
set -- \
  -p \
  --mode json \
  --no-session \
  --tools read,grep,find,ls,report_findings \
  --extension /opt/magpie/review-extension/src/index.ts \
  --no-extensions \
  --append-system-prompt /opt/magpie/reviewer-prompt.md \
  "$@"

# ---------------------------------------------------------------------------
# M8-C3 (task_39ff): guest privilege drop -- MICRO-VM TIER ONLY.
#
# CRUN TIER: reviewer.ts's `docker run --user <uid>:<gid>` already runs this
# whole entrypoint (and therefore Pi) as an unprivileged host uid -- nothing
# to drop, and this block is SKIPPED (guarded on MAGPIE_IS_MICROVM), so the
# crun path is byte-for-byte unaffected: it falls through to the plain
# `exec pi "$@"` at the very bottom.
#
# MICRO-VM TIER: the launcher's krun_setuid/krun_setgid confine only the
# HOST-side VMM process, NOT the guest -- the guest boots (and, until this
# point, runs this script) as root (fully documented, source + empirically,
# in rust/magpie-microvm-launcher/src/krun.rs's module doc comment). So the
# equivalent of `--user` has to happen HERE, image-side: re-exec Pi as an
# unprivileged uid, matching the crun tier's non-root posture. As of M8-E5
# (task_a749) that uid is the one the ORCHESTRATOR passes in
# (MAGPIE_MICROVM_REVIEWER_UID/_GID) -- the same host uid the crun tier's
# `--user` uses -- NOT the image's baked-in `reviewer` account (uid 10001,
# docker/reviewer/Dockerfile's groupadd/useradd, which the crun tier still
# carries as its own default non-root identity). See the fail-closed block
# further down for why the baked account cannot be used at this tier.
# `setpriv` (util-linux) does a pure privilege drop with no
# PAM/login/shell in between and `exec`s straight into Pi, so Pi still
# receives SIGTERM/SIGKILL directly (the timeout/abort path -- see reviewer.ts's
# startKillSequence, which for this tier kills the launcher process == the VM).
# Only the setpriv WRAPPER differs between the tiers; the `pi` argv ("$@",
# built just above) is shared.
#
#   --reuid/--regid <uid>:<gid>   drop real+effective+saved id to the
#                                   orchestrator-supplied unprivileged id
#   --clear-groups                 shed root's supplementary groups
#   --no-new-privs                 set PR_SET_NO_NEW_PRIVS (mirrors the crun
#                                   tier's --security-opt=no-new-privileges)
#
# HOME/.pi (holding the non-secret models.json written just above) is chowned
# to the reviewer uid first so Pi can read it after the drop; everything in
# it is a fixed, deployment-wide URL, never a per-job credential (the gateway
# key reaches Pi only via the OPENROUTER_API_KEY env var, which survives the
# setpriv exec since setpriv does not scrub the environment).
#
# M8-E2 (task_76b8): this chown only works at all under the micro-VM tier
# because HOME=/tmp is, by this point, the guest-local tmpfs mounted earlier
# in this script (see the virtiofs-mount block above) rather than the
# virtiofs-backed guest root -- guest-root cannot chown paths living on
# rootless virtiofs (its uid is remapped back to the unprivileged HOST user
# by the rootless krun setup), which is exactly the EPERM this task fixes.
#
# M8-E5 (task_a749): the uid/gid dropped TO is now supplied by the
# orchestrator (MAGPIE_MICROVM_REVIEWER_UID/_GID -- see reviewer.ts's
# buildMicrovmLaunchArgs `env` map) instead of being the image's baked-in
# `reviewer` account (uid 10001, still present in the Dockerfile and still
# used by the crun tier's own non-root posture). It has to be, because of
# who owns the OTHER side of the /out virtiofs:
#
#   `/out` is a virtiofs view of the host directory container-mounts.ts's
#   createOutputDir makes with `mkdtemp`, i.e. mode 0700 owned by the
#   ORCHESTRATOR's uid. The crun tier never noticed, because `docker run
#   --user <uid>:<gid>` runs the whole container as that same host uid, so Pi
#   owns what it writes. Here, the guest boots as root and drops on its own --
#   and dropping to 10001, a uid with no relationship whatsoever to the host
#   uid owning those files, meant Pi saw `/out` as `drwx------ <hostuid>
#   <hostgid>` and got EACCES on findings.json. Every micro-VM review failed
#   as "pi did not call report_findings" regardless of what Pi actually did.
#
# Fixing it by widening /out's mode host-side, or by chowning /out here, were
# both rejected: the first loosens permissions on a host directory to paper
# over an identity mismatch, and the second is the same rootless-virtiofs
# chown that already produced M8-E2's EPERM (guest-root's uid is remapped back
# to the unprivileged host user for virtiofs ownership purposes -- see the
# tmpfs block above). Aligning the IDENTITY is the fix that removes the
# mismatch instead of masking it.
#
# POSTURE IS PRESERVED, AND NOW UNIFIED: this is still a drop from guest-root
# to an unprivileged, non-root uid before Pi ever runs -- the same drop, to the
# same uid the crun tier has always used. The two tiers' reviewer identity is
# now IDENTICAL rather than divergent. Note the guest is a separate kernel with
# its own uid space; "the host's uid" here is a number chosen so the shared
# virtiofs files line up, and it is unprivileged on both sides.
#
# FAIL CLOSED on unset / non-numeric / zero, and NEVER fall back to 10001 --
# that fallback is now known-broken for /out, and silently taking it would
# resurrect exactly the silent-failure mode this fixes. Zero is rejected
# separately and loudly: uid 0 would mean running Pi -- the thing that
# processes untrusted PR content -- as guest-root, discarding the entire point
# of this block. (No passwd entry exists in the guest for the host's uid, and
# none is needed: setpriv takes numeric ids, and HOME is force-set to /tmp
# above rather than resolved via getpwuid.)
if [ "${MAGPIE_IS_MICROVM}" = "1" ]; then
  case "${MAGPIE_MICROVM_REVIEWER_UID:-}" in
    ''|*[!0-9]*)
      echo "magpie-reviewer: refusing to run: MAGPIE_MICROVM_REVIEWER_UID is unset or non-numeric (${MAGPIE_MICROVM_REVIEWER_UID:-unset}) -- cannot determine the unprivileged uid to drop to before running Pi, and must not fall back to the baked-in 10001 account (it cannot write the /out virtiofs -- see task_a749). Aborting before Pi starts." >&2
      exit 1
      ;;
  esac
  case "${MAGPIE_MICROVM_REVIEWER_GID:-}" in
    ''|*[!0-9]*)
      echo "magpie-reviewer: refusing to run: MAGPIE_MICROVM_REVIEWER_GID is unset or non-numeric (${MAGPIE_MICROVM_REVIEWER_GID:-unset}) -- cannot determine the unprivileged gid to drop to before running Pi, and must not fall back to the baked-in 10001 account (it cannot write the /out virtiofs -- see task_a749). Aborting before Pi starts." >&2
      exit 1
      ;;
  esac
  if [ "${MAGPIE_MICROVM_REVIEWER_UID}" -eq 0 ] || [ "${MAGPIE_MICROVM_REVIEWER_GID}" -eq 0 ]; then
    echo "magpie-reviewer: refusing to run: MAGPIE_MICROVM_REVIEWER_UID/_GID resolve to root (${MAGPIE_MICROVM_REVIEWER_UID}:${MAGPIE_MICROVM_REVIEWER_GID}) -- Pi must never run as root in the guest, which is the entire purpose of this privilege drop. Aborting before Pi starts." >&2
    exit 1
  fi
  echo "magpie-reviewer: micro-VM tier -- dropping to uid/gid ${MAGPIE_MICROVM_REVIEWER_UID}:${MAGPIE_MICROVM_REVIEWER_GID} (the orchestrator's own unprivileged uid, matching the crun tier's --user and the /out virtiofs owner) before exec pi" >&2
  chown -R "${MAGPIE_MICROVM_REVIEWER_UID}:${MAGPIE_MICROVM_REVIEWER_GID}" "$HOME/.pi"
  exec setpriv --reuid="${MAGPIE_MICROVM_REVIEWER_UID}" --regid="${MAGPIE_MICROVM_REVIEWER_GID}" --clear-groups --no-new-privs pi "$@"
fi

# exec: replace this script as PID 1 so Pi receives SIGTERM/SIGKILL directly
# from `docker stop`/`docker kill` (the container-lifecycle timeout/abort
# path -- see epic_a580) instead of a shell swallowing the signal. "$@" is
# the baked review flags followed by the caller's trailing --provider/--model
# (see the `set --` above). (Crun tier only -- the micro-VM tier exec'd above.)
exec pi "$@"
