// In-process job queue for review jobs.
//
// Wraps p-queue to bound how many review jobs run at once and enforces a
// hard per-job wall-clock timeout via `AbortController`, so a stuck or
// runaway job (e.g. Pi hanging on a huge diff, a wedged docker run) can never
// pile up unbounded work or block the service forever. This is in-process
// only: no persistence, no Redis/BullMQ. Queued-but-not-started jobs are
// lost on a crash or restart, which is acceptable for this milestone (see
// PLAN.md Milestone 1).
//
// `JobQueue` is deliberately decoupled from the typed `Config` (see
// config.ts) so it can be constructed and unit tested with plain numbers.
// Callers that have a `Config` should derive the options themselves (e.g.
// `concurrency: config.limits.concurrency`,
// `jobTimeoutMs: config.limits.jobTimeoutSeconds * 1000`) or use the
// `jobQueueOptionsFromConfig` helper below. Wiring this into the webhook
// server / real clone-diff-review-publish pipeline is a later task; this
// module only provides the generic scheduling machinery, with the actual
// work injected as a callback per job.

import PQueue from "p-queue";
import type { Config } from "./config.js";

/** Identifies a single review job as it moves through the queue. */
export interface JobDescriptor {
  /** Opaque unique id for this job (e.g. a UUID minted by the caller). */
  id: string;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
}

/** Terminal state of a job once it has left the queue. */
export type JobOutcomeStatus = "success" | "failed" | "timed-out" | "skipped";

/** Result reported once a job has settled (in any terminal state). */
export interface JobOutcome {
  id: string;
  outcome: JobOutcomeStatus;
  durationMs: number;
  /** Present when `outcome` is `"failed"` (the error `run` rejected with). */
  error?: unknown;
}

/**
 * The actual review work for a job. Must resolve/reject on its own once
 * finished, and SHOULD observe `signal` and stop promptly when it fires
 * (the job exceeded its timeout). `run` is injected by the caller; this
 * module has no knowledge of clone/docker/Pi/GitHub specifics.
 */
export type JobRunner = (
  job: JobDescriptor,
  signal: AbortSignal,
) => Promise<void>;

/**
 * Optional workspace cleanup invoked when a job is abandoned because it
 * exceeded its timeout (e.g. remove a checkout, kill a container). Not
 * called on normal success or failure — `run` is expected to clean up after
 * itself in those cases.
 */
export type JobCleanup = (job: JobDescriptor) => Promise<void>;

/** Minimal structured logger. Defaults to one-line JSON on stdout/stderr. */
export interface Logger {
  info(payload: Record<string, unknown>): void;
  error(payload: Record<string, unknown>): void;
}

function serializeError(err: unknown): unknown {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  return err;
}

const consoleLogger: Logger = {
  info(payload) {
    console.log(JSON.stringify({ level: "info", ...payload }));
  },
  error(payload) {
    console.error(JSON.stringify({ level: "error", ...payload }));
  },
};

/** Constructor options for {@link JobQueue}. Plain numbers — no `Config`. */
export interface JobQueueOptions {
  /** Max number of jobs allowed to run at the same time. */
  concurrency: number;
  /** Hard wall-clock timeout per job, in milliseconds. */
  jobTimeoutMs: number;
  /** Defaults to a JSON-on-console logger. */
  logger?: Logger;
}

/** Derives {@link JobQueueOptions} from the app's typed `Config`. */
export function jobQueueOptionsFromConfig(
  config: Pick<Config, "limits">,
  logger?: Logger,
): JobQueueOptions {
  return {
    concurrency: config.limits.concurrency,
    jobTimeoutMs: config.limits.jobTimeoutSeconds * 1000,
    logger,
  };
}

function jobLogFields(job: JobDescriptor): Record<string, unknown> {
  return {
    id: job.id,
    owner: job.owner,
    repo: job.repo,
    prNumber: job.prNumber,
    headSha: job.headSha,
  };
}

function dedupKey(job: JobDescriptor): string {
  return `${job.owner}/${job.repo}#${job.prNumber}`;
}

/** A queued-but-not-yet-started job, tracked for dedup purposes. */
interface PendingEntry {
  job: JobDescriptor;
  /**
   * Set once a newer job for the same PR has superseded this one. Checked by
   * the queued task itself when p-queue eventually dequeues it, so a
   * cancelled job never invokes `run` even though it can't be pulled out of
   * p-queue's internal queue directly.
   */
  cancelled: boolean;
  /** Resolves the enqueue() promise with a "skipped" outcome, once. */
  resolveSkipped: () => void;
}

