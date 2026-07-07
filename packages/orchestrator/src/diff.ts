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
// `as unknown as string` at the one call site below.

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

  const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  });

  const changedFiles = files.map((file) => file.filename);
  const changedLineCount = files.reduce(
    (total, file) => total + file.additions + file.deletions,
    0,
  );
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
