// M8-C3 (task_39ff) micro-VM tier argv builder tests — the counterpart to
// reviewer-crun-floor-argv.test.ts/reviewer-podman-argv.test.ts, but for
// `buildMicrovmLaunchArgs` (the `magpie-krun-launch` argv builder) rather
// than `buildReviewDockerArgs`.
//
// Unlike the crun-tier tests, this is NOT a byte-for-byte golden-fixture
// pin (the micro-VM tier is new, opt-in, and not the shipped default — there
// is no "floor" to protect yet). Instead this file exercises:
//   - the argv SHAPE (every flag present, in the documented pairing);
//   - the uid-split / CTO-edit-1 MERGE-BLOCKER invariant: the gateway
//     virtual key value must NEVER appear anywhere in the returned argv —
//     only its NAME, via `--env-from-host OPENROUTER_API_KEY`;
//   - findMissingMicrovmFlags's fail-closed preflight.

import { describe, expect, it } from "vitest";
import {
  buildMicrovmLaunchArgs,
  findMicrovmNetworkTransportViolations,
  findMissingMicrovmFlags,
} from "./reviewer.js";

/** A representative, fully-populated set of inputs — mirrors a real runReview() call under the microvm tier. */
const GOLDEN_INPUT = {
  rootfsPath: "/var/lib/magpie/microvm-rootfs",
  execPath: "/opt/magpie/entrypoint.sh",
  execArgs: ["--provider", "openrouter", "--model", "some/model"],
  vcpus: 2,
  ramMib: 1024,
  uid: 10001,
  gid: 10001,
  workdir: "/work",
  envFromHost: ["OPENROUTER_API_KEY"],
  env: {
    OPENAI_BASE_URL: "http://127.0.0.1:4000/v1",
    MAGPIE_REQUIRE_MEMORY_LIMIT: "true",
    MAGPIE_MICROVM_RAM_MIB: "1024",
    // M8-E5 (task_a749): the uid/gid entrypoint.sh drops to in the guest.
    // Deliberately equal to `uid`/`gid` above — that equality IS the fix (see
    // the dedicated test below and reviewer.ts's call site).
    MAGPIE_MICROVM_REVIEWER_UID: "10001",
    MAGPIE_MICROVM_REVIEWER_GID: "10001",
  },
  vsockPort: 1234,
  vsockUdsPath: "/run/magpie-gateway/jobs/job-1/gw.sock",
  workMountHostPath: "/var/lib/magpie/work/job-1",
  outMountHostPath: "/var/lib/magpie/work/job-1-out",
} as const;

/**
 * A fixture value shaped like a REAL minted gateway virtual key
 * (packages/gateway/src/keystore.ts's `sk-magpie-` prefix) — used ONLY to
 * prove it never leaks onto the argv this module returns; `runReview` never
 * passes a key value into `buildMicrovmLaunchArgs` at all (only into the
 * process `env` it spawns with), so this constant exists purely as
 * "the thing that must not appear", not as an actual input to the builder.
 */
const FIXTURE_SECRET_KEY = "sk-magpie-should-never-appear-on-argv";

