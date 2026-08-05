// The isolation-tier ladder: probes the host and selects the strongest
// isolation tier a review job can actually run under (see
// docs/design/cto-decision-brief.md §5 "the isolation ladder" and §8's
// implementation scope). This is the SINGLE auditable module the
// tier-honesty invariant is built around -- tier selection is a
// single auditable module, degradation always requires explicit
// acknowledgement, and the selected tier is what actually launches jobs.
//
// THE LADDER (strongest first): micro-VM (KVM) > hardened crun (the floor).
// Ranked, not just listed: {@link TIER_RANK} is the one place that encodes
// "stronger than" for the whole module.
//
// THE SIN THIS EXISTS TO PREVENT: silent degradation. A host that can no
// longer do what its config asks for (KVM revoked, rootfs misconfigured, the
// `magpie-krun-launch` binary went missing, ...) must never quietly fall
// back to a weaker sandbox and keep serving reviews as if nothing changed --
// that is exactly how an operator ends up running unhardened reviews over
// untrusted PR content without knowing it. So {@link resolveTier} FAILS
// LOUD (throws {@link TierSelectionError}) the moment the strongest tier
// this host can actually deliver is weaker than what `config.container.tier`
// asked for, UNLESS the operator has explicitly acknowledged exactly that
// weaker tier via the `MAGPIE_ACK_TIER` environment variable (never
// config.toml -- see {@link parseAckTier}'s doc comment for why this is
// deliberately an env-only, not-persisted mechanism).
//
// WHY THIS MODULE SELECTS THE STRONGEST AVAILABLE TIER RATHER THAN JUST
// VALIDATING THE CONFIGURED ONE: `config.container.tier` is a static,
// human-edited value (see config.ts) that can go stale in either direction
// -- a host can lose capability (KVM access revoked) or gain it (an
// operator finishes provisioning `microvm.rootfs_path` after initially
// shipping on "crun"). This module always computes the strongest tier the
// PROBE evidence supports and treats that as the resolved tier; the
// acknowledgement gate below only fires in the DOWNGRADE direction (weaker
// than configured), never blocks an upgrade. In practice this rarely
// matters: {@link computeAvailability} only counts "microvm" as available
// when `microvm.rootfs_path` is ALSO configured, so a host that hasn't
// opted into the micro-VM knobs at all can never be silently upgraded past
// its "crun" default -- the only way to reach that edge case is to already
// have deliberately configured `[microvm]` while leaving `container.tier`
// at "crun", a self-contradictory combination an operator is unlikely to
// leave in place.
//
// TWO CALLERS OF THE SAME PROBE BINARY: the KVM half of the probe below
// shells out to `rust/magpie-tier-probe` (see that crate's module doc
// comment) -- the same binary the installer also runs directly, with
// no Node in the loop at all. This module is the orchestrator-runtime
// consumer only; it does not know or care that the installer also calls the
// same binary.
//
// NOT SURFACED ON THE PR: the resolved tier is operator-only information
// (index.ts logs it; it's also surfaced on `/healthz`) --
// never posted to a PR review body/comment. This module doesn't touch the
// publisher at all, but the constraint is worth restating here since a
// future caller might otherwise be tempted to thread `TierSelectionResult`
// into `buildPromptPayload`/`publisher.ts`.

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { Config } from "./config.js";
import type { ExecFileFn } from "./docker.js";

const execFileAsync = promisify(execFileCb);

/**
 * The two tiers the ladder knows about, ranked strongest-first by
 * {@link TIER_RANK}.
 */
export type Tier = "microvm" | "crun";

/**
 * Higher = stronger isolation. The one place "stronger than" is defined for
 * this whole module -- every degradation/upgrade comparison below goes
 * through this table rather than re-deriving tier order ad hoc.
 */
const TIER_RANK: Readonly<Record<Tier, number>> = {
  microvm: 2,
  crun: 1,
};

/** Strongest-first iteration order, derived from {@link TIER_RANK} so the two can never drift apart. */
const TIERS_STRONGEST_FIRST: readonly Tier[] = (Object.keys(TIER_RANK) as Tier[]).sort(
  (a, b) => TIER_RANK[b] - TIER_RANK[a],
);

/**
 * Thrown by {@link resolveTier} for every fail-loud path: no tier at all is
 * usable on this host, an invalid `MAGPIE_ACK_TIER` value, or an
 * unacknowledged degradation. Mirrors config.ts's `ConfigError` / docker.ts's
 * `DockerUnavailableError` -- a single clear, actionable message rather than
 * a raw underlying error -- so index.ts's `formatStartupError` can treat it
 * identically to those (a clean one-line `[magpie] <message>`, no stack).
 */
