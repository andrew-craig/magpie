// PR diff computation, sourced entirely from the GitHub API.
//
// Deliberately does NOT touch the host-side workspace/checkout (see
// workspace.ts) or local `git` at all. The "base" side of a PR diff is
// whatever the target branch pointed at when GitHub computed the merge base —
// the workspace only ever holds `refs/pull/{N}/head` (see workspace.ts's
// module doc comment: "we always fetch refs/pull/{N}/head ... never a fork
// remote"), so it has no base ref checked out to diff against locally. The
// GitHub API (`GET /repos/{owner}/{repo}/pulls/{number}` with the `diff`
// media type) already computes exactly this two-sided unified diff for us,
// so this module just asks for it rather than re-deriving it from a partial
// local checkout.
//
// Cap semantics: before fetching the (potentially large) diff body, we first
// list the PR's changed files (paginated, since a large PR can span more than
// one page) and sum `additions + deletions` across them. If that total
// exceeds `maxDiffLines` (from `config.limits.maxDiffLines`), we short-circuit
// and never fetch the diff body at all — the job downstream posts a
// summary-only comment for oversized PRs rather than running a review, so
// pulling a huge diff payload just to discard it would be wasted GitHub API
// traffic (and, per the project's threat model, unnecessary exposure of a
// large untrusted payload to anything that touches it on the host).
//
// Octokit quirk: `octokit.rest.pulls.get(...)` is statically typed to return
// a `PullRequest` object, but when called with `mediaType: { format: "diff" }`
// the GitHub API instead responds with the raw unified diff as plain text,
// and Octokit hands that back as `response.data` — a `string`, not a
// `PullRequest`. The static type doesn't know this, so we cast via
// `as unknown as string` at the one call site below. The same quirk applies to
// `repos.compareCommitsWithBasehead` (see {@link computeIncrementalDiff}).
//
// Incremental re-review (M5-B): on a `synchronize` delivery the webhook payload
// carries the pre/post-push head SHAs (`before`/`after`). Rather than
// re-reviewing (and re-billing) the whole PR on every follow-up push,
// {@link computeIncrementalDiff} asks GitHub's compare API for just the
// `before...after` range. It is deliberately CONSERVATIVE: it only returns a
// usable range for a clean fast-forward (`compare.status === "ahead"`, i.e.
// `before` is an ancestor of `after`, so the range is exactly the newly-pushed
// commits). Every other case — a rebase/force-push (`diverged`), a revert
// (`behind`), a no-op (`identical`), a `before` GitHub can no longer reach
// (404), an empty file set, or any compare error — reports the range as
// unavailable so the caller falls back to the full PR diff. This keeps the
// incremental path from ever silently reviewing a WRONG or partial slice: when
// in any doubt, review everything.

import type { Octokit } from "@octokit/rest";

/** Result of computing a PR's diff. */
export interface PrDiffResult {
  /** Unified diff text (git-style). `null` when `tooLarge` (never fetched — see module doc comment). */
  diff: string | null;
  /** Changed file paths, from the PR's files API (across all pages). */
  changedFiles: string[];
  /** Total changed lines = Σ(additions + deletions) across all changed files. */
  changedLineCount: number;
  /** True when `changedLineCount` exceeds `maxDiffLines`; downstream posts summary-only. */
  tooLarge: boolean;
}

/** Parameters for {@link computePrDiff}. */
export interface ComputePrDiffParams {
  /** Authenticated Octokit client — injected by the caller, never constructed here. */
  octokit: Octokit;
  owner: string;
  repo: string;
  prNumber: number;
  /** Cap on total changed lines; caller passes `config.limits.maxDiffLines`. */
  maxDiffLines: number;
}

/**
 * Compute a PR's diff and size, sourcing the base side from the GitHub API
 * (see module doc comment for why — never local git, never the workspace).
 *
 * Flow:
 *   1. List every changed file via `octokit.paginate(octokit.rest.pulls.listFiles, ...)`
 *      (paginated across all pages — a large PR can exceed one page of files).
 *      Derive `changedFiles` (each file's `filename`) and `changedLineCount`
 *      (sum of each file's `additions + deletions`).
 *   2. `tooLarge = changedLineCount > maxDiffLines`.
 *   3. If `tooLarge`: return immediately with `diff: null` — the full diff
 *      body is never fetched (see module doc comment).
 *   4. Otherwise fetch the unified diff via `octokit.rest.pulls.get` with
 *      `mediaType: { format: "diff" }` and assign it to `diff` (see the
 *      module doc comment for the response-shape cast this requires).
 */