describe("buildMicrovmLaunchArgs", () => {
  it("produces the documented flag/value pairs, in order", () => {
    const argv = buildMicrovmLaunchArgs({ ...GOLDEN_INPUT });
    expect(argv).toEqual([
      "--rootfs",
      "/var/lib/magpie/microvm-rootfs",
      "--exec",
      "/opt/magpie/entrypoint.sh",
      "--arg",
      "--provider",
      "--arg",
      "openrouter",
      "--arg",
      "--model",
      "--arg",
      "some/model",
      "--vcpus",
      "2",
      "--ram-mib",
      "1024",
      "--uid",
      "10001",
      "--gid",
      "10001",
      "--workdir",
      "/work",
      "--env-from-host",
      "OPENROUTER_API_KEY",
      "--env",
      "OPENAI_BASE_URL=http://127.0.0.1:4000/v1",
      "--env",
      "MAGPIE_REQUIRE_MEMORY_LIMIT=true",
      "--env",
      "MAGPIE_MICROVM_RAM_MIB=1024",
      "--env",
      "MAGPIE_MICROVM_REVIEWER_UID=10001",
      "--env",
      "MAGPIE_MICROVM_REVIEWER_GID=10001",
      "--vsock-port",
      "1234",
      "--vsock-uds",
      "/run/magpie-gateway/jobs/job-1/gw.sock",
      "--work-mount",
      "/var/lib/magpie/work/job-1:work",
      "--out-mount",
      "/var/lib/magpie/work/job-1-out:out",
    ]);
  });

  it("defaults the work-mount/out-mount tags to work/out when not overridden", () => {
    const argv = buildMicrovmLaunchArgs({ ...GOLDEN_INPUT });
    expect(argv).toContain("--work-mount");
    expect(argv[argv.indexOf("--work-mount") + 1]).toBe("/var/lib/magpie/work/job-1:work");
    expect(argv[argv.indexOf("--out-mount") + 1]).toBe("/var/lib/magpie/work/job-1-out:out");
  });

  it("honours explicit work-mount/out-mount tag overrides", () => {
    const argv = buildMicrovmLaunchArgs({ ...GOLDEN_INPUT, workMountTag: "pr", outMountTag: "findings" });
    expect(argv[argv.indexOf("--work-mount") + 1]).toBe("/var/lib/magpie/work/job-1:pr");
    expect(argv[argv.indexOf("--out-mount") + 1]).toBe("/var/lib/magpie/work/job-1-out:findings");
  });

  // M8-E3 (task_2541): entrypoint.sh cross-checks this inline env var against
  // the guest's own /proc/meminfo MemTotal as its positive proof that
  // libkrun's --ram-mib ceiling (the SAME ramMib value, passed a few flags
  // earlier) actually applied — see reviewer.ts's runReview call site and
  // that script's memory-ceiling section. Pinned separately from the golden
  // array above so a future refactor that renamed/dropped this key gets a
  // targeted failure, not just a golden-array diff.
  it("passes the configured ram-mib as the non-secret MAGPIE_MICROVM_RAM_MIB inline env var", () => {
    const argv = buildMicrovmLaunchArgs({ ...GOLDEN_INPUT });
    const idx = argv.indexOf("MAGPIE_MICROVM_RAM_MIB=1024");
    expect(idx).toBeGreaterThan(0);
    expect(argv[idx - 1]).toBe("--env");
  });

  // M8-E5 (task_a749): pinned separately from the golden array so a rename or
  // drop of either key gets a targeted failure. The value equality with
  // --uid/--gid is what matters — see reviewer.ts's call site, which binds both
  // from the same `hostUid`/`hostGid` locals, and reviewer.test.ts's
  // runReview-level assertion against the real process uid.
  it("passes the reviewer uid/gid as inline env vars matching --uid/--gid", () => {
    const argv = buildMicrovmLaunchArgs({ ...GOLDEN_INPUT });
    const flagUid = argv[argv.indexOf("--uid") + 1];
    const flagGid = argv[argv.indexOf("--gid") + 1];

    const uidIdx = argv.indexOf(`MAGPIE_MICROVM_REVIEWER_UID=${flagUid}`);
    expect(uidIdx).toBeGreaterThan(0);
    expect(argv[uidIdx - 1]).toBe("--env");

    const gidIdx = argv.indexOf(`MAGPIE_MICROVM_REVIEWER_GID=${flagGid}`);
    expect(gidIdx).toBeGreaterThan(0);
    expect(argv[gidIdx - 1]).toBe("--env");
  });

  it("uses --env-from-host (name only) for OPENROUTER_API_KEY, never --env with a value", () => {
    const argv = buildMicrovmLaunchArgs({ ...GOLDEN_INPUT });
    const idx = argv.indexOf("--env-from-host");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(argv[idx + 1]).toBe("OPENROUTER_API_KEY");
    // Never appears as the VALUE half of a plain --env pair.
    expect(argv).not.toContain("--env=OPENROUTER_API_KEY");
    expect(argv.some((tok) => tok.startsWith("OPENROUTER_API_KEY="))).toBe(false);
  });

  // --- uid-split / CTO-edit-1 MERGE BLOCKER --------------------------------
  it("never contains a gateway-virtual-key-shaped value anywhere in the argv (structural: the builder has no parameter that could carry one)", () => {
    const argv = buildMicrovmLaunchArgs({ ...GOLDEN_INPUT });
    expect(argv.join(" ")).not.toContain(FIXTURE_SECRET_KEY);
    expect(argv.some((tok) => tok.startsWith("sk-magpie-"))).toBe(false);
  });

  it("passing a credential-shaped string as an env value only ever reaches a NON-secret key, never OPENROUTER_API_KEY (documents the caller contract)", () => {
    // buildMicrovmLaunchArgs's `env` param is for NON-secret values only —
    // reviewer.ts's actual production call site never puts the gateway key
    // there (it goes through envFromHost, resolved from the launcher's own
    // process env instead). This test pins that contract: even if a caller
    // mistakenly tried to route a secret through `env`, the resulting argv
    // would make that mistake VISIBLE (a `--env OPENROUTER_API_KEY=<value>`
    // token), not hidden — nothing in this builder silently drops or masks
    // an `env` entry.
    const argv = buildMicrovmLaunchArgs({
      ...GOLDEN_INPUT,
      envFromHost: [],
      env: { ...GOLDEN_INPUT.env },
    });
    expect(argv).not.toContain("--env-from-host");
    // No OPENROUTER_API_KEY anywhere when envFromHost is empty and env
    // doesn't mention it — confirms the ONLY path that can name that
    // variable is envFromHost.
    expect(argv.some((tok) => tok.includes("OPENROUTER_API_KEY"))).toBe(false);
  });
});

