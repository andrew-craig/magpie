import { describe, expect, it } from "vitest";
import type { Config } from "./config.js";
import type { ExecFileFn } from "./docker.js";
import {
  computeAvailability,
  parseAckTier,
  pickStrongestAvailable,
  probeTier,
  resolveTier,
  TierSelectionError,
  type TierAvailability,
  type TierProbe,
} from "./tier-ladder.js";

// NOTE: everything here runs fully offline — no real /dev/kvm ioctl, no real
// podman/docker daemon, no real magpie-krun-launch. `ExecFileFn` (the same
// test seam docker.ts's assertDockerAvailable uses) is faked directly rather
// than via a throwaway spawned script (reviewer.test.ts's heavier pattern) —
// this module never spawns docker with a full argv contract to reproduce, it
// only ever runs one of three simple probe binaries and reads their exit
// code/stdout, so a plain async function fake is enough.

/** A minimal-but-valid Config, mirroring reviewer.test.ts's/docker.test.ts's `testConfig` convention. */
function testConfig(
  overrides: { container?: Partial<Config["container"]>; microvm?: Partial<Config["microvm"]> } = {},
): Config {
  return {
    github: { appId: "123", privateKeyPath: null },
    llm: { baseUrl: "https://example.com/v1", model: "some/model", allowedModels: [] },
    server: { host: "127.0.0.1", port: 0 },
    limits: { jobTimeoutSeconds: 600, concurrency: 2, maxDiffLines: 4000 },
    repoAllowlist: [],
    workspace: { workDir: "/tmp/magpie-work" },
    container: {
      image: "magpie-reviewer:0.1.0",
      memory: "4g",
      requireMemoryLimit: true,
      cpus: "2",
      pidsLimit: 256,
      dockerBin: "docker",
      tier: "crun",
      tierProbeBin: "magpie-tier-probe",
      ...overrides.container,
    },
    microvm: {
      ramMib: 1024,
      vcpus: 2,
      rootfsPath: "",
      hostRamBudgetMib: 4096,
      launcherBin: "magpie-krun-launch",
      ...overrides.microvm,
    },
    gateway: {
      baseUrl: "http://127.0.0.1:4100",
      containerBaseUrl: "http://127.0.0.1:4000/v1",
      perJobBudgetUsd: 0.5,
      ttlMarginSeconds: 120,
    },
    telemetry: { path: "/tmp/magpie-telemetry-test.jsonl" },
    secrets: {
      webhookSecret: "test-webhook-secret",
      githubPrivateKey: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n",
      gatewayMasterKey: "test-gateway-master-key",
    },
  };
}

/** One canned response for a fake `ExecFileFn`, keyed by the exact binary path/name it's invoked with. */
type FakeExecBehavior =
  | { kind: "resolve"; stdout: string }
  | { kind: "reject-enoent" }
  | { kind: "reject-nonzero"; stdout?: string; message?: string };

/** Builds an `ExecFileFn` fake that dispatches purely on `file` (the binary), ignoring `args` — every probe in this module invokes each binary exactly one way, so no test here needs argv-sensitive behavior. Mirrors docker.test.ts's `fakeExec` convention, generalized to multiple binaries. */
function fakeExecFileFn(behaviors: Record<string, FakeExecBehavior>): ExecFileFn {
  return async (file) => {
    const behavior = behaviors[file];
    if (behavior === undefined) {
      throw Object.assign(new Error(`test fake: no behavior registered for "${file}"`), { code: "ENOENT" });
    }
    if (behavior.kind === "resolve") {
      return { stdout: behavior.stdout, stderr: "" };
    }
    if (behavior.kind === "reject-enoent") {
      throw Object.assign(new Error(`spawn ${file} ENOENT`), { code: "ENOENT" });
    }
    throw Object.assign(new Error(behavior.message ?? `${file} exited non-zero`), {
      code: 1,
      stdout: behavior.stdout,
    });
  };
}

const KVM_TRUE_STDOUT = JSON.stringify({ kvm: true, reason: null }) + "\n";
const KVM_FALSE_STDOUT = JSON.stringify({ kvm: false, reason: "open(/dev/kvm) failed: no such file" }) + "\n";

