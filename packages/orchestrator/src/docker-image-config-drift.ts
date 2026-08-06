// Drift guard for the reviewer image's `ENV` surface between the
// crun-floor tier and the micro-VM tier.
//
// BACKGROUND: the crun tier runs the reviewer OCI *image*, so `docker`/
// `podman run` applies the image config (`ENV`, `WORKDIR`, base-image
// `PATH`, `USER`, `ENTRYPOINT`) for free. The micro-VM tier boots an
// *exported bare rootfs* — libkrun reads no image config at all, so none of
// that surface reaches the guest unless something re-declares it. This has
// already caused two live production defects, found one Pi-host run at a
// time: a missing `PATH` and a missing `MAGPIE_FINDINGS_PATH`, both fixed by
// re-exports in docker/reviewer/entrypoint.sh under its `MAGPIE_IS_MICROVM`
// guard. Nothing previously stopped a THIRD
// such gap from being introduced silently — add a new `ENV` to the
// Dockerfile and the micro-VM tier loses it with no test failing. That is
// what this module exists to catch: it is exercised by a real `npm test`
// (vitest) case (reviewer-microvm-env-parity.test.ts), unlike the earlier
// one-variable pin in docker/reviewer/entrypoint-tier-memory.test.sh, which
// is a bare shell script no CI workflow runs on its own.
//
// This module is a REGRESSION GUARD, not a general Dockerfile/bash/
// TypeScript parser. It understands exactly the `ENV` form and the two
// re-declaration idioms this repo currently uses, and says so below rather
// than pretending to a generality it doesn't implement — see each
// function's own doc comment for precisely what it does and does not parse.

/**
 * Extracts the variable names set by `ENV NAME=value` lines in a Dockerfile.
 *
 * UNDERSTOOD: the single form this repo's Dockerfile actually uses today —
 * `ENV NAME=value` on its own line, no leading whitespace.
 *
 * NOT UNDERSTOOD (by design — extend this if the Dockerfile ever starts
 * using one of these; it will silently miss them today):
 *   - the legacy two-token form without `=` (`ENV NAME value`)
 *   - multiple vars on one `ENV` line (`ENV A=1 B=2`)
 *   - a line-continued `ENV` (trailing `\`)
 *   - build-stage scoping (multi-stage Dockerfiles) — this scans every line
 *     in the file with no notion of which `FROM` stage it belongs to; not a
 *     problem for THIS Dockerfile (only the final stage has any `ENV`), but
 *     would over-report if a builder stage ever set one too.
 */
export function parseDockerfileEnvVars(dockerfileText: string): string[] {
  const names: string[] = [];
  const re = /^ENV\s+([A-Za-z_][A-Za-z0-9_]*)=/;
  for (const line of dockerfileText.split("\n")) {
    const match = re.exec(line);
    if (match) names.push(match[1]);
  }
  return names;
}

/**
 * Extracts the bodies of every top-level
 * `if [ "${MAGPIE_IS_MICROVM}" = "1" ]; then ... fi` block in
 * docker/reviewer/entrypoint.sh — the exact guard idiom that script uses to
 * re-declare image-config surface for the micro-VM tier (see the module doc
 * comment's PATH/MAGPIE_FINDINGS_PATH history). Each block's capture stops
 * at either its OWN matching `fi` or an `else` at the same nesting depth —
 * so an if/else/fi's `else`
 * branch (e.g. the memory-ceiling check's crun-only half) is never mistaken
 * for micro-VM-guarded content — while correctly skipping over NESTED
 * if/then/fi inside the block (e.g. the privilege-drop block's own
 * fail-closed checks).
 *
 * UNDERSTOOD: line-oriented bash where every `if` opener ends its line with
 * a literal `then` and every `fi`/`else` sits alone on its own
 * (whitespace-trimmed) line — true of every guard in entrypoint.sh today
 * (verified: no single-line `if ...; then ...; fi` compaction anywhere in
 * the file, and no here-doc/comment containing a bare standalone `fi`/
 * `else`/`if ...; then` line). `elif ...; then` lines are also understood
 * correctly: unlike a nested `if`, an `elif` shares its parent `if`'s single
 * `fi` rather than opening a new nesting level requiring its own — so depth
 * is only incremented on `if`, never on `elif`, and an `elif` line is simply
 * captured as part of its enclosing block.
 *
 * NOT UNDERSTOOD: single-line if-compaction; `case`/`esac` nesting is not
 * tracked at all (harmless today only because no `case` in this file
 * contains a bare `fi`/`else` line of its own); a comment or string literal
 * that happened to contain a standalone `fi`/`else`/`if ...; then` line
 * would confuse this parser. If entrypoint.sh's style ever changes in a way
 * that breaks these assumptions, update this function rather than trust it
 * blindly — the fixture test below only proves the CURRENT heuristic can
 * trip, not that it is bash-general.
 */
