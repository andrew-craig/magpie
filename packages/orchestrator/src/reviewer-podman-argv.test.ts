// M8-B2 rootless-podman golden test (task_08ec) — the companion to the M8-B1
// docker floor golden (reviewer-crun-floor-argv.test.ts).
//
// As of M8-B2 the DEFAULT review-container runtime is rootless podman (crun),
// and the port adds exactly ONE argv difference vs the docker path:
// `--userns=keep-id`, injected immediately after `--user <uid>:<gid>` (see
// reviewer.ts's isPodmanBinary / buildReviewDockerArgs). That flag is a
// rootless uid-mapping shim so the container can write /out/findings.json back
// owned by the orchestrator's own uid — it is NOT a hardening flag, and every
// hardened flag is byte-for-byte identical to the docker golden.
//
// Two goldens are kept deliberately:
//   - reviewer-crun-floor-argv.test.ts pins the DOCKER argv (dockerBin:"docker"
//     config, no keep-id) — the CTO edit #3 floor invariant, UNCHANGED by
//     M8-B2.
//   - THIS test pins the PODMAN argv (the shipped default), so the rootless
//     posture that actually runs is equally drift-protected: any hardened flag
//     added/removed/reordered/renamed — OR keep-id silently dropped/moved —
//     fails here loudly and forces a visible fixture diff.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Config } from "./config.js";
import { buildReviewDockerArgs, isPodmanBinary } from "./reviewer.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Fixed, non-production inputs — identical to the floor golden's GOLDEN_INPUT. */
const GOLDEN_INPUT = {
  containerName: "magpie-golden-job",
  uid: 1000,
  gid: 1000,
  mountDir: "/golden/work",
  outDir: "/golden/out",
  gatewaySocketDir: "/golden/gw",
} as const;

/** Fixed Config — mirrors the floor golden's GOLDEN_CONFIG exactly EXCEPT dockerBin: "podman" (the M8-B2 default). */
const GOLDEN_CONFIG: Config = {
  github: { appId: "123", privateKeyPath: null },
  llm: { baseUrl: "https://example.com/v1", model: "some/model" },
  server: { host: "127.0.0.1", port: 0 },
  limits: { jobTimeoutSeconds: 600, concurrency: 2, maxDiffLines: 4000 },
  repoAllowlist: [],
  workspace: { workDir: "/tmp/magpie-work" },
  container: {
    image: "magpie-reviewer:0.1.0",
    memory: "4g",
    cpus: "2",
    pidsLimit: 256,
    dockerBin: "podman",
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

interface GoldenFixture {
  argv: string[];
}

function loadGoldenFixture(): GoldenFixture {
  const path = join(__dirname, "__fixtures__", "reviewer-podman-argv.golden.json");
  return JSON.parse(readFileSync(path, "utf-8")) as GoldenFixture;
}

describe("buildReviewDockerArgs (M8-B2 rootless-podman default posture)", () => {
  it("matches the committed podman golden argv byte-for-byte", () => {
    const golden = loadGoldenFixture();
    // config.container.dockerBin is "podman", so no explicit dockerBin param is
    // needed — the builder defaults to it.
    const actual = buildReviewDockerArgs({ ...GOLDEN_INPUT, config: GOLDEN_CONFIG });
    expect(actual).toEqual(golden.argv);
  });

  it("also selects podman when only the dockerBin param (not config) is podman", () => {
    // In production runReview passes the resolved binary (honouring piBinary)
    // as `dockerBin`; assert that path drives keep-id even with a docker config.
    const dockerConfig: Config = { ...GOLDEN_CONFIG, container: { ...GOLDEN_CONFIG.container, dockerBin: "docker" } };
    const actual = buildReviewDockerArgs({ ...GOLDEN_INPUT, dockerBin: "/usr/bin/podman", config: dockerConfig });
    expect(actual).toContain("--userns=keep-id");
  });

  it("injects --userns=keep-id immediately after the --user value (uid-mapping stays adjacent)", () => {
    const argv = buildReviewDockerArgs({ ...GOLDEN_INPUT, config: GOLDEN_CONFIG });
    const userIdx = argv.indexOf("--user");
    expect(userIdx).toBeGreaterThanOrEqual(0);
    expect(argv[userIdx + 1]).toBe("1000:1000");
    expect(argv[userIdx + 2]).toBe("--userns=keep-id");
  });

  it("the podman argv is the docker floor argv plus exactly one token (--userns=keep-id)", () => {
    const podmanArgv = buildReviewDockerArgs({ ...GOLDEN_INPUT, config: GOLDEN_CONFIG });
    const dockerArgv = buildReviewDockerArgs({
      ...GOLDEN_INPUT,
      config: { ...GOLDEN_CONFIG, container: { ...GOLDEN_CONFIG.container, dockerBin: "docker" } },
    });
    expect(podmanArgv.length).toBe(dockerArgv.length + 1);
    expect(podmanArgv.filter((t) => t !== "--userns=keep-id")).toEqual(dockerArgv);
  });

  it("does NOT add --userns=keep-id for a docker binary (floor-golden invariant preserved)", () => {
    const dockerArgv = buildReviewDockerArgs({
      ...GOLDEN_INPUT,
      config: { ...GOLDEN_CONFIG, container: { ...GOLDEN_CONFIG.container, dockerBin: "docker" } },
    });
    expect(dockerArgv).not.toContain("--userns=keep-id");
  });
});

describe("isPodmanBinary", () => {
  it("is true only for a `podman` basename (bare name or full path)", () => {
    expect(isPodmanBinary("podman")).toBe(true);
    expect(isPodmanBinary("/usr/bin/podman")).toBe(true);
    expect(isPodmanBinary("/usr/local/bin/podman")).toBe(true);
  });

  it("is false for docker and other docker-compatible clients", () => {
    expect(isPodmanBinary("docker")).toBe(false);
    expect(isPodmanBinary("/usr/bin/docker")).toBe(false);
    expect(isPodmanBinary("nerdctl")).toBe(false);
    expect(isPodmanBinary("podman-remote")).toBe(false);
  });
});
