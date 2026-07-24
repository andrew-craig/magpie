// The end-to-end review pipeline: wires auth -> clone -> diff -> review ->
// publish -> cleanup into the single `JobRunner` the queue (see queue.ts)
// invokes per job, plus the `JobCleanup` hook the queue falls back to on a
// timeout.
//
// Pipeline order for a single job:
//
//   1. Require `job.installationId` (can't mint a token without it).
//   2. Mint ONE fresh installation token (github.ts) and build ONE Octokit
//      client from it, reused for every GitHub API call this job makes
//      (PR metadata, diff, and the final published comment). This mirrors
//      github.ts's "mint fresh per job, no cross-job cache" principle at the
//      per-job granularity: one token, minted once, used everywhere it's
//      needed, then allowed to expire naturally — never re-minted or cached
//      across jobs. We deliberately do NOT use `createInstallationOctokit`
//      (see github.ts): that helper re-derives its own token internally via
//      `authStrategy`, which would mean two tokens minted per job instead of
//      one.
//   2z. RE-REVIEW DEDUP (M5-C, rereview.ts): read Magpie's own prior
//      comments/reviews on the PR via `readReviewState` — stateless, sourced
//      entirely from GitHub (see rereview.ts's module doc comment; no local
//      DB). Deliberately placed here, BEFORE minting the gateway virtual key
//      or cloning, so a redelivered webhook for an already-reviewed head SHA
//      is a true no-op: no wasted gateway budget, no wasted clone. If
//      `lastReviewedSha === job.headSha`, log `event:"already-reviewed"` and
//      return without doing anything else. Before calling `readReviewState`
//      this step first resolves Magpie's own bot login (github.ts's
//      `getAppBotLogin`, via the `getBotLogin` dep) and passes it through —
//      `readReviewState` needs it to verify a comment/review's AUTHOR
//      identity, not just the forgeable `MAGPIE_REVIEW_MARKER` body literal
//      (see rereview.ts's module doc comment SECURITY section: without this,
//      a malicious PR author could spoof a "reviewed" marker for the current
//      head SHA and silently DoS the bot into skipping their own PR). BOTH
//      the bot-login resolution and the `readReviewState` call are wrapped in
//      ONE try/catch: a failure at EITHER step is logged and treated as "not
//      reviewed" (best-effort, never fails the job, never wrongly skips a
//      review) — see the try/catch below. The returned `minimizableNodeIds`
//      snapshot is threaded through to step 7's post-publish minimize call.
//   2a. Mint ONE fresh gateway virtual key (gateway.ts's
//      `mintGatewayKeyFromConfig`, M4-B) scoped to `config.llm.model`, with a
//      budget/TTL from `config.gateway`. From here on the rest of the job
//      body runs inside a `try/finally` that revokes this key on every exit
//      path (success, a thrown error, or a "review failed" result) — mirrors
//      step 3's workspace `try/finally` one level out, since the key must
//      outlive (and be cleaned up around) everything the workspace cleanup
//      already wraps. Revocation is best-effort and never throws (see
//      gateway.ts) — a revoke failure is logged but never changes the job's
//      outcome. The minted key's `.key` is threaded straight into
//      `runReview` below as `gatewayApiKey` (M4-C), which sets it as the
//      review container's `OPENROUTER_API_KEY` — the orchestrator never
//      holds (and, since M4-C, no longer even loads — see config.ts) a real
//      provider key to substitute instead. As of M7-1 (Design D —
//      DISTRIBUTION.md §2) the mint call also passes `job.id` and the
//      response's `.socketDir` is threaded into `runReview` as
//      `gatewaySocketDir`, which reviewer.ts bind-mounts read-only at
//      `/run/gw` in the review container — now the container's ONLY path to
//      the gateway, since it runs `--network none`.
//   3. Create the credential-free host workspace (workspace.ts) for the PR
//      head checkout. From here on the rest of the job body runs inside a
//      (nested) `try/finally` so the workspace is always cleaned up, on every
//      exit path (success, a thrown error, or a "review failed" result — the
//      last of those is not an error at all, see step 6).
//   4. Compute the PR diff via the GitHub API (diff.ts), capped by
//      `config.limits.maxDiffLines`.
//   5. Fetch PR title/body/head sha (needed by the reviewer prompt; the
//      queue's `JobDescriptor` deliberately doesn't carry title/body — see
//      queue.ts). This call is deliberately made AFTER the diff fetch and
//      AFTER the workspace checkout (which itself pins to `job.headSha` and
//      fails closed if a force-push landed before checkout — see
//      workspace.ts) so its `head.sha` can be compared against `job.headSha`
//      to detect a force-push that landed *after* checkout but before/during
//      the diff fetch (see HEAD VERIFY below) — the one race window
//      workspace.ts's own pre-checkout check can't cover.
//   5a. HEAD VERIFY: if the just-fetched `pr.head.sha` no longer matches
//      `job.headSha`, the workspace (pinned to the old head) and the diff
//      (fetched against the new head) are now an incoherent pair — publishing
//      a review built from them could describe the wrong commit. Log and
//      return WITHOUT publishing; a fresh webhook delivery for the new head
//      will re-trigger a review of the current state (same benign-loss
//      rationale as a crash mid-job — see PLAN.md §3).
//   6. Turn the diff into a `ReviewResult`: an oversized diff never reaches
//      `runReview` at all (diff.ts never even fetches the body — see its
//      module doc comment) and instead gets a synthesized "skipped" summary;
//      everything else is handed to reviewer.ts's `runReview`, which never
//      throws — a failed review is a normal `{ ok: false, reason }` value,
//      not an exception, and is published just like a successful one.
//   7. Publish exactly one review/comment (publisher.ts), branching on the
//      shape of `result`:
//        - `{ ok: false }` (review failed) -> `publishReview` (M1's single
//          `issues.createComment` failure-note path, unchanged).
//        - `{ ok: true }` but `prDiff.tooLarge` (the synthesized skipped-review
//          summary from step 6) -> `publishReview` too (M1's single summary
//          comment, unchanged) — there are no real findings to anchor.
//        - `{ ok: true }` from a real `runReview` call -> anchor its findings
//          against the diff (anchor.ts's `anchorFindings`) and publish the
//          result as ONE PR review with inline comments plus a summary body
//          (`publishReviewWithFindings`), so diff-anchored findings surface as
//          inline comments instead of being flattened into plain text.
//      Whichever branch runs, `result.ok ? job.headSha : undefined` is passed
//      as `reviewedSha` (publisher.ts, M5-C) so a definitive outcome (real
//      success or tooLarge skip) — but never a failure — embeds the hidden
//      "reviewed" marker `readReviewState` looks for on the next delivery.
//   7a. MINIMIZE OUTDATED (M5-C, rereview.ts): when `result.ok`, call
//      `minimizeOutdated` on the `minimizableNodeIds` snapshot captured in
//      step 2z — BEFORE this publish, not after — so the comment/review just
//      posted in step 7 is never in that list and can't self-minimize.
//      Best-effort: `minimizeOutdated` never throws (see rereview.ts); a
//      per-node minimize failure is only logged.
//
// SECURITY: the installation token minted in step 2 is a live GitHub
// credential. It is only ever passed to `new Octokit({ auth: token })` and to
// `createWorkspace({ token })` (which itself only ever sends it over the
// process environment to `git`, never argv or disk — see workspace.ts). It is
// never logged, never included in a log payload below, and never reaches the
// reviewer subprocess (reviewer.ts strips all `MAGPIE_*` env vars from that
// child's environment before spawning it). Every log line emitted by this
// module is a plain object of ids/counts/urls — never the token, never
// `config.secrets`, never the raw Octokit client, never a gateway master key
// or minted virtual key (gateway.ts's own mint/revoke functions carry the
// same never-log discipline for those — see gateway.ts's module doc comment).

