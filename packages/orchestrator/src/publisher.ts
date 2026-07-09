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
import type { Finding, InlineComment } from "./anchor.js";
export type { ReviewResult, ReviewUsage };
export type { Finding, InlineComment };

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
  /**
   * Used only by the M2 structured-findings publish path
   * ({@link publishReviewWithFindings}) — `publishReview` never touches it.
   * Included on this same minimal-client interface (rather than a second,
   * parallel interface) so production code hands both publish functions the
   * one real Octokit client from `createInstallationOctokit`, and tests
   * build one fake client shape for both.
   */
  pulls: {
    createReview(args: {
      owner: string;
      repo: string;
      pull_number: number;
      event: "COMMENT";
      body: string;
      comments: Array<{
        path: string;
        line: number;
        side: "RIGHT";
        start_line?: number;
        start_side?: "RIGHT";
        body: string;
      }>;
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

// ---------------------------------------------------------------------------
// M2: structured findings -> one PR review with inline comments.
//
// `publishReviewWithFindings` is DECOUPLED from reviewer.ts's `ReviewResult`:
// it takes already-anchored data (an `anchor.ts` `AnchorResult`'s `inline` /
// `other`, plus the review `summary`), not a `ReviewResult`. The pipeline
// (wave 3) is the one that calls `anchorFindings()` and passes its output in
// here; this module stays ignorant of diff-anchoring entirely. It is
// additive — `publishReview`, `buildFailureBody`, `fenceReason`,
// `buildSuccessBody`, `formatUsageFooter`, the `{ok:false}` failure path, and
// the no-findings success path above are all unchanged and still used by
// the M1 pipeline until wave 3 rewires it.
// ---------------------------------------------------------------------------

/** Parameters for {@link publishReviewWithFindings}. */
export interface PublishReviewWithFindingsParams {
  /** Authenticated GitHub client — see {@link MinimalIssuesClient} for the test seam. */
  octokit: MinimalIssuesClient;
  owner: string;
  repo: string;
  prNumber: number;
  /** The review's overall markdown summary (as authored by the Pi reviewer). */
  summary: string;
  /** Findings that anchored to a commentable diff line — see `anchor.ts`'s `anchorFindings`. */
  inline: InlineComment[];
  /** Findings that could not be anchored at all — rendered into the body instead of dropped. */
  other: Finding[];
  usage?: ReviewUsage;
  /**
   * Advisory only. ACCEPTED BUT IGNORED: Magpie never approves or requests
   * changes (see PLAN.md §7 / CLAUDE.md's core security principle — a human
   * always decides), so every review this function posts uses
   * `event: "COMMENT"` regardless of what's passed here. The parameter
   * exists purely so callers holding a `verdict` from the findings payload
   * don't need to strip it before calling this function.
   */
  verdict?: "approve" | "comment";
}

/**
 * Publish exactly one GitHub PR review (`pulls.createReview`) carrying
 * inline comments for every diff-anchored finding, with a summary body that
 * also surfaces every un-anchored finding under "Other observations" so
 * nothing is silently dropped (PLAN.md §7's diff-anchoring constraint).
 *
 * `event` is always `"COMMENT"` — see {@link PublishReviewWithFindingsParams.verdict}.
 *
 * FALLBACK CHAIN (never throws, never goes silent — mirrors `publishReview`'s
 * M1 contract):
 *  1. `pulls.createReview` with the full `comments[]` built from `inline`.
 *  2. If that rejects (GitHub 422s when any comment anchors to a line it
 *     doesn't consider part of the diff — see `anchor.ts`'s module doc
 *     comment), retry ONCE with `comments: []` and the `inline` findings
 *     folded into the body's "Other observations" section alongside `other`,
 *     so they're preserved as text instead of lost.
 *  3. If the retry ALSO rejects, fall back to a single `issues.createComment`
 *     (the M1-style plain summary comment) carrying that same folded body.
 */
export async function publishReviewWithFindings(
  params: PublishReviewWithFindingsParams,
): Promise<PublishedComment> {
  const { octokit, owner, repo, prNumber, summary, inline, other, usage } = params;

  const body = buildFindingsBody({ summary, other, usage });
  const comments = inline.map(toReviewComment);

  try {
    const response = await octokit.pulls.createReview({
      owner,
      repo,
      pull_number: prNumber,
      event: "COMMENT",
      body,
      comments,
    });
    return { id: response.data.id, url: response.data.html_url };
  } catch {
    // First failure (typically a 422 from an inline comment anchored to a
    // line GitHub rejects — see module doc comment above). Retry once with
    // no inline comments at all, folding what would have been inline
    // findings into the body as text instead of losing them.
    const fallbackBody = buildFindingsBody({ summary, other, usage, foldedInline: inline });
    try {
      const response = await octokit.pulls.createReview({
        owner,
        repo,
        pull_number: prNumber,
        event: "COMMENT",
        body: fallbackBody,
        comments: [],
      });
      return { id: response.data.id, url: response.data.html_url };
    } catch {
      // Second failure: give up on posting a review object at all and fall
      // back to the M1-style single issue comment, so a run never goes
      // silent even if `pulls.createReview` is unusable for this PR.
      const response = await octokit.issues.createComment({
        owner,
        repo,
        issue_number: prNumber,
        body: fallbackBody,
      });
      return { id: response.data.id, url: response.data.html_url };
    }
  }
}

/** Map an anchored `InlineComment` to a `pulls.createReview` `comments[]` entry. */
function toReviewComment(comment: InlineComment): {
  path: string;
  line: number;
  side: "RIGHT";
  start_line?: number;
  start_side?: "RIGHT";
  body: string;
} {
  const entry: {
    path: string;
    line: number;
    side: "RIGHT";
    start_line?: number;
    start_side?: "RIGHT";
    body: string;
  } = {
    path: comment.path,
    line: comment.line,
    side: comment.side,
    body: comment.message,
  };
  // Only set start_line/start_side for an actual multi-line range — anchor.ts
  // never sets one without the other, but this keeps that pairing explicit
  // here too rather than relying on the caller.
  if (comment.start_line !== undefined) {
    entry.start_line = comment.start_line;
    entry.start_side = comment.start_side;
  }
  return entry;
}

/**
 * Build the review body for {@link publishReviewWithFindings}: marker +
 * header + summary, an "Other observations" section (when there's anything
 * to show), and the usage footer.
 *
 * `foldedInline`, when provided, is the 422-fallback path folding what would
 * have been `comments[]` entries into the same "Other observations" section
 * as `other` — see `renderOtherObservations`'s doc comment for why they can
 * share one section/renderer instead of needing two.
 */
function buildFindingsBody(params: {
  summary: string;
  other: Finding[];
  usage?: ReviewUsage;
  foldedInline?: InlineComment[];
}): string {
  const { summary, other, usage, foldedInline } = params;
  const parts = [MAGPIE_REVIEW_MARKER, COMMENT_HEADER, "", summary.trim()];

  const observations = renderOtherObservations(other, foldedInline ?? []);
  if (observations) parts.push("", observations);

  const footer = formatUsageFooter(usage);
  if (footer) parts.push("", footer);

  return parts.join("\n");
}

/**
 * Render an "Other observations" markdown section listing every un-anchored
 * `Finding` and (on the 422-fallback path only) every `InlineComment` that
 * couldn't be posted inline, each as a `path:line` (or `path:start-end` for
 * a range) list item followed by its text. Returns `undefined` when there's
 * nothing to render, so callers can omit the section entirely rather than
 * emitting an empty heading.
 *
 * Both `Finding` (unformatted: separate severity/category/message/
 * suggestion) and `InlineComment` (pre-formatted via anchor.ts's
 * `formatMessage` into `.message`) are accepted so the SAME renderer backs
 * both the normal "other[] findings" section and the 422-fallback's folded
 * inline findings, instead of two near-duplicate implementations drifting
 * apart.
 */
function renderOtherObservations(other: Finding[], foldedInline: InlineComment[]): string | undefined {
  const items = [...other.map(findingToListItem), ...foldedInline.map(inlineCommentToListItem)];
  if (items.length === 0) return undefined;
  return ["### Other observations", "", ...items].join("\n");
}

/** One `Finding` -> one "Other observations" markdown list item. */
function findingToListItem(finding: Finding): string {
  const location =
    finding.end_line !== undefined && finding.end_line !== finding.line
      ? `${finding.path}:${finding.line}-${finding.end_line}`
      : `${finding.path}:${finding.line}`;
  const severityLabel = { blocking: "Blocking", important: "Important", nit: "Nit" }[
    finding.severity
  ];
  const textParts = [`**${severityLabel}** (${finding.category}) ${finding.message}`];
  if (finding.suggestion) textParts.push(`Suggestion: ${finding.suggestion}`);
  return `- \`${location}\`: ${textParts.join(" ")}`;
}

/** One (un-postable) `InlineComment` -> one "Other observations" markdown list item. */
function inlineCommentToListItem(comment: InlineComment): string {
  const location =
    comment.start_line !== undefined
      ? `${comment.path}:${comment.start_line}-${comment.line}`
      : `${comment.path}:${comment.line}`;
  // comment.message already has severity/category/suggestion folded in by
  // anchor.ts's formatMessage and may span multiple lines; flatten it to a
  // single line so it renders as one list item rather than breaking the list.
  const text = comment.message.replace(/\s*\n+\s*/g, " ").trim();
  return `- \`${location}\`: ${text}`;
}
