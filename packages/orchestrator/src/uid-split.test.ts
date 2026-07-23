// MERGE-BLOCKER regression test (CTO binding edit #1, epic_59b1 / task_08ec):
// the orchestrator ⟂ gateway uid separation must hold in EVERY tier from the
// first landed commit. The real threat is indirect prompt injection against the
// review agent, so the process that parses untrusted PR content (this
// orchestrator) must never hold a provider/LLM credential worth stealing — it
// only ever mints and hands out a short-lived, budget-capped per-job gateway
// VIRTUAL key; the real OpenRouter key lives solely in the gateway's own
// unprivileged process/uid (packages/gateway).
//
// This test enforces that structurally with a grep-level assertion over the
// orchestrator source, so a future change that routes a real provider
// credential through the orchestrator — even transiently, even behind a flag —
// fails CI here rather than silently collapsing the split (the exact regression
// Proposal B "as written" introduced; see docs/design/cto-decision-brief.md
// §2b). It is deliberately grep-based (reads the source, not the runtime) so it
// can't be satisfied by a mock.
//
// --- uid layout being protected -------------------------------------------
//   magpie.service   (user `magpie`) — orchestrator: webhook/queue/git/diff,
//                     launches the reviewer, mints/revokes per-job virtual
//                     keys. Holds: webhook secret, GitHub App key, gateway
//                     MASTER key (mgmt-plane bearer). Holds NO provider key.
//   magpie-gateway.service (SEPARATE user `magpie-gateway`) — the only process
//                     that holds the real provider key
//                     (MAGPIE_GATEWAY_OPENROUTER_KEY), reached by the reviewer
//                     only over a per-job unix socket, capped by the virtual
//                     key's budget.
//   reviewer container — holds only the per-job virtual key (as
//                     OPENROUTER_API_KEY), --network none, no host secret.
// The docker→rootless-podman port (M8-B2) does not touch this split: the
// launcher change is uid-mapping only; the mint/revoke management plane and the
// per-job socket handoff are unchanged.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ORCH_SRC = __dirname;
const GATEWAY_CONFIG = join(__dirname, "..", "..", "gateway", "src", "config.ts");

/** Non-test orchestrator source files. */
function orchestratorSourceFiles(): string[] {
  return readdirSync(ORCH_SRC)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".d.ts"))
    .map((f) => join(ORCH_SRC, f));
}

/**
 * Every `process.env.NAME` / `process.env["NAME"]` READ in a source file.
 * (The `{ ...process.env }` spread in reviewer.ts has no property name and is
 * intentionally not matched — it copies the ambient env for the spawned client
 * and is immediately stripped of all `MAGPIE_*` keys; see the assertion below.)
 */
