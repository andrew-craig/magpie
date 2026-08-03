// M8-E8 (task_0208): the drift test that makes docker-image-config-drift.ts's
// guard an ACTUAL merge gate — see that module's doc comment for the full
// background.
//
// WHY A VITEST TEST AND NOT (ONLY) A SHELL SCRIPT: the existing one-variable
// pin (docker/reviewer/entrypoint-tier-memory.test.sh's task_80a4 case)
// already asserts MAGPIE_FINDINGS_PATH's *value* matches between the
// Dockerfile and entrypoint.sh, but that script is not run by any CI
// workflow — .github/workflows/ci.yml only runs `npm run build` + `npm test`
// (vitest across workspaces). A check that isn't wired into a workflow isn't
// a merge gate, which defeats the point of a DRIFT guard: it must fail a PR
// that adds an uncovered `ENV`, not just be available to run by hand. This
// file lives in the orchestrator workspace's `src/` (matching
// reviewer-crun-floor-argv.test.ts / reviewer-microvm-argv.test.ts) so `npm
// test` — and therefore ci.yml's PR gate — picks it up automatically.
//
// See also: this repo's ci.yml `pull_request`/`push` `paths:` filter was
// extended (see that file) to include `docker/reviewer/**`, because without
// that a PR that touched ONLY docker/reviewer/Dockerfile (e.g. adding a new
// `ENV` with no accompanying packages/ change) would not trigger ci.yml at
// all — this test would exist but never actually run on the PR that needs
// it. Both halves (the test existing under `npm test`, and CI actually
// running on Dockerfile-only changes) are required for this to be a real gate.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  findUncoveredMicrovmEnvVars,
  isInjectedByReviewerTs,
  isReexportedForMicrovm,
  parseDockerfileEnvVars,
} from "./docker-image-config-drift.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// packages/orchestrator/src -> repo root is three levels up.
const REPO_ROOT = join(__dirname, "..", "..", "..");
const DOCKERFILE_PATH = join(REPO_ROOT, "docker", "reviewer", "Dockerfile");
const ENTRYPOINT_PATH = join(REPO_ROOT, "docker", "reviewer", "entrypoint.sh");
const REVIEWER_TS_PATH = join(__dirname, "reviewer.ts");

const dockerfileText = readFileSync(DOCKERFILE_PATH, "utf8");
const entrypointText = readFileSync(ENTRYPOINT_PATH, "utf8");
const reviewerTsText = readFileSync(REVIEWER_TS_PATH, "utf8");

describe("real reviewer image-config surface (docker/reviewer/Dockerfile vs. the micro-VM tier)", () => {
  it("finds at least the known MAGPIE_FINDINGS_PATH ENV in the real Dockerfile (sanity: the parser isn't vacuously matching nothing)", () => {
    expect(parseDockerfileEnvVars(dockerfileText)).toContain("MAGPIE_FINDINGS_PATH");
  });

  // THE ACTUAL DRIFT GATE. Fails the moment a future `ENV` is added to the
  // Dockerfile without either re-exporting it in entrypoint.sh's
  // MAGPIE_IS_MICROVM guard or injecting it via reviewer.ts's
  // buildMicrovmLaunchArgs call site — see docker-image-config-drift.ts.
  it("every Dockerfile ENV is covered for the micro-VM tier (entrypoint.sh re-export or reviewer.ts injection)", () => {
    const uncovered = findUncoveredMicrovmEnvVars(dockerfileText, entrypointText, reviewerTsText);
    expect(uncovered).toEqual([]);
  });

  it("MAGPIE_FINDINGS_PATH specifically is covered via the entrypoint.sh re-export mechanism (pins WHICH mechanism, not just that some mechanism exists)", () => {
    expect(isReexportedForMicrovm("MAGPIE_FINDINGS_PATH", entrypointText)).toBe(true);
  });
});