export function extractMicrovmGuardedBlocks(entrypointText: string): string[] {
  const GUARD = 'if [ "${MAGPIE_IS_MICROVM}" = "1" ]; then';
  const lines = entrypointText.split("\n");
  const blocks: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== GUARD) continue;
    const captured: string[] = [];
    let depth = 1;
    for (let j = i + 1; j < lines.length; j++) {
      const trimmed = lines[j].trim();
      if (depth === 1 && trimmed === "else") break;
      if (/^if\b.*\bthen$/.test(trimmed)) {
        depth++;
      } else if (trimmed === "fi") {
        depth--;
        if (depth === 0) break;
      }
      captured.push(lines[j]);
    }
    blocks.push(captured.join("\n"));
  }
  return blocks;
}

/**
 * True iff `envVarName` is re-declared (`export NAME=...`) somewhere inside
 * one of entrypoint.sh's `MAGPIE_IS_MICROVM`-guarded blocks — see
 * {@link extractMicrovmGuardedBlocks}.
 */
export function isReexportedForMicrovm(envVarName: string, entrypointText: string): boolean {
  const blocks = extractMicrovmGuardedBlocks(entrypointText);
  const re = new RegExp(`\\bexport\\s+${envVarName}=`);
  return blocks.some((block) => re.test(block));
}

/**
 * True iff `envVarName` is injected by reviewer.ts's micro-VM launch-argv
 * call site — either as a non-secret inline `env: { NAME: ... }` entry or a
 * name-only `envFromHost: ["NAME"]` entry passed to
 * `buildMicrovmLaunchArgs` from `runReview`'s `"microvm"`-tier branch.
 *
 * UNDERSTOOD: this is a targeted regex over the SPECIFIC call-site shape
 * reviewer.ts uses today (an object-literal argument with an `env: { KEY:
 * value, ... }` field and/or an `envFromHost: ["NAME", ...]` field) — not a
 * real TypeScript/AST parser. It is scoped by the literal markers `env: {`
 * / `envFromHost: [` (immediately followed by the brace/bracket) so it does
 * not accidentally match unrelated `env`-named symbols elsewhere in the
 * file — e.g. `const env: NodeJS.ProcessEnv = {...}` (docker-client env) or
 * the `env: Record<string, string>` interface field both have OTHER text
 * between the `env:`/`envFromHost:` token and the next `{`/`[`, so neither
 * is matched.
 *
 * NOT UNDERSTOOD: a future refactor that builds the env map imperatively
 * (e.g. `env[key] = value` assignments) instead of as one object literal.
 * If reviewer.ts's call site is ever restructured that way, this function
 * needs updating alongside it — until then it will silently stop finding
 * coverage it used to find, which {@link findUncoveredMicrovmEnvVars} would
 * then correctly report as newly uncovered (a safe direction to fail in:
 * loud, not silent).
 */
export function isInjectedByReviewerTs(envVarName: string, reviewerTsText: string): boolean {
  const envObjectMatch = /env:\s*\{([\s\S]*?)\n\s*\}/.exec(reviewerTsText);
  const envKeys = envObjectMatch
    ? Array.from(envObjectMatch[1].matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*):/gm)).map((m) => m[1])
    : [];
  const envFromHostMatch = /envFromHost:\s*\[([^\]]*)\]/.exec(reviewerTsText);
  const envFromHostNames = envFromHostMatch
    ? Array.from(envFromHostMatch[1].matchAll(/"([A-Za-z_][A-Za-z0-9_]*)"/g)).map((m) => m[1])
    : [];
  return envKeys.includes(envVarName) || envFromHostNames.includes(envVarName);
}

/**
 * Returns every Dockerfile `ENV` var name covered by NEITHER micro-VM-tier
 * mechanism (entrypoint.sh re-export or reviewer.ts injection) — an empty
 * array means the micro-VM tier's `ENV` surface is believed complete. The
 * drift test in reviewer-microvm-env-parity.test.ts asserts this is `[]`
 * against the real, on-disk Dockerfile/entrypoint.sh/reviewer.ts, and
 * separately asserts it is NON-empty against a fixture Dockerfile with an
 * uncovered `ENV` added, to prove the guard actually trips rather than
 * vacuously passing.
 */
export function findUncoveredMicrovmEnvVars(
  dockerfileText: string,
  entrypointText: string,
  reviewerTsText: string,
): string[] {
  return parseDockerfileEnvVars(dockerfileText).filter(
    (name) => !isReexportedForMicrovm(name, entrypointText) && !isInjectedByReviewerTs(name, reviewerTsText),
  );
}