export class TierSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TierSelectionError";
  }
}

/**
 * Result of probing `/dev/kvm` via `rust/magpie-tier-probe`'s
 * `KVM_CREATE_VM` ioctl (see {@link probeKvm}). `reason` is `null` iff
 * `available` -- mirrors the Rust binary's own `{"kvm":bool,"reason":...}`
 * output contract exactly (see that crate's module doc comment).
 */
export interface KvmProbeResult {
  available: boolean;
  reason: string | null;
}

/**
 * Result of probing a runtime CLI's presence (the crun-floor's
 * `config.container.docker_bin`, or the micro-VM tier's
 * `config.microvm.launcher_bin`). `reason` is only set when `present` is
 * `false`.
 */
export interface RuntimeProbeResult {
  present: boolean;
  /** The binary path/name this result is about (echoes the input, for logging). */
  binary: string;
  /** First line of the binary's own version/help output, when available. */
  version?: string;
  reason?: string;
}

/** Raw probe evidence gathered by {@link probeTier} -- the full audit trail {@link resolveTier} reasons over. */
export interface TierProbe {
  kvm: KvmProbeResult;
  /** Presence of `magpie-krun-launch` (`config.microvm.launcherBin`). */
  microvmLauncher: RuntimeProbeResult;
  /** Whether `config.microvm.rootfsPath` is non-empty -- the micro-VM tier's other hard prerequisite besides KVM+launcher. */
  microvmRootfsConfigured: boolean;
  /** Presence of the crun-floor's runtime CLI (`config.container.dockerBin`, e.g. podman or docker). */
  crunRuntime: RuntimeProbeResult;
}

/** Per-tier availability, derived from {@link TierProbe} by {@link computeAvailability}. */
export interface TierAvailability {
  microvm: boolean;
  crun: boolean;
}

/**
 * The full result of {@link resolveTier} -- designed for two consumers: (1)
 * `reviewer.ts`/`pipeline.ts`, which need only `resolvedTier` (threaded
 * through as `RunReviewParams.resolvedTier` rather than letting reviewer.ts
 * re-read `config.container.tier` independently -- see this module's doc
 * comment and reviewer.ts's own note on the same point), and (2)
 * server.ts's `/healthz` handler, which surfaces the REST of this object on
 * `/healthz` and in structured logs (never the PR itself -- see this
 * module's doc comment).
 */
export interface TierSelectionResult {
  /** The tier that actually launches jobs. This is what reviewer.ts must use -- see this module's doc comment. */
  resolvedTier: Tier;
  /** `config.container.tier` -- what the operator configured. */
  requestedTier: Tier;
  /** `true` iff `resolvedTier` is strictly weaker than `requestedTier` (by {@link TIER_RANK}). */
  degraded: boolean;
  /** The parsed, validated `MAGPIE_ACK_TIER` value, or `null` if unset. Present even when `degraded` is `false` (informational). */
  acknowledgedTier: Tier | null;
  /** Raw probe evidence -- see {@link TierProbe}. */
  probe: TierProbe;
  /** Per-tier availability derived from `probe` -- see {@link TierAvailability}. */
  availability: TierAvailability;
  /** Human-readable audit trail (one line per probe input plus the final decision), for logs -- never posted to a PR. */
  reasons: string[];
}