describe("parseAckTier", () => {
  it("returns null when unset or empty", () => {
    expect(parseAckTier(undefined)).toBeNull();
    expect(parseAckTier("")).toBeNull();
  });

  it("accepts each known tier exactly", () => {
    expect(parseAckTier("microvm")).toBe("microvm");
    expect(parseAckTier("crun")).toBe("crun");
  });

  it("throws TierSelectionError for an unrecognized value (typo, wrong case, whitespace)", () => {
    expect(() => parseAckTier("cru")).toThrow(TierSelectionError);
    expect(() => parseAckTier("CRUN")).toThrow(TierSelectionError);
    expect(() => parseAckTier(" crun")).toThrow(TierSelectionError);
    expect(() => parseAckTier("crun ")).toThrow(TierSelectionError);
  });
});

describe("computeAvailability", () => {
  function probeWith(overrides: Partial<TierProbe> = {}): TierProbe {
    return {
      kvm: { available: true, reason: null },
      microvmLauncher: { present: true, binary: "magpie-krun-launch" },
      microvmRootfsConfigured: true,
      crunRuntime: { present: true, binary: "podman", version: "podman version 4.3.1" },
      ...overrides,
    };
  }

  it("microvm requires kvm + launcher + rootfs all together", () => {
    expect(computeAvailability(probeWith()).microvm).toBe(true);
    expect(computeAvailability(probeWith({ kvm: { available: false, reason: "x" } })).microvm).toBe(false);
    expect(
      computeAvailability(probeWith({ microvmLauncher: { present: false, binary: "x", reason: "y" } })).microvm,
    ).toBe(false);
    expect(computeAvailability(probeWith({ microvmRootfsConfigured: false })).microvm).toBe(false);
  });

  it("crun tracks the runtime probe directly", () => {
    expect(computeAvailability(probeWith()).crun).toBe(true);
    expect(
      computeAvailability(probeWith({ crunRuntime: { present: false, binary: "podman", reason: "not found" } }))
        .crun,
    ).toBe(false);
  });
});

describe("pickStrongestAvailable", () => {
  it("prefers microvm > crun, in that order", () => {
    expect(pickStrongestAvailable({ microvm: true, crun: true })).toBe("microvm");
    expect(pickStrongestAvailable({ microvm: false, crun: true })).toBe("crun");
  });

  it("returns null when nothing is available", () => {
    expect(pickStrongestAvailable({ microvm: false, crun: false })).toBeNull();
  });
});

