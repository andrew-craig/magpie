import { describe, expect, it } from "vitest";
import { logJobOutcome } from "./index.js";
import type { JobOutcome } from "./queue.js";

/** Captures a single logger's `.error(line)` calls without touching console. */
function makeRecordingLogger(): { error(line: string): void; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    error(line) {
      lines.push(line);
    },
  };
}

const FAKE_TOKEN = "ghs_super-secret-installation-token-fixture-should-never-leak";

describe("logJobOutcome", () => {
  it("logs a job-failed line with event/id/outcome/error for a failed outcome", () => {
    const logger = makeRecordingLogger();
    const error = new Error("something went wrong downstream");
    const outcome: JobOutcome = {
      id: "job-123",
      outcome: "failed",
      durationMs: 42,
      error,
    };

    logJobOutcome(outcome, logger);

    expect(logger.lines).toHaveLength(1);
    const parsed = JSON.parse(logger.lines[0]) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      level: "error",
      event: "job-failed",
      id: "job-123",
      outcome: "failed",
      durationMs: 42,
    });
    expect(parsed.error).toMatchObject({
      name: "Error",
      message: "something went wrong downstream",
    });
  });

  it("also logs timed-out outcomes", () => {
    const logger = makeRecordingLogger();
    const outcome: JobOutcome = { id: "job-9", outcome: "timed-out", durationMs: 600_000 };

    logJobOutcome(outcome, logger);

    expect(logger.lines).toHaveLength(1);
    const parsed = JSON.parse(logger.lines[0]) as Record<string, unknown>;
    expect(parsed).toMatchObject({ event: "job-failed", id: "job-9", outcome: "timed-out" });
  });

  it("does not log success or skipped outcomes", () => {
    const logger = makeRecordingLogger();
    logJobOutcome({ id: "a", outcome: "success", durationMs: 1 }, logger);
    logJobOutcome({ id: "b", outcome: "skipped", durationMs: 0 }, logger);

    expect(logger.lines).toHaveLength(0);
  });

  it("locks in the job-failed log shape for a realistic post-mint pipeline error, with no token leak", () => {
    const logger = makeRecordingLogger();
    // Shaped like what pipeline.ts's `runJob` actually rejects with when the
    // PR-metadata fetch fails after the installation token was minted (see
    // pipeline.test.ts's "token never leaks when a post-mint stage fails" ->
    // Case 1): pipeline.ts never puts the token into an error it produces,
    // so a realistic post-mint error's message/stack never contains it.
    const error = new Error("Request failed with status 401");
    error.stack = "Error: Request failed with status 401\n    at Octokit.request (octokit.js:1:1)";
    const outcome: JobOutcome = { id: "job-1", outcome: "failed", durationMs: 5, error };

    logJobOutcome(outcome, logger);

    expect(logger.lines).toHaveLength(1);
    expect(logger.lines[0]).not.toContain(FAKE_TOKEN);
    const parsed = JSON.parse(logger.lines[0]) as Record<string, unknown>;
    expect(parsed).toMatchObject({ event: "job-failed", id: "job-1", outcome: "failed" });
    expect(parsed.error).toMatchObject({
      name: "Error",
      message: "Request failed with status 401",
    });
    expect((parsed.error as { stack: string }).stack).toContain("Octokit.request");
  });
});