function envReads(src: string): string[] {
  const names = new Set<string>();
  const dot = /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g;
  const bracket = /process\.env\[\s*["'`]([A-Za-z_][A-Za-z0-9_]*)["'`]\s*\]/g;
  for (const re of [dot, bracket]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) names.add(m[1]);
  }
  return [...names];
}

/**
 * DYNAMIC reads of `process.env` that {@link envReads} cannot name-check, and
 * that a future regression could use to smuggle a provider key past the
 * allowlist grep above:
 *   - destructuring:      `const { OPENROUTER_API_KEY } = process.env`
 *   - variable-index:     `process.env[someName]` (index is not a string literal)
 * The orchestrator has no legitimate need for either — every real read is a
 * static `process.env.NAME`, and the one bulk access (`{ ...process.env }` in
 * reviewer.ts, immediately stripped of all MAGPIE_* keys) is a spread, matched
 * and excluded here. So we forbid the patterns outright rather than trying to
 * resolve the name they'd read.
 */
function dynamicEnvReads(src: string): string[] {
  const hits: string[] = [];
  // Destructuring off process.env: `} = process.env` / `] = process.env`.
  // (The spread `{ ...process.env }` has process.env on the RHS *inside* the
  // braces, never `= process.env`, so it does not match.)
  const destructure = /[}\]]\s*=\s*process\.env\b/g;
  // Variable/computed index: `process.env[` NOT immediately followed by a
  // string-literal key (which is the safe, name-checkable `envReads` form).
  const computedIndex = /process\.env\[\s*(?!["'`])/g;
  for (const re of [destructure, computedIndex]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) hits.push(m[0].trim());
  }
  return hits;
}

// The COMPLETE set of environment variables the orchestrator is permitted to
// read. None is a provider/LLM credential. Adding a provider key here — or
// reading one without listing it — fails this test.
const ALLOWED_ORCHESTRATOR_ENV = new Set([
  "MAGPIE_CONFIG",
  "MAGPIE_WEBHOOK_SECRET",
  "MAGPIE_GATEWAY_MASTER_KEY", // mgmt-plane bearer to mint/revoke virtual keys — NOT a provider key
  "MAGPIE_GITHUB_PRIVATE_KEY",
]);

/** Env names that would indicate a real provider/LLM credential leaking into the orchestrator. */
const PROVIDER_KEY_ENV_RE = /(OPENROUTER|OPENAI|ANTHROPIC).*KEY|LLM.*KEY|PROVIDER.*KEY/i;

describe("orchestrator ⟂ gateway uid split (merge-blocker grep assertion)", () => {
  it("the orchestrator reads ONLY the allowlisted MAGPIE_* env vars — no provider key", () => {
    const offenders: Array<{ file: string; name: string }> = [];
    for (const file of orchestratorSourceFiles()) {
      for (const name of envReads(readFileSync(file, "utf-8"))) {
        if (!ALLOWED_ORCHESTRATOR_ENV.has(name)) {
          offenders.push({ file, name });
        }
      }
    }
    // A clear failure lists exactly what leaked in and where.
    expect(offenders).toEqual([]);
  });

  it("no orchestrator source reads process.env dynamically (destructure / computed index)", () => {
    // Closes the grep's evasion vectors: the allowlist assertion above only
    // sees static `process.env.NAME` reads, so a provider key pulled via
    // destructuring or a variable index would slip past it. Neither pattern is
    // used anywhere legitimately, so any occurrence fails here.
    const offenders: Array<{ file: string; pattern: string }> = [];
    for (const file of orchestratorSourceFiles()) {
      for (const pattern of dynamicEnvReads(readFileSync(file, "utf-8"))) {
        offenders.push({ file, pattern });
      }
    }
    expect(offenders).toEqual([]);
  });

  it("no orchestrator source reads a provider/LLM-key-shaped env var", () => {
    const offenders: Array<{ file: string; name: string }> = [];
    for (const file of orchestratorSourceFiles()) {
      for (const name of envReads(readFileSync(file, "utf-8"))) {
        if (PROVIDER_KEY_ENV_RE.test(name)) offenders.push({ file, name });
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the Config type / secrets carry no provider-key field", () => {
    const configSrc = readFileSync(join(ORCH_SRC, "config.ts"), "utf-8");
    // Field DECLARATIONS only (`name:`), so the explanatory comments that
    // mention these names (describing what does NOT live here) don't trip it.
    for (const forbidden of ["llmApiKey", "openrouterKey", "openaiKey", "providerKey", "apiKey"]) {
      expect(configSrc).not.toMatch(new RegExp(`\\b${forbidden}\\s*:`));
    }
  });

  it("reviewer.ts injects ONLY the per-job gateway virtual key as the container credential", () => {
    const reviewerSrc = readFileSync(join(ORCH_SRC, "reviewer.ts"), "utf-8");
    // The one credential the orchestrator sets for the container is the virtual
    // key from params (gatewayApiKey), by env, referenced in argv name-only.
    expect(reviewerSrc).toMatch(/env\.OPENROUTER_API_KEY\s*=\s*params\.gatewayApiKey/);
    // And every MAGPIE_* secret is stripped from the spawned client's env.
    expect(reviewerSrc).toMatch(/startsWith\(["'`]MAGPIE_["'`]\)/);
    // The provider key is passed to the container by NAME ONLY (never =value).
    expect(reviewerSrc).toMatch(/"OPENROUTER_API_KEY"/);
    expect(reviewerSrc).not.toMatch(/`OPENROUTER_API_KEY=\$/);
  });

  it("positive control: the real provider key lives in the SEPARATE gateway package", () => {
    // Proves the split exists (the key is somewhere) rather than merely that the
    // orchestrator lacks it — the gateway is where MAGPIE_GATEWAY_OPENROUTER_KEY
    // is declared and read.
    const gatewaySrc = readFileSync(GATEWAY_CONFIG, "utf-8");
    expect(gatewaySrc).toMatch(/MAGPIE_GATEWAY_OPENROUTER_KEY/);
    // And it is NOT read anywhere in the orchestrator.
    for (const file of orchestratorSourceFiles()) {
      expect(readFileSync(file, "utf-8")).not.toMatch(/process\.env\.MAGPIE_GATEWAY_OPENROUTER_KEY/);
    }
  });
});
