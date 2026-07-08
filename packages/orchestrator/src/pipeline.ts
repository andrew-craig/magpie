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
//   3. Fetch PR title/body (needed by the reviewer prompt; the queue's
//      `JobDescriptor` deliberately doesn't carry them — see queue.ts).
//   4. Create the credential-free host workspace (workspace.ts) for the PR
//      head checkout. From here on the rest of the job body runs inside a
//      `try/finally` so the workspace is always cleaned up, on every exit
//      path (success, a thrown error, or a "review failed" result — the last
//      of those is not an error at all, see step 6).
//   5. Compute the PR diff via the GitHub API (diff.ts), capped by
//      `config.limits.maxDiffLines`.
//   6. Turn the diff into a `ReviewResult`: an oversized diff never reaches
//      `runReview` at all (diff.ts never even fetches the body — see its
//      module doc comment) and instead gets a synthesized "skipped" summary;
//      everything else is handed to reviewer.ts's `runReview`, which never
//      throws — a failed review is a normal `{ ok: false, reason }` value,
//      not an exception, and is published just like a successful one.
//   7. Publish exactly one summary comment (publisher.ts).
//
// SECURITY: the installation token minted in step 2 is a live GitHub
// credential. It is only ever passed to `new Octokit({ auth: token })` and to
// `createWorkspace({ token })` (which itself only ever sends it over the
// process environment to `git`, never argv or disk — see workspace.ts). It is
// never logged, never included in a log payload below, and never reaches the
// reviewer subprocess (reviewer.ts strips all `MAGPIE_*` env vars from that
// child's environment before spawning it). Every log line emitted by this
// module is a plain object of ids/counts/urls — never the token, never
// `config.secrets`, never the raw Octokit client.

import { rm } from "node:fs/promises";
import { join } from "node:path";
import { Octokit } from "@octokit/rest";
import type { Config } from "./config.js";
import { computePrDiff } from "./diff.js";
import { mintInstallationTokenFromConfig } from "./github.js";
import { publishReview } from "./publisher.js";
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
  const mintToken = deps.mintToken ?? mintInstallationTokenFromConfig;
  const makeOctokit = deps.makeOctokit ?? ((token: string) => new Octokit({ auth: token }));
  const makeWorkspace = deps.createWorkspace ?? createWorkspace;
  const logger = deps.logger ?? consoleLogger;

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

    logger.info({ event: "minting-token", ...jobLogFields(job) });
    const { token } = await mintToken(config, job.installationId);
    const octokit = makeOctokit(token);

    const { data: pr } = await octokit.rest.pulls.get({
      owner: job.owner,
      repo: job.repo,
      pull_number: job.prNumber,
    });

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
        });
      }

      logger.info({
        event: "publishing-review",
        ...jobLogFields(job),
        resultOk: result.ok,
      });
      const published = await publishReview({
        octokit,
        owner: job.owner,
        repo: job.repo,
        prNumber: job.prNumber,
        result,
      });

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