import { rm } from "node:fs/promises";
import { join } from "node:path";
import { Octokit } from "@octokit/rest";
import { anchorFindings } from "./anchor.js";
import type { Config } from "./config.js";
import type { PrDiffResult } from "./diff.js";
import { computeIncrementalDiff, computePrDiff, listPrChangedFiles } from "./diff.js";
import type { GatewayKey, GatewayKeyRevocation } from "./gateway.js";
import { mintGatewayKeyFromConfig, revokeGatewayKeyFromConfig } from "./gateway.js";
import { getAppBotLoginFromConfig, mintInstallationTokenFromConfig } from "./github.js";
import { publishReview, publishReviewWithFindings } from "./publisher.js";
import type { JobCleanup, JobDescriptor, JobRunner } from "./queue.js";
import type { ReviewState } from "./rereview.js";
import { minimizeOutdated, readReviewState } from "./rereview.js";
import type { ReviewResult } from "./reviewer.js";
import { runReview } from "./reviewer.js";
import type { JobOutcome, TelemetryGatewaySpend } from "./telemetry.js";
import { recordJobTelemetry } from "./telemetry.js";
import { createWorkspace } from "./workspace.js";

/** Minimal structured logger this module needs. Defaults to console JSON. */
export interface PipelineLogger {
  info(payload: Record<string, unknown>): void;
  error(payload: Record<string, unknown>): void;
}

