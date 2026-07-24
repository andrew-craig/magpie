// M8-B1 floor-invariant regression test (task_89c4; CTO binding edit #3 in
// docs/design/cto-decision-brief.md: "CI or preflight must assert the
// hardened 'crun floor' tier's flag set is byte-for-byte today's shipped
// hardened posture, so the floor cannot silently erode while attention is on
// the micro-VM path" — see also docs/design/rust-adoption.md's reference to
// "the M8-B1 floor-invariant flag test" as the golden fixture that pins
// behaviour across the future micro-VM swap).
//
// This is deliberately narrower and stricter than reviewer.test.ts's
// "assembles a hardened docker run argv..." case (which asserts individual
// flags are PRESENT via `toContain`, tolerant of reordering/additions).
// THIS test asserts the FULL argv array returned by reviewer.ts's
// `buildReviewDockerArgs` equals a committed golden fixture EXACTLY —
// element-for-element, in order — so a flag being silently added, removed,
// reordered, or renamed anywhere in the hardened posture fails this test
// loudly, rather than only failing if it happens to touch one of the flags
// reviewer.test.ts already asserts on. Both tests are intentionally kept:
// reviewer.test.ts documents *why* each flag matters inline; this one is the
// tripwire that catches ANY drift, named/explained or not.
//
// WHAT IS PINNED vs NORMALIZED:
//   - PINNED (this is the point of the test): the full flag SET, each flag's
//     VALUE, and their ORDER — --rm, --user, --read-only, --tmpfs /tmp,
//     --cap-drop=ALL, --security-opt=no-new-privileges, --memory/--cpus/
//     --pids-limit, --network none, the three -v bind mounts' in-container
//     targets and ro/rw-ness, -e OPENROUTER_API_KEY (name-only, never a
//     value), -e OPENAI_BASE_URL=<value>, -i, the image, and the trailing
//     --provider/--model container args.
//   - NORMALIZED (fed as fixed, non-production placeholder values rather than
//     read from a live host/job so the test is 100% deterministic): the
//     container name (real ones are `magpie-<random-or-job-id>`), the host
//     uid:gid (real ones come from `process.getuid()`/`getgid()` and vary by
//     host), and the three host-side bind-mount SOURCE paths (`/work`,
//     `/out`, `/run/gw` — real ones are per-job mkdtemp'd paths). These are
//     "per-job-variable inputs" per the task spec: they change every run by
//     construction and pinning their exact string would make the fixture
//     fail for reasons that have nothing to do with the hardened posture.
//     `buildReviewDockerArgs` is a pure function of its params (see
//     reviewer.ts), so feeding it fixed placeholder values here is
//     equivalent to normalizing real values post-hoc — nothing is hidden,
//     it's just supplied as a constant instead of computed and then redacted.
//   - The image tag/model/memory/cpus/pids-limit/gateway base URL come from
//     this test's own fixed `Config` (mirroring reviewer.test.ts's
//     `testConfig`), NOT from config.example.toml's real (digest-pinned,
//     deployment-specific) defaults — this test's job is to pin reviewer.ts's
//     FLAG-BUILDING LOGIC, not any one deployment's config values.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Config } from "./config.js";
import { buildReviewDockerArgs } from "./reviewer.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Fixed, non-production inputs — see the "NORMALIZED" note above. */
const GOLDEN_INPUT = {
  containerName: "magpie-golden-job",
  uid: 1000,
  gid: 1000,
  mountDir: "/golden/work",
  outDir: "/golden/out",
  gatewaySocketDir: "/golden/gw",
} as const;

/** Fixed Config — mirrors reviewer.test.ts's `testConfig` container/llm/gateway fields exactly. */
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
    requireMemoryLimit: true,
    cpus: "2",
    pidsLimit: 256,
    dockerBin: "docker",
  },
  gateway: {
    baseUrl: "http://127.0.0.1:4100",
    containerBaseUrl: "http://127.0.0.1:4000/v1",
    perJobBudgetUsd: 0.5,
    ttlMarginSeconds: 120,
  },
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
  const path = join(__dirname, "__fixtures__", "reviewer-crun-floor-argv.golden.json");
  return JSON.parse(readFileSync(path, "utf-8")) as GoldenFixture;
}

describe("buildReviewDockerArgs (M8-B1 crun-floor invariant)", () => {
  it("matches the committed golden argv byte-for-byte", () => {
    const golden = loadGoldenFixture();
    const actual = buildReviewDockerArgs({ ...GOLDEN_INPUT, config: GOLDEN_CONFIG });

    // Element-for-element, order-sensitive equality — NOT `toContain`/
    // `toMatchObject`/set-comparison. Any flag added, removed, reordered, or
    // whose value changed makes this fail. On an INTENTIONAL posture change,
    // update `argv` in
    // src/__fixtures__/reviewer-crun-floor-argv.golden.json in the SAME PR —
    // that diff being visible in review is the entire point of this test
    // (task_89c4 / CTO binding edit #3).
    expect(actual).toEqual(golden.argv);
  });

  it("is a pure function: identical inputs always produce the identical argv", () => {
    const a = buildReviewDockerArgs({ ...GOLDEN_INPUT, config: GOLDEN_CONFIG });
    const b = buildReviewDockerArgs({ ...GOLDEN_INPUT, config: GOLDEN_CONFIG });
    expect(a).toEqual(b);
  });
});
