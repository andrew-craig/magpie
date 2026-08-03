import { describe, expect, it, vi } from "vitest";
import {
  createIssueCommentHandler,
  type CommentCommandConfig,
  type CommentCommandDeps,
  type CommentCommandLogger,
} from "./comment-command.js";
import type { JobDescriptor } from "./queue.js";
import type { IssueCommentEvent } from "./server.js";

const ALLOWED_REPO = "my-org/repo";
const FAKE_TOKEN = "ghs_fake-token-fixture";

function testConfig(overrides: Partial<CommentCommandConfig> = {}): CommentCommandConfig {
  return {
    repoAllowlist: [ALLOWED_REPO],
    github: { appId: "123" },
    secrets: { githubPrivateKey: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n" },
    ...overrides,
  };
}

function makeEvent(overrides: {
  action?: string;
  isPr?: boolean;
  body?: string;
  fullName?: string;
  owner?: string;
  repoName?: string;
  prNumber?: number;
  commentId?: number;
  commenterLogin?: string;
  installationId?: number | undefined;
} = {}): IssueCommentEvent {
  const fullName = overrides.fullName ?? ALLOWED_REPO;
  const [owner, repoName] = fullName.split("/");
  const isPr = overrides.isPr ?? true;

  const payload: Record<string, unknown> = {
    action: overrides.action ?? "created",
    issue: {
      number: overrides.prNumber ?? 7,
      ...(isPr ? { pull_request: { url: "https://api.github.com/x" } } : {}),
    },
    comment: {
      id: overrides.commentId ?? 555,
      body: overrides.body ?? "@magpie review",
      user: { login: overrides.commenterLogin ?? "octocat" },
    },
    repository: {
      id: 1,
      name: overrides.repoName ?? repoName,
      full_name: fullName,
      owner: { login: overrides.owner ?? owner },
    },
    sender: { id: 1, login: overrides.commenterLogin ?? "octocat" },
  };

  if (overrides.installationId !== undefined) {
    payload.installation = { id: overrides.installationId };
  } else {
    payload.installation = { id: 99 };
  }

  return {
    id: "delivery-1",
    name: "issue_comment",
    payload,
  } as unknown as IssueCommentEvent;
}

function makeLogger(): CommentCommandLogger & { calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  return {
    calls,
    debug(payload) {
      calls.push({ level: "debug", ...payload });
    },
    info(payload) {
      calls.push({ level: "info", ...payload });
    },
    warn(payload) {
      calls.push({ level: "warn", ...payload });
    },
    error(payload) {
      calls.push({ level: "error", ...payload });
    },
  };
}

/**
 * Fake Octokit exposing exactly the surface comment-command.ts touches:
 * `rest.repos.getCollaboratorPermissionLevel`, `rest.pulls.get`, and
 * `rest.reactions.createForIssueComment`.
 */
function fakeOctokit(opts: {
  permission?: string;
  permissionError?: unknown;
  headSha?: string;
  reactionError?: unknown;
}) {
  const getCollaboratorPermissionLevel = vi.fn(async () => {
    if (opts.permissionError !== undefined) throw opts.permissionError;
    return { data: { permission: opts.permission ?? "write" } };
  });
  const get = vi.fn(async () => ({ data: { head: { sha: opts.headSha ?? "freshsha" } } }));
  const createForIssueComment = vi.fn(async () => {
    if (opts.reactionError !== undefined) throw opts.reactionError;
    return { data: {} };
  });

  const octokit = {
    rest: {
      repos: { getCollaboratorPermissionLevel },
      pulls: { get },
      reactions: { createForIssueComment },
    },
  };

  return { octokit, getCollaboratorPermissionLevel, get, createForIssueComment };
}

function testDeps(octokit: unknown): CommentCommandDeps {
  return {
    mintToken: vi.fn(async () => ({ token: FAKE_TOKEN })),
    makeOctokit: vi.fn(() => octokit as never),
  };
}

describe("createIssueCommentHandler", () => {
  it("ignores non-'created' actions", async () => {
    const enqueue = vi.fn();
    const { octokit } = fakeOctokit({});
    const handler = createIssueCommentHandler(testConfig(), enqueue, testDeps(octokit));

    await handler(makeEvent({ action: "edited" }));
    await handler(makeEvent({ action: "deleted" }));

    expect(enqueue).not.toHaveBeenCalled();
  });

  it("ignores comments on plain issues (not PRs)", async () => {
    const enqueue = vi.fn();
    const logger = makeLogger();
    const { octokit } = fakeOctokit({});
    const handler = createIssueCommentHandler(testConfig(), enqueue, testDeps(octokit), logger);

    await handler(makeEvent({ isPr: false }));

    expect(enqueue).not.toHaveBeenCalled();
    expect(logger.calls.some((c) => c.event === "comment-command-drop-not-a-pr")).toBe(true);
  });

  it("ignores comment bodies that don't contain the command", async () => {
    const enqueue = vi.fn();
    const { octokit } = fakeOctokit({});
    const handler = createIssueCommentHandler(testConfig(), enqueue, testDeps(octokit));

    await handler(makeEvent({ body: "thanks for the PR!" }));
    await handler(makeEvent({ body: "@magpie approve" }));

    expect(enqueue).not.toHaveBeenCalled();
  });

  it.each([
    "@magpie review",
    "please @magpie review this",
    "@magpie   review",
    "  @magpie review  ",
    "@MAGPIE REVIEW",
    "@magpie review please!",
  ])("matches the command in various forms: %j", async (body) => {
    const enqueue = vi.fn();
    const { octokit } = fakeOctokit({});
    const handler = createIssueCommentHandler(testConfig(), enqueue, testDeps(octokit));

    await handler(makeEvent({ body }));

    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("drops events from repos not on the allowlist", async () => {
    const enqueue = vi.fn();
    const logger = makeLogger();
    const { octokit } = fakeOctokit({});
    const handler = createIssueCommentHandler(testConfig(), enqueue, testDeps(octokit), logger);

    await handler(makeEvent({ fullName: "someone-else/other-repo" }));

    expect(enqueue).not.toHaveBeenCalled();
    expect(logger.calls.some((c) => c.event === "comment-command-drop-not-allowlisted")).toBe(true);
  });

  it("does nothing (no enqueue, no reaction) for a commenter with 'read' permission", async () => {
    const enqueue = vi.fn();
    const logger = makeLogger();
    const { octokit, createForIssueComment } = fakeOctokit({ permission: "read" });
    const handler = createIssueCommentHandler(testConfig(), enqueue, testDeps(octokit), logger);

    await handler(makeEvent({}));

    expect(enqueue).not.toHaveBeenCalled();
    expect(createForIssueComment).not.toHaveBeenCalled();
    expect(logger.calls.some((c) => c.event === "comment-command-unauthorized")).toBe(true);
  });

  it("does nothing (no enqueue, no reaction) for a commenter with 'none' permission", async () => {
    const enqueue = vi.fn();
    const { octokit, createForIssueComment } = fakeOctokit({ permission: "none" });
    const handler = createIssueCommentHandler(testConfig(), enqueue, testDeps(octokit));

    await handler(makeEvent({}));

    expect(enqueue).not.toHaveBeenCalled();
    expect(createForIssueComment).not.toHaveBeenCalled();
  });

  it("does nothing (no enqueue, no reaction) when the permission lookup API call errors", async () => {
    const enqueue = vi.fn();
    const logger = makeLogger();
    const { octokit, createForIssueComment } = fakeOctokit({ permissionError: new Error("boom") });
    const handler = createIssueCommentHandler(testConfig(), enqueue, testDeps(octokit), logger);

    await handler(makeEvent({}));

    expect(enqueue).not.toHaveBeenCalled();
    expect(createForIssueComment).not.toHaveBeenCalled();
    expect(
      logger.calls.some(
        (c) => c.event === "comment-command-unauthorized" && c.reason === "permission-lookup-failed",
      ),
    ).toBe(true);
  });

  it.each(["write", "admin"])(
    "enqueues a forced-full-review job and posts an eyes reaction for a '%s' collaborator",
    async (permission) => {
      const enqueue = vi.fn();
      const { octokit, createForIssueComment } = fakeOctokit({ permission, headSha: "abc123freshhead" });
      const handler = createIssueCommentHandler(testConfig(), enqueue, testDeps(octokit));

      await handler(
        makeEvent({ prNumber: 42, commentId: 999, commenterLogin: "maintainer", installationId: 77 }),
      );

      expect(enqueue).toHaveBeenCalledTimes(1);
      const job = enqueue.mock.calls[0][0] as JobDescriptor;
      expect(job.owner).toBe("my-org");
      expect(job.repo).toBe("repo");
      expect(job.prNumber).toBe(42);
      expect(job.headSha).toBe("abc123freshhead");
      expect(job.baseFullName).toBe(ALLOWED_REPO);
      expect(job.installationId).toBe(77);
      expect(job.forceFullReview).toBe(true);
      expect(job.before).toBeUndefined();
      expect(job.after).toBeUndefined();
      expect(typeof job.id).toBe("string");
      expect(job.id.length).toBeGreaterThan(0);

      expect(createForIssueComment).toHaveBeenCalledTimes(1);
      expect(createForIssueComment.mock.calls[0][0]).toMatchObject({
        owner: "my-org",
        repo: "repo",
        comment_id: 999,
        content: "eyes",
      });
    },
  );

  it("still enqueues the job even when posting the reaction fails", async () => {
    const enqueue = vi.fn();
    const logger = makeLogger();
    const { octokit } = fakeOctokit({ reactionError: new Error("reaction api down") });
    const handler = createIssueCommentHandler(testConfig(), enqueue, testDeps(octokit), logger);

    await handler(makeEvent({}));

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(logger.calls.some((c) => c.event === "comment-command-reaction-failed")).toBe(true);
  });

  it("never throws out of the handler on a malformed/partial payload", async () => {
    const enqueue = vi.fn();
    const logger = makeLogger();
    const { octokit } = fakeOctokit({});
    const handler = createIssueCommentHandler(testConfig(), enqueue, testDeps(octokit), logger);

    const malformedEvents: IssueCommentEvent[] = [
      { id: "d1", name: "issue_comment", payload: {} } as unknown as IssueCommentEvent,
      {
        id: "d2",
        name: "issue_comment",
        payload: { action: "created" },
      } as unknown as IssueCommentEvent,
      {
        id: "d3",
        name: "issue_comment",
        payload: {
          action: "created",
          issue: { pull_request: {} },
          comment: { body: "@magpie review" },
          repository: { full_name: ALLOWED_REPO },
        },
      } as unknown as IssueCommentEvent,
      { id: "d4", name: "issue_comment", payload: null } as unknown as IssueCommentEvent,
      undefined as unknown as IssueCommentEvent,
    ];

    for (const event of malformedEvents) {
      await expect(handler(event)).resolves.toBeUndefined();
    }

    expect(enqueue).not.toHaveBeenCalled();
  });
});