function serializeError(err: unknown): unknown {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  return err;
}

const consoleLogger: PipelineLogger = {
  info(payload) {
    console.log(JSON.stringify({ level: "info", ...payload }));
  },
  error(payload) {
    console.error(JSON.stringify({ level: "error", ...payload }));
  },
};

function jobLogFields(job: JobDescriptor): Record<string, unknown> {
  return {
    id: job.id,
    owner: job.owner,
    repo: job.repo,
    prNumber: job.prNumber,
    headSha: job.headSha,
  };
}

/**
 * Inputs {@link classifyJobOutcome} needs to pick a job's terminal
 * {@link JobOutcome} — see telemetry.ts's doc comment on the outcome enum
 * itself for what each value means.
 */
export interface JobOutcomeClassificationInputs {
  /** Set inline at any pre-review-result exit point (an aborted signal check, the M5-C dedup return, or the mid-job head-SHA-mismatch return) — always wins over everything else below, since it means `reviewResult` was never even computed. */
  earlyOutcome?: JobOutcome;
  /** The `ReviewResult` `runReview` (or the synthesized diff-too-large skip) produced, if the job got that far. */
  reviewResult?: ReviewResult;
  /** True when `reviewResult` is the synthesized `{ ok: true }` diff-too-large skip rather than a real `runReview` outcome. */
  diffTooLarge: boolean;
  /** The gateway's final spend for this job's key, if one was minted and revoke reported it (see gateway.ts's `GatewayKeyRevocation`). */
  gatewaySpend?: TelemetryGatewaySpend;
}

/**
 * Classify a settled job into exactly one {@link JobOutcome}. Pure and
 * exported so it's independently unit-testable (see pipeline.test.ts)
 * without having to drive a full `runJob` for every combination.
 *
 * BUDGET-EXHAUSTED is decided from the gateway's own reported spend
 * (`spentUsd >= budgetUsd`), NOT by string-matching Pi's error text — the
 * gateway's spend is the authoritative signal (see telemetry.ts's module doc
 * comment), and a 402 from the proxy plane can surface through Pi's error
 * reporting in more than one phrasing. Only reachable when `reviewResult` is
 * a genuine `{ ok: false }` runReview failure that isn't itself a
 * timeout/abort (those are always classified as such regardless of spend).
 */
export function classifyJobOutcome(inputs: JobOutcomeClassificationInputs): JobOutcome {
  if (inputs.earlyOutcome) return inputs.earlyOutcome;
  if (!inputs.reviewResult) return "error";
  if (inputs.reviewResult.ok) return inputs.diffTooLarge ? "diff-too-large" : "success";

  const { reason } = inputs.reviewResult;
  if (reason === "aborted") return "aborted";
  if (reason.startsWith("timeout after")) return "timeout-kill";

  const spend = inputs.gatewaySpend;
  if (spend && spend.budgetUsd > 0 && spend.spentUsd >= spend.budgetUsd) return "budget-exhausted";

  return "error";
}

/**
 * Collaborators the pipeline needs that either touch the network or mint/hold
 * a secret. Every field defaults to the real production implementation;
 * pipeline.test.ts overrides them with offline fakes so the whole
 * auth -> clone -> diff -> review -> publish flow can be driven end-to-end
 * with no network access, no real GitHub App, and no real `pi` binary. This
 * mirrors the test-seam pattern already used across the codebase (reviewer.ts's
 * `piBinary`, workspace.ts's `baseUrlOverride`, publisher.ts's
 * `MinimalIssuesClient`) — production callers (index.ts) must leave every
 * field undefined so the real implementations are used.
 */