describe("probeTier", () => {
  it("reports kvm:true, launcher present, and crun runtime present when every probe succeeds", async () => {
    const exec = fakeExecFileFn({
      "magpie-tier-probe": { kind: "resolve", stdout: KVM_TRUE_STDOUT },
      "magpie-krun-launch": { kind: "resolve", stdout: "usage: magpie-krun-launch ...\n" },
      podman: { kind: "resolve", stdout: "podman version 4.3.1\n" },
    });
    const probe = await probeTier(testConfig({ container: { dockerBin: "podman" } }), exec);
    expect(probe.kvm).toEqual({ available: true, reason: null });
    expect(probe.microvmLauncher.present).toBe(true);
    expect(probe.crunRuntime).toEqual({ present: true, binary: "podman", version: "podman version 4.3.1" });
  });

  it("parses a magpie-tier-probe exit-1 (kvm:false) result as an ordinary negative answer, not an error", async () => {
    const exec = fakeExecFileFn({
      "magpie-tier-probe": { kind: "reject-nonzero", stdout: KVM_FALSE_STDOUT },
      "magpie-krun-launch": { kind: "resolve", stdout: "" },
      podman: { kind: "resolve", stdout: "podman version 4.3.1\n" },
    });
    const probe = await probeTier(testConfig({ container: { dockerBin: "podman" } }), exec);
    expect(probe.kvm.available).toBe(false);
    expect(probe.kvm.reason).toBe("open(/dev/kvm) failed: no such file");
  });

  it("treats a missing magpie-tier-probe binary (ENOENT) as kvm unavailable with an actionable reason", async () => {
    const exec = fakeExecFileFn({
      "magpie-krun-launch": { kind: "resolve", stdout: "" },
      podman: { kind: "resolve", stdout: "podman version 4.3.1\n" },
    });
    const probe = await probeTier(testConfig({ container: { dockerBin: "podman" } }), exec);
    expect(probe.kvm.available).toBe(false);
    expect(probe.kvm.reason).toContain("was not found on PATH");
  });

  it("treats unparseable magpie-tier-probe stdout as kvm unavailable rather than throwing", async () => {
    const exec = fakeExecFileFn({
      "magpie-tier-probe": { kind: "resolve", stdout: "not json\n" },
      "magpie-krun-launch": { kind: "resolve", stdout: "" },
      podman: { kind: "resolve", stdout: "podman version 4.3.1\n" },
    });
    const probe = await probeTier(testConfig({ container: { dockerBin: "podman" } }), exec);
    expect(probe.kvm.available).toBe(false);
    expect(probe.kvm.reason).toContain("unparseable output");
  });

  it("reports the launcher/runtime absent (ENOENT) with a clear reason", async () => {
    const exec = fakeExecFileFn({
      "magpie-tier-probe": { kind: "resolve", stdout: KVM_TRUE_STDOUT },
      // magpie-krun-launch and podman deliberately unregistered -> ENOENT
    });
    const probe = await probeTier(testConfig({ container: { dockerBin: "podman" } }), exec);
    expect(probe.microvmLauncher.present).toBe(false);
    expect(probe.microvmLauncher.reason).toContain("was not found on PATH");
    expect(probe.crunRuntime.present).toBe(false);
    expect(probe.crunRuntime.reason).toContain("was not found on PATH");
  });
});

