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
//   2a. Mint ONE fresh gateway virtual key (gateway.ts's
//      `mintGatewayKeyFromConfig`, M4-B) scoped to `config.llm.model`, with a
//      budget/TTL from `config.gateway`. From here on the rest of the job
//      body runs inside a `try/finally` that revokes this key on every exit
//      path (success, a thrown error, or a "review failed" result) — mirrors
//      step 3's workspace `try/finally` one level out, since the key must
//      outlive (and be cleaned up around) everything the workspace cleanup
//      already wraps. Revocation is best-effort and never throws (see
//      gateway.ts) — a revoke failure is logged but never changes the job's
//      outcome. NOTE: the minted key itself is not yet consumed by
//      `runReview` below — wiring it into the container's
//      `OPENROUTER_API_KEY` in place of `config.secrets.llmApiKey` is M4-C's
//      job; this step only establishes the mint/revoke lifecycle.
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
import { computePrDiff } from "./diff.js";
import type { GatewayKey } from "./gateway.js";
import { mintGatewayKeyFromConfig, revokeGatewayKeyFromConfig } from "./gateway.js";
import { mintInstallationTokenFromConfig } from "./github.js";
import { publishReview, publishReviewWithFindings } from "./publisher.js";
import type { JobCleanup, JobDescriptor, JobRunner } from "./queue.js";
import type { ReviewResult } from "./reviewer.js";
import { runReview } from "./reviewer.js";
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
  /** Forwarded to `runReview` as its `piBinary` test seam; see reviewer.ts. */
  piBinary?: string;
  /** Defaults to {@link createWorkspace}. Overridable so tests can skip real git. */
  createWorkspace?: typeof createWorkspace;
  /**
   * Mint the per-job gateway virtual key (M4-B). Defaults to
   * {@link mintGatewayKeyFromConfig}. Overridable so pipeline.test.ts can run
   * the whole flow against a fake gateway (or none at all) — production
   * callers (index.ts) leave it undefined so the real gateway mgmt API is
   * called.
   */
  mintGatewayKey?: (config: Config) => Promise<GatewayKey>;
  /**
   * Revoke a per-job gateway virtual key by id (M4-B). Defaults to
   * {@link revokeGatewayKeyFromConfig}. Best-effort by contract — never
   * throws (see gateway.ts) — so the pipeline's cleanup can call it
   * unconditionally without a revoke failure ever masking the job result.
   */
  revokeGatewayKey?: (config: Config, id: string) => Promise<void>;
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
  const makeWorkspace = deps.createWorkspace ?? createWorkspace;
  const mintGatewayKey = deps.mintGatewayKey ?? mintGatewayKeyFromConfig;
  const revokeGatewayKey =
    deps.revokeGatewayKey ?? ((cfg: Config, id: string) => revokeGatewayKeyFromConfig(cfg, id, logger));

  const runJob: JobRunner = async (job, signal) => {
    if (job.installationId === undefined) {
      logger.error({
        event: "job-missing-installation-id",
        ...jobLogFields(job),
      });
      throw new Error(
        `job ${job.id} (${job.owner}/${job.repo}#${job.prNumber}) has no installationId; cannot mint a GitHub App token`,
      );
    }

    if (signal.aborted) return;

    logger.info({ event: "minting-token", ...jobLogFields(job) });
    const { token } = await mintToken(config, job.installationId);
    const octokit = makeOctokit(token);

    if (signal.aborted) return;

    // Step 2a: mint the per-job gateway virtual key (see module doc comment).
    // A mint failure throws (gateway.ts) and propagates like any other
    // pre-workspace failure — no key was allocated, so there is nothing to
    // revoke. On success, the outer `try/finally` below revokes it on EVERY
    // subsequent exit path (success, thrown error, review-failed result,
    // abort), one level out from the workspace cleanup.
    logger.info({ event: "minting-gateway-key", ...jobLogFields(job) });
    const gatewayKey = await mintGatewayKey(config);

    try {
      if (signal.aborted) return;

      const workspace = await makeWorkspace({
        owner: job.owner,
        repo: job.repo,
        prNumber: job.prNumber,
        headSha: job.headSha,
        token,
        workDir: config.workspace.workDir,
      });

      try {
        if (signal.aborted) return;

        logger.info({ event: "computing-diff", ...jobLogFields(job) });
        const prDiff = await computePrDiff({
          octokit,
          owner: job.owner,
          repo: job.repo,
          prNumber: job.prNumber,
          maxDiffLines: config.limits.maxDiffLines,
        });

        if (signal.aborted) return;

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
          return;
        }

        // An abort can land during the metadata fetch above; short-circuit here
        // so we don't spawn `pi` (or synthesize a summary) for a job the queue
        // has already terminated.
        if (signal.aborted) return;

        let result: ReviewResult;
        if (prDiff.tooLarge) {
          logger.info({
            event: "diff-too-large",
            ...jobLogFields(job),
            changedLineCount: prDiff.changedLineCount,
            maxDiffLines: config.limits.maxDiffLines,
          });
          result = {
            ok: true,
            summary:
              `This PR changes ${prDiff.changedLineCount} lines, which exceeds the ` +
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
            changedFiles: prDiff.changedFiles,
            prTitle: pr.title,
            prBody: pr.body ?? "",
            config,
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
        let published: { id: number; url: string };
        if (!result.ok || prDiff.tooLarge) {
          published = await publishReview({
            octokit,
            owner: job.owner,
            repo: job.repo,
            prNumber: job.prNumber,
            result,
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
          });
        }

        logger.info({
          event: "published-review",
          ...jobLogFields(job),
          commentId: published.id,
          commentUrl: published.url,
        });
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
      // that inner try was entered.
      await revokeGatewayKey(config, gatewayKey.id);
      logger.info({ event: "gateway-key-revoked", ...jobLogFields(job), keyId: gatewayKey.id });
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
