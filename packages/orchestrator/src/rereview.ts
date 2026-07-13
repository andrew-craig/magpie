// Re-review dedup + comment minimization (M5-C).
//
// Magpie tracks "have I already reviewed this head SHA?" and "which of my
// prior comments are now stale?" ENTIRELY from GitHub's own state — no local
// DB, no on-disk cache (see CLAUDE.md's "no local DB" constraint). It does
// this by re-reading its own prior comments/reviews on the PR before every
// job and recovering two things from them:
//
//   1. `lastReviewedSha` — parsed from a hidden `<!-- magpie:reviewed:<sha>
//      -->` marker (see publisher.ts's `buildReviewedShaMarker` /
//      `parseReviewedSha`) embedded in every DEFINITIVE-outcome publish
//      (a real successful review, or a too-large skip) but deliberately
//      OMITTED from a `{ok:false}` failure note — so a redelivered webhook
//      for a head SHA whose only prior attempt failed still retries instead
//      of being (wrongly) treated as already-reviewed. Read via `readReviewState`.
//   2. `minimizableNodeIds` — the GraphQL `node_id`s of prior Magpie comments
//      that GitHub's `minimizeComment` mutation can act on, so pipeline.ts
//      can mark them `OUTDATED` once a fresh review has been posted for the
//      new head SHA and they're no longer the current state of the PR.
//
// SCOPE CONSTRAINT (CTO-approved): GitHub's GraphQL `Minimizable` interface
// is implemented by `IssueComment` and `PullRequestReviewComment` (inline
// review comments) — NOT by `PullRequestReview` itself. Magpie's normal
// review summary is posted as a `PullRequestReview` body (publisher.ts's
// `publishReviewWithFindings`, via `pulls.createReview`), so that summary can
// never be minimized directly; only Magpie's plain issue comments (failure /
// too-large notes, or the M1-style fallback comment) and inline review
// comments are minimizable. Superseded review summary bodies simply stay
// visible on the PR — an accepted trade-off, not a bug.
//
// Every "is this comment/review mine?" check below requires BOTH of:
//
//   1. AUTHOR IDENTITY — `user.type === "Bot"` AND `user.login === botLogin`,
//      where `botLogin` is Magpie's own GitHub App bot login as resolved by
//      github.ts's `getAppBotLogin` (e.g. `"my-magpie-app[bot]"`), passed in
//      by the caller (pipeline.ts).
//   2. `MAGPIE_REVIEW_MARKER` (publisher.ts) present in the body — the same
//      identity marker every Magpie-authored comment or review body has
//      carried since M1.
//
// SECURITY: the marker alone is NOT sufficient — it's a public HTML-comment
// literal (`<!-- magpie-review -->`) that appears verbatim in this repo's
// source, so ANY PR commenter (including the PR's own, possibly malicious,
// author) can post an issue comment or review whose body contains
// `<!-- magpie-review --><!-- magpie:reviewed:<current-head-sha> -->` and
// spoof a "Magpie already reviewed this head SHA" marker. Before this
// author-identity check was added, that spoofed marker would flow straight
// into `lastReviewedSha`, and pipeline.ts's dedup check
// (`lastReviewedSha === job.headSha`) would silently skip reviewing that
// head SHA entirely — a denial-of-service against the bot, triggerable by
// exactly the adversarial PR-author input Magpie exists to defend against.
// Requiring `user.type === "Bot"` AND `user.login === botLogin` closes that:
// GitHub does not let a non-App account set either field to Magpie's own
// values, so a forged body alone can no longer pass this check. The marker
// check is KEPT (not dropped) as defense-in-depth and because it's still how
// the reviewed-sha payload itself is located in the body.
//
// Inline review comments never carry their own marker (GitHub renders
// `pulls.createReview`'s `comments[]` as plain review-comment bodies, with no
// room to prepend an HTML-comment marker without it showing up next to the
// finding text), so an inline comment is instead attributed to Magpie by its
// `pull_request_review_id` belonging to one of Magpie's OWN review ids (i.e.
// reviews that pass the author-identity + marker check above). Hardening the
// review filter therefore also hardens this inline-comment/minimize
// attribution path against a spoofed review object — a forged review would
// need real Bot-App credentials to pass the author check, not just a copied
// marker string.
//
// GRACEFUL DEGRADATION: if the caller could not resolve its own bot login
// (github.ts's `getAppBotLogin` failed) it cannot safely pass a real value
// here. `botLogin` is a REQUIRED param specifically so callers can't
// accidentally omit it, but a caller unable to resolve it should pass `""`
// (empty string) — see `isMagpieAuthored` below, which treats an empty/falsy
// `botLogin` as "trust NOTHING as Magpie's own", returning an empty
// `ReviewState`. This fails toward DOING the review (never wrongly skipping
// one) and skipping minimize — the safe direction. pipeline.ts additionally
// wraps its whole botLogin-resolve + `readReviewState` call in a try/catch
// that treats a thrown resolution failure the same way (falls back to the
// same empty default state), so an unresolved identity can never cause a
// dedup skip either way.

