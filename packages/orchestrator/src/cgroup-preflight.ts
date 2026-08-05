// cgroup v2 memory-controller preflight for the magpie orchestrator.
//
// WHY THIS EXISTS: `config.container.memory` is passed as `docker/podman run
// --memory=<limit>` on every review container (see reviewer.ts) — the hard
// cap bounding how much host RAM a single, possibly prompt-injected review
// job can consume. That flag only does anything if the kernel's cgroup v2
// `memory` controller is actually present and delegated to the cgroup the
// container runs in. Some hosts don't have it: e.g. Raspberry Pi firmware
// defaults prepend `cgroup_disable=memory` to the kernel cmdline, which
// removes `memory` from `/sys/fs/cgroup/cgroup.controllers` kernel-wide. When
// that happens the two supported runtimes fail in OPPOSITE and both-bad ways:
//   - Docker/dockerd FAILS OPEN: it prints a warning
//     ("your kernel does not support memory limit capabilities") and starts
//     the container anyway, unconfined — silent, ongoing risk. This is the
//     exact silent-failure behavior this preflight check exists to catch.
//   - Podman/crun FAILS CLOSED, but late and cryptically: container CREATION
//     itself errors ("crun: opening file 'memory.max' for writing: No such
//     file or directory"), so every single review job fails from the first
//     one after boot, with a root cause that isn't obvious from the error
//     text alone.
// Neither is acceptable for an unattended, self-hosted service. This module
// runs ONE check at startup (mirroring docker.ts's own fail-fast philosophy)
// so a missing memory controller is a clear, actionable message at boot
// instead of either of those per-job surprises — see index.ts's composition
// root for where this is wired in, right after `assertDockerAvailable`. The
// review container ALSO re-checks this for itself at the top of every job
// (docker/reviewer/entrypoint.sh) as a defence-in-depth backstop — this
// module only covers the orchestrator-host-level, startup-time half.
//
// PORTABLE BY DESIGN: this module does NOT special-case Raspberry Pi (or any
// other platform) in code. It only reads two generic cgroup v2 files that
// exist identically on any Linux host using the unified hierarchy:
//   1. `/sys/fs/cgroup/cgroup.controllers` — the ROOT cgroup's controller
//      list. If `memory` is absent here, it is unavailable kernel-wide, full
//      stop — this is the exact signature of the Raspberry Pi firmware gap,
//      but the check itself has no RPi-specific logic; it would just as
//      correctly catch any other kernel/boot-config that disables the
//      controller.
//   2. This process's OWN cgroup's `cgroup.controllers` (resolved via
//      `/proc/self/cgroup`, the portable way to find "what cgroup am I in"
//      without assuming a particular systemd unit type or slice layout) —
//      catches the narrower case where the controller exists on the host but
//      wasn't DELEGATED down to this process's cgroup (e.g. a systemd unit
//      that didn't request `Delegate=`), even though the root has it.
// Per-platform remediation (the Raspberry Pi boot-arg fix, etc.) belongs in
// INSTALL.md/QUICKSTART.md, not here.

import { readFile } from "node:fs/promises";
import type { Config } from "./config.js";

/** Root cgroup v2 controllers file — present on any cgroup-v2-unified host. */
const ROOT_CONTROLLERS_PATH = "/sys/fs/cgroup/cgroup.controllers";

/** Where this process can read its own cgroup v2 path from. */
const SELF_CGROUP_PATH = "/proc/self/cgroup";

/** The controller this module checks for. */
const MEMORY_CONTROLLER = "memory";

/**
 * Minimal shape this module needs from `fs/promises.readFile`. TEST SEAM:
 * {@link assertMemoryControllerAvailable}'s second parameter accepts an
 * implementation of this type (mirrors docker.ts's `ExecFileFn` pattern) so
 * cgroup-preflight.test.ts can exercise every branch (root-missing,
 * delegation-missing, both-present, unreadable-files) without depending on a
 * real cgroup v2 filesystem or this host's actual (currently-enabled) state.
 */
export type ReadFileFn = (path: string) => Promise<string>;

const realReadFile: ReadFileFn = (path) => readFile(path, "utf-8");

/**
 * Thrown when {@link assertMemoryControllerAvailable} determines the memory
 * controller is unavailable AND `config.container.requireMemoryLimit` is
 * true (the default). Mirrors docker.ts's `DockerUnavailableError`: one
 * clear, actionable message rather than a raw ENOENT/parse error.
 */
export class MemoryControllerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryControllerUnavailableError";
  }
}

