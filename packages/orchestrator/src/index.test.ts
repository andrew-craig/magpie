import { describe, expect, it } from "vitest";
import { MemoryControllerUnavailableError } from "./cgroup-preflight.js";
import { ConfigError } from "./config.js";
import { DockerUnavailableError } from "./docker.js";
import { formatStartupError, logJobOutcome } from "./index.js";
import type { JobOutcome } from "./queue.js";
import { TierSelectionError } from "./tier-ladder.js";

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

describe("formatStartupError (entrypoint catch wiring)", () => {
  it("renders known, operator-actionable startup errors as a clean [magpie] message (no 'fatal' prefix)", () => {
    // These carry human-written, actionable messages — a stack would be noise.
    for (const err of [
      new ConfigError(["missing [gateway].base_url"], "/etc/magpie/config.toml"),
      new DockerUnavailableError("docker CLI not found on PATH"),
      // bug_df2d: a memory-controller failure must be surfaced as an actionable
      // message, NOT swallowed into a generic internal-fault trace.
      new MemoryControllerUnavailableError("cgroup memory-controller preflight failed: ..."),
      // M8-D1 (task_2f46): an unacknowledged isolation-tier degradation must
      // be surfaced the same way — actionable, no stack noise.
      new TierSelectionError("isolation-tier DEGRADATION: ..."),
    ]) {
      const out = formatStartupError(err);
      expect(out).toBe(`[magpie] ${(err as Error).message}`);
      expect(out).not.toContain("fatal startup error");
    }
  });

  it("renders an unexpected error with the 'fatal startup error' prefix", () => {
    expect(formatStartupError(new Error("kaboom"))).toBe("[magpie] fatal startup error: kaboom");
    // Non-Error throws are stringified, never crash the handler.
    expect(formatStartupError("plain string")).toBe("[magpie] fatal startup error: plain string");
  });
});