describe("parseDockerfileEnvVars", () => {
  it("extracts a simple ENV NAME=value line", () => {
    expect(parseDockerfileEnvVars("FROM node:22-slim\nENV FOO=bar\n")).toEqual(["FOO"]);
  });

  it("extracts multiple ENV lines, in order", () => {
    const fixture = ["FROM node:22-slim", "ENV FOO=bar", "RUN echo hi", "ENV BAZ=qux"].join("\n");
    expect(parseDockerfileEnvVars(fixture)).toEqual(["FOO", "BAZ"]);
  });

  it("ignores ENV mentioned in a comment", () => {
    expect(parseDockerfileEnvVars("# ENV FOO=bar (documented here, not actually set)\n")).toEqual([]);
  });

  it("returns [] for a Dockerfile with no ENV lines", () => {
    expect(parseDockerfileEnvVars("FROM node:22-slim\nRUN echo hi\n")).toEqual([]);
  });
});

describe("extractMicrovmGuardedBlocks / isReexportedForMicrovm", () => {
  const FIXTURE_ENTRYPOINT = [
    "#!/usr/bin/env bash",
    'if [ "${MAGPIE_IS_MICROVM}" = "1" ]; then',
    "  export PATH=/usr/local/bin:/usr/bin",
    "fi",
    "",
    'if [ "${MAGPIE_IS_MICROVM}" = "1" ]; then',
    "  if [ -z \"${SOME_VAR:-}\" ]; then",
    "    echo nested",
    "  fi",
    "  export MAGPIE_FINDINGS_PATH=/out/findings.json",
    "fi",
    "",
    'if [ "${MAGPIE_IS_MICROVM}" = "1" ]; then',
    "  # crun-only stuff lives in the else branch, never in scope for coverage",
    "  echo microvm-branch",
    "else",
    "  export MAGPIE_ELSE_ONLY=should-not-count",
    "fi",
  ].join("\n");

  it("finds a var re-exported in a simple (unnested) guarded block", () => {
    expect(isReexportedForMicrovm("PATH", FIXTURE_ENTRYPOINT)).toBe(true);
  });

  it("finds a var re-exported after a nested if/fi inside the guarded block", () => {
    expect(isReexportedForMicrovm("MAGPIE_FINDINGS_PATH", FIXTURE_ENTRYPOINT)).toBe(true);
  });

  it("does NOT count an export that lives only in the guard's else branch", () => {
    expect(isReexportedForMicrovm("MAGPIE_ELSE_ONLY", FIXTURE_ENTRYPOINT)).toBe(false);
  });

  it("returns false for a var not exported anywhere", () => {
    expect(isReexportedForMicrovm("NEVER_SET", FIXTURE_ENTRYPOINT)).toBe(false);
  });

  // Regression test: an `elif` shares its parent `if`'s single `fi` rather
  // than opening its own nesting level. A depth-tracker that (wrongly)
  // treats `elif` as a new opener never sees the nested if/elif/fi's `fi`
  // bring depth back down correctly, so it also never recognizes the OUTER
  // guard's closing `fi` — and over-captures everything after it, including
  // `export` lines that live outside the MAGPIE_IS_MICROVM guard entirely.
  // That's the unsafe direction: a var never re-exported for the micro-VM
  // tier gets falsely reported as covered.
  const FIXTURE_ENTRYPOINT_WITH_ELIF = [
    "#!/usr/bin/env bash",
    'if [ "${MAGPIE_IS_MICROVM}" = "1" ]; then',
    "  if [ -z \"${SOME_VAR:-}\" ]; then",
    "    echo a",
    "  elif [ -n \"${OTHER_VAR:-}\" ]; then",
    "    echo b",
    "  fi",
    "  export MAGPIE_AFTER_ELIF=covered",
    "fi",
    "export MAGPIE_OUTSIDE_BLOCK=not-covered",
  ].join("\n");

  it("correctly closes a guarded block containing a nested if/elif/fi (does not over-capture past the elif's shared fi)", () => {
    expect(isReexportedForMicrovm("MAGPIE_AFTER_ELIF", FIXTURE_ENTRYPOINT_WITH_ELIF)).toBe(true);
  });

  it("does NOT count an export that lives after the guard's closing fi, even when the block contains a nested elif", () => {
    expect(isReexportedForMicrovm("MAGPIE_OUTSIDE_BLOCK", FIXTURE_ENTRYPOINT_WITH_ELIF)).toBe(false);
  });
});