/** Result of the internal (host-level) memory-controller check. */
interface ControllerCheckResult {
  available: boolean;
  /** Human-readable detail, folded into the warning/error message. */
  detail: string;
  /**
   * Set when the check passed the two AUTHORITATIVE gates (kernel-wide root
   * controller present) but a non-authoritative sub-check was inconclusive in
   * a way worth surfacing — currently: the memory controller isn't delegated
   * to THIS process's own cgroup. Advisory only: `available` stays `true` (see
   * the delegation branch in {@link checkMemoryController} for why), and
   * {@link assertMemoryControllerAvailable} logs it as a WARNING and continues
   * rather than blocking startup.
   */
  warning?: string;
}

/** Parses a cgroup v2 `cgroup.controllers` file's space-separated contents into a Set. */
function parseControllers(raw: string): Set<string> {
  return new Set(raw.trim().split(/\s+/).filter((s) => s.length > 0));
}

/**
 * Resolves this process's own cgroup v2 path from `/proc/self/cgroup`.
 * Cgroup v2 (unified hierarchy) always reports exactly one line of the form
 * `0::<path>`; a hybrid/legacy (cgroup v1) host won't have that exact `0::`
 * line, which this function surfaces as `undefined` (treated as
 * "can't determine delegation" by the caller — see below).
 */
function parseSelfCgroupPath(raw: string): string | undefined {
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("0::")) {
      return trimmed.slice("0::".length);
    }
  }
  return undefined;
}

/**
 * Checks whether the cgroup v2 `memory` controller is available at the host
 * root and, best-effort, delegated to this process's own cgroup. Pure
 * data-in/data-out over the injected `readFileFn` — no throwing, no config
 * dependency (the config-driven fail-open/fail-closed decision is
 * {@link assertMemoryControllerAvailable}'s job, not this function's).
 */
async function checkMemoryController(readFileFn: ReadFileFn): Promise<ControllerCheckResult> {
  let rootRaw: string;
  try {
    rootRaw = await readFileFn(ROOT_CONTROLLERS_PATH);
  } catch (err) {
    return {
      available: false,
      detail:
        `could not read ${ROOT_CONTROLLERS_PATH} (${errorMessage(err)}) — this host may not be ` +
        `using the cgroup v2 unified hierarchy, which Magpie's container runtime requires`,
    };
  }

  const rootControllers = parseControllers(rootRaw);
  if (!rootControllers.has(MEMORY_CONTROLLER)) {
    return {
      available: false,
      detail:
        `the kernel's cgroup v2 "memory" controller is not present at all (${ROOT_CONTROLLERS_PATH} ` +
        `lists: ${[...rootControllers].join(", ") || "(none)"})`,
    };
  }

  // The root has it — now check it's actually DELEGATED to THIS process's
  // own cgroup, not just present somewhere in the tree. Best-effort: if we
  // can't resolve our own cgroup path or read its controllers file, we don't
  // treat that as a failure on its own (the root-level check above is the
  // authoritative "is this possible at all" signal) — just skip the more
  // precise delegation check rather than false-failing on, say, a
  // permissions quirk reading our own cgroup file.
  //
  // TOPOLOGY CAVEAT: this inspects the ORCHESTRATOR process's own cgroup, which
  // is NOT necessarily the cgroup subtree the review-container's cgroup is
  // created in — under the default rootless-Podman runtime the container cgroup
  // lands under the invoking user's slice, and the shipped magpie.service runs
  // as a system unit (User=magpie, no Delegate=). So this delegation sub-check
  // is a best-effort early hint, NOT authoritative: the root-level check above
  // is the real "is this possible at all" gate, and docker/reviewer/
  // entrypoint.sh's per-job memory.max assertion observes the ACTUAL enforced
  // state from inside the real container regardless of where its cgroup lives.
  //
  // Because it's the LEAST authoritative of the three signals, a delegation
  // miss is a WARNING, not a hard startup gate (`available` stays `true`). It
  // false-positives on legitimate topologies where the kernel has `memory` and
  // the container WOULD be enforced but this process's own cgroup lacks the
  // delegated controller (e.g. systemd `DefaultMemoryAccounting=no`, a hardened
  // unit profile, or a non-systemd init). Making it a hard gate would block
  // startup in those cases, and the only escape (`require_memory_limit=false`)
  // would ALSO demote the authoritative in-container assertion to warn-only —
  // so a false-positive on the weakest signal would end up disabling the
  // strongest one. It stays advisory instead; the two hard gates are the
  // root-level check and entrypoint.sh's per-job assertion.
  let selfRaw: string;
  try {
    selfRaw = await readFileFn(SELF_CGROUP_PATH);
  } catch {
    return {
      available: true,
      detail:
        "root cgroup has the memory controller (own-cgroup delegation check skipped: could not " +
        "read /proc/self/cgroup)",
    };
  }

  const selfPath = parseSelfCgroupPath(selfRaw);
  if (!selfPath) {
    return {
      available: true,
      detail:
        "root cgroup has the memory controller (own-cgroup delegation check skipped: not on the " +
        "cgroup v2 unified hierarchy)",
    };
  }

  const selfControllersPath = `/sys/fs/cgroup${selfPath}/cgroup.controllers`;
  let selfControllersRaw: string;
  try {
    selfControllersRaw = await readFileFn(selfControllersPath);
  } catch {
    return {
      available: true,
      detail: `root cgroup has the memory controller (own-cgroup delegation check skipped: could not read ${selfControllersPath})`,
    };
  }

  const selfControllers = parseControllers(selfControllersRaw);
  if (!selfControllers.has(MEMORY_CONTROLLER)) {
    // Advisory, not a hard failure — see the TOPOLOGY CAVEAT above. The kernel
    // has the controller (the authoritative gate passed); it just isn't
    // delegated to THIS process's cgroup, which may or may not be where the
    // review container lands. Surface it as a warning and let the per-job
    // in-container assertion be the real enforcement check.
    return {
      available: true,
      detail: "memory controller present at the host root (delegation to this process's own cgroup not detected)",
      warning:
        `the kernel has the "memory" controller, but it is not delegated to this process's own ` +
        `cgroup (${selfControllersPath} lists: ${[...selfControllers].join(", ") || "(none)"}). This is ` +
        `often benign (the review container may run in a different cgroup subtree that IS enforced — the ` +
        `per-job in-container assertion is the authoritative check), but if reviews fail with an ` +
        `unenforced/creation error, the service manager likely needs cgroup delegation enabled (e.g. ` +
        `systemd's Delegate=) for this user/slice`,
    };
  }

  return {
    available: true,
    detail: "memory controller present at the host root and delegated to this process's own cgroup",
  };
}

