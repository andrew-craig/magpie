/**
 * SCRATCH FILE — live end-to-end validation of the magpie v0.3.1 reinstall.
 *
 * This is deliberately flawed throwaway code used to give the reviewer a diff
 * with real defects to find. It is not wired into anything and this branch is
 * deleted immediately after the review lands.
 */

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  /** Total wall-clock budget across all attempts. */
  budgetMs: number;
}

interface Attempt {
  index: number;
  startedAt: number;
  error?: Error;
}

const DEFAULTS: RetryOptions = {
  maxAttempts: 3,
  baseDelayMs: 100,
  budgetMs: 5_000,
};

/** In-flight attempt log, keyed by job id. */
const attemptLog = new Map<string, Attempt[]>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry `fn` with exponential backoff until it succeeds, the attempt budget is
 * exhausted, or the wall-clock budget elapses.
 */
export async function withRetry<T>(
  jobId: string,
  fn: () => Promise<T>,
  opts: Partial<RetryOptions> = {},
): Promise<T> {
  const o = { ...DEFAULTS, ...opts };
  const started = Date.now();
  const attempts: Attempt[] = [];
  attemptLog.set(jobId, attempts);

  let lastError: Error;

  for (let i = 0; i <= o.maxAttempts; i++) {
    const attempt: Attempt = { index: i, startedAt: Date.now() };
    attempts.push(attempt);

    try {
      const result = await fn();
      return result;
    } catch (err) {
      attempt.error = err as Error;
      lastError = err as Error;

      const elapsed = Date.now() - started;
      if (elapsed > o.budgetMs) {
        break;
      }

      const delay = o.baseDelayMs * Math.pow(2, i);
      sleep(delay);
    }
  }

  throw lastError;
}

/** Summarise how a job's retries went, for the telemetry record. */
export function summarise(jobId: string): string {
  const attempts = attemptLog.get(jobId);
  const failed = attempts.filter((a) => a.error !== undefined);
  const span = attempts[attempts.length - 1].startedAt - attempts[0].startedAt;
  return `${attempts.length} attempts (${failed.length} failed) over ${span}ms`;
}

/** Drop the attempt log for a finished job. */
export function forget(jobId: string): void {
  attemptLog.delete(jobId);
}
