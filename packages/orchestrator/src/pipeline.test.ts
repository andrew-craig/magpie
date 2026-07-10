import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Octokit } from "@octokit/rest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "./config.js";
import { createReviewPipeline } from "./pipeline.js";
import { MAGPIE_REVIEW_MARKER } from "./publisher.js";
import type { JobDescriptor } from "./queue.js";
import type { CreateWorkspaceParams, Workspace } from "./workspace.js";

// NOTE: everything here runs fully offline end-to-end through `runJob` —
// no network, no real GitHub App, no real `pi` binary, no real git checkout.
// The pipeline's `deps` seam (see pipeline.ts's `PipelineDeps`) lets us swap
// in fakes for every collaborator that would otherwise touch the network or
// hold a secret: `mintToken` (github.ts), `makeOctokit` (@octokit/rest),
// `createWorkspace` (workspace.ts — here backed by a real throwaway temp dir
// rather than a git fixture, since the pipeline itself never runs git; only
// runReview cares about `workspace.dir` as a `cwd`), and `piBinary` (the same
// fake-NDJSON-script pattern used in reviewer.test.ts).

const FAKE_TOKEN = "ghs_super-secret-installation-token-fixture-should-never-leak";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "magpie-pipeline-test-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Writes `body` as an executable Node script (fake `pi`) and returns its path. */
function writeFakePi(body: string): string {
  const path = join(root, "fake-pi.js");
  writeFileSync(path, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

/**
 * NDJSON script body for a fake `pi` that emits one assistant review turn AND
 * "calls" the report_findings tool by writing a findings file to
 * `MAGPIE_FINDINGS_PATH` (see reviewer.ts's M2 findings-file contract and
 * reviewer.test.ts's `writeFakePiWithFindings`, which this mirrors) — the
 * child never actually receives the real Pi extension since these are all
 * fake `pi` binaries, so simulating the file write is the only way an ok:true
 * `ReviewResult` (now requiring `findings`/`verdict`) is reachable here.
 */
function fakePiScriptEmitting(text: string): string {
  return fakePiScriptEmittingFindings(text, []);
}

/**
 * Like {@link fakePiScriptEmitting} but lets the caller supply the
 * `findings[]` array written to the findings file, so tests can drive the
 * pipeline's inline-anchoring path (anchor.ts's `anchorFindings`, wired in
 * pipeline.ts) instead of always taking the "no findings" happy path.
 */
function fakePiScriptEmittingFindings(text: string, findingsList: unknown[]): string {
  const msg = {
    role: "assistant",
    content: [{ type: "text", text }],
    usage: { input: 10, output: 20, totalTokens: 30, cost: { total: 0.001 } },
  };
  const findings = { findings: findingsList, summary: text, verdict: "comment" };
  return [
    `const fs = require("fs");`,
    `fs.writeFileSync(process.env.MAGPIE_FINDINGS_PATH, ${JSON.stringify(JSON.stringify(findings))});`,
    `process.stdout.write(JSON.stringify({type:"session",version:3,id:"t",timestamp:"",cwd:process.cwd()}) + "\\n");`,
    `const msg = ${JSON.stringify(msg)};`,
    `process.stdout.write(JSON.stringify({type:"message_end",message:msg}) + "\\n");`,
    `process.stdout.write(JSON.stringify({type:"agent_end",messages:[msg]}) + "\\n");`,
  ].join("\n");
}

/** Fake `pi` script that exits non-zero, simulating a failed review run. */
function fakePiScriptFailing(): string {
  return [
    `process.stderr.write("boom: provider unavailable\\n");`,
    `process.exit(1);`,
  ].join("\n");
}

function testConfig(overrides: Partial<Config["limits"]> = {}): Config {
  return {
    github: { appId: "123", privateKeyPath: null },
    llm: { baseUrl: "https://example.com/v1", model: "some/model" },
    server: { host: "127.0.0.1", port: 0 },
    limits: { jobTimeoutSeconds: 600, concurrency: 2, maxDiffLines: 100, ...overrides },
    repoAllowlist: [],
    workspace: { workDir: join(root, "work") },
    container: {
      image: "magpie-reviewer:0.1.0",
      memory: "4g",
      cpus: "2",
      pidsLimit: 256,
      dockerBin: "docker",
      network: "bridge",
    },
    secrets: {
      webhookSecret: "test-webhook-secret",
      llmApiKey: "test-llm-api-key",
      githubPrivateKey: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n",
    },
  };
}

function testJob(overrides: Partial<JobDescriptor> = {}): JobDescriptor {
  return {
    id: "job-1",
    owner: "acme",
    repo: "widgets",
    prNumber: 7,
    headSha: "deadbeef",
    baseFullName: "acme/widgets",
    installationId: 999,
    ...overrides,
  };
}

interface FakeFile {
  filename: string;
  additions: number;
  deletions: number;
}

/**
 * Builds a fake Octokit exposing exactly the surface the pipeline touches:
 * `rest.pulls.get` (called twice with different args — once for PR metadata
 * (now also carrying `head.sha`, used by the HEAD VERIFY race check — see
 * pipeline.ts), once by diff.ts with `mediaType: { format: "diff" }`),
 * `rest.pulls.listFiles` + `paginate` (diff.ts's file listing), and
 * `issues.createComment` (publisher.ts). Mirrors diff.test.ts's /
 * publisher.test.ts's fake-Octokit pattern.
 *
 * `head.sha` defaults to `"deadbeef"` — the same default `testJob()` uses for
 * `headSha` — so every existing test gets a MATCHING head unless it opts into
 * a mismatch via `opts.head`.
 */
function fakeOctokit(opts: {
  title: string;
  body: string | null;
  files: FakeFile[];
  diffText: string;
  head?: { sha: string };
}) {
  const listFiles = vi.fn();
  const paginate = vi.fn(async () => opts.files);
  const head = opts.head ?? { sha: "deadbeef" };
  const get = vi.fn(async (args: { mediaType?: { format: string } }) => {
    if (args?.mediaType?.format === "diff") {
      return { data: opts.diffText };
    }
    return { data: { title: opts.title, body: opts.body, head } };
  });
  const createComment = vi.fn(async (_args: { owner: string; repo: string; issue_number: number; body: string }) => ({
    data: { id: 42, html_url: "https://github.com/acme/widgets/pull/7#issuecomment-42" },
  }));
  const createReview = vi.fn(async (_args: unknown) => ({
    data: { id: 43, html_url: "https://github.com/acme/widgets/pull/7#pullrequestreview-43" },
  }));

  const octokit = {
    paginate,
    rest: { pulls: { get, listFiles } },
    issues: { createComment },
    pulls: { createReview },
  };

  return { octokit, get, listFiles, paginate, createComment, createReview };
}

/** Fake `createWorkspace`: a real throwaway temp dir, no git involved. */
function fakeWorkspaceFactory() {
  const cleanupCalls: string[] = [];
  const createCalls: CreateWorkspaceParams[] = [];

  const factory = async (params: CreateWorkspaceParams): Promise<Workspace> => {
    createCalls.push(params);
    const dir = mkdtempSync(join(root, "ws-"));
    let cleaned = false;
    return {
      dir,
      cleanup: async () => {
        if (cleaned) return;
        cleaned = true;
        cleanupCalls.push(dir);
        rmSync(dir, { recursive: true, force: true });
      },
    };
  };

  return { factory, cleanupCalls, createCalls };
}

describe("createReviewPipeline / runJob", () => {
  it("happy path: reviews a small diff and posts exactly one PR review (no findings); workspace is cleaned up", async () => {
    const { octokit, get, createComment, createReview } = fakeOctokit({
      title: "Add feature",
      body: "Some PR body",
      files: [{ filename: "src/a.ts", additions: 5, deletions: 1 }],
      diffText: "diff --git a/src/a.ts b/src/a.ts\n+hello\n",
    });
    const { factory, cleanupCalls, createCalls } = fakeWorkspaceFactory();
    const piBinary = writeFakePi(fakePiScriptEmitting("Looks good, no issues found."));
    const mintToken = vi.fn(async () => ({ token: FAKE_TOKEN }));

    const { runJob } = createReviewPipeline(testConfig(), {
      mintToken,
      makeOctokit: () => octokit as unknown as Octokit,
      createWorkspace: factory,
      piBinary,
    });

    const job = testJob();
    await runJob(job, new AbortController().signal);

    expect(mintToken).toHaveBeenCalledTimes(1);
    expect(mintToken).toHaveBeenCalledWith(expect.anything(), 999);

    // PR metadata fetched once (no mediaType) plus once for the diff body.
    expect(get).toHaveBeenCalledTimes(2);

    // No findings at all -> anchorFindings produces an empty inline[] and
    // other[], so publishReviewWithFindings still goes through
    // pulls.createReview (never issues.createComment) with comments: [].
    expect(createReview).toHaveBeenCalledTimes(1);
    const reviewArgs = createReview.mock.calls[0][0] as { body: string; comments: unknown[] };
    expect(reviewArgs.body).toContain(MAGPIE_REVIEW_MARKER);
    expect(reviewArgs.body).toContain("Looks good, no issues found.");
    expect(reviewArgs.comments).toEqual([]);
    expect(createComment).not.toHaveBeenCalled();

    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]).toMatchObject({
      owner: "acme",
      repo: "widgets",
      prNumber: 7,
      headSha: "deadbeef",
      token: FAKE_TOKEN,
    });
    expect(cleanupCalls).toHaveLength(1);
    expect(existsSync(cleanupCalls[0])).toBe(false);
  });

  it("anchors a findable finding to an inline comment and folds an unanchorable one into Other observations", async () => {
    // One finding lands on `src/a.ts` line 1 — a genuine '+' (added) line in
    // the diff below, so anchorFindings (anchor.ts) anchors it and the
    // pipeline must publish it as a `comments[]` entry via
    // publishReviewWithFindings. The other finding is on a path the diff
    // never touches at all, so it can't anchor and must instead show up as
    // text under the review body's "Other observations" section instead of
    // being silently dropped (PLAN.md's diff-anchoring constraint).
    const diffText =
      "diff --git a/src/a.ts b/src/a.ts\n" +
      "--- a/src/a.ts\n" +
      "+++ b/src/a.ts\n" +
      "@@ -1,0 +1,2 @@\n" +
      "+const x = 1;\n" +
      "+const y = 2;\n";

    const { octokit, createComment, createReview } = fakeOctokit({
      title: "Add feature",
      body: "Some PR body",
      files: [{ filename: "src/a.ts", additions: 2, deletions: 0 }],
      diffText,
    });
    const { factory, cleanupCalls } = fakeWorkspaceFactory();

    const anchoredFinding = {
      path: "src/a.ts",
      line: 1,
      severity: "important",
      category: "style",
      message: "Prefer a named constant here.",
    };
    const unanchoredFinding = {
      path: "src/does-not-exist.ts",
      line: 99,
      severity: "nit",
      category: "clarity",
      message: "This file is not part of the diff at all.",
    };

    const piBinary = writeFakePi(
      fakePiScriptEmittingFindings("Overall looks fine.", [anchoredFinding, unanchoredFinding]),
    );
    const mintToken = vi.fn(async () => ({ token: FAKE_TOKEN }));

    const { runJob } = createReviewPipeline(testConfig(), {
      mintToken,
      makeOctokit: () => octokit as unknown as Octokit,
      createWorkspace: factory,
      piBinary,
    });

    await runJob(testJob(), new AbortController().signal);

    expect(createReview).toHaveBeenCalledTimes(1);
    expect(createComment).not.toHaveBeenCalled();

    const reviewArgs = createReview.mock.calls[0][0] as {
      body: string;
      comments: Array<{ path: string; line: number; side: string; body: string }>;
    };

    expect(reviewArgs.comments).toHaveLength(1);
    expect(reviewArgs.comments[0]).toMatchObject({
      path: "src/a.ts",
      line: 1,
      side: "RIGHT",
    });
    expect(reviewArgs.comments[0].body).toContain("Prefer a named constant here.");

    expect(reviewArgs.body).toContain(MAGPIE_REVIEW_MARKER);
    expect(reviewArgs.body).toContain("Overall looks fine.");
    expect(reviewArgs.body).toContain("Other observations");
    expect(reviewArgs.body).toContain("This file is not part of the diff at all.");
    expect(reviewArgs.body).not.toContain("Prefer a named constant here.");

    expect(cleanupCalls).toHaveLength(1);
  });

  it("tooLarge diff: skips runReview entirely and posts a size-capped summary comment", async () => {
    const { octokit, get, createComment } = fakeOctokit({
      title: "Huge PR",
      body: null,
      files: [{ filename: "big.ts", additions: 500, deletions: 500 }],
      diffText: "should never be fetched",
    });
    const { factory, cleanupCalls } = fakeWorkspaceFactory();
    // No fake pi provided at all — if runReview were invoked, spawning the
    // default `pi` (unset piBinary defaults to MAGPIE_PI_BIN/"pi") would fail
    // loudly rather than silently succeed, but we also assert directly below
    // that the diff-format `get` call never happens.
    const mintToken = vi.fn(async () => ({ token: FAKE_TOKEN }));

    const { runJob } = createReviewPipeline(testConfig({ maxDiffLines: 100 }), {
      mintToken,
      makeOctokit: () => octokit as unknown as Octokit,
      createWorkspace: factory,
    });

    await runJob(testJob(), new AbortController().signal);

    // Only the metadata `get` call happened — diff.ts never fetches the diff
    // body when tooLarge (see diff.ts's module doc comment).
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).not.toHaveBeenCalledWith(expect.objectContaining({ mediaType: { format: "diff" } }));

    expect(createComment).toHaveBeenCalledTimes(1);
    const body = createComment.mock.calls[0][0].body as string;
    expect(body).toMatch(/1000 lines/);
    expect(body).toMatch(/exceeds the configured review cap of 100/);
    expect(cleanupCalls).toHaveLength(1);
  });

  it("rejects and posts no comment when the job has no installationId", async () => {
    const { octokit, createComment } = fakeOctokit({
      title: "x",
      body: "",
      files: [],
      diffText: "",
    });
    const { factory } = fakeWorkspaceFactory();
    const mintToken = vi.fn(async () => ({ token: FAKE_TOKEN }));

    const { runJob } = createReviewPipeline(testConfig(), {
      mintToken,
      makeOctokit: () => octokit as unknown as Octokit,
      createWorkspace: factory,
    });

    const job = testJob({ installationId: undefined });
    await expect(runJob(job, new AbortController().signal)).rejects.toThrow();

    expect(mintToken).not.toHaveBeenCalled();
    expect(createComment).not.toHaveBeenCalled();
  });

  it("review failure: still posts exactly one comment containing the failure note", async () => {
    const { octokit, createComment } = fakeOctokit({
      title: "Add feature",
      body: "Some PR body",
      files: [{ filename: "src/a.ts", additions: 5, deletions: 1 }],
      diffText: "diff --git a/src/a.ts b/src/a.ts\n+hello\n",
    });
    const { factory, cleanupCalls } = fakeWorkspaceFactory();
    const piBinary = writeFakePi(fakePiScriptFailing());
    const mintToken = vi.fn(async () => ({ token: FAKE_TOKEN }));

    const { runJob } = createReviewPipeline(testConfig(), {
      mintToken,
      makeOctokit: () => octokit as unknown as Octokit,
      createWorkspace: factory,
      piBinary,
    });

    await runJob(testJob(), new AbortController().signal);

    expect(createComment).toHaveBeenCalledTimes(1);
    const body = createComment.mock.calls[0][0].body as string;
    expect(body).toMatch(/could not complete a review/i);
    expect(body).toMatch(/boom: provider unavailable/);
    expect(cleanupCalls).toHaveLength(1);
  });

  it("head-sha race: a force-push landing after checkout aborts the job without publishing", async () => {
    // The metadata `get` call (fetched AFTER the diff, per pipeline.ts's HEAD
    // VERIFY reorder) now reports a DIFFERENT head sha than the workspace was
    // checked out at (`job.headSha` stays "deadbeef" — see `testJob()`) —
    // simulating a force-push that landed after checkout but before/during
    // the diff fetch. The pipeline must abort (no publish) rather than
    // publish a review built from an incoherent workspace/diff pair.
    const { octokit, createComment } = fakeOctokit({
      title: "Add feature",
      body: "Some PR body",
      files: [{ filename: "src/a.ts", additions: 5, deletions: 1 }],
      diffText: "diff --git a/src/a.ts b/src/a.ts\n+hello\n",
      head: { sha: "cafef00d" },
    });
    const { factory, cleanupCalls } = fakeWorkspaceFactory();
    const mintToken = vi.fn(async () => ({ token: FAKE_TOKEN }));

    // head-sha-mismatch is logged at INFO (a benign self-healing race — see
    // pipeline.ts), so spy on console.log rather than console.error.
    const logCalls: unknown[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logCalls.push(args);
    });

    try {
      const { runJob } = createReviewPipeline(testConfig(), {
        mintToken,
        makeOctokit: () => octokit as unknown as Octokit,
        createWorkspace: factory,
      });

      await runJob(testJob(), new AbortController().signal);
    } finally {
      logSpy.mockRestore();
    }

    expect(createComment).not.toHaveBeenCalled();
    expect(cleanupCalls).toHaveLength(1);

    const serializedLogCalls = JSON.stringify(logCalls);
    expect(serializedLogCalls).toContain("head-sha-mismatch");
    expect(serializedLogCalls).toContain("deadbeef");
    expect(serializedLogCalls).toContain("cafef00d");
  });

  it("never logs or publishes the installation token", async () => {
    const { octokit, createReview } = fakeOctokit({
      title: "Add feature",
      body: "Some PR body",
      files: [{ filename: "src/a.ts", additions: 5, deletions: 1 }],
      diffText: "diff --git a/src/a.ts b/src/a.ts\n+hello\n",
    });
    const { factory } = fakeWorkspaceFactory();
    const piBinary = writeFakePi(fakePiScriptEmitting("All good."));
    const mintToken = vi.fn(async () => ({ token: FAKE_TOKEN }));

    const logCalls: unknown[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logCalls.push(args);
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logCalls.push(args);
    });

    try {
      const { runJob } = createReviewPipeline(testConfig(), {
        mintToken,
        makeOctokit: () => octokit as unknown as Octokit,
        createWorkspace: factory,
        piBinary,
      });

      await runJob(testJob(), new AbortController().signal);
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
    }

    const serializedLogs = JSON.stringify(logCalls);
    expect(serializedLogs).not.toContain(FAKE_TOKEN);

    expect(createReview).toHaveBeenCalledTimes(1);
    const body = createReview.mock.calls[0][0].body as string;
    expect(body).not.toContain(FAKE_TOKEN);
  });

  describe("AbortSignal (queue backstop timeout) handling", () => {
    it("a pre-aborted signal short-circuits before minting a token (no publish)", async () => {
      const { octokit, createComment } = fakeOctokit({
        title: "Add feature",
        body: "Some PR body",
        files: [{ filename: "src/a.ts", additions: 5, deletions: 1 }],
        diffText: "diff --git a/src/a.ts b/src/a.ts\n+hello\n",
      });
      const { factory } = fakeWorkspaceFactory();
      const mintToken = vi.fn(async () => ({ token: FAKE_TOKEN }));

      const { runJob } = createReviewPipeline(testConfig(), {
        mintToken,
        makeOctokit: () => octokit as unknown as Octokit,
        createWorkspace: factory,
      });

      const controller = new AbortController();
      controller.abort();

      await runJob(testJob(), controller.signal);

      expect(mintToken).not.toHaveBeenCalled();
      expect(createComment).not.toHaveBeenCalled();
    });

    it("a signal aborted before createWorkspace short-circuits (no publish, no workspace created)", async () => {
      const { octokit, createComment } = fakeOctokit({
        title: "Add feature",
        body: "Some PR body",
        files: [{ filename: "src/a.ts", additions: 5, deletions: 1 }],
        diffText: "diff --git a/src/a.ts b/src/a.ts\n+hello\n",
      });
      const { factory, createCalls } = fakeWorkspaceFactory();
      const controller = new AbortController();
      // Aborts the instant mintToken is invoked — i.e. strictly after the
      // pre-mint guard has already let this job through, but before
      // createWorkspace runs.
      const mintToken = vi.fn(async () => {
        controller.abort();
        return { token: FAKE_TOKEN };
      });

      const { runJob } = createReviewPipeline(testConfig(), {
        mintToken,
        makeOctokit: () => octokit as unknown as Octokit,
        createWorkspace: factory,
      });

      await runJob(testJob(), controller.signal);

      expect(mintToken).toHaveBeenCalledTimes(1);
      expect(createCalls).toHaveLength(0);
      expect(createComment).not.toHaveBeenCalled();
    });

    it("a signal aborted after the diff/metadata fetch but before publish skips publishing (workspace still cleaned up)", async () => {
      const { octokit, createComment } = fakeOctokit({
        title: "Add feature",
        body: "Some PR body",
        files: [{ filename: "src/a.ts", additions: 5, deletions: 1 }],
        diffText: "diff --git a/src/a.ts b/src/a.ts\n+hello\n",
      });
      const { factory, cleanupCalls } = fakeWorkspaceFactory();
      const mintToken = vi.fn(async () => ({ token: FAKE_TOKEN }));
      const controller = new AbortController();
      // The fake `pi` aborts the controller itself, simulating the queue's
      // backstop timeout firing while runReview is in flight; runReview
      // (reviewer.ts) observes the same signal and resolves
      // `{ ok: false, reason: "aborted" }` promptly instead of hanging, and
      // the pipeline's own pre-publish guard (NO DOUBLE-HANDLING) must then
      // skip publishing entirely.
      const piBinary = writeFakePi(
        [
          `process.stdout.write(JSON.stringify({type:"session",version:3,id:"t",timestamp:"",cwd:process.cwd()}) + "\\n");`,
          `setTimeout(() => {}, 60000);`,
        ].join("\n"),
      );

      const { runJob } = createReviewPipeline(testConfig(), {
        mintToken,
        makeOctokit: () => octokit as unknown as Octokit,
        createWorkspace: factory,
        piBinary,
      });

      const jobPromise = runJob(testJob(), controller.signal);
      // Give runReview a moment to spawn the fake pi before aborting, so the
      // abort is genuinely observed mid-review rather than pre-empting it.
      await new Promise((resolve) => setTimeout(resolve, 50));
      controller.abort();
      await jobPromise;

      expect(createComment).not.toHaveBeenCalled();
      expect(cleanupCalls).toHaveLength(1);
    });
  });

  // The happy-path test above only proves the token never leaks when the job
  // *succeeds*. But the installation token is live in scope for every stage
  // between mintToken and workspace cleanup (PR metadata fetch, diff fetch),
  // and a failure in any of those stages propagates its error out through
  // `runJob` and on into index.ts's job-failed logging (see index.ts's
  // `logJobOutcome`, which serializes `{name, message, stack}` of whatever
  // error the queue caught). These cases drive a FAILURE through each
  // post-mint stage and assert the token never appears in the rejection
  // (serialized the same way logJobOutcome would) or in anything logged
  // during the run.
  describe("token never leaks when a post-mint stage fails", () => {
    /** Serializes an unknown rejection the same way index.ts's logJobOutcome does. */
    function serializeLikeJobFailedHandler(err: unknown): string {
      const error =
        err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : err;
      return JSON.stringify({ event: "job-failed", outcome: "failed", error });
    }

    it("Case 1: PR-metadata fetch (pulls.get, no mediaType) rejects", async () => {
      const mintToken = vi.fn(async () => ({ token: FAKE_TOKEN }));
      // A realistic failure shape (e.g. what @octokit/rest's RequestError
      // looks like for a 404/401) — deliberately does NOT reference the
      // token, since the invariant under test is that *pipeline.ts itself*
      // never splices the token into an error or a log line while the
      // token is in scope, not that a token we ourselves embedded survives.
      // The diff fetch (computePrDiff, called BEFORE the metadata fetch — see
      // pipeline.ts's HEAD VERIFY reorder) must succeed here so the metadata
      // (non-diff) `get` call below is actually the one that fails.
      const paginate = vi.fn(async () => []);
      const get = vi.fn(async (args: { mediaType?: { format: string } }) => {
        if (args?.mediaType?.format === "diff") {
          return { data: "" };
        }
        throw new Error("Not Found");
      });
      const octokit = { paginate, rest: { pulls: { get, listFiles: vi.fn() } }, issues: { createComment: vi.fn() } };
      const { factory } = fakeWorkspaceFactory();

      const logCalls: unknown[] = [];
      const logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
        logCalls.push(args);
      });
      const errSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
        logCalls.push(args);
      });

      let caught: unknown;
      try {
        const { runJob } = createReviewPipeline(testConfig(), {
          mintToken,
          makeOctokit: () => octokit as unknown as Octokit,
          createWorkspace: factory,
        });
        try {
          await runJob(testJob(), new AbortController().signal);
          throw new Error("expected runJob to reject");
        } catch (err) {
          caught = err;
        }
      } finally {
        logSpy.mockRestore();
        errSpy.mockRestore();
      }

      expect(caught).toBeInstanceOf(Error);
      const serializedRejection = serializeLikeJobFailedHandler(caught);
      expect(serializedRejection).not.toContain(FAKE_TOKEN);

      const serializedLogs = JSON.stringify(logCalls);
      expect(serializedLogs).not.toContain(FAKE_TOKEN);
    });

    it("Case 2: diff fetch (pulls.get with mediaType: diff) rejects", async () => {
      const mintToken = vi.fn(async () => ({ token: FAKE_TOKEN }));
      // Same rationale as Case 1: a realistic diff-fetch failure, not one
      // that echoes the token back.
      const get = vi.fn(async (args: { mediaType?: { format: string } }) => {
        if (args?.mediaType?.format === "diff") {
          throw new Error("API rate limit exceeded");
        }
        return { data: { title: "Add feature", body: "Some PR body" } };
      });
      const paginate = vi.fn(async () => [{ filename: "src/a.ts", additions: 5, deletions: 1 }]);
      const octokit = { paginate, rest: { pulls: { get, listFiles: vi.fn() } }, issues: { createComment: vi.fn() } };
      const { factory, cleanupCalls } = fakeWorkspaceFactory();

      const logCalls: unknown[] = [];
      const logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
        logCalls.push(args);
      });
      const errSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
        logCalls.push(args);
      });

      let caught: unknown;
      try {
        const { runJob } = createReviewPipeline(testConfig(), {
          mintToken,
          makeOctokit: () => octokit as unknown as Octokit,
          createWorkspace: factory,
        });
        try {
          await runJob(testJob(), new AbortController().signal);
          throw new Error("expected runJob to reject");
        } catch (err) {
          caught = err;
        }
      } finally {
        logSpy.mockRestore();
        errSpy.mockRestore();
      }

      expect(caught).toBeInstanceOf(Error);
      const serializedRejection = serializeLikeJobFailedHandler(caught);
      expect(serializedRejection).not.toContain(FAKE_TOKEN);

      const serializedLogs = JSON.stringify(logCalls);
      expect(serializedLogs).not.toContain(FAKE_TOKEN);

      // workspace was created (post pulls.get metadata) so cleanup ran via
      // the pipeline's try/finally even though the diff fetch failed.
      expect(cleanupCalls).toHaveLength(1);
    });

    it("Case 3: mintToken itself rejects (documents the invariant trivially: no token was ever minted)", async () => {
      const mintToken = vi.fn(async () => {
        throw new Error("failed to mint installation token");
      });
      const { octokit } = fakeOctokit({ title: "x", body: "", files: [], diffText: "" });
      const { factory } = fakeWorkspaceFactory();

      const logCalls: unknown[] = [];
      const logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
        logCalls.push(args);
      });
      const errSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
        logCalls.push(args);
      });

      let caught: unknown;
      try {
        const { runJob } = createReviewPipeline(testConfig(), {
          mintToken,
          makeOctokit: () => octokit as unknown as Octokit,
          createWorkspace: factory,
        });
        try {
          await runJob(testJob(), new AbortController().signal);
          throw new Error("expected runJob to reject");
        } catch (err) {
          caught = err;
        }
      } finally {
        logSpy.mockRestore();
        errSpy.mockRestore();
      }

      expect(caught).toBeInstanceOf(Error);
      const serializedRejection = serializeLikeJobFailedHandler(caught);
      expect(serializedRejection).not.toContain(FAKE_TOKEN);

      const serializedLogs = JSON.stringify(logCalls);
      expect(serializedLogs).not.toContain(FAKE_TOKEN);
    });
  });
});
