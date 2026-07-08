import { describe, expect, it } from "vitest";
import type { DrainableQueue, ShutdownLogger } from "./shutdown.js";
import { drainQueue } from "./shutdown.js";

/** Captures logger calls for assertions without printing to the console. */
function makeRecordingLogger(): ShutdownLogger & { calls: Record<string, unknown>[] } {
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

describe("drainQueue", () => {
  it("returns 'drained' immediately when the queue is already idle", async () => {
    const logger = makeRecordingLogger();
    const queue: DrainableQueue = {
      size: 0,
      pending: 0,
      onIdle: () => new Promise(() => {}), // would hang forever if actually awaited
    };

    const result = await drainQueue(queue, 20, logger);

    expect(result).toBe("drained");
    // Already-idle short-circuits before logging anything.
    expect(logger.calls).toHaveLength(0);
  });

  it("returns 'drained' once the queue's onIdle() resolves within the grace period", async () => {
    const logger = makeRecordingLogger();
    const queue: DrainableQueue = {
      size: 0,
      pending: 1,
      onIdle: () => new Promise((resolve) => setTimeout(resolve, 5)),
    };

    const result = await drainQueue(queue, 1000, logger);

    expect(result).toBe("drained");
    expect(logger.calls).toContainEqual(
      expect.objectContaining({ event: "draining", queued: 0, running: 1 }),
    );
    // No timeout should have been logged.
    expect(logger.calls.some((c) => c.event === "shutdown-drain-timeout")).toBe(false);
  });

  it("returns 'timed-out' when onIdle() never resolves within graceMs", async () => {
    const logger = makeRecordingLogger();
    const queue: DrainableQueue = {
      size: 0,
      pending: 1,
      onIdle: () => new Promise(() => {}), // never resolves
    };

    const result = await drainQueue(queue, 20, logger);

    expect(result).toBe("timed-out");
    expect(logger.calls).toContainEqual(
      expect.objectContaining({ event: "shutdown-drain-timeout", queued: 0, running: 1 }),
    );
  });
});