describe("isInjectedByReviewerTs", () => {
  const FIXTURE_REVIEWER_TS = [
    "const env: NodeJS.ProcessEnv = { ...process.env }; // must NOT be mistaken for the microvm env object",
    "interface Foo { env: Record<string, string>; envFromHost: string[]; } // type positions must NOT match either",
    "buildMicrovmLaunchArgs({",
    "  envFromHost: [\"OPENROUTER_API_KEY\"],",
    "  env: {",
    "    OPENAI_BASE_URL: config.gateway.containerBaseUrl,",
    "    MAGPIE_REQUIRE_MEMORY_LIMIT: String(config.container.requireMemoryLimit),",
    "  },",
    "  vsockPort: 1234,",
    "});",
  ].join("\n");

  it("finds a name-only envFromHost entry", () => {
    expect(isInjectedByReviewerTs("OPENROUTER_API_KEY", FIXTURE_REVIEWER_TS)).toBe(true);
  });

  it("finds an inline env object key", () => {
    expect(isInjectedByReviewerTs("MAGPIE_REQUIRE_MEMORY_LIMIT", FIXTURE_REVIEWER_TS)).toBe(true);
  });

  it("does not false-positive on the unrelated `env: NodeJS.ProcessEnv = {}` docker-client env or the `env: Record<...>` / `envFromHost: string[]` interface fields", () => {
    expect(isInjectedByReviewerTs("process", FIXTURE_REVIEWER_TS)).toBe(false);
  });

  it("returns false for a var injected nowhere", () => {
    expect(isInjectedByReviewerTs("NEVER_INJECTED", FIXTURE_REVIEWER_TS)).toBe(false);
  });
});

describe("findUncoveredMicrovmEnvVars — proves the guard actually trips", () => {
  // A realistic-shaped fixture pair that mirrors today's real files closely
  // enough to be a meaningful regression test, plus one extra `ENV` in the
  // Dockerfile that NEITHER mechanism covers — the exact "someone added an
  // ENV and forgot the micro-VM side" scenario this whole task exists to
  // catch.
  const FIXTURE_DOCKERFILE = [
    "FROM node:22-slim",
    "ENV MAGPIE_FINDINGS_PATH=/out/findings.json",
    "ENV MAGPIE_NEW_THING=some-value",
    "WORKDIR /work",
    "ENTRYPOINT [\"/opt/magpie/entrypoint.sh\"]",
  ].join("\n");

  const FIXTURE_ENTRYPOINT = [
    "#!/usr/bin/env bash",
    'if [ "${MAGPIE_IS_MICROVM}" = "1" ]; then',
    "  export MAGPIE_FINDINGS_PATH=/out/findings.json",
    "fi",
  ].join("\n");

  const FIXTURE_REVIEWER_TS = ["buildMicrovmLaunchArgs({", "  envFromHost: [],", "  env: {},", "});"].join("\n");

  it("reports the uncovered ENV, and only the uncovered ENV", () => {
    const uncovered = findUncoveredMicrovmEnvVars(FIXTURE_DOCKERFILE, FIXTURE_ENTRYPOINT, FIXTURE_REVIEWER_TS);
    expect(uncovered).toEqual(["MAGPIE_NEW_THING"]);
  });

  it("is silent (empty) once the new ENV is covered via an entrypoint.sh re-export", () => {
    // Built by inserting a new line ahead of the closing `fi`, rather than a
    // naive string `.replace("fi", ...)` — the fixture's own body contains
    // the substring "fi" inside "findings.json", which a substring replace
    // would corrupt instead of touching the intended closing `fi` line.
    const coveredEntrypoint = [
      "#!/usr/bin/env bash",
      'if [ "${MAGPIE_IS_MICROVM}" = "1" ]; then',
      "  export MAGPIE_FINDINGS_PATH=/out/findings.json",
      "  export MAGPIE_NEW_THING=some-value",
      "fi",
    ].join("\n");
    expect(findUncoveredMicrovmEnvVars(FIXTURE_DOCKERFILE, coveredEntrypoint, FIXTURE_REVIEWER_TS)).toEqual([]);
  });

  it("is silent (empty) once the new ENV is covered via a reviewer.ts injection instead", () => {
    const coveredReviewerTs = [
      "buildMicrovmLaunchArgs({",
      "  envFromHost: [],",
      "  env: { MAGPIE_NEW_THING: \"some-value\" },",
      "});",
    ].join("\n");
    expect(findUncoveredMicrovmEnvVars(FIXTURE_DOCKERFILE, FIXTURE_ENTRYPOINT, coveredReviewerTs)).toEqual([]);
  });
});