/**
 * Bounded-concurrency queue for review jobs with a hard per-job timeout.
 *
 * Enqueue jobs with {@link JobQueue.enqueue}; the returned promise never
 * rejects — it always resolves with a {@link JobOutcome} describing how the
 * job ended.
 */
export class JobQueue {
  readonly #queue: PQueue;
  readonly #jobTimeoutMs: number;
  readonly #logger: Logger;
  readonly #pendingByKey = new Map<string, PendingEntry>();

  constructor(options: JobQueueOptions) {
    this.#jobTimeoutMs = options.jobTimeoutMs;
    this.#logger = options.logger ?? consoleLogger;
    this.#queue = new PQueue({ concurrency: options.concurrency });
  }

  /** Number of jobs queued but not yet running. */
  get size(): number {
    return this.#queue.size;
  }

  /** Number of jobs currently running. */
  get pending(): number {
    return this.#queue.pending;
  }

  /**
   * Enqueue a job for processing.
   *
   * If another job for the same `owner/repo/prNumber` is still queued (not
   * yet started), it is replaced: the older enqueue() call resolves
   * immediately with outcome `"skipped"` and is removed from the queue
   * without ever invoking `run`. This is a lightweight dedup only — a job
   * already running is never interrupted by a newer one (that is later
   * milestone work).
   *
   * The returned promise resolves once the job reaches a terminal state; it
   * does not reject. Timeouts, run() failures, and dedup are all reported
   * via the returned {@link JobOutcome}.
   */
  async enqueue(
    job: JobDescriptor,
    run: JobRunner,
    cleanup?: JobCleanup,
  ): Promise<JobOutcome> {
    const key = dedupKey(job);

    return new Promise<JobOutcome>((resolveOutcome) => {
      const entry: PendingEntry = {
        job,
        cancelled: false,
        resolveSkipped: () => {
          resolveOutcome({ id: job.id, outcome: "skipped", durationMs: 0 });
        },
      };

      // Replace any not-yet-started job queued for the same PR. The
      // superseded job's task is still sitting in p-queue's internal queue
      // (it can't be plucked out directly), so we mark it cancelled here
      // and the task itself checks that flag and bails out with no-op when
      // p-queue eventually gets to it.
      const replaced = this.#pendingByKey.get(key);
      if (replaced) {
        replaced.cancelled = true;
        replaced.resolveSkipped();
      }
      this.#pendingByKey.set(key, entry);

      void this.#queue.add(async () => {
        if (entry.cancelled) {
          return;
        }
        // Only clear the map entry if it's still ours (a newer job may
        // already have replaced it and re-registered under the same key).
        if (this.#pendingByKey.get(key) === entry) {
          this.#pendingByKey.delete(key);
        }

        const start = Date.now();
        this.#logger.info({ event: "start", ...jobLogFields(job) });

        const outcome = await this.#runOne(job, run, cleanup, start);

        this.#logger.info({
          event: "finish",
          ...jobLogFields(job),
          durationMs: outcome.durationMs,
          outcome: outcome.outcome,
        });
        resolveOutcome(outcome);
      });
    });
  }

  /** Runs a single job to completion, enforcing the per-job timeout. */
  async #runOne(
    job: JobDescriptor,
    run: JobRunner,
    cleanup: JobCleanup | undefined,
    start: number,
  ): Promise<JobOutcome> {
    const controller = new AbortController();

    return new Promise<JobOutcome>((resolve) => {
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        controller.abort(
          new Error(`job ${job.id} exceeded timeout of ${this.#jobTimeoutMs}ms`),
        );
        void (async () => {
          try {
            if (cleanup) {
              await cleanup(job);
            }
          } catch (cleanupErr) {
            this.#logger.error({
              event: "cleanup-failed",
              ...jobLogFields(job),
              error: serializeError(cleanupErr),
            });
          }
          resolve({
            id: job.id,
            outcome: "timed-out",
            durationMs: Date.now() - start,
          });
        })();
      }, this.#jobTimeoutMs);

      Promise.resolve()
        .then(() => run(job, controller.signal))
        .then(
          () => {
            if (settled) {
              return;
            }
            settled = true;
            clearTimeout(timer);
            resolve({
              id: job.id,
              outcome: "success",
              durationMs: Date.now() - start,
            });
          },
          (error: unknown) => {
            if (settled) {
              return;
            }
            settled = true;
            clearTimeout(timer);
            resolve({
              id: job.id,
              outcome: "failed",
              durationMs: Date.now() - start,
              error,
            });
          },
        );
    });
  }
}