describe("findMissingMicrovmFlags", () => {
  it("returns [] for a fully-populated argv", () => {
    const argv = buildMicrovmLaunchArgs({ ...GOLDEN_INPUT });
    expect(findMissingMicrovmFlags(argv)).toEqual([]);
  });

  it("flags a root uid", () => {
    const argv = buildMicrovmLaunchArgs({ ...GOLDEN_INPUT, uid: 0 });
    expect(findMissingMicrovmFlags(argv)).toContain("--uid <non-root>");
  });

  it("flags a root gid", () => {
    const argv = buildMicrovmLaunchArgs({ ...GOLDEN_INPUT, gid: 0 });
    expect(findMissingMicrovmFlags(argv)).toContain("--gid <non-root>");
  });

  it("flags a missing vsock pair", () => {
    const argv = buildMicrovmLaunchArgs({ ...GOLDEN_INPUT }).filter(
      (tok, i, arr) => tok !== "--vsock-port" && tok !== "--vsock-uds" && arr[i - 1] !== "--vsock-port" && arr[i - 1] !== "--vsock-uds",
    );
    expect(findMissingMicrovmFlags(argv)).toContain("--vsock-port/--vsock-uds pair");
  });

  it("flags a missing --work-mount", () => {
    const argv = buildMicrovmLaunchArgs({ ...GOLDEN_INPUT }).filter(
      (tok, i, arr) => tok !== "--work-mount" && arr[i - 1] !== "--work-mount",
    );
    expect(findMissingMicrovmFlags(argv)).toContain("--work-mount");
  });

  it("flags a missing --out-mount", () => {
    const argv = buildMicrovmLaunchArgs({ ...GOLDEN_INPUT }).filter(
      (tok, i, arr) => tok !== "--out-mount" && arr[i - 1] !== "--out-mount",
    );
    expect(findMissingMicrovmFlags(argv)).toContain("--out-mount");
  });

  it("flags a missing --rootfs", () => {
    const argv = buildMicrovmLaunchArgs({ ...GOLDEN_INPUT }).filter(
      (tok, i, arr) => tok !== "--rootfs" && arr[i - 1] !== "--rootfs",
    );
    expect(findMissingMicrovmFlags(argv)).toContain("--rootfs");
  });

  it("reports every missing flag at once, not just the first", () => {
    expect(findMissingMicrovmFlags([]).length).toBeGreaterThanOrEqual(6);
  });
});

// M8-C4 (task_3b48) Layer 2 — install/launch preflight: the argv this
// module produces must never enable a network transport (no TSI/passt, no
// virtio-net device — see rust/magpie-microvm-launcher/src/krun.rs's
// "LAYER 1 PIN"). This launcher's CLI has no such flag today, so these
// tests exist to catch a FUTURE regression, not because the golden argv is
// expected to ever trip them.
describe("findMicrovmNetworkTransportViolations", () => {
  it("returns [] for the real builder's output — no network-enabling flag is ever emitted", () => {
    const argv = buildMicrovmLaunchArgs({ ...GOLDEN_INPUT });
    expect(findMicrovmNetworkTransportViolations(argv)).toEqual([]);
  });

  it("returns [] for an empty argv (nothing to violate)", () => {
    expect(findMicrovmNetworkTransportViolations([])).toEqual([]);
  });

  it("catches a disallowed flag if one is ever accidentally present", () => {
    const argv = [...buildMicrovmLaunchArgs({ ...GOLDEN_INPUT }), "--tsi-hijack", "on"];
    expect(findMicrovmNetworkTransportViolations(argv)).toContain("--tsi-hijack");
  });

  it("catches every disallowed flag present, not just the first", () => {
    const argv = ["--net", "bridge", "--passt", "--virtio-net"];
    const violations = findMicrovmNetworkTransportViolations(argv);
    expect(violations).toEqual(expect.arrayContaining(["--net", "--passt", "--virtio-net"]));
    expect(violations.length).toBeGreaterThanOrEqual(3);
  });
});
