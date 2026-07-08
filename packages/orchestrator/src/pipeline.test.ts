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

/** NDJSON script body for a fake `pi` that emits one assistant review turn. */
function fakePiScriptEmitting(text: string): string {
  const msg = {
    role: "assistant",
    content: [{ type: "text", text }],
    usage: { input: 10, output: 20, totalTokens: 30, cost: { total: 0.001 } },
  };
  return [
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
 * `rest.pulls.get` (called twice with different args — once for PR metadata,
 * once by diff.ts with `mediaType: { format: "diff" }`), `rest.pulls.listFiles`
 * + `paginate` (diff.ts's file listing), and `issues.createComment`
 * (publisher.ts). Mirrors diff.test.ts's / publisher.test.ts's fake-Octokit
 * pattern.
 */
function fakeOctokit(opts: { title: string; body: string | null; files: FakeFile[]; diffText: string }) {
  const listFiles = vi.fn();
  const paginate = vi.fn(async () => opts.files);
  const get = vi.fn(async (args: { mediaType?: { format: string } }) => {
    if (args?.mediaType?.format === "diff") {
      return { data: opts.diffText };
    }
    return { data: { title: opts.title, body: opts.body } };
  });
  const createComment = vi.fn(async (_args: { owner: string; repo: string; issue_number: number; body: string }) => ({
    data: { id: 42, html_url: "https://github.com/acme/widgets/pull/7#issuecomment-42" },
  }));

  const octokit = {
    paginate,
    rest: { pulls: { get, listFiles } },
    issues: { createComment },
  };

  return { octokit, get, listFiles, paginate, createComment };
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
  it("happy path: reviews a small diff and posts exactly one comment; workspace is cleaned up", async () => {
    const { octokit, get, createComment } = fakeOctokit({
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

    expect(createComment).toHaveBeenCalledTimes(1);
    const body = createComment.mock.calls[0][0].body as string;
    expect(body).toContain(MAGPIE_REVIEW_MARKER);
    expect(body).toContain("Looks good, no issues found.");

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

  it("never logs or publishes the installation token", async () => {
    const { octokit, createComment } = fakeOctokit({
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

    const body = createComment.mock.calls[0][0].body as string;
    expect(body).not.toContain(FAKE_TOKEN);
  });
});
