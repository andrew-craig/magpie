// M8-B2 / task_bfaf — runtime fail-closed hardened-flag preflight tests.
//
// findMissingHardenedFlags() is the RUNTIME counterpart (CTO binding edit #3's
// "CI or preflight" language) to the M8-B1 build-time floor golden: it runs on
// the real, fully-templated argv immediately before spawn and returns the
// labels of any hardened flags that regressed, so runReview can fail the job
// CLOSED (loud log + {ok:false}) instead of launching an under-hardened
// container over untrusted PR content. These tests assert it passes today's
// shipped argv (both runtimes) and fails closed on each individual flag being
// dropped or weakened.

import { describe, expect, it } from "vitest";
import type { Config } from "./config.js";
import { buildReviewDockerArgs, findMissingHardenedFlags } from "./reviewer.js";

const INPUT = {
  containerName: "magpie-test",
  uid: 1000,
  gid: 1000,
  mountDir: "/w",
  outDir: "/o",
  gatewaySocketDir: "/g",
} as const;

const CONFIG: Config = {
  github: { appId: "1", privateKeyPath: null },
  llm: { baseUrl: "https://example.com/v1", model: "m/m" },
  server: { host: "127.0.0.1", port: 0 },
  limits: { jobTimeoutSeconds: 600, concurrency: 2, maxDiffLines: 4000 },
  repoAllowlist: [],
  workspace: { workDir: "/tmp/w" },
  container: { image: "img:1", memory: "4g", cpus: "2", pidsLimit: 256, dockerBin: "podman" },
  gateway: {
    baseUrl: "http://127.0.0.1:4100",
    containerBaseUrl: "http://127.0.0.1:4000/v1",
    perJobBudgetUsd: 0.5,
    ttlMarginSeconds: 120,
  },
  secrets: { webhookSecret: "w", githubPrivateKey: "k", gatewayMasterKey: "m" },
};

const podmanArgv = (): string[] => buildReviewDockerArgs({ ...INPUT, config: CONFIG });
const dockerArgv = (): string[] =>
  buildReviewDockerArgs({ ...INPUT, config: { ...CONFIG, container: { ...CONFIG.container, dockerBin: "docker" } } });

describe("findMissingHardenedFlags", () => {
  it("returns [] for today's shipped podman argv (full posture present)", () => {
    expect(findMissingHardenedFlags(podmanArgv())).toEqual([]);
  });

  it("returns [] for today's shipped docker argv too", () => {
    expect(findMissingHardenedFlags(dockerArgv())).toEqual([]);
  });

  it("does NOT treat --userns=keep-id as required (it's a shim, not a hardening flag)", () => {
    // Removing keep-id must not itself trip the preflight — the preflight
    // guards the hardened posture, not the rootless substrate.
    const withoutKeepId = podmanArgv().filter((t) => t !== "--userns=keep-id");
    expect(findMissingHardenedFlags(withoutKeepId)).toEqual([]);
  });

  // Each hardened flag, individually removed/weakened, must be reported.
  const cases: Array<{ name: string; mutate: (a: string[]) => string[]; expectLabel: string }> = [
    { name: "--rm dropped", mutate: (a) => a.filter((t) => t !== "--rm"), expectLabel: "--rm" },
    {
      name: "--read-only dropped",
      mutate: (a) => a.filter((t) => t !== "--read-only"),
      expectLabel: "--read-only",
    },
    {
      name: "--cap-drop=ALL dropped",
      mutate: (a) => a.filter((t) => t !== "--cap-drop=ALL"),
      expectLabel: "--cap-drop=ALL",
    },
    {
      name: "--cap-drop weakened to a subset",
      mutate: (a) => a.map((t) => (t === "--cap-drop=ALL" ? "--cap-drop=NET_RAW" : t)),
      expectLabel: "--cap-drop=ALL",
    },
    {
      name: "no-new-privileges dropped",
      mutate: (a) => a.filter((t) => t !== "--security-opt=no-new-privileges"),
      expectLabel: "--security-opt=no-new-privileges",
    },
    {
      name: "--memory dropped",
      mutate: (a) => a.filter((t) => !t.startsWith("--memory=")),
      expectLabel: "--memory=<limit>",
    },
    {
      name: "--cpus dropped",
      mutate: (a) => a.filter((t) => !t.startsWith("--cpus=")),
      expectLabel: "--cpus=<limit>",
    },
    {
      name: "--pids-limit dropped",
      mutate: (a) => a.filter((t) => !t.startsWith("--pids-limit=")),
      expectLabel: "--pids-limit=<n>",
    },
    {
      name: "--network changed away from none",
      mutate: (a) => a.map((t, i) => (a[i - 1] === "--network" ? "bridge" : t)),
      expectLabel: "--network none",
    },
    {
      name: "/work mount made writable (lost :ro)",
      mutate: (a) => a.map((t) => (t.endsWith(":/work:ro") ? t.replace(":/work:ro", ":/work") : t)),
      expectLabel: "read-only /work bind mount (…:/work:ro)",
    },
    {
      name: "/run/gw mount made writable (lost :ro)",
      mutate: (a) => a.map((t) => (t.endsWith(":/run/gw:ro") ? t.replace(":/run/gw:ro", ":/run/gw") : t)),
      expectLabel: "read-only /run/gw bind mount (…:/run/gw:ro)",
    },
    {
      name: "provider key passed by value instead of name-only",
      mutate: (a) => a.map((t) => (t === "OPENROUTER_API_KEY" ? "OPENROUTER_API_KEY=secret" : t)),
      expectLabel: "-e OPENROUTER_API_KEY (name-only, never a value)",
    },
    {
      name: "--tmpfs /tmp dropped",
      mutate: (a) => {
        const i = a.indexOf("--tmpfs");
        return [...a.slice(0, i), ...a.slice(i + 2)];
      },
      expectLabel: "--tmpfs /tmp",
    },
  ];

  for (const c of cases) {
    it(`fails closed when ${c.name}`, () => {
      const missing = findMissingHardenedFlags(c.mutate(podmanArgv()));
      expect(missing).toContain(c.expectLabel);
    });
  }

  it("reports every hardened flag when handed an empty argv", () => {
    // Sanity: an empty argv is missing the entire set (>= 10 labels).
    expect(findMissingHardenedFlags([]).length).toBeGreaterThanOrEqual(10);
  });
});
