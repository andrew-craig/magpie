import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobDescriptor, Logger } from "./queue.js";
import { JobQueue } from "./queue.js";

function makeJob(overrides: Partial<JobDescriptor> = {}): JobDescriptor {
  return {
    id: "job-1",
    owner: "acme",
    repo: "widgets",
    prNumber: 42,
    headSha: "deadbeef",
    ...overrides,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Captures logger calls for assertions without printing to the console. */
function makeRecordingLogger(): Logger & { calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  return {
    calls,
    info(payload) {
      calls.push(payload);
    },
    error(payload) {
      calls.push(payload);
    },
  };
}

describe("JobQueue", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("never runs more than `concurrency` jobs at once", async () => {
    const logger = makeRecordingLogger();
    const queue = new JobQueue({ concurrency: 2, jobTimeoutMs: 5000, logger });

    let running = 0;
    let peak = 0;

    const run = async (): Promise<void> => {
      running++;
      peak = Math.max(peak, running);
      await sleep(25);
      running--;
    };

    const jobs = Array.from({ length: 6 }, (_, i) =>
      makeJob({ id: `job-${i}`, prNumber: 100 + i }),
    );

    const outcomes = await Promise.all(jobs.map((job) => queue.enqueue(job, run)));

    expect(peak).toBeLessThanOrEqual(2);
    expect(outcomes.every((o) => o.outcome === "success")).toBe(true);
  });

  it("aborts a job that exceeds the timeout, runs cleanup, and reports timed-out", async () => {
    vi.useFakeTimers();
    const logger = makeRecordingLogger();
    const queue = new JobQueue({
      concurrency: 1,
      jobTimeoutMs: 1000,
      logger,
    });

    let signalAborted = false;
    let cleanupCalled = false;

    const run = (_job: JobDescriptor, signal: AbortSignal): Promise<void> =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          signalAborted = true;
          reject(new Error("aborted"));
        });
      });

    const cleanup = async (): Promise<void> => {
      cleanupCalled = true;
    };

    const job = makeJob();
    const outcomePromise = queue.enqueue(job, run, cleanup);

    // Let the queued task actually start (p-queue dispatches synchronously,
    // but flush microtasks to be safe) before advancing the fake clock.
    await vi.advanceTimersByTimeAsync(1000);

    const outcome = await outcomePromise;

    expect(signalAborted).toBe(true);
    expect(cleanupCalled).toBe(true);
    expect(outcome.outcome).toBe("timed-out");

    const finishLog = logger.calls.find(
      (c) => c.event === "finish" && c.id === job.id,
    );
    expect(finishLog?.outcome).toBe("timed-out");
  });

  it("clears the timer on success and never calls cleanup after completion", async () => {
    vi.useFakeTimers();
    const logger = makeRecordingLogger();
    const queue = new JobQueue({
      concurrency: 1,
      jobTimeoutMs: 1000,
      logger,
    });

    let cleanupCalled = false;
    const run = async (): Promise<void> => {
      // Resolves immediately (well before the timeout).
    };
    const cleanup = async (): Promise<void> => {
      cleanupCalled = true;
    };

    const job = makeJob();
    const outcomePromise = queue.enqueue(job, run, cleanup);

    // Flush microtasks so the job settles before we fast-forward time.
    await vi.advanceTimersByTimeAsync(0);
    const outcome = await outcomePromise;

    expect(outcome.outcome).toBe("success");
    expect(cleanupCalled).toBe(false);

    // Advance well past the timeout — the dangling timer must not fire
    // cleanup for an already-completed job.
    await vi.advanceTimersByTimeAsync(10_000);

    expect(cleanupCalled).toBe(false);
  });

  it("logs a start and finish event for each job", async () => {
    const logger = makeRecordingLogger();
    const queue = new JobQueue({ concurrency: 1, jobTimeoutMs: 5000, logger });
    const job = makeJob();

    const outcome = await queue.enqueue(job, async () => {});

    expect(outcome.outcome).toBe("success");
    const startLog = logger.calls.find((c) => c.event === "start");
    const finishLog = logger.calls.find((c) => c.event === "finish");
    expect(startLog).toMatchObject({
      id: job.id,
      owner: job.owner,
      repo: job.repo,
      prNumber: job.prNumber,
      headSha: job.headSha,
    });
    expect(finishLog).toMatchObject({
      id: job.id,
      outcome: "success",
    });
    expect(typeof finishLog?.durationMs).toBe("number");
  });

  it("reports a failed run as outcome 'failed' with the error attached", async () => {
    const queue = new JobQueue({ concurrency: 1, jobTimeoutMs: 5000 });
    const job = makeJob();
    const boom = new Error("boom");

    const outcome = await queue.enqueue(job, async () => {
      throw boom;
    });

    expect(outcome.outcome).toBe("failed");
    expect(outcome.error).toBe(boom);
  });

  it("settles (not hangs) when the queue task itself throws (e.g. logger error)", async () => {
    // Guards against a regression where an unexpected throw inside the
    // queue-task body (before resolveOutcome) leaves enqueue() pending
    // forever, hanging every caller awaiting the job.
    const throwingLogger: Logger = {
      info() {
        throw new Error("logger exploded");
      },
      error() {
        // swallow so the catch-path logging doesn't itself throw
      },
    };
    const queue = new JobQueue({
      concurrency: 1,
      jobTimeoutMs: 5000,
      logger: throwingLogger,
    });

    let ranBody = false;
    const outcomePromise = queue.enqueue(makeJob(), async () => {
      ranBody = true;
    });

    // If the fix regresses, this race resolves to "HUNG".
    const result = await Promise.race([
      outcomePromise,
      sleep(200).then(() => "HUNG" as const),
    ]);

    expect(result).not.toBe("HUNG");
    expect((result as { outcome: string }).outcome).toBe("failed");
    // The throw happened on the "start" log, before run() was invoked.
    expect(ranBody).toBe(false);
  });

  it("skips a superseded, not-yet-started job for the same PR", async () => {
    const queue = new JobQueue({ concurrency: 1, jobTimeoutMs: 5000 });

    let secondStarted = false;
    // First job occupies the single concurrency slot so the second job for
    // the same PR sits in the queue (not yet started) when the third
    // (superseding) job for that PR is enqueued.
    const blocker = makeJob({ id: "blocker", prNumber: 1, owner: "x", repo: "y" });
    const blockerPromise = queue.enqueue(blocker, () => sleep(30));

    const superseded = makeJob({ id: "superseded", prNumber: 7, owner: "x", repo: "y" });
    const supersededPromise = queue.enqueue(superseded, async () => {
      secondStarted = true;
    });

    const superseding = makeJob({ id: "superseding", prNumber: 7, owner: "x", repo: "y" });
    const supersedingPromise = queue.enqueue(superseding, async () => {});

    const [, supersededOutcome, supersedingOutcome] = await Promise.all([
      blockerPromise,
      supersededPromise,
      supersedingPromise,
    ]);

    expect(supersededOutcome.outcome).toBe("skipped");
    expect(secondStarted).toBe(false);
    expect(supersedingOutcome.outcome).toBe("success");
  });
});