/**
 * Verifies the cgroup v2 `memory` controller is available before Magpie starts
 * accepting webhooks — see this module's doc comment for why. The ONLY hard
 * gate here is the authoritative kernel-wide root-controller check; a
 * non-authoritative delegation miss resolves with a WARNING and continues (see
 * {@link ControllerCheckResult.warning} and the TOPOLOGY CAVEAT in
 * {@link checkMemoryController}). Resolves silently when fully available, logs a
 * WARNING and continues when available-with-a-caveat or when unavailable AND
 * `config.container.requireMemoryLimit` is `false`, and throws
 * {@link MemoryControllerUnavailableError} only when the root controller is
 * unavailable AND `requireMemoryLimit` is `true` (the default) — fail loud,
 * never silent.
 *
 * `readFileFn`/`warn` default to the real `fs/promises.readFile` and
 * `console.warn`; cgroup-preflight.test.ts injects fakes for every branch.
 */
export async function assertMemoryControllerAvailable(
  config: Pick<Config, "container">,
  readFileFn: ReadFileFn = realReadFile,
  warn: (message: string) => void = (m) => console.warn(m),
): Promise<void> {
  const result = await checkMemoryController(readFileFn);
  if (result.available) {
    // Passed the authoritative gate, but a non-authoritative sub-check (memory
    // not delegated to our own cgroup) was inconclusive — surface it, don't
    // block startup. The per-job in-container assertion remains the real check.
    if (result.warning) {
      warn(
        `[magpie] WARNING: cgroup memory-controller preflight: ${result.warning}. Continuing ` +
          `(the per-job in-container memory.max assertion is the authoritative enforcement check).`,
      );
    }
    return;
  }

  if (!config.container.requireMemoryLimit) {
    warn(
      `[magpie] WARNING: cgroup memory-controller preflight failed (${result.detail}). ` +
        `container.require_memory_limit is false, so Magpie is starting anyway — every review ` +
        `container's --memory=${config.container.memory} limit will be UNENFORCED (docker discards it ` +
        `with a warning; podman/crun may instead fail each job at container creation, depending on ` +
        `version). See INSTALL.md/QUICKSTART.md for how to enable the memory controller on your host.`,
    );
    return;
  }

  throw new MemoryControllerUnavailableError(
    `cgroup memory-controller preflight failed: ${result.detail}. Magpie refuses to start with ` +
      `container.require_memory_limit = true (the default) because every review container's ` +
      `--memory=${config.container.memory} limit would otherwise be silently unenforced (Docker) or ` +
      `every review job would hard-fail at container creation (Podman/crun). Fix: enable the cgroup v2 ` +
      `memory controller for this host — see INSTALL.md/QUICKSTART.md for the per-platform steps (e.g. ` +
      `Raspberry Pi needs a kernel boot-arg change + reboot). If you understand the risk and want to run ` +
      `without an enforced memory limit anyway, set [container] require_memory_limit = false in config.toml.`,
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
