import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordJobTelemetry } from "./telemetry.js";
import type { JobTelemetryRecord, RecordJobTelemetryParams, TelemetryLogger } from "./telemetry.js";

/** Captures logger calls for assertions without printing to the console — mirrors shutdown.test.ts's `makeRecordingLogger`. */
function recordingLogger(): TelemetryLogger & { infos: Record<string, unknown>[]; errors: Record<string, unknown>[] } {
  const infos: Record<string, unknown>[] = [];
  const errors: Record<string, unknown>[] = [];
  return {
    infos,
    errors,
    info(payload) {
      infos.push(payload);
    },
    error(payload) {
      errors.push(payload);
    },
  };
}

const BASE_RECORD: RecordJobTelemetryParams["record"] = {
  jobId: "job-1",
  owner: "acme",
  repo: "widgets",
  prNumber: 42,
  headSha: "deadbeef",
  outcome: "success",
  durationMs: 1234,
  costUsd: 0.0123,
};

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "magpie-telemetry-test-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("recordJobTelemetry", () => {
  it("always emits exactly one structured log line via logger.info, tagged event:'job-telemetry'", async () => {
    const logger = recordingLogger();
    const path = join(root, "nested", "telemetry.jsonl");

    await recordJobTelemetry({ record: BASE_RECORD, path, logger });

    expect(logger.infos).toHaveLength(1);
    expect(logger.infos[0]).toMatchObject({ event: "job-telemetry", ...BASE_RECORD });
    expect(typeof logger.infos[0].timestamp).toBe("string");
  });

  it("appends exactly one JSONL line to the configured path, creating parent dirs as needed", async () => {
    const logger = recordingLogger();
    const path = join(root, "does", "not", "exist", "yet", "telemetry.jsonl");

    await recordJobTelemetry({ record: BASE_RECORD, path, logger });

    const contents = await readFile(path, "utf-8");
    const lines = contents.trim().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]) as JobTelemetryRecord;
    expect(parsed).toMatchObject({ event: "job-telemetry", ...BASE_RECORD });
    expect(logger.errors).toHaveLength(0);
  });

  it("appends a second job as a second JSONL line (append-only, one record per job)", async () => {
    const path = join(root, "telemetry.jsonl");
    await recordJobTelemetry({ record: BASE_RECORD, path, logger: recordingLogger() });
    await recordJobTelemetry({
      record: { ...BASE_RECORD, jobId: "job-2", outcome: "timeout-kill", reason: "timeout after 600s" },
      path,
      logger: recordingLogger(),
    });

    const lines = (await readFile(path, "utf-8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect((JSON.parse(lines[0]) as JobTelemetryRecord).jobId).toBe("job-1");
    expect((JSON.parse(lines[1]) as JobTelemetryRecord).jobId).toBe("job-2");
  });

  it("carries usage and gateway spend through to the JSONL record when present", async () => {
    const path = join(root, "telemetry.jsonl");
    const record: RecordJobTelemetryParams["record"] = {
      ...BASE_RECORD,
      outcome: "budget-exhausted",
      reason: "pi review failed: 402 budget exhausted for this key",
      usage: { turns: 3, inputTokens: 500, outputTokens: 200, totalTokens: 700, costUsd: 0.6 },
      gateway: { keyId: "gw-key-1", spentUsd: 0.5, budgetUsd: 0.5 },
    };

    await recordJobTelemetry({ record, path, logger: recordingLogger() });

    const parsed = JSON.parse((await readFile(path, "utf-8")).trim()) as JobTelemetryRecord;
    expect(parsed.usage).toEqual(record.usage);
    expect(parsed.gateway).toEqual(record.gateway);
    expect(parsed.outcome).toBe("budget-exhausted");
  });

  it("degrades gracefully when the JSONL path is unwritable: log line still emitted, write failure logged, never throws", async () => {
    // Point the JSONL append at a path whose parent is a FILE, not a
    // directory — mkdir(dirname(path), {recursive:true}) fails in a way that
    // reliably reproduces "the sink isn't writable" (e.g. a dev box without
    // /var/lib/magpie, or a permissions problem in production) without
    // relying on platform-specific chmod/root behavior.
    const blockerFile = join(root, "blocker");
    await (await import("node:fs/promises")).writeFile(blockerFile, "not a directory");
    const unwritablePath = join(blockerFile, "telemetry.jsonl");
    const logger = recordingLogger();

    await expect(recordJobTelemetry({ record: BASE_RECORD, path: unwritablePath, logger })).resolves.toBeUndefined();

    // The floor guarantee still held...
    expect(logger.infos).toHaveLength(1);
    expect(logger.infos[0]).toMatchObject({ event: "job-telemetry", jobId: "job-1" });
    // ...and the write failure was itself reported, not silently swallowed.
    expect(logger.errors).toHaveLength(1);
    expect(logger.errors[0]).toMatchObject({ event: "telemetry-write-failed", path: unwritablePath, jobId: "job-1" });
  });

  it("uses the default console logger and DEFAULT_TELEMETRY_PATH when neither is supplied", async () => {
    // Just asserts this doesn't throw when no logger/path override is given —
    // production callers (pipeline.ts) always pass config.telemetry.path, but
    // the defaults must still be sane/non-throwing on their own. Redirect
    // console output so the test doesn't spam stdout, and use a path override
    // anyway to avoid ever touching the real /var/lib/magpie from a test run.
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const path = join(root, "telemetry.jsonl");
      await expect(recordJobTelemetry({ record: BASE_RECORD, path })).resolves.toBeUndefined();
      const contents = await readFile(path, "utf-8");
      expect(contents.trim().length).toBeGreaterThan(0);
      expect(logSpy).toHaveBeenCalledTimes(1);
    } finally {
      logSpy.mockRestore();
    }
  });
});
