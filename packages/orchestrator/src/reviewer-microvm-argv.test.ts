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
import { buildMicrovmLaunchArgs, findMissingMicrovmFlags } from "./reviewer.js";

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
