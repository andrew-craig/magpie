// Per-repo configuration overrides via `.magpie.toml`.
//
// Lets a repo tune a narrow, pre-approved slice of review
// behaviour (which model, how much diff to review, freeform reviewer
// guidance, which paths to skip) without an operator touching the server's
// `config.toml`. The entire point of this module is that repo-supplied
// config must never become an attacker lever — a malicious PR author (or,
// more to the point, anyone who can land a commit on the DEFAULT branch,
// which is a strictly smaller and more trusted set than "anyone who can open
// a PR") must not be able to reach budgets, network egress, the container
// image/tier, the tool allowlist, the repo allowlist, timeouts, concurrency,
// or any other server-only knob through this file.
//
// SECURITY — ref pinning (design decision, binding): `.magpie.toml` is read
// ONLY from the base repository's DEFAULT branch
// (`pr.base.repo.default_branch`), NEVER from `pr.base.ref` and NEVER from
// the PR head. A PR can target a non-default branch, so `base.ref` is a
// weaker, PR-author-influenced surface (anyone who can open a PR against a
// non-default base branch would otherwise get to pick which `.magpie.toml`
// governs their own review); the PR head is obviously fully attacker-
// controlled. The default branch is the one surface that unambiguously means
// "whoever the repo owner trusts to push here". pipeline.ts is responsible
// for resolving that ref (via `octokit.rest.repos.get` — see its own comment)
// and passing it in as {@link FetchRepoConfigParams.ref}; this module never
// resolves it itself, so there is exactly one place in the codebase that
// decides "which ref is authoritative for repo config".
//
// SECURITY — the overridable subset is EXACTLY four knobs, gated field-by-
// field (see {@link applyRepoConfig}):
//   - `llm.model`, but ONLY if it's a member of the server's OWN
//     `config.llm.allowedModels` (config.ts). Absent/empty
//     `allowedModels` silently refuses every model override. This exists
//     because the model choice feeds straight into gateway.ts's
//     `mintGatewayKeyFromConfig`, which scopes the per-job virtual key to a
//     model — an unconstrained repo-chosen model could scope a budget-capped
//     key to an arbitrarily expensive model the operator never agreed to
//     pay for.
//   - `limits.max_diff_lines`, clamped to `min(repo, server)` — a repo can
//     only make the cap TIGHTER, never looser, than what the operator
//     configured.
//   - `review.guidance` — free text, hard length capped, folded into the
//     prompt inside its own nonce-tagged advisory block (reviewer.ts's
//     `buildPromptPayload`) that is explicitly labelled as NOT able to
//     override the system prompt. This is repo-controlled input, same trust
//     tier as the PR diff/title/body themselves — never operator input.
//   - `review.ignore_paths` — glob list, applied to the changed-file list and
//     diff body (see diff.ts) and, belt-and-braces, to findings
//     (reviewer.ts) before anything is published.
// Everything else a hostile `.magpie.toml` might try to name (container
// image/tier, gateway URLs, budgets, timeouts, concurrency, the tool
// allowlist, the repo allowlist, workspace paths, telemetry, secrets, ...)
// is rejected outright: `repoConfigSchema` below is `.strict()` at every
// level, so a file that even MENTIONS an unknown key fails validation
// wholesale (see FAIL-SOFT below) rather than having the unknown key
// silently ignored while everything else in the file is honoured. This is a
// deliberately blunter failure mode than "ignore just the bad key" — a
// `.magpie.toml` that tries to set `container.image` is far more likely to
// be a hostile probe than a typo, and the safest response to "this file
// tried to name a server-only knob" is "trust none of it, log it, and fall
// back to server defaults."
//
// SECURITY — construction of the effective `Config` in {@link applyRepoConfig}
// is done FIELD BY FIELD, enumerating every top-level `Config` key
// explicitly, rather than any form of generic/deep merge of `repoConfig` into
// `serverConfig`. This is intentional and load-bearing: a generic merge means
// a future server `Config` field could become repo-overridable purely by
// having the same name show up somewhere in a hostile TOML file, with no
// code change required. Enumerating every field here means the TypeScript
// compiler itself enforces "every `Config` field must be explicitly accounted
// for" — adding a new field to the `Config` interface without updating this
// function is a compile error, not a silent gap.
//
// FAIL-SOFT, ALWAYS (design decision, binding): a missing file (404), an
// oversized file, malformed TOML, a zod validation failure, a GitHub API
// error, or non-UTF8 content all fall back to the pure server config with a
// logged notice (a 404 is logged at `info` — "no `.magpie.toml`" is the
// overwhelmingly common, non-noteworthy case; every other failure is logged
// at `error`, same convention as rereview.ts's swallowed-but-notable
// `review-state-read-failed`). A repo-config problem must NEVER fail or skip
// a review — see `fetchRepoConfig`'s `null` return, which every caller
// treats as "use the server config, unmodified".