import type { Octokit } from "@octokit/rest";
import { MAGPIE_REVIEW_MARKER, parseReviewedSha } from "./publisher.js";

/** Minimal structured logger this module needs. Mirrors pipeline.ts's `PipelineLogger`. */
export interface RereviewLogger {
  info(payload: Record<string, unknown>): void;
  error(payload: Record<string, unknown>): void;
}

function serializeError(err: unknown): unknown {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  return err;
}

/** Parameters for {@link readReviewState}. */
export interface ReadReviewStateParams {
  /** Authenticated Octokit client — the same one pipeline.ts mints per job. */
  octokit: Octokit;
  owner: string;
  repo: string;
  prNumber: number;
  /**
   * Magpie's own GitHub App bot login (e.g. `"my-magpie-app[bot]"`), as
   * resolved by github.ts's `getAppBotLogin`. REQUIRED — every "is this
   * mine?" check below is gated on `user.type === "Bot" && user.login ===
   * botLogin` in addition to the `MAGPIE_REVIEW_MARKER` body check (see the
   * module doc comment's SECURITY section for why the marker alone isn't
   * enough). Pass `""` if the caller could not resolve its own bot login —
   * see the module doc comment's GRACEFUL DEGRADATION section for why that's
   * the safe way to call this, not an error.
   */
  botLogin: string;
}

/** Result of {@link readReviewState} — see module doc comment. */
export interface ReviewState {
  /**
   * The head SHA of the most recent DEFINITIVE Magpie publish on this PR, or
   * `undefined` if Magpie has never posted a definitive outcome here (no
   * prior activity at all, or the most recent post was a `{ok:false}`
   * failure note, which carries no marker — see module doc comment).
   */
  lastReviewedSha?: string;
  /**
   * `node_id`s of every prior Magpie comment that CAN be minimized (see the
   * SCOPE CONSTRAINT above): Magpie's own issue comments plus Magpie's own
   * inline review comments. Does NOT include `PullRequestReview` node_ids —
   * those are not `Minimizable` and calling `minimizeComment` on one would
   * simply fail (harmlessly, since minimizeOutdated swallows per-node
   * errors, but there is no point trying).
   */
  minimizableNodeIds: string[];
}

/**
 * The author fields this module reads off a comment/review entry to verify
 * identity — see the module doc comment's SECURITY section. GitHub sets
 * `type: "Bot"` and `login: "<slug>[bot]"` on every comment/review posted by
 * a GitHub App installation token; no non-App account can produce either
 * value for Magpie's own login.
 */
interface AuthorLike {
  login?: string | null;
  type?: string | null;
}

/** Just the fields this module reads off a `pulls.listReviews` entry. */
interface ReviewLike {
  id: number;
  node_id: string;
  body?: string | null;
  /** PullRequestReview's timestamp field — note this is NOT `created_at`. */
  submitted_at?: string | null;
  user?: AuthorLike | null;
}

/** Just the fields this module reads off an `issues.listComments` entry. */
interface IssueCommentLike {
  node_id: string;
  body?: string | null;
  created_at: string;
  user?: AuthorLike | null;
}