export async function computePrDiff(
  params: ComputePrDiffParams,
): Promise<PrDiffResult> {
  const { octokit, owner, repo, prNumber, maxDiffLines } = params;

  const { changedFiles, changedLineCount } = await listPrChangedFiles({
    octokit,
    owner,
    repo,
    prNumber,
  });
  const tooLarge = changedLineCount > maxDiffLines;

  if (tooLarge) {
    return { diff: null, changedFiles, changedLineCount, tooLarge };
  }

  const response = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
    mediaType: { format: "diff" },
  });
  // See module doc comment: with format:"diff" the response body is the raw
  // diff string, not the statically-typed PullRequest object.
  const diff = response.data as unknown as string;

  return { diff, changedFiles, changedLineCount, tooLarge };
}

/** Parameters for {@link listPrChangedFiles}. */
export interface ListPrChangedFilesParams {
  octokit: Octokit;
  owner: string;
  repo: string;
  prNumber: number;
}

/**
 * List a PR's changed files (across all pages) and their total changed-line
 * count. Shared by {@link computePrDiff} (which additionally fetches the full
 * diff body) and by pipeline.ts's incremental path, which needs the WHOLE-PR
 * file list as reviewer context even when only the incremental range is sent
 * to Pi (see {@link computeIncrementalDiff}).
 */
export async function listPrChangedFiles(
  params: ListPrChangedFilesParams,
): Promise<{ changedFiles: string[]; changedLineCount: number }> {
  const { octokit, owner, repo, prNumber } = params;

  const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  });

  const changedFiles = files.map((file) => file.filename);
  // `additions`/`deletions` are typed as required `number` in GitHub's
  // diff-entry schema, but this sum feeds the `maxDiffLines` security cap
  // downstream: a missing field at runtime would make the sum `NaN`, and
  // `NaN > maxDiffLines` is `false` — the cap would fail open on a huge PR.
  // `?? 0` keeps a malformed/missing field from silently defeating the cap.
  const changedLineCount = files.reduce(
    (total, file) => total + (file.additions ?? 0) + (file.deletions ?? 0),
    0,
  );

  return { changedFiles, changedLineCount };
}

/** Parameters for {@link computeIncrementalDiff}. */
export interface ComputeIncrementalDiffParams {
  /** Authenticated Octokit client — injected by the caller, never constructed here. */
  octokit: Octokit;
  owner: string;
  repo: string;
  /** The pre-push head SHA (`before` from a `synchronize` payload). */
  base: string;
  /** The post-push head SHA (`after` from a `synchronize` payload). */
  head: string;
  /** Cap on total changed lines; caller passes `config.limits.maxDiffLines`. */
  maxDiffLines: number;
}

/**
 * Result of {@link computeIncrementalDiff}: either a usable incremental
 * `PrDiffResult` for the `base...head` range, or an explicit
 * "not available, here's why" signal telling the caller to fall back to the
 * full PR diff. Deliberately a discriminated union (not a nullable
 * `PrDiffResult`) so the fallback reason can be logged.
 */
export type IncrementalDiffResult =
  | { available: true; result: PrDiffResult }
  | { available: false; reason: string };

/** The all-zeros SHA GitHub uses for an absent ref (e.g. branch just created). */
const ZERO_SHA = "0000000000000000000000000000000000000000";

/**
 * GitHub's documented per-response file cap for the compare endpoint (it
 * returns "a diff of up to 300 files"). A compare `files` array at this length
 * may be truncated, so {@link computeIncrementalDiff} falls back to the full
 * (paginated-cap) PR diff rather than risk undercounting the size cap.
 */
const COMPARE_FILES_LIMIT = 300;

/**
 * Compute the incremental `base...head` diff for a `synchronize` re-review,
 * sourced from GitHub's compare API — see the module doc comment for the
 * conservative "fast-forward only" policy and why every other case falls back
 * to the full PR diff.
 *
 * Flow:
 *   1. Reject obviously-unusable SHAs (missing or the all-zeros sentinel)
 *      before spending an API call.
 *   2. `GET /repos/{owner}/{repo}/compare/{base}...{head}` (metadata only).
 *      Any error (notably a 404 when `base` was rewritten away by a
 *      force-push and GitHub can no longer reach it) → unavailable.
 *   3. Only `status === "ahead"` (base is an ancestor of head) yields a range
 *      that is exactly the newly-pushed commits. `diverged`/`behind`/
 *      `identical` → unavailable (fall back to full).
 *   4. Empty file set (e.g. an empty/merge-only push) → unavailable.
 *   5. Apply the SAME `maxDiffLines` cap to the incremental range; if it's
 *      over, return a `tooLarge` result (diff never fetched — same skip path
 *      as an oversized full PR).
 *   6. Otherwise fetch the unified diff for the range (compare API with the
 *      `diff` media type — same response-shape cast as `computePrDiff`).
 */
