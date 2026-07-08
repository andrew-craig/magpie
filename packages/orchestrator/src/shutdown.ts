// Drain-with-timeout helper for graceful shutdown.
//
// Extracted so it can be unit tested with a fake queue and fake/short grace
// windows, with no `process.exit` inside it — index.ts owns the actual exit.
// See index.ts's `shutdown` handler for how this is wired in.

/** Minimal structured logger this module needs. */
export interface ShutdownLogger {
  info(payload: Record<string, unknown>): void;
  error(payload: Record<string, unknown>): void;
}

/** The subset of `JobQueue` (see queue.ts) that draining needs. */
export interface DrainableQueue {
  onIdle(): Promise<void>;
  readonly size: number;
  readonly pending: number;
}

/**
 * Waits for `queue` to drain (no queued jobs, no running jobs), bounded by
 * `graceMs` so shutdown never hangs forever on a stuck job.
 *
 * Returns `"drained"` if the queue was already idle or idled before the
 * grace period elapsed; `"timed-out"` if `graceMs` elapsed first (in which
 * case a `shutdown-drain-timeout` event is logged with the still-in-flight
 * counts — the caller is expected to exit anyway, per the queue's own
 * per-job timeout being the ultimate backstop).
 */
export async function drainQueue(
  queue: DrainableQueue,
  graceMs: number,
  logger: ShutdownLogger,
): Promise<"drained" | "timed-out"> {
  if (queue.size === 0 && queue.pending === 0) {
    return "drained";
  }

  logger.info({
    event: "draining",
    queued: queue.size,
    running: queue.pending,
    graceMs,
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timed-out">((resolve) => {
    timer = setTimeout(() => resolve("timed-out"), graceMs);
  });

  const result = await Promise.race([
    queue.onIdle().then((): "drained" => "drained"),
    timeout,
  ]);
  clearTimeout(timer);

  if (result === "timed-out") {
    logger.error({
      event: "shutdown-drain-timeout",
      queued: queue.size,
      running: queue.pending,
      graceMs,
    });
  }

  return result;
}