describe("resolveTier", () => {
  /** Every probe succeeding fully: kvm true, launcher present, crun runtime present. */
  function fullySuccessfulExec(dockerBin = "podman"): ExecFileFn {
    return fakeExecFileFn({
      "magpie-tier-probe": { kind: "resolve", stdout: KVM_TRUE_STDOUT },
      "magpie-krun-launch": { kind: "resolve", stdout: "" },
      [dockerBin]: { kind: "resolve", stdout: `${dockerBin} version 4.3.1\n` },
    });
  }

  it("(a) selects micro-VM when configured tier is microvm and kvm+launcher+rootfs are all present", async () => {
    const config = testConfig({
      container: { tier: "microvm", dockerBin: "podman" },
      microvm: { rootfsPath: "/var/lib/magpie/rootfs" },
    });
    const result = await resolveTier(config, { execFileFn: fullySuccessfulExec(), env: {} });
    expect(result.resolvedTier).toBe("microvm");
    expect(result.requestedTier).toBe("microvm");
    expect(result.degraded).toBe(false);
    expect(result.acknowledgedTier).toBeNull();
    expect(result.availability).toEqual({ microvm: true, crun: true });
  });

  it("(b) fails loud when the configured tier (microvm) is unavailable and no acknowledgement is set", async () => {
    // kvm unavailable (ENOENT'd probe binary), rootfs never configured -> microvm
    // unavailable; crun runtime present -> strongest available is "crun", weaker
    // than the requested "microvm".
    const config = testConfig({ container: { tier: "microvm", dockerBin: "podman" } });
    const exec = fakeExecFileFn({
      podman: { kind: "resolve", stdout: "podman version 4.3.1\n" },
    });

    await expect(resolveTier(config, { execFileFn: exec, env: {} })).rejects.toThrow(TierSelectionError);
    await expect(resolveTier(config, { execFileFn: exec, env: {} })).rejects.toThrow(
      /MAGPIE_ACK_TIER=crun/,
    );
  });

  it("(c) allows the crun degradation when MAGPIE_ACK_TIER=crun is set", async () => {
    const config = testConfig({ container: { tier: "microvm", dockerBin: "podman" } });
    const exec = fakeExecFileFn({
      podman: { kind: "resolve", stdout: "podman version 4.3.1\n" },
    });

    const result = await resolveTier(config, { execFileFn: exec, env: { MAGPIE_ACK_TIER: "crun" } });
    expect(result.resolvedTier).toBe("crun");
    expect(result.requestedTier).toBe("microvm");
    expect(result.degraded).toBe(true);
    expect(result.acknowledgedTier).toBe("crun");
  });

  it("does not accept an acknowledgement for a DIFFERENT tier than the one actually resolved", async () => {
    // Ack says "microvm" (the requested tier, not what's actually available),
    // but the real degradation lands on "crun" -- the ack must match the
    // RESOLVED tier exactly, not just be "any valid ack is present".
    const config = testConfig({ container: { tier: "microvm", dockerBin: "podman" } });
    const exec = fakeExecFileFn({
      podman: { kind: "resolve", stdout: "podman version 4.3.1\n" },
    });

    await expect(resolveTier(config, { execFileFn: exec, env: { MAGPIE_ACK_TIER: "microvm" } })).rejects.toThrow(
      TierSelectionError,
    );
  });

  it("throws immediately on an invalid MAGPIE_ACK_TIER value, even before probing", async () => {
    const config = testConfig({ container: { tier: "crun", dockerBin: "podman" } });
    const exec = fakeExecFileFn({ podman: { kind: "resolve", stdout: "podman version 4.3.1\n" } });
    await expect(
      resolveTier(config, { execFileFn: exec, env: { MAGPIE_ACK_TIER: "not-a-tier" } }),
    ).rejects.toThrow(/not a recognized isolation tier/);
  });

  it("throws when no tier is usable at all (even the crun floor)", async () => {
    const config = testConfig({ container: { tier: "crun", dockerBin: "podman" } });
    const exec = fakeExecFileFn({}); // every binary ENOENTs
    await expect(resolveTier(config, { execFileFn: exec, env: {} })).rejects.toThrow(
      /no isolation tier is usable on this host at all/,
    );
  });

  it("resolves crun with no degradation when requested tier is crun and only crun is available", async () => {
    const config = testConfig({ container: { tier: "crun", dockerBin: "podman" } });
    const exec = fakeExecFileFn({ podman: { kind: "resolve", stdout: "podman version 4.3.1\n" } });
    const result = await resolveTier(config, { execFileFn: exec, env: {} });
    expect(result.resolvedTier).toBe("crun");
    expect(result.degraded).toBe(false);
  });

  it("auto-selects the strongest AVAILABLE tier even when it exceeds the configured tier (upgrade is never a degradation)", async () => {
    // An operator who has fully provisioned microvm.rootfs_path (and the host
    // genuinely has KVM + the launcher) but left container.tier at the "crun"
    // default gets the stronger tier -- see tier-ladder.ts's module doc
    // comment ("WHY THIS MODULE SELECTS THE STRONGEST AVAILABLE TIER...") for
    // why this is intentional and why it's safe (microvm can only ever look
    // "available" once rootfs is deliberately configured).
    const config = testConfig({
      container: { tier: "crun", dockerBin: "podman" },
      microvm: { rootfsPath: "/var/lib/magpie/rootfs" },
    });
    const result = await resolveTier(config, { execFileFn: fullySuccessfulExec(), env: {} });
    expect(result.resolvedTier).toBe("microvm");
    expect(result.requestedTier).toBe("crun");
    expect(result.degraded).toBe(false);
  });

  it("populates a human-readable reasons trail ending in the final resolution", async () => {
    const config = testConfig({ container: { tier: "crun", dockerBin: "podman" } });
    const exec = fakeExecFileFn({ podman: { kind: "resolve", stdout: "podman version 4.3.1\n" } });
    const result = await resolveTier(config, { execFileFn: exec, env: {} });
    expect(result.reasons.length).toBeGreaterThan(0);
    expect(result.reasons.at(-1)).toContain('resolution: "crun"');
  });
});

// Exercise TierAvailability's shape is exactly what pickStrongestAvailable/computeAvailability agree on.
describe("TierAvailability shape sanity", () => {
  it("has exactly the two ladder tiers as keys", () => {
    const availability: TierAvailability = { microvm: false, crun: false };
    expect(Object.keys(availability).sort()).toEqual(["crun", "microvm"]);
  });
});