export interface PipelineDeps {
  /** Defaults to {@link mintInstallationTokenFromConfig}. */
  mintToken?: (config: Config, installationId: number) => Promise<{ token: string }>;
  /** Defaults to `(token) => new Octokit({ auth: token })`. */
  makeOctokit?: (token: string) => Octokit;
  /**
   * Resolve Magpie's own GitHub App bot login (e.g. `"my-magpie-app[bot]"`),
   * threaded into rereview.ts's `readReviewState` so it can verify a prior
   * comment/review's AUTHOR identity instead of trusting the forgeable
   * `MAGPIE_REVIEW_MARKER` body literal alone (see rereview.ts's module doc
   * comment SECURITY section and step 2z above). Defaults to
   * {@link getAppBotLoginFromConfig}. Overridable so pipeline.test.ts can
   * supply a fixed bot login without a real GitHub App or network call —
   * production callers (index.ts) leave it undefined.
   */
  getBotLogin?: (config: Config) => Promise<string>;
  /** Forwarded to `runReview` as its `piBinary` test seam; see reviewer.ts. */
  piBinary?: string;
  /** Defaults to {@link createWorkspace}. Overridable so tests can skip real git. */
  createWorkspace?: typeof createWorkspace;
  /**
   * Mint the per-job gateway virtual key (M4-B). Defaults to
   * {@link mintGatewayKeyFromConfig}. Overridable so pipeline.test.ts can run
   * the whole flow against a fake gateway (or none at all) — production
   * callers (index.ts) leave it undefined so the real gateway mgmt API is
   * called. As of M7-1 (Design D) takes the job id as a second argument — the
   * gateway needs it to create/name the per-job socket directory it returns
   * as `GatewayKey.socketDir` (see gateway.ts).
   */
  mintGatewayKey?: (config: Config, jobId: string) => Promise<GatewayKey>;
  /**
   * Revoke a per-job gateway virtual key by id (M4-B). Defaults to
   * {@link revokeGatewayKeyFromConfig}. Best-effort by contract — never
   * throws (see gateway.ts) — so the pipeline's cleanup can call it
   * unconditionally without a revoke failure ever masking the job result.
   * Resolves the key's final spend (M5-D — see gateway.ts's
   * `GatewayKeyRevocation`) when the gateway reported one, threaded into this
   * job's telemetry record; `undefined` when it didn't (revoke failure,
   * unreachable gateway, or an already-gone key).
   */
  revokeGatewayKey?: (config: Config, id: string) => Promise<GatewayKeyRevocation | undefined>;
  logger?: PipelineLogger;
}

/** The job runner + timeout-cleanup hook, ready to hand to `JobQueue.enqueue`. */
export interface ReviewPipeline {
  runJob: JobRunner;
  cleanupJob: JobCleanup;
}

/**
 * Build the review pipeline for a given `config`, returning the `JobRunner`
 * and `JobCleanup` the queue needs (see queue.ts). See the module doc comment
 * for the full per-job step order and the single-token design.
 */
