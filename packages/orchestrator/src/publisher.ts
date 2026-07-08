// Publisher: post the review result back to the PR as ONE summary comment.
//
// This is the last host-privileged step of the M1 pipeline (webhook -> auth
// -> clone -> reviewer.ts -> HERE). It takes the `ReviewResult` produced by
// reviewer.ts and turns it into exactly one `issues.createComment` call —
// never zero (a silent failure looks worse than an ugly comment) and never
// more than one (no duplicate/partial comments if something above this layer
// retries).
//
// SECURITY: the installation token used to authenticate the Octokit client is
// a live secret (see github.ts's doc comment) but this module never sees it
// directly — it only receives an already-authenticated client through the
// `octokit` param, and Octokit handles attaching the token to the HTTP
// request internally. The *comment body* built here is assembled only from
// `result.summary` / `result.reason` (plain review text / provider error
// text) — it is never templated from config, env, or any credential, so
// there is no path for a secret to end up in a PR comment. See
// `publisher.test.ts`'s "never leaks a secret-shaped token" test for the
// enforced invariant.

import type { ReviewResult, ReviewUsage } from "./reviewer.js";
export type { ReviewResult, ReviewUsage };

/**
 * Machine-greppable marker embedded (as an HTML comment, so invisible in
 * rendered markdown) in every comment this module posts. Exported as a
 * constant — rather than inlined per call site — so later milestones (e.g.
 * "find and update/minimize the existing magpie comment on this PR instead
 * of posting a new one") and this module's own tests both key off the exact
 * same literal instead of two copies drifting apart.
 */
export const MAGPIE_REVIEW_MARKER = "<!-- magpie-review -->";

/** Visible header for every Magpie review comment. */
const COMMENT_HEADER = "## \u{1F426} Magpie review";

/**
 * The exact slice of an authenticated Octokit client this module calls.
 * Deliberately NOT `Octokit` itself — narrowing to a minimal structural
 * interface means production code can hand this module the real client from
 * `createInstallationOctokit` (which satisfies this shape) while
 * `publisher.test.ts` hands it a bare `vi.fn()` fake, with no network, no
 * real GitHub App, and no real HTTP client involved. Mirrors reviewer.ts's
 * `piBinary` test-seam pattern.
 */
export interface MinimalIssuesClient {
  issues: {
    createComment(args: {
      owner: string;
      repo: string;
      issue_number: number;
      body: string;
    }): Promise<{ data: { id: number; html_url: string } }>;
  };
}

/** Parameters for {@link publishReview}. */
export interface PublishReviewParams {
  /** Authenticated GitHub client — see {@link MinimalIssuesClient} for the test seam. */
  octokit: MinimalIssuesClient;
  owner: string;
  repo: string;
  prNumber: number;
  /** The outcome of reviewer.ts's `runReview` — either branch is always published, never dropped. */
  result: ReviewResult;
}

/** The created comment's identity, as returned by the GitHub API. */
export interface PublishedComment {
  id: number;
  url: string;
}

/**
 * Publish exactly one issue comment summarizing a review run.
 *
 * Both branches of `ReviewResult` are handled: a successful run posts
 * `result.summary` (plus a compact usage footer when telemetry is
 * available), and a failed run posts a short, clearly-worded failure note
 * that still surfaces `result.reason` for debugging. Magpie's publish step
 * intentionally never goes silent — a bare "review failed" comment is far
 * more useful to a human than no comment at all, and it's the only signal
 * this bot ever gives besides inline findings in later milestones.
 *
 * Every comment carries {@link MAGPIE_REVIEW_MARKER} so future milestones
 * (dedup, edit-in-place, minimize-on-update) can find comments this bot
 * posted without guessing at comment text or author heuristics.
 */
export async function publishReview(
  params: PublishReviewParams,
): Promise<PublishedComment> {
  const { octokit, owner, repo, prNumber, result } = params;

  const body = result.ok
    ? buildSuccessBody(result)
    : buildFailureBody(result);

  const response = await octokit.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body,
  });

  return { id: response.data.id, url: response.data.html_url };
}

function buildSuccessBody(result: { ok: true; summary: string; usage?: ReviewUsage }): string {
  const parts = [MAGPIE_REVIEW_MARKER, COMMENT_HEADER, "", result.summary.trim()];
  const footer = formatUsageFooter(result.usage);
  if (footer) parts.push("", footer);
  return parts.join("\n");
}

function buildFailureBody(result: { ok: false; reason: string }): string {
  // Kept short and human-readable per the task's requirement: this is a
  // clear "the bot could not review this PR" signal, not a stack trace dump.
  // `result.reason` can contain upstream provider error text (see
  // reviewer.ts's "pi review failed: ..." / "pi exited with code ..." paths)
  // but never the installation token or LLM key — reviewer.ts's own doc
  // comments guarantee those are never placed in `reason`, and this function
  // does not append anything else that could carry a secret.
  //
  // ASYMMETRY (deliberate): the reason is rendered VERBATIM inside a fenced
  // code block, whereas the ok-path `summary` is rendered as raw markdown.
  // The summary is the Pi agent's authored review (file:line citations,
  // finding lists) meant to render as markdown; the reason is unknown-shape
  // machine error text (stderr, provider JSON, file paths with underscores,
  // `<tag>`-like fragments, asterisks) that would corrupt the rendered comment
  // — and mislead a reader — if interpolated as markdown.
  return [
    MAGPIE_REVIEW_MARKER,
    COMMENT_HEADER,
    "",
    "Magpie could not complete a review of this PR.",
    "",
    "Reason:",
    fenceReason(result.reason.trim()),
  ].join("\n");
}

/**
 * Wrap `reason` in a fenced code block that renders it verbatim.
 *
 * WHY: `reason` is unknown-shape error text (see {@link buildFailureBody}) and
 * may itself contain a run of backticks — a naive triple-backtick fence would
 * let such a run close the fence early and let the rest of the reason "break
 * out" into interpreted markdown (the very corruption this fence prevents). So
 * the fence length is computed as one more than the longest backtick run in
 * the reason (floored at the CommonMark minimum of 3), which guarantees the
 * inner text cannot terminate the fence. The reason sits on its own line
 * between the open/close fences so a leading/trailing backtick can't merge
 * with the fence.
 */
export function fenceReason(reason: string): string {
  const longestBacktickRun = Math.max(
    0,
    ...Array.from(reason.matchAll(/`+/g), (m) => m[0].length),
  );
  const fence = "`".repeat(Math.max(3, longestBacktickRun + 1));
  return `${fence}\n${reason}\n${fence}`;
}

/**
 * Compact one-line usage/cost footer (e.g. `_turns=2 tokens=333 cost=$0.0042_`),
 * or `undefined` when no usage telemetry was recorded for the run.
 */
function formatUsageFooter(usage: ReviewUsage | undefined): string | undefined {
  if (!usage) return undefined;
  return `_turns=${usage.turns} tokens=${usage.totalTokens} cost=$${usage.costUsd.toFixed(4)}_`;
}
