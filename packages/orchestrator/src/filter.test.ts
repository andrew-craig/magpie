import { describe, expect, it, vi } from "vitest";
import type { Config } from "./config.js";
import { createPullRequestFilter, type FilterLogger } from "./filter.js";
import type { JobDescriptor } from "./queue.js";
import type { PullRequestEvent } from "./server.js";

const ALLOWED_REPO = "my-org/repo";

function testConfig(overrides: Partial<Pick<Config, "repoAllowlist">> = {}): Pick<
  Config,
  "repoAllowlist"
> {
  return {
    repoAllowlist: [ALLOWED_REPO],
    ...overrides,
  };
}

/** Builds a realistic-enough `pull_request` webhook event fixture. */
function makeEvent(overrides: {
  action?: string;
  draft?: boolean;
  fullName?: string;
  owner?: string;
  repoName?: string;
  prNumber?: number;
  headSha?: string;
  installationId?: number | undefined;
  before?: string;
  after?: string;
} = {}): PullRequestEvent {
  const fullName = overrides.fullName ?? ALLOWED_REPO;
  const [owner, repoName] = fullName.split("/");

  const payload: Record<string, unknown> = {
    action: overrides.action ?? "opened",
    number: overrides.prNumber ?? 42,
    pull_request: {
      number: overrides.prNumber ?? 42,
      draft: overrides.draft ?? false,
      head: { sha: overrides.headSha ?? "deadbeef" },
    },
    repository: {
      id: 1,
      name: overrides.repoName ?? repoName,
      full_name: fullName,
      owner: { login: overrides.owner ?? owner },
    },
    sender: { id: 1, login: "octocat" },
  };

  if (overrides.installationId !== undefined) {
    payload.installation = { id: overrides.installationId };
  }

  if (overrides.action === "synchronize") {
    payload.before = overrides.before ?? "beforesha";
    payload.after = overrides.after ?? "aftersha";
  }

  return {
    id: "delivery-1",
    name: "pull_request",
    payload,
  } as unknown as PullRequestEvent;
}

function makeLogger(): FilterLogger & { calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  return {
    calls,
    debug(payload) {
      calls.push({ level: "debug", ...payload });
    },
    warn(payload) {
      calls.push({ level: "warn", ...payload });
    },
  };
}

describe("createPullRequestFilter", () => {
  it("ignores draft PRs", () => {
    const enqueue = vi.fn();
    const filter = createPullRequestFilter(testConfig(), enqueue);

    filter(makeEvent({ action: "opened", draft: true }));

    expect(enqueue).not.toHaveBeenCalled();
  });

  it("ignores non-matching actions", () => {
    const enqueue = vi.fn();
    const filter = createPullRequestFilter(testConfig(), enqueue);

    for (const action of ["closed", "labeled", "assigned", "edited"]) {
      filter(makeEvent({ action }));
    }

    expect(enqueue).not.toHaveBeenCalled();
  });

  it("drops events from repos not on the allowlist and logs at debug level", () => {
    const enqueue = vi.fn();
    const logger = makeLogger();
    const filter = createPullRequestFilter(testConfig(), enqueue, logger);

    filter(makeEvent({ fullName: "someone-else/other-repo" }));

    expect(enqueue).not.toHaveBeenCalled();
    expect(
      logger.calls.some(
        (c) => c.level === "debug" && c.event === "pr-filter-drop-not-allowlisted",
      ),
    ).toBe(true);
  });

  it.each(["opened", "ready_for_review", "reopened", "synchronize"] as const)(
    "accepts a non-draft, allowlisted '%s' event and enqueues exactly one well-formed job",
    (action) => {
      const enqueue = vi.fn();
      const filter = createPullRequestFilter(testConfig(), enqueue);

      filter(
        makeEvent({
          action,
          headSha: "abc123",
          prNumber: 7,
          installationId: 99,
        }),
      );

      expect(enqueue).toHaveBeenCalledTimes(1);
      const job = enqueue.mock.calls[0][0] as JobDescriptor;

      expect(typeof job.id).toBe("string");
      expect(job.id.length).toBeGreaterThan(0);
      expect(job.owner).toBe("my-org");
      expect(job.repo).toBe("repo");
      expect(job.prNumber).toBe(7);
      expect(job.headSha).toBe("abc123");
      expect(job.baseFullName).toBe(ALLOWED_REPO);
      expect(job.installationId).toBe(99);
    },
  );

  it("carries before/after SHAs for synchronize and does not crash", () => {
    const enqueue = vi.fn();
    const filter = createPullRequestFilter(testConfig(), enqueue);

    expect(() =>
      filter(
        makeEvent({
          action: "synchronize",
          before: "oldsha",
          after: "newsha",
        }),
      ),
    ).not.toThrow();

    expect(enqueue).toHaveBeenCalledTimes(1);
    const job = enqueue.mock.calls[0][0] as JobDescriptor;
    expect(job.before).toBe("oldsha");
    expect(job.after).toBe("newsha");
  });

  it("does not set before/after for non-synchronize actions", () => {
    const enqueue = vi.fn();
    const filter = createPullRequestFilter(testConfig(), enqueue);

    filter(makeEvent({ action: "opened" }));

    const job = enqueue.mock.calls[0][0] as JobDescriptor;
    expect(job.before).toBeUndefined();
    expect(job.after).toBeUndefined();
  });

  it("tolerates a missing installation id defensively", () => {
    const enqueue = vi.fn();
    const filter = createPullRequestFilter(testConfig(), enqueue);

    filter(makeEvent({ action: "opened", installationId: undefined }));

    expect(enqueue).toHaveBeenCalledTimes(1);
    const job = enqueue.mock.calls[0][0] as JobDescriptor;
    expect(job.installationId).toBeUndefined();
  });

  it("never throws out of the handler on a malformed/partial payload", () => {
    const enqueue = vi.fn();
    const logger = makeLogger();
    const filter = createPullRequestFilter(testConfig(), enqueue, logger);

    const malformedEvents: PullRequestEvent[] = [
      { id: "d1", name: "pull_request", payload: {} } as unknown as PullRequestEvent,
      {
        id: "d2",
        name: "pull_request",
        payload: { action: "opened" },
      } as unknown as PullRequestEvent,
      {
        id: "d3",
        name: "pull_request",
        payload: {
          action: "opened",
          pull_request: { draft: false },
          repository: { full_name: ALLOWED_REPO },
        },
      } as unknown as PullRequestEvent,
      { id: "d4", name: "pull_request", payload: null } as unknown as PullRequestEvent,
      undefined as unknown as PullRequestEvent,
    ];

    for (const event of malformedEvents) {
      expect(() => filter(event)).not.toThrow();
    }

    expect(enqueue).not.toHaveBeenCalled();
  });

  it("logs (rather than throws) when the injected enqueue callback rejects", async () => {
    const logger = makeLogger();
    const enqueue = vi.fn().mockRejectedValue(new Error("queue exploded"));
    const filter = createPullRequestFilter(testConfig(), enqueue, logger);

    expect(() => filter(makeEvent({ action: "opened" }))).not.toThrow();

    // enqueue() rejection is handled asynchronously; flush microtasks.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(
      logger.calls.some(
        (c) => c.level === "warn" && c.event === "pr-filter-enqueue-error",
      ),
    ).toBe(true);
  });
});