export async function computeIncrementalDiff(
  params: ComputeIncrementalDiffParams,
): Promise<IncrementalDiffResult> {
  const { octokit, owner, repo, base, head, maxDiffLines } = params;

  if (!base || !head || base === ZERO_SHA || head === ZERO_SHA) {
    return { available: false, reason: "missing or zero before/after sha" };
  }
  if (base === head) {
    return { available: false, reason: "before and after sha are identical" };
  }

  const basehead = `${base}...${head}`;

  let comparison: {
    status?: string;
    files?: { filename: string; additions?: number; deletions?: number }[];
  };
  try {
    const response = await octokit.rest.repos.compareCommitsWithBasehead({
      owner,
      repo,
      basehead,
    });
    // Default to `{}` if the API ever hands back a null/undefined body: the
    // status/files checks below run OUTSIDE this try/catch, so a bare
    // `comparison.status` on a null body would throw a TypeError and fail the
    // whole job instead of falling through to the full-diff fallback.
    comparison = response.data ?? {};
  } catch (err) {
    // A force-push can rewrite `before` out of existence; GitHub then 404s the
    // compare. Any other transient/API error lands here too — either way, fall
    // back to the full PR diff rather than failing the review.
    return {
      available: false,
      reason: `compare ${basehead} failed: ${errorMessage(err)}`,
    };
  }

  // Only a clean fast-forward gives a range that is exactly the new commits.
  // Anything else (rebase/force-push -> diverged, revert -> behind, no-op ->
  // identical) is reviewed in full instead (see module doc comment).
  if (comparison.status !== "ahead") {
    return {
      available: false,
      reason: `compare ${basehead} status ${comparison.status ?? "unknown"} is not a fast-forward`,
    };
  }

  const files = comparison.files ?? [];
  if (files.length === 0) {
    return { available: false, reason: `compare ${basehead} has no changed files` };
  }

  // The compare endpoint returns files from a SINGLE response and caps them at
  // COMPARE_FILES_LIMIT (GitHub's documented per-response limit) — unlike
  // `computePrDiff`, which paginates `pulls.listFiles`. If the range touches
  // that many files, `comparison.files` may be TRUNCATED, so summing it would
  // undercount `changedLineCount` and let an over-cap range slip past the size
  // cap (shipping an oversized untrusted diff to Pi — the very thing the cap
  // exists to prevent). Rather than paginate the awkward compare response, stay
  // consistent with this function's "when in any doubt, review everything"
  // policy: treat a possibly-truncated list as unavailable and fall back to the
  // full PR diff, whose cap is computed from a fully-paginated source.
  if (files.length >= COMPARE_FILES_LIMIT) {
    return {
      available: false,
      reason: `compare ${basehead} returned ${files.length} files (>= ${COMPARE_FILES_LIMIT} cap); file list may be truncated`,
    };
  }

  const changedFiles = files.map((file) => file.filename);
  // Same `?? 0` cap-hardening rationale as listPrChangedFiles above.
  const changedLineCount = files.reduce(
    (total, file) => total + (file.additions ?? 0) + (file.deletions ?? 0),
    0,
  );
  const tooLarge = changedLineCount > maxDiffLines;

  if (tooLarge) {
    return {
      available: true,
      result: { diff: null, changedFiles, changedLineCount, tooLarge },
    };
  }

  let diff: string;
  try {
    const response = await octokit.rest.repos.compareCommitsWithBasehead({
      owner,
      repo,
      basehead,
      mediaType: { format: "diff" },
    });
    // See module doc comment: with format:"diff" the response body is the raw
    // diff string, not the statically-typed comparison object.
    diff = response.data as unknown as string;
  } catch (err) {
    return {
      available: false,
      reason: `compare ${basehead} diff fetch failed: ${errorMessage(err)}`,
    };
  }

  return { available: true, result: { diff, changedFiles, changedLineCount, tooLarge } };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