export function createReviewPipeline(
  config: Config,
  deps: PipelineDeps = {},
): ReviewPipeline {
  const logger = deps.logger ?? consoleLogger;
  const mintToken = deps.mintToken ?? mintInstallationTokenFromConfig;
  const makeOctokit = deps.makeOctokit ?? ((token: string) => new Octokit({ auth: token }));
  const getBotLogin = deps.getBotLogin ?? getAppBotLoginFromConfig;
  const makeWorkspace = deps.createWorkspace ?? createWorkspace;
  const mintGatewayKey = deps.mintGatewayKey ?? mintGatewayKeyFromConfig;
  const revokeGatewayKey =
    deps.revokeGatewayKey ?? ((cfg: Config, id: string) => revokeGatewayKeyFromConfig(cfg, id, logger));

  const runJob: JobRunner = async (job, signal) => {
    // M5-D (task_8a10): per-job cost/outcome telemetry. Every exit path below
    // — an early return, a thrown error, or a normal completion — funnels
    // through the outer `finally` at the bottom of this function, which
    // classifies whichever of these got set into exactly one
    // `JobTelemetryRecord` (see classifyJobOutcome and telemetry.ts). Wrapping
    // the WHOLE body (rather than threading a try/finally through every
    // existing nested try) keeps every pre-existing return/throw site
    // unchanged except for the one-line "record why we're exiting" markers
    // added at each of them below.
    const jobStartedAt = Date.now();
    let earlyOutcome: JobOutcome | undefined;
    let reviewResult: ReviewResult | undefined;
    let diffTooLarge = false;
    let gatewaySpend: TelemetryGatewaySpend | undefined;
    let thrownReason: string | undefined;

    try {
      if (job.installationId === undefined) {
        logger.error({
          event: "job-missing-installation-id",
          ...jobLogFields(job),
        });
        throw new Error(
          `job ${job.id} (${job.owner}/${job.repo}#${job.prNumber}) has no installationId; cannot mint a GitHub App token`,
        );
      }

      if (signal.aborted) {
        earlyOutcome = "aborted";
        return;
      }

      logger.info({ event: "minting-token", ...jobLogFields(job) });
      const { token } = await mintToken(config, job.installationId);
      const octokit = makeOctokit(token);

      if (signal.aborted) {
        earlyOutcome = "aborted";
        return;
      }

      // Step 2z: re-review dedup (M5-C, see module doc comment). Read Magpie's
      // own prior review state for this PR BEFORE spending anything else on
      // this job (gateway budget, a clone) — a redelivered webhook for a head
      // SHA already definitively reviewed is a no-op from here. Resolving the
      // bot login and calling `readReviewState` are both plain GitHub reads
      // with no side effects, so a failure at EITHER step is swallowed and
      // treated as "not reviewed yet" rather than failing the job — losing the
      // dedup optimization for one job is far cheaper than failing (or, worse,
      // WRONGLY SKIPPING) a review over a transient API hiccup or an
      // unresolvable identity. See rereview.ts's module doc comment SECURITY
      // section for why `readReviewState` needs `botLogin` at all: the old
      // marker-only check was forgeable by any PR commenter.
      logger.info({ event: "reading-review-state", ...jobLogFields(job) });
      let reviewState: ReviewState = {
        lastReviewedSha: undefined,
        minimizableNodeIds: [],
      };
      try {
        const botLogin = await getBotLogin(config);
        reviewState = await readReviewState({
          octokit,
          owner: job.owner,
          repo: job.repo,
          prNumber: job.prNumber,
          botLogin,
        });
      } catch (err) {
        logger.error({
          event: "review-state-read-failed",
          ...jobLogFields(job),
          error: serializeError(err),
        });
      }

      if (reviewState.lastReviewedSha === job.headSha) {
        logger.info({
          event: "already-reviewed",
          ...jobLogFields(job),
          lastReviewedSha: reviewState.lastReviewedSha,
        });
        earlyOutcome = "already-reviewed";
        return;
      }

      if (signal.aborted) {
        earlyOutcome = "aborted";
        return;
      }

      // Step 2a: mint the per-job gateway virtual key (see module doc comment).
      // A mint failure throws (gateway.ts) and propagates like any other
      // pre-workspace failure — no key was allocated, so there is nothing to
      // revoke. On success, the outer `try/finally` below revokes it on EVERY
      // subsequent exit path (success, thrown error, review-failed result,
      // abort), one level out from the workspace cleanup.
      logger.info({ event: "minting-gateway-key", ...jobLogFields(job) });
      const gatewayKey = await mintGatewayKey(config, job.id);

      try {
        if (signal.aborted) {
          earlyOutcome = "aborted";
          return;
        }

        const workspace = await makeWorkspace({
          owner: job.owner,
          repo: job.repo,
          prNumber: job.prNumber,
          headSha: job.headSha,
          token,
          workDir: config.workspace.workDir,
        });

        try {
          if (signal.aborted) {
            earlyOutcome = "aborted";
            return;
          }

          logger.info({ event: "computing-diff", ...jobLogFields(job) });
          // Incremental re-review (M5-B): on a `synchronize` delivery the filter
          // carries the pre/post-push head SHAs (job.before/job.after). Try to
          // review just that `before...after` range instead of the whole PR — a
          // small follow-up push shouldn't re-review (and re-bill) everything.
          // `computeIncrementalDiff` is conservative: it reports the range as
          // unavailable (force-push that rewrote `before`, rebase/revert/no-op,
          // empty range, any compare error) whenever it isn't a clean
          // fast-forward, in which case we fall back to the full PR diff (see
          // diff.ts). The size cap applies to whichever range we end up using.
          //
          // BASE PREFERENCE (M5-C): prefer `reviewState.lastReviewedSha` (step
          // 2z) over the webhook's own `job.before` when both are available —
          // it's the more RELIABLE base: `job.before` is whatever the webhook
          // payload happened to carry for this one delivery, whereas
          // `lastReviewedSha` is what Magpie actually last posted a definitive
          // review for, straight from GitHub's own state. If Magpie skipped a
          // delivery (e.g. a transient failure between two pushes) `job.before`
          // could point at a commit Magpie never reviewed, silently dropping
          // that range from the diff; `lastReviewedSha` doesn't have that gap.
          // Falls back to `job.before` when there's no prior definitive review
          // (`lastReviewedSha` undefined) — same as before this change. A stale
          // or unreachable `lastReviewedSha` is safe either way:
          // `computeIncrementalDiff` itself falls back to the full PR diff on
          // any bad/GC'd/diverged base (see diff.ts's module doc comment).
          let prDiff: PrDiffResult;
          let incremental = false;
          // The file list handed to the reviewer as context. For an incremental
          // review this is the WHOLE-PR changed-file list (task_a193), NOT just
          // the incremental range's files — so the reviewer still sees every file
          // the PR touches even though the diff is only the new range.
          let reviewChangedFiles: string[] = [];
          if (job.before && job.after) {
            const inc = await computeIncrementalDiff({
              octokit,
              owner: job.owner,
              repo: job.repo,
              base: reviewState.lastReviewedSha ?? job.before,
              head: job.after,
              maxDiffLines: config.limits.maxDiffLines,
            });
            if (inc.available) {
              prDiff = inc.result;
              incremental = true;
              // Only fetch the whole-PR file list when we'll actually review the
              // range — an over-cap (tooLarge) incremental range takes the
              // synthesized summary-only branch below and never reads
              // reviewChangedFiles, so skip the extra paginated listFiles call.
              if (!prDiff.tooLarge) {
                reviewChangedFiles = (
                  await listPrChangedFiles({
                    octokit,
                    owner: job.owner,
                    repo: job.repo,
                    prNumber: job.prNumber,
                  })
                ).changedFiles;
              }
              logger.info({
                event: "incremental-diff",
                ...jobLogFields(job),
                base: job.before,
                head: job.after,
                changedLineCount: prDiff.changedLineCount,
                tooLarge: prDiff.tooLarge,
              });
            } else {
              logger.info({
                event: "incremental-diff-fallback",
                ...jobLogFields(job),
                base: job.before,
                head: job.after,
                reason: inc.reason,
              });
              prDiff = await computePrDiff({
                octokit,
                owner: job.owner,
                repo: job.repo,
                prNumber: job.prNumber,
                maxDiffLines: config.limits.maxDiffLines,
              });
              reviewChangedFiles = prDiff.changedFiles;
            }
          } else {
            prDiff = await computePrDiff({
              octokit,
              owner: job.owner,
              repo: job.repo,
              prNumber: job.prNumber,
              maxDiffLines: config.limits.maxDiffLines,
            });
            reviewChangedFiles = prDiff.changedFiles;
          }

          if (signal.aborted) {
            earlyOutcome = "aborted";
            return;
          }

          const { data: pr } = await octokit.rest.pulls.get({
            owner: job.owner,
            repo: job.repo,
            pull_number: job.prNumber,
          });

          // HEAD VERIFY: see the module doc comment (step 5a) for why this check
          // is placed here — after the diff fetch, before either the tooLarge or
          // runReview branch — and why a mismatch returns without publishing
          // rather than throwing.
          const actualHeadSha: string | undefined = pr.head?.sha;
          if (actualHeadSha !== job.headSha) {
            // Logged at INFO, not ERROR: a mid-job force-push is a benign, expected
            // race that the system self-heals (a fresh webhook for the new head
            // re-triggers the review), exactly like the `diff-too-large` skip above
            // — surfacing it at error level would trip error-based alerting for a
            // non-error. Both SHAs are included so the skip is still traceable.
            logger.info({
              event: "head-sha-mismatch",
              ...jobLogFields(job),
              expected: job.headSha,
              actual: actualHeadSha,
            });
            earlyOutcome = "head-sha-mismatch";
            return;
          }

          // An abort can land during the metadata fetch above; short-circuit here
          // so we don't spawn `pi` (or synthesize a summary) for a job the queue
          // has already terminated.
          if (signal.aborted) {
            earlyOutcome = "aborted";
            return;
          }

          let result: ReviewResult;
          if (prDiff.tooLarge) {
            diffTooLarge = true;
            logger.info({
              event: "diff-too-large",
              ...jobLogFields(job),
              changedLineCount: prDiff.changedLineCount,
              maxDiffLines: config.limits.maxDiffLines,
            });
            result = {
              ok: true,
              summary: incremental
                ? `The changes pushed since the last review total ${prDiff.changedLineCount} lines, ` +
                  `which exceeds the configured review cap of ${config.limits.maxDiffLines}. ` +
                  `Skipping automated review of this update.`
                : `This PR changes ${prDiff.changedLineCount} lines, which exceeds the ` +
                  `configured review cap of ${config.limits.maxDiffLines}. Skipping automated review.`,
              // No findings possible for a skipped review (task_0d97/wave 3 owns
              // the real anchor+inline wiring); this is a minimal type-fix so this
              // synthetic result still satisfies reviewer.ts's now-required
              // ReviewResult.findings/verdict fields.
              findings: [],
              verdict: "comment",
            };
          } else {
            logger.info({ event: "running-review", ...jobLogFields(job) });
            result = await runReview({
              workspaceDir: workspace.dir,
              // Not tooLarge, so diff.ts guarantees a non-null diff (see
              // diff.ts's PrDiffResult doc comment: "diff is null exactly when
              // tooLarge").
              diff: prDiff.diff as string,
              // Whole-PR file list as context even for an incremental review (see
              // reviewChangedFiles above); `incremental` tells reviewer.ts the
              // diff itself is only the newly-pushed range.
              changedFiles: reviewChangedFiles,
              incremental,
              prTitle: pr.title,
              prBody: pr.body ?? "",
              config,
              // The per-job virtual key minted in step 2a above (see this
              // module's doc comment) — reviewer.ts sets this as the review
              // container's OPENROUTER_API_KEY (M4-C).
              gatewayApiKey: gatewayKey.key,
              // The per-job socket directory minted alongside the key above
              // (M7-1, Design D — see gateway.ts's `GatewayKey.socketDir` doc
              // comment) — reviewer.ts bind-mounts this read-only at `/run/gw`
              // in the (now `--network none`) review container, the container's
              // only remaining path to the gateway.
              gatewaySocketDir: gatewayKey.socketDir,
              piBinary: deps.piBinary,
              // The queue's own per-job id (see queue.ts's `JobDescriptor.id`,
              // already used for every log line via `jobLogFields` above) doubles
              // as the review container's name (`magpie-<sanitized id>` — see
              // reviewer.ts's `buildContainerName`), so the timeout/abort
              // `docker kill` path targets the right container. No parallel id
              // is minted here.
              jobId: job.id,
              signal,
            });
          }

          // Capture the review result for telemetry (M5-D) as soon as it
          // exists — BEFORE the abort short-circuit below — so a job that
          // produced a real (possibly failed/timed-out) result still records
          // it even if an abort lands in the same tick.
          reviewResult = result;

          // NO DOUBLE-HANDLING: if the queue's backstop timeout already fired
          // (see queue.ts), it has already recorded this job as "timed-out" and
          // may already be running/have run its own cleanup. Publishing a review
          // comment here too would double-handle the same job. `runReview` above
          // itself resolves promptly once `signal` aborts (never throws), so this
          // check catches that case before we ever call `publishReview`.
          if (signal.aborted) return;

          logger.info({
            event: "publishing-review",
            ...jobLogFields(job),
            resultOk: result.ok,
          });

          // See the module doc comment (step 7) for the three-way branch: a
          // failed review and a tooLarge-skipped review both keep using
          // publishReview's M1 single-summary-comment path unchanged (there are
          // no real findings to anchor in either case); only a genuine
          // `{ ok: true }` result from `runReview` has findings worth anchoring
          // against the diff and publishing as inline PR review comments.
          // M5-C: `reviewedSha` is only ever set on a definitive `result.ok`
          // outcome (a real success or the tooLarge-skip synthesized result) —
          // never on `{ok:false}` — so a redelivered webhook for a head SHA
          // whose only prior attempt failed still retries. See publisher.ts's
          // `buildReviewedShaMarker` doc comment and this module's doc comment
          // (step 7).
          let published: { id: number; url: string };
          if (!result.ok || prDiff.tooLarge) {
            published = await publishReview({
              octokit,
              owner: job.owner,
              repo: job.repo,
              prNumber: job.prNumber,
              result,
              reviewedSha: result.ok ? job.headSha : undefined,
            });
          } else {
            const { inline, other } = anchorFindings(prDiff.diff as string, {
              findings: result.findings,
              summary: result.summary,
              verdict: result.verdict,
            });
            published = await publishReviewWithFindings({
              octokit,
              owner: job.owner,
              repo: job.repo,
              prNumber: job.prNumber,
              summary: result.summary,
              inline,
              other,
              usage: result.usage,
              verdict: result.verdict,
              reviewedSha: job.headSha,
            });
          }

          logger.info({
            event: "published-review",
            ...jobLogFields(job),
            commentId: published.id,
            commentUrl: published.url,
          });

          // Step 7a (M5-C): minimize Magpie's prior minimizable comments as
          // OUTDATED now that a fresh, definitive review has been posted for
          // this head SHA — but only on a definitive outcome (`result.ok`,
          // covering both a real success and a tooLarge skip), mirroring the
          // `reviewedSha` gating just above: a `{ok:false}` failure doesn't
          // supersede anything, so prior comments (which may still describe the
          // PR's actual current state) are left alone. `minimizableNodeIds` is
          // the PRE-publish snapshot from step 2z, so the artifact just
          // published above is never included. Best-effort — never fails the
          // job (see rereview.ts's `minimizeOutdated` doc comment).
          if (result.ok) {
            await minimizeOutdated({
              octokit,
              nodeIds: reviewState.minimizableNodeIds,
              logger,
            });
          }
        } finally {
          await workspace.cleanup();
          logger.info({ event: "workspace-cleaned", ...jobLogFields(job) });
        }
      } finally {
        // Best-effort revoke on EVERY exit path (success, thrown error,
        // review-failed result, abort). `revokeGatewayKey` never throws (see
        // gateway.ts), so this can't mask the job's real outcome — a revoke
        // failure is only logged. Runs OUTSIDE the workspace `finally` above so
        // the key is still revoked even if `makeWorkspace` itself threw before
        // that inner try was entered. Its resolved value (M5-D) is the gateway's
        // own authoritative final spend for this key, captured here for the
        // telemetry record assembled in the outermost `finally` below.
        const revocation = await revokeGatewayKey(config, gatewayKey.id);
        if (revocation) {
          gatewaySpend = {
            keyId: gatewayKey.id,
            spentUsd: revocation.spentUsd,
            budgetUsd: revocation.budgetUsd,
          };
        }
        logger.info({ event: "gateway-key-revoked", ...jobLogFields(job), keyId: gatewayKey.id });
      }
    } catch (err) {
      // Record the failure reason for telemetry, then rethrow — the queue
      // (see queue.ts) still needs the throw to mark the job "failed"; this
      // catch only OBSERVES it on the way out (it never swallows).
      thrownReason = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      // M5-D: exactly one per-job telemetry record on EVERY exit path. Runs
      // best-effort (recordJobTelemetry never throws — see telemetry.ts), so a
      // telemetry-sink failure can never mask the job's real outcome or the
      // rethrow above. `usage` prefers the review result's own usage (present
      // on success AND, as of M5-D, on reviewer.ts's failure/kill paths);
      // `costUsd` is the gateway's authoritative spend when available, else
      // Pi's self-reported cost, else 0 (see telemetry.ts's COST OF RECORD).
      const outcome = classifyJobOutcome({ earlyOutcome, reviewResult, diffTooLarge, gatewaySpend });
      const usage = reviewResult?.usage;
      const reason =
        outcome === "success"
          ? undefined
          : reviewResult && !reviewResult.ok
            ? reviewResult.reason
            : (thrownReason ?? earlyOutcome ?? outcome);
      const costUsd = gatewaySpend?.spentUsd ?? usage?.costUsd ?? 0;
      await recordJobTelemetry({
        record: {
          jobId: job.id,
          owner: job.owner,
          repo: job.repo,
          prNumber: job.prNumber,
          headSha: job.headSha,
          outcome,
          durationMs: Date.now() - jobStartedAt,
          costUsd,
          usage,
          gateway: gatewaySpend,
          reason,
        },
        path: config.telemetry.path,
        logger,
      });
    }
  };

  const cleanupJob: JobCleanup = async (job) => {
    const dir = join(
      config.workspace.workDir,
      `${job.owner}-${job.repo}-${job.prNumber}-${job.headSha}`,
    );
    logger.info({ event: "timeout-cleanup", ...jobLogFields(job), dir });
    try {
      await rm(dir, { recursive: true, force: true });
    } catch (err) {
      logger.error({
        event: "timeout-cleanup-failed",
        ...jobLogFields(job),
        error: serializeError(err),
      });
    }
  };

  return { runJob, cleanupJob };
}