import type { Octokit } from "@octokit/rest";
import { parse as parseToml, TomlError } from "smol-toml";
import { z } from "zod";
import type { Config } from "./config.js";

/** Path `.magpie.toml` is read from, relative to the repo root. */
export const REPO_CONFIG_PATH = ".magpie.toml";

/**
 * Hard cap on the fetched file's size, checked BEFORE base64-decoding or
 * parsing (untrusted-input hygiene, same posture as diff.ts's `maxDiffLines`
 * cap on the diff body: never do real work on an attacker-sized payload
 * before even knowing its size is sane). 16 KiB is generous for a config file
 * that has exactly four knobs, one of which (`review.guidance`) has its own
 * tighter cap below.
 */
export const MAX_REPO_CONFIG_BYTES = 16 * 1024;

/** Hard cap on `review.guidance`'s length (characters), applied in {@link applyRepoConfig}. */
export const GUIDANCE_MAX_CHARS = 4 * 1024;

/**
 * Hard cap on the NUMBER of `review.ignore_paths` entries, enforced in
 * `repoConfigSchema` below (so an oversized list fails the whole file, same
 * fail-soft posture as every other schema violation — see module doc
 * comment). Each entry `glob-match.ts` accepts gets compiled into its own
 * `RegExp` and tested against every changed file in the PR, once per job —
 * an unbounded list is avoidable per-job CPU, not just a config-hygiene
 * nicety. 100 is generous for a genuine ignore list (vendored dirs, build
 * output, lockfiles, ...) while still being a real ceiling.
 */
export const IGNORE_PATHS_MAX_ENTRIES = 100;

/**
 * Hard cap on each individual `review.ignore_paths` entry's length
 * (characters), same rationale as {@link IGNORE_PATHS_MAX_ENTRIES}: a
 * pathological single pattern (e.g. deeply nested `**`-heavy segments) costs
 * more to compile/match than a normal glob, with no legitimate ignore-list
 * use case needing anywhere near this much.
 */
export const IGNORE_PATH_MAX_CHARS = 256;

/**
 * Minimal structured logger this module needs — deliberately just
 * `info`/`error`, mirroring pipeline.ts's `PipelineLogger` (and rereview.ts's
 * `RereviewLogger`) exactly, so pipeline.ts's own logger can be passed
 * straight through here with no adapter object. `error` is used for every
 * "fell back to server config" case (mirrors rereview.ts's
 * `review-state-read-failed`, which is likewise a swallowed-not-fatal
 * failure logged at error level so it's visible without special-casing a
 * `warn` level nothing else in this codebase has) EXCEPT the ordinary
 * "no `.magpie.toml` on this repo" 404 case, logged at `info` since that's
 * the overwhelmingly common, unremarkable case for any repo that hasn't
 * opted into per-repo config.
 */
export interface RepoConfigLogger {
  info(payload: Record<string, unknown>): void;
  error(payload: Record<string, unknown>): void;
}

function serializeError(err: unknown): unknown {
  if (err instanceof Error) {
    return { name: err.name, message: err.message };
  }
  return err;
}