/** Injectable dependencies for {@link resolveTier} / {@link probeTier} -- production callers (index.ts) leave both undefined. */
export interface ResolveTierDeps {
  /**
   * TEST SEAM: overrides how every probe subprocess (the KVM probe binary,
   * the crun runtime CLI, the micro-VM launcher binary) is invoked. Defaults
   * to the real, promisified `child_process.execFile` -- mirrors docker.ts's
   * `ExecFileFn` test-seam convention exactly (same type, imported from
   * there, not redeclared) so a single fake can stub every subprocess this
   * module runs.
   */
  execFileFn?: ExecFileFn;
  /** TEST SEAM: overrides `process.env` for `MAGPIE_ACK_TIER` lookup. Defaults to the real `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/** Schema for `magpie-tier-probe`'s one line of stdout JSON -- see that crate's "Output contract" doc section. `.strict()` so an unexpected extra field (a probe binary built from a newer/older contract) is treated as unparseable rather than silently accepted. */
const kvmProbeOutputSchema = z.object({ kvm: z.boolean(), reason: z.string().nullable() }).strict();

/** Extracts `{ code, stdout }` from whatever `execFileFn` rejects with, if anything is there. `child_process.execFile`'s promisified rejection carries these on the `Error` itself (Node's documented `ExecException` contract) -- this reaches into that without assuming every possible caller/fake provides them. */
function execErrorDetails(err: unknown): { code?: string | number; stdout?: string } {
  if (err !== null && typeof err === "object") {
    const e = err as { code?: string | number; stdout?: string };
    return { code: e.code, stdout: e.stdout };
  }
  return {};
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Runs `probeBin` (`config.container.tierProbeBin`, default
 * `"magpie-tier-probe"`) and parses its one-line JSON contract (see
 * rust/magpie-tier-probe/src/main.rs's "Output contract" doc section).
 *
 * `magpie-tier-probe` exits `0` for `kvm:true` and `1` for `kvm:false` -- the
 * LATTER is an ORDINARY, EXPECTED result (a host with no hardware
 * virtualization), not a probe failure, so this function still parses
 * stdout on that path rather than treating a non-zero exit as an error.
 * `child_process.execFile`'s promisified form rejects on ANY non-zero exit,
 * but the rejection's `Error` carries the child's stdout (Node's documented
 * `ExecException` contract) -- {@link execErrorDetails} recovers it from
 * there. Only a genuine failure to run the binary at all (missing binary,
 * unparseable output on EITHER exit path) resolves to `{ available: false,
 * reason: <explanation> }` for a reason OTHER than "this host has no KVM".
 */
async function probeKvm(probeBin: string, execFileFn: ExecFileFn): Promise<KvmProbeResult> {
  let stdout: string;
  try {
    const result = await execFileFn(probeBin, []);
    stdout = result.stdout;
  } catch (err) {
    const { code, stdout: errStdout } = execErrorDetails(err);
    if (code === "ENOENT") {
      return {
        available: false,
        reason:
          `KVM preflight binary "${probeBin}" was not found on PATH -- see config.toml's ` +
          `container.tier_probe_bin (rust/magpie-tier-probe must be built/installed alongside ` +
          "the orchestrator; see scripts/pack-host.sh).",
      };
    }
    if (typeof errStdout === "string" && errStdout.trim().length > 0) {
      // The expected "KVM unavailable" path (exit 1) -- parse it exactly
      // like a clean exit, see this function's doc comment.
      stdout = errStdout;
    } else {
      return {
        available: false,
        reason: `failed to run KVM preflight binary "${probeBin}": ${errorMessage(err)}`,
      };
    }
  }

  const firstLine = stdout.trim().split("\n")[0] ?? "";
  let raw: unknown;
  try {
    raw = JSON.parse(firstLine);
  } catch {
    return {
      available: false,
      reason: `KVM preflight binary "${probeBin}" produced unparseable output: ${JSON.stringify(stdout.trim())}`,
    };
  }
  const parsed = kvmProbeOutputSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      available: false,
      reason: `KVM preflight binary "${probeBin}" produced output that doesn't match its documented contract: ${JSON.stringify(stdout.trim())}`,
    };
  }
  return { available: parsed.data.kvm, reason: parsed.data.reason };
}

/** First non-empty line of `text`, trimmed -- used to reduce a version/help banner to one log-friendly line. */
function firstLine(text: string): string {
  return text.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
}

/**
 * Probes the crun-floor's runtime CLI (`config.container.dockerBin`) by
 * running `<binary> version` -- the SAME invocation docker.ts's
 * `assertDockerAvailable` uses, so a fake `execFileFn` written for one
 * reproduces the other. Unlike `assertDockerAvailable` (which throws), this
 * never throws: it's aggregating evidence for the ladder, not itself the
 * fail-fast gate (docker.ts's own preflight, wired separately in index.ts,
 * remains the authoritative "docker/podman is usable at all" check).
 */
async function probeCrunRuntime(binary: string, execFileFn: ExecFileFn): Promise<RuntimeProbeResult> {
  try {
    const { stdout } = await execFileFn(binary, ["version"]);
    return { present: true, binary, version: firstLine(stdout) };
  } catch (err) {
    const { code } = execErrorDetails(err);
    const reason =
      code === "ENOENT"
        ? `"${binary}" was not found on PATH`
        : `"${binary} version" did not succeed (${errorMessage(err)})`;
    return { present: false, binary, reason };
  }
}

/**
 * Probes `magpie-krun-launch` (`config.microvm.launcherBin`) presence via
 * `--help`, which the launcher documents as always exiting `0` (see
 * rust/magpie-microvm-launcher/src/main.rs's exit-code doc comment) -- a
 * side-effect-free way to confirm the binary runs at all without needing a
 * real rootfs/KVM/vsock setup just to answer "is it present and executable".
 */
async function probeMicrovmLauncher(launcherBin: string, execFileFn: ExecFileFn): Promise<RuntimeProbeResult> {
  try {
    await execFileFn(launcherBin, ["--help"]);
    return { present: true, binary: launcherBin };
  } catch (err) {
    const { code } = execErrorDetails(err);
    const reason =
      code === "ENOENT"
        ? `"${launcherBin}" was not found on PATH`
        : `"${launcherBin} --help" did not succeed (${errorMessage(err)})`;
    return { present: false, binary: launcherBin, reason };
  }
}

/**
 * Gathers every probe input the ladder needs, running the three
 * independent subprocess probes concurrently (they touch disjoint
 * binaries/paths, so there's no ordering requirement between them).
 */
export async function probeTier(config: Config, execFileFn: ExecFileFn = execFileAsync): Promise<TierProbe> {
  const [kvm, microvmLauncher, crunRuntime] = await Promise.all([
    probeKvm(config.container.tierProbeBin, execFileFn),
    probeMicrovmLauncher(config.microvm.launcherBin, execFileFn),
    probeCrunRuntime(config.container.dockerBin, execFileFn),
  ]);
  return {
    kvm,
    microvmLauncher,
    microvmRootfsConfigured: config.microvm.rootfsPath.length > 0,
    crunRuntime,
  };
}

/**
 * Derives per-tier availability from raw probe evidence. `"microvm"`
 * requires ALL THREE of: a real KVM_CREATE_VM success, the launcher binary
 * present, AND `microvm.rootfs_path` configured -- missing any one of these
 * means a job launched at that tier would immediately fail (or, worse,
 * silently run against a stale/wrong rootfs), so all three are hard
 * requirements, not independent nice-to-haves.
 */
export function computeAvailability(probe: TierProbe): TierAvailability {
  return {
    microvm: probe.kvm.available && probe.microvmLauncher.present && probe.microvmRootfsConfigured,
    crun: probe.crunRuntime.present,
  };
}

/** The strongest tier with `availability[tier] === true`, or `null` if none is available at all. */
export function pickStrongestAvailable(availability: TierAvailability): Tier | null {
  for (const tier of TIERS_STRONGEST_FIRST) {
    if (availability[tier]) return tier;
  }
  return null;
}

/** Human-readable explanation of why `tier` is unavailable, from probe evidence -- used to build {@link TierSelectionError} messages and the `reasons` audit trail. */
function explainTierUnavailable(tier: Tier, probe: TierProbe): string {
  switch (tier) {
    case "microvm": {
      const problems: string[] = [];
      if (!probe.kvm.available) {
        problems.push(`KVM unavailable (${probe.kvm.reason ?? "KVM_CREATE_VM did not succeed"})`);
      }
      if (!probe.microvmLauncher.present) {
        problems.push(`launcher not found (${probe.microvmLauncher.reason ?? "unknown reason"})`);
      }
      if (!probe.microvmRootfsConfigured) {
        problems.push("microvm.rootfs_path is not configured");
      }
      return problems.length > 0 ? problems.join("; ") : "unknown reason";
    }
    case "crun":
      return probe.crunRuntime.reason ?? "container runtime unavailable";
  }
}

/** Every tier string this module recognizes -- the only valid values for `MAGPIE_ACK_TIER`. */
const KNOWN_TIERS: readonly Tier[] = ["microvm", "crun"];

/**
 * Parses the `MAGPIE_ACK_TIER` environment variable -- the operator's
 * explicit, per-host, EXPLICIT acknowledgement that a weaker-than-requested
 * tier is expected and accepted on this host. Deliberately an ENVIRONMENT variable, not a `config.toml`
 * field: a config field would persist silently across a host migration/
 * upgrade/config-copy and could end up quietly acknowledging a DIFFERENT,
 * future degradation an operator never actually looked at -- exactly the
 * silent-degradation failure mode this whole module exists to prevent. An
 * env var set (or not) at each `systemctl start`/process launch keeps the
 * acknowledgement a live, per-run decision.
 *
 * Returns `null` for "unset" (the ordinary case). Throws
 * {@link TierSelectionError} for a NON-EMPTY value that isn't exactly one of
 * {@link KNOWN_TIERS} -- validated unconditionally, even on a host where no
 * degradation ever occurs, so a typo'd ack (e.g. `"cru"`, trailing
 * whitespace) is caught immediately rather than sitting inert until the one
 * day a real degradation needs it, at which point an operator who believes
 * they already handled it would be confused by an unrelated-looking
 * degradation error instead.
 */
export function parseAckTier(envValue: string | undefined): Tier | null {
  if (envValue === undefined || envValue.length === 0) return null;
  if ((KNOWN_TIERS as readonly string[]).includes(envValue)) return envValue as Tier;
  throw new TierSelectionError(
    `MAGPIE_ACK_TIER="${envValue}" is not a recognized isolation tier -- must be exactly one of ` +
      `${KNOWN_TIERS.join(", ")} (case-sensitive, no surrounding whitespace). This variable is the ` +
      "explicit operator acknowledgement required to run a degraded isolation tier (see tier-ladder.ts); " +
      "a value it can't parse is treated as a misconfiguration, not as \"no acknowledgement\".",
  );
}

/**
 * Probes the host and resolves the isolation tier that will actually launch
 * review jobs -- the single entry point this whole module exists to expose.
 * See this module's doc comment for the full ladder/degradation/
 * acknowledgement design.
 *
 * Never returns a "degraded, unacknowledged" result -- that path always
 * throws {@link TierSelectionError} instead (see the module doc comment's
 * "THE SIN THIS EXISTS TO PREVENT"). A caller that gets a resolved value
 * back can pass `resolvedTier` straight to `runReview` (see
 * `RunReviewParams.resolvedTier` in reviewer.ts) with no further checks.
 */
export async function resolveTier(config: Config, deps: ResolveTierDeps = {}): Promise<TierSelectionResult> {
  const execFileFn = deps.execFileFn ?? execFileAsync;
  const env = deps.env ?? process.env;

  // Validate the acknowledgement env var's FORMAT up front, unconditionally
  // -- see parseAckTier's doc comment for why this can't wait until we know
  // whether it's actually needed.
  const acknowledgedTier = parseAckTier(env.MAGPIE_ACK_TIER);

  const requestedTier = config.container.tier;
  const probe = await probeTier(config, execFileFn);
  const availability = computeAvailability(probe);
  const strongest = pickStrongestAvailable(availability);

  const reasons: string[] = [
    `kvm: ${probe.kvm.available ? "available (KVM_CREATE_VM succeeded)" : `unavailable (${probe.kvm.reason})`}`,
    `microvm launcher (${probe.microvmLauncher.binary}): ${
      probe.microvmLauncher.present ? "present" : `absent (${probe.microvmLauncher.reason})`
    }`,
    `microvm.rootfs_path configured: ${probe.microvmRootfsConfigured}`,
    `crun runtime (${probe.crunRuntime.binary}): ${
      probe.crunRuntime.present ? `present (${probe.crunRuntime.version ?? "version unknown"})` : `absent (${probe.crunRuntime.reason})`
    }`,
  ];

  if (strongest === null) {
    reasons.push("resolution: FAILED -- no isolation tier is usable on this host at all");
    throw new TierSelectionError(
      "no isolation tier is usable on this host at all: " +
        `micro-VM unavailable (${explainTierUnavailable("microvm", probe)}); ` +
        `crun-floor unavailable (${explainTierUnavailable("crun", probe)}). ` +
        "Magpie refuses to start with no working review sandbox at all -- at minimum, install/" +
        "configure a working container runtime (config.container.docker_bin) to run the crun floor.",
    );
  }

  const resolvedTier = strongest;
  const degraded = TIER_RANK[resolvedTier] < TIER_RANK[requestedTier];

  if (degraded && acknowledgedTier !== resolvedTier) {
    reasons.push(
      `resolution: FAILED -- degraded from requested "${requestedTier}" to "${resolvedTier}", unacknowledged`,
    );
    throw new TierSelectionError(
      `isolation-tier DEGRADATION: configured tier is "${requestedTier}", but the strongest tier ` +
        `actually available on this host is "${resolvedTier}" (${requestedTier} unavailable: ` +
        `${explainTierUnavailable(requestedTier, probe)}). Magpie refuses to silently run a weaker ` +
        "isolation posture than configured over untrusted PR content -- this is the exact silent-" +
        "degradation failure mode the isolation ladder (see " +
        "docs/design/cto-decision-brief.md §5) exists to prevent. To proceed anyway on this host, an " +
        `operator must explicitly acknowledge the weaker tier by setting MAGPIE_ACK_TIER=${resolvedTier} ` +
        "in the environment (NOT config.toml -- see parseAckTier's doc comment for why this is " +
        "deliberately not a persisted config default).",
    );
  }

  reasons.push(
    `resolution: "${resolvedTier}"${degraded ? ` (DEGRADED from requested "${requestedTier}", acknowledged via MAGPIE_ACK_TIER)` : ""}`,
  );

  return {
    resolvedTier,
    requestedTier,
    degraded,
    acknowledgedTier,
    probe,
    availability,
    reasons,
  };
}