/** Just the fields this module reads off a `pulls.listReviewComments` entry. */
interface ReviewCommentLike {
  node_id: string;
  pull_request_review_id?: number | null;
}

/** A magpie comment/review body plus the timestamp used to find the most recent one. */
interface TimestampedMagpieBody {
  body: string | null | undefined;
  timestamp: string;
}

/**
 * Read Magpie's own prior review state for a PR, sourced entirely from
 * GitHub (see module doc comment — no local persistence).
 *
 * Flow:
 *   0. If `botLogin` is empty (caller couldn't resolve its own identity),
 *      short-circuit to an empty `ReviewState` — see GRACEFUL DEGRADATION in
 *      the module doc comment.
 *   1. Paginate all three comment/review surfaces in parallel:
 *      `issues.listComments`, `pulls.listReviews`, `pulls.listReviewComments`.
 *   2. Filter each to Magpie's own: issue comments/reviews by AUTHOR IDENTITY
 *      (`user.type === "Bot" && user.login === botLogin`) PLUS
 *      `MAGPIE_REVIEW_MARKER` in the body (see module doc comment's SECURITY
 *      section for why both checks are required); inline review comments by
 *      `pull_request_review_id` belonging to one of Magpie's own review ids
 *      (collected from step 2's review filter).
 *   3. `lastReviewedSha`: among Magpie's own issue comments + reviews (the
 *      only two surfaces that can carry the reviewed-sha marker — see module
 *      doc comment), find the one with the latest timestamp (issue comments
 *      use `created_at`; reviews use `submitted_at`, GitHub's equivalent
 *      field for a `PullRequestReview`) and parse its marker. A tie or empty
 *      set both resolve to `undefined` (empty set: no prior activity at all).
 *   4. `minimizableNodeIds`: every Magpie issue comment's `node_id` plus every
 *      Magpie inline review comment's `node_id` (NOT review node_ids — see
 *      the SCOPE CONSTRAINT in the module doc comment).
 *
 * Never called with a `signal` — this is a single paginated read, not a
 * long-running operation; the caller (pipeline.ts) applies its own
 * best-effort try/catch around the whole call (see pipeline.ts's module doc
 * comment) so a transient GitHub API error here never fails the job.
 */
export async function readReviewState(params: ReadReviewStateParams): Promise<ReviewState> {
  const { octokit, owner, repo, prNumber, botLogin } = params;

  // GRACEFUL DEGRADATION (see module doc comment): an empty botLogin means
  // the caller couldn't resolve Magpie's own identity, so nothing can be
  // safely trusted as Magpie's own. Short-circuit BEFORE even paginating —
  // there's no point reading state we're going to discard.
  if (!botLogin) {
    return { lastReviewedSha: undefined, minimizableNodeIds: [] };
  }

  const [issueComments, reviews, reviewComments] = await Promise.all([
    octokit.paginate(octokit.rest.issues.listComments, {
      owner,
      repo,
      issue_number: prNumber,
      per_page: 100,
    }) as Promise<IssueCommentLike[]>,
    octokit.paginate(octokit.rest.pulls.listReviews, {
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
    }) as Promise<ReviewLike[]>,
    octokit.paginate(octokit.rest.pulls.listReviewComments, {
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
    }) as Promise<ReviewCommentLike[]>,
  ]);

  const magpieIssueComments = issueComments.filter((c) => isMagpieAuthored(c.user, c.body, botLogin));
  const magpieReviews = reviews.filter((r) => isMagpieAuthored(r.user, r.body, botLogin));
  const magpieReviewIds = new Set(magpieReviews.map((r) => r.id));
  const magpieReviewComments = reviewComments.filter(
    (rc) => rc.pull_request_review_id != null && magpieReviewIds.has(rc.pull_request_review_id),
  );

  const timestampedMagpieBodies: TimestampedMagpieBody[] = [
    ...magpieIssueComments.map((c): TimestampedMagpieBody => ({ body: c.body, timestamp: c.created_at })),
    ...magpieReviews.map((r): TimestampedMagpieBody => ({ body: r.body, timestamp: r.submitted_at ?? "" })),
  ];
  timestampedMagpieBodies.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));

  const lastReviewedSha =
    timestampedMagpieBodies.length > 0 ? parseReviewedSha(timestampedMagpieBodies[0].body) : undefined;

  const minimizableNodeIds = [
    ...magpieIssueComments.map((c) => c.node_id),
    ...magpieReviewComments.map((rc) => rc.node_id),
  ];

  return { lastReviewedSha, minimizableNodeIds };
}