const consoleLogger: RepoConfigLogger = {
  info(payload) {
    console.log(JSON.stringify({ level: "info", ...payload }));
  },
  error(payload) {
    console.error(JSON.stringify({ level: "error", ...payload }));
  },
};

// --- Raw file schema -------------------------------------------------------
//
// `.strict()` at every level (top-level and each section): an unknown
// key anywhere in the file — `[container]`, an extra field inside `[llm]`,
// etc — fails validation for the WHOLE file (see module doc comment's
// SECURITY section on why this is deliberately blunt).

const repoConfigSchema = z
  .object({
    llm: z
      .object({
        model: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    limits: z
      .object({
        max_diff_lines: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    review: z
      .object({
        guidance: z.string().optional(),
        // Capped both in NUMBER of entries and per-entry LENGTH (see
        // IGNORE_PATHS_MAX_ENTRIES/IGNORE_PATH_MAX_CHARS above) — an
        // oversized list fails the whole file, same as any other schema
        // violation, rather than being silently truncated.
        ignore_paths: z
          .array(z.string().min(1).max(IGNORE_PATH_MAX_CHARS))
          .max(IGNORE_PATHS_MAX_ENTRIES)
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** Parsed, schema-validated (but not yet gated against server policy) `.magpie.toml` contents. */
export interface RepoConfig {
  llm?: { model?: string };
  limits?: { maxDiffLines?: number };
  review?: { guidance?: string; ignorePaths?: string[] };
}

function mapRepoConfig(data: z.infer<typeof repoConfigSchema>): RepoConfig {
  return {
    llm: data.llm?.model !== undefined ? { model: data.llm.model } : undefined,
    limits:
      data.limits?.max_diff_lines !== undefined
        ? { maxDiffLines: data.limits.max_diff_lines }
        : undefined,
    review:
      data.review !== undefined
        ? { guidance: data.review.guidance, ignorePaths: data.review.ignore_paths }
        : undefined,
  };
}

/** Parameters for {@link fetchRepoConfig}. */
export interface FetchRepoConfigParams {
  /** Authenticated Octokit client — injected by the caller, never constructed here. */
  octokit: Octokit;
  owner: string;
  repo: string;
  /**
   * The ref to read `.magpie.toml` from. Callers MUST pass the base repo's
   * DEFAULT branch (see module doc comment's SECURITY section) — this
   * module does not resolve or validate that itself, by design (single
   * source of truth for that decision lives in pipeline.ts).
   */
  ref: string;
  logger?: RepoConfigLogger;
}

/**
 * Fetches and validates `.magpie.toml` from `params.ref` via the GitHub
 * contents API. Returns `null` on ANY problem — missing file, oversized,
 * non-UTF8, malformed TOML, schema validation failure, or any other API
 * error — logging at `error` for every case except the (overwhelmingly
 * common, unremarkable) "file doesn't exist" 404, which is logged at `info`.
 * Never throws (see module doc comment's FAIL-SOFT section) and never
 * returns partial/best-effort data — a `.magpie.toml` that's invalid in any
 * way is treated exactly like "no `.magpie.toml` at all", not "apply
 * whatever parsed".
 */
export async function fetchRepoConfig(params: FetchRepoConfigParams): Promise<RepoConfig | null> {
  const { octokit, owner, repo, ref, logger = consoleLogger } = params;
  const logFields = { owner, repo, ref, path: REPO_CONFIG_PATH };

  let response: Awaited<ReturnType<typeof octokit.rest.repos.getContent>>;
  try {
    response = await octokit.rest.repos.getContent({ owner, repo, path: REPO_CONFIG_PATH, ref });
  } catch (err) {
    const status = (err as { status?: number } | undefined)?.status;
    if (status === 404) {
      logger.info({ event: "repo-config-not-found", ...logFields });
    } else {
      logger.error({
        event: "repo-config-fetch-failed",
        ...logFields,
        error: serializeError(err),
      });
    }
    return null;
  }

  const data = response.data;
  // `getContent` returns an array when `path` names a directory, and several
  // possible object shapes (`file`/`dir`/`submodule`/`symlink`) otherwise —
  // only a `file` with base64 `content` is usable here.
  if (Array.isArray(data) || data.type !== "file" || typeof data.content !== "string") {
    logger.error({ event: "repo-config-not-a-file", ...logFields, type: Array.isArray(data) ? "dir" : data.type });
    return null;
  }

  // Cap BEFORE decoding — the API's own `size` field is the cheapest check
  // (no decode needed), but is defence-in-depth only; the authoritative
  // check is the decoded buffer length just below, since `size` is
  // server-reported metadata this module doesn't otherwise trust blindly.
  if (typeof data.size === "number" && data.size > MAX_REPO_CONFIG_BYTES) {
    logger.error({ event: "repo-config-oversized", ...logFields, size: data.size });
    return null;
  }

  // `Buffer.from(str, "base64")` never throws — it silently skips characters
  // outside the base64 alphabet rather than raising — so there is nothing to
  // catch here. Garbage/truncated base64 just decodes to garbage bytes,
  // which the strict UTF-8 decode immediately below (or, failing that, the
  // TOML parse or schema validation further down) is what actually catches
  // and rejects it; this line has no failure mode of its own to guard.
  const decoded = Buffer.from(data.content, "base64");

  if (decoded.byteLength > MAX_REPO_CONFIG_BYTES) {
    logger.error({ event: "repo-config-oversized", ...logFields, size: decoded.byteLength });
    return null;
  }

  // Decode STRICTLY (`fatal: true`) rather than `Buffer#toString("utf-8")`,
  // which silently replaces invalid byte sequences with U+FFFD instead of
  // throwing. A strict decode throws ONLY on genuinely invalid UTF-8 byte
  // sequences, so a file that legitimately CONTAINS a literal U+FFFD
  // character (e.g. `review.guidance` prose documenting encoding-handling
  // conventions) is correctly accepted rather than rejected — a plain
  // `text.includes("�")` check would have false-positived on exactly
  // that legitimate case.
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(decoded);
  } catch {
    logger.error({ event: "repo-config-not-utf8", ...logFields });
    return null;
  }

  let raw: unknown;
  try {
    raw = parseToml(text);
  } catch (err) {
    const reason = err instanceof TomlError ? err.message : String(err);
    logger.error({ event: "repo-config-invalid-toml", ...logFields, error: reason });
    return null;
  }

  const parsed = repoConfigSchema.safeParse(raw);
  if (!parsed.success) {
    logger.error({
      event: "repo-config-schema-invalid",
      ...logFields,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
    return null;
  }

  return mapRepoConfig(parsed.data);
}

/** What {@link applyRepoConfig} returns: the effective `Config` plus the sidecar bits that aren't `Config` fields at all. */
export interface RepoConfigOverrideResult {
  /** The effective per-job `Config`, built field-by-field from `serverConfig` (see module doc comment's SECURITY section). Identical to `serverConfig` in every field when `repoConfig` is `null`. */
  config: Config;
  /** `review.guidance`, length-capped, or `""` if not set/refused. Not a `Config` field — threaded separately into reviewer.ts's prompt builder. */
  guidance: string;
  /** `review.ignore_paths`, or `[]` if not set/refused. Not a `Config` field — threaded separately into diff.ts's file/diff filtering and reviewer.ts's findings filtering. */
  ignorePaths: string[];
  /** Human-readable descriptions of every override actually applied, for one structured operator log line (pipeline.ts). */
  accepted: string[];
  /** Human-readable descriptions of every override the repo attempted but was refused, with why, for the same log line. */
  refused: string[];
}

/**
 * Builds the effective per-job `Config` from `serverConfig`, applying at most
 * the four knobs `repoConfig` is allowed to touch (see module doc comment).
 * `repoConfig: null` (no file, or any fetch/parse/validation failure) yields
 * `serverConfig` back unchanged in every field.
 *
 * Never throws; every rejection is a "refuse and keep the server value"
 * decision recorded in the returned `refused` list, not an exception —
 * mirrors {@link fetchRepoConfig}'s own fail-soft contract.
 */
export function applyRepoConfig(
  serverConfig: Config,
  repoConfig: RepoConfig | null,
  logger: RepoConfigLogger = consoleLogger,
): RepoConfigOverrideResult {
  const accepted: string[] = [];
  const refused: string[] = [];

  // --- llm.model: gated by the server's own allowlist -----------------
  let model = serverConfig.llm.model;
  const requestedModel = repoConfig?.llm?.model;
  if (requestedModel !== undefined) {
    if (serverConfig.llm.allowedModels.includes(requestedModel)) {
      model = requestedModel;
      accepted.push(`llm.model=${requestedModel}`);
    } else {
      refused.push(
        `llm.model=${requestedModel} (not in server llm.allowed_models; allowed_models is ${
          serverConfig.llm.allowedModels.length === 0 ? "empty" : "non-empty but does not list this model"
        })`,
      );
    }
  }

  // --- limits.max_diff_lines: clamp to min(repo, server), never above ---
  let maxDiffLines = serverConfig.limits.maxDiffLines;
  const requestedMaxDiffLines = repoConfig?.limits?.maxDiffLines;
  if (requestedMaxDiffLines !== undefined) {
    const clamped = Math.min(requestedMaxDiffLines, serverConfig.limits.maxDiffLines);
    maxDiffLines = clamped;
    if (clamped < requestedMaxDiffLines) {
      accepted.push(
        `limits.maxDiffLines=${clamped} (repo requested ${requestedMaxDiffLines}, clamped to server cap ${serverConfig.limits.maxDiffLines})`,
      );
    } else {
      accepted.push(`limits.maxDiffLines=${clamped}`);
    }
  }

  // --- review.guidance: length-capped advisory text, not a Config field -
  let guidance = "";
  const requestedGuidance = repoConfig?.review?.guidance;
  if (requestedGuidance !== undefined && requestedGuidance.trim().length > 0) {
    guidance = requestedGuidance.slice(0, GUIDANCE_MAX_CHARS);
    accepted.push(
      guidance.length < requestedGuidance.length
        ? `review.guidance (${requestedGuidance.length} chars, truncated to ${guidance.length})`
        : `review.guidance (${guidance.length} chars)`,
    );
  }

  // --- review.ignore_paths: glob list, not a Config field ----------------
  let ignorePaths: string[] = [];
  const requestedIgnorePaths = repoConfig?.review?.ignorePaths;
  if (requestedIgnorePaths !== undefined && requestedIgnorePaths.length > 0) {
    ignorePaths = requestedIgnorePaths;
    accepted.push(`review.ignorePaths(${ignorePaths.length})`);
  }

  // SECURITY: every `Config` field enumerated explicitly — see module doc
  // comment. `github`/`server`/`repoAllowlist`/`workspace`/`container`/
  // `microvm`/`gateway`/`telemetry`/`secrets` are copied VERBATIM from
  // `serverConfig`; only `llm.model` and `limits.maxDiffLines` are ever
  // replaced, and only with the gated/clamped values computed above.
  const config: Config = {
    github: serverConfig.github,
    llm: {
      baseUrl: serverConfig.llm.baseUrl,
      model,
      allowedModels: serverConfig.llm.allowedModels,
    },
    server: serverConfig.server,
    limits: {
      jobTimeoutSeconds: serverConfig.limits.jobTimeoutSeconds,
      concurrency: serverConfig.limits.concurrency,
      maxDiffLines,
    },
    repoAllowlist: serverConfig.repoAllowlist,
    workspace: serverConfig.workspace,
    container: serverConfig.container,
    microvm: serverConfig.microvm,
    gateway: serverConfig.gateway,
    telemetry: serverConfig.telemetry,
    secrets: serverConfig.secrets,
  };

  if (accepted.length > 0 || refused.length > 0) {
    logger.info({ event: "repo-config-overrides", accepted, refused });
  }

  return { config, guidance, ignorePaths, accepted, refused };
}