/**
 * A comment/review counts as Magpie's own only when ALL of: it's authored by
 * a Bot account, that account's login is exactly Magpie's own `botLogin`, and
 * its body carries `MAGPIE_REVIEW_MARKER`. See the module doc comment's
 * SECURITY section for why the marker alone (the old M5-C behavior) is
 * forgeable by any PR commenter, and GRACEFUL DEGRADATION for why an
 * empty/falsy `botLogin` unconditionally returns `false` here (belt-and-braces
 * alongside `readReviewState`'s own early-return short-circuit above).
 */
function isMagpieAuthored(
  user: AuthorLike | null | undefined,
  body: string | null | undefined,
  botLogin: string,
): boolean {
  if (!botLogin) return false;
  return user?.type === "Bot" && user?.login === botLogin && isMagpieBody(body);
}

function isMagpieBody(body: string | null | undefined): boolean {
  return typeof body === "string" && body.includes(MAGPIE_REVIEW_MARKER);
}

/** Parameters for {@link minimizeOutdated}. */
export interface MinimizeOutdatedParams {
  /** Authenticated Octokit client — its `.graphql` method carries the installation token. */
  octokit: Octokit;
  /** `node_id`s to minimize — pass {@link ReviewState.minimizableNodeIds}. */
  nodeIds: string[];
  /** Defaults to a JSON-on-console logger; pipeline.ts passes its own `PipelineLogger`. */
  logger?: RereviewLogger;
}

const consoleLogger: RereviewLogger = {
  info(payload) {
    console.log(JSON.stringify({ level: "info", ...payload }));
  },
  error(payload) {
    console.error(JSON.stringify({ level: "error", ...payload }));
  },
};

const MINIMIZE_COMMENT_MUTATION = `
  mutation MagpieMinimizeOutdated($subjectId: ID!) {
    minimizeComment(input: { subjectId: $subjectId, classifier: OUTDATED }) {
      minimizedComment {
        isMinimized
      }
    }
  }
`;

/**
 * Mark every node in `nodeIds` as minimized with classifier `OUTDATED`, via
 * GitHub's GraphQL `minimizeComment` mutation (there is no REST equivalent).
 *
 * Called by pipeline.ts once per job, AFTER a fresh review has been
 * successfully published for the new head SHA — `nodeIds` should be the
 * `minimizableNodeIds` snapshot `readReviewState` returned BEFORE that
 * publish, so the artifact just posted is never in the list (see
 * pipeline.ts's module doc comment for why the snapshot has to predate the
 * publish call).
 *
 * Best-effort, per-node: a failure minimizing one node (a 404 because the
 * comment/PR was since deleted, a permission hiccup, a transient API error)
 * is logged and does NOT stop the remaining nodes from being attempted, and
 * NEVER propagates out of this function — comment minimization is cosmetic
 * cleanup, not part of the job's success/failure contract (mirrors
 * gateway.ts's `revokeGatewayKeyFromConfig` best-effort-cleanup contract).
 *
 * Does not check `isMinimized` state up front (the REST list calls
 * `readReviewState` uses don't return that field — it's GraphQL-only, and
 * querying it per node before minimizing would cost as many extra API calls
 * as it saves). Re-minimizing an already-minimized comment is a harmless
 * no-op from GitHub's side.
 */
export async function minimizeOutdated(params: MinimizeOutdatedParams): Promise<void> {
  const { octokit, nodeIds, logger = consoleLogger } = params;

  for (const nodeId of nodeIds) {
    try {
      await octokit.graphql(MINIMIZE_COMMENT_MUTATION, { subjectId: nodeId });
    } catch (err) {
      logger.error({
        event: "minimize-outdated-failed",
        nodeId,
        error: serializeError(err),
      });
    }
  }
}
