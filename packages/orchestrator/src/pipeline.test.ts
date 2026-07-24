import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Octokit } from "@octokit/rest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "./config.js";
import { classifyJobOutcome, createReviewPipeline } from "./pipeline.js";
import { buildReviewedShaMarker, MAGPIE_REVIEW_MARKER } from "./publisher.js";
import type { JobDescriptor } from "./queue.js";
import type { GatewayKeyRevocation } from "./gateway.js";
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

// Default fake gateway lifecycle deps (M4-B) for the tests that aren't
// specifically about the key lifecycle: mint returns a fixed fake virtual key
// and revoke is a no-op, so the pipeline never reaches for the real gateway
// mgmt API over the network. The dedicated "gateway virtual-key lifecycle"
// describe block below injects its own spies instead to assert the calls.
const FAKE_GATEWAY_KEY = {
  id: "gw-key-fixture",
  key: "sk-magpie-fixture-should-never-leak",
  // M7-1 (Design D): opaque mount-source path for the `-v <socketDir>:/run/gw:ro`
  // bind mount reviewer.ts now adds — the fake docker below never actually
  // connects through it, so any non-empty string is fine here.
  socketDir: "/run/magpie-gateway/jobs/gw-key-fixture",
};
async function fakeMintGatewayKey(): Promise<{ id: string; key: string; socketDir: string }> {
  return FAKE_GATEWAY_KEY;
}
async function fakeRevokeGatewayKey(): Promise<void> {}

// Default fake bot-login resolver (M5-C hardening / task_948f): a fixed
// value so `readReviewState` (rereview.ts) always sees a real, non-empty
// `botLogin` to author-match against, and so runJob never reaches for the
// real GitHub App JWT auth flow / network (see github.ts's `getAppBotLogin`)
// during a test run — every `createReviewPipeline` call in this file injects
// this in place of the real default (`getAppBotLoginFromConfig`). The M5-C
// dedup/minimize fixtures below (`magpieIssueComment`/`magpieReview`) default
// their `user.login` to this exact value so they're recognized as Magpie's
// own by the new author-identity check.
const FAKE_BOT_LOGIN = "magpie-app[bot]";
async function fakeGetBotLogin(): Promise<string> {
  return FAKE_BOT_LOGIN;
}

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
 * NDJSON script body for a fake "docker" that emits one assistant review turn
 * AND "calls" the report_findings tool by writing a findings file into the
 * mounted `/out` dir — parsed from its own `-v <hostOut>:/out` argv, the same
 * channel M3's real container writes through (see reviewer.ts's M3 docker
 * invocation and reviewer.test.ts's `writeFakeDockerWithFindings`, which this
 * mirrors). The child never receives the real Pi extension since these are all
 * fake binaries, so simulating the file write is the only way an ok:true
 * `ReviewResult` (requiring `findings`/`verdict`) is reachable here. NOTE: in
 * M3 the pipeline's `piBinary` seam is spawned as `<dockerBin> run ...`, so
 * these scripts see the docker argv (not the old `MAGPIE_FINDINGS_PATH` env,
 * which reviewer.ts no longer sets — that path is baked into the image now).
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
    `const nodepath = require("path");`,
    `const argv = process.argv.slice(2);`,
    // Record the full "docker run" argv this fake was invoked with so tests
    // can assert on it afterwards (e.g. that pipeline.ts threaded job.id
    // through to reviewer.ts's `--name magpie-<jobId>` — see the
    // "threads the job id into the container name" test below), mirroring
    // reviewer.test.ts's `invocation.json` pattern.
    `fs.writeFileSync(${JSON.stringify(join(root, INVOCATION_FILE))}, JSON.stringify(argv));`,
    // Record the OPENROUTER_API_KEY value this fake saw in its own env, so
    // tests can assert the pipeline threaded the minted gateway virtual key
    // (not any other value) into the container — see reviewer.test.ts's
    // equivalent `openRouterKey` invocation field, mirrored here at the
    // pipeline level since this is the only place that observes what
    // pipeline.ts (not reviewer.ts directly) actually passed through.
    `fs.writeFileSync(${JSON.stringify(join(root, ENV_FILE))}, JSON.stringify({ openRouterKey: process.env.OPENROUTER_API_KEY ?? null }));`,
    `let outHost = "";`,
    `for (let i = 0; i < argv.length - 1; i++) {`,
    `  if (argv[i] === "-v" && argv[i + 1].endsWith(":/out")) outHost = argv[i + 1].slice(0, -5);`,
    `}`,
    `fs.writeFileSync(nodepath.join(outHost, "findings.json"), ${JSON.stringify(JSON.stringify(findings))});`,
    `process.stdout.write(JSON.stringify({type:"session",version:3,id:"t",timestamp:"",cwd:process.cwd()}) + "\\n");`,
    `const msg = ${JSON.stringify(msg)};`,
    `process.stdout.write(JSON.stringify({type:"message_end",message:msg}) + "\\n");`,
    `process.stdout.write(JSON.stringify({type:"agent_end",messages:[msg]}) + "\\n");`,
  ].join("\n");
}

/**
 * Like {@link fakePiScriptEmittingFindings} but ALSO records the full stdin
 * payload (the prompt reviewer.ts pipes to the container — PR metadata +
 * changed-file list + diff) to a file, so incremental-review tests can assert
 * exactly which diff/notice reached Pi. Emission of stdout is deferred to
 * stdin's `end` so the whole payload is captured first.
 */
function fakePiScriptCapturingStdin(text: string): string {
  const msg = {
    role: "assistant",
    content: [{ type: "text", text }],
    usage: { input: 10, output: 20, totalTokens: 30, cost: { total: 0.001 } },
  };
  const findings = { findings: [], summary: text, verdict: "comment" };
  return [
    `const fs = require("fs");`,
    `const nodepath = require("path");`,
    `const argv = process.argv.slice(2);`,
    `let outHost = "";`,
    `for (let i = 0; i < argv.length - 1; i++) {`,
    `  if (argv[i] === "-v" && argv[i + 1].endsWith(":/out")) outHost = argv[i + 1].slice(0, -5);`,
    `}`,
    `let stdinData = "";`,
    `process.stdin.setEncoding("utf-8");`,
    `process.stdin.on("data", (d) => { stdinData += d; });`,
    `process.stdin.on("end", () => {`,
    `  fs.writeFileSync(${JSON.stringify(join(root, STDIN_FILE))}, stdinData);`,
    `  fs.writeFileSync(nodepath.join(outHost, "findings.json"), ${JSON.stringify(JSON.stringify(findings))});`,
    `  process.stdout.write(JSON.stringify({type:"session",version:3,id:"t",timestamp:"",cwd:process.cwd()}) + "\\n");`,
    `  const msg = ${JSON.stringify(msg)};`,
    `  process.stdout.write(JSON.stringify({type:"message_end",message:msg}) + "\\n");`,
    `  process.stdout.write(JSON.stringify({type:"agent_end",messages:[msg]}) + "\\n");`,
    `});`,
  ].join("\n");
}

/** Name of the file `fakePiScriptCapturingStdin` records the stdin payload to, under `root`. */
const STDIN_FILE = "stdin.txt";

/** Reads back the stdin payload the fake docker script captured, or `undefined` if it never ran. */
function readRecordedStdin(): string | undefined {
  const path = join(root, STDIN_FILE);
  if (!existsSync(path)) return undefined;
  return readFileSync(path, "utf-8");
}

/** Name of the file the fake docker script (see `fakePiScriptEmittingFindings`) records its argv to, under `root`. */
const INVOCATION_FILE = "invocation.json";

/** Name of the file the fake docker script records its observed env to, under `root` (see `readRecordedEnv`). */
const ENV_FILE = "env.json";

/** Reads back the `docker run` argv the fake docker script recorded, or `undefined` if it never ran. */
function readRecordedArgv(): string[] | undefined {
  const path = join(root, INVOCATION_FILE);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf-8")) as string[];
}

/** Reads back the `OPENROUTER_API_KEY` value the fake docker script observed in its own env, or `undefined` if it never ran. */
function readRecordedEnv(): { openRouterKey: string | null } | undefined {
  const path = join(root, ENV_FILE);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf-8")) as { openRouterKey: string | null };
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
    },
    gateway: {
      baseUrl: "http://127.0.0.1:4100",
      containerBaseUrl: "http://127.0.0.1:4000/v1",
      perJobBudgetUsd: 0.5,
      ttlMarginSeconds: 120,
    },
    telemetry: { path: "/tmp/magpie-telemetry-test.jsonl" },
    secrets: {
      webhookSecret: "test-webhook-secret",
      githubPrivateKey: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n",
      gatewayMasterKey: "test-gateway-master-key",
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

/** Author fields the M5-C author-identity check reads (task_948f). */
interface FakeAuthor {
  login?: string | null;
  type?: string | null;
}
/** Fixture shape for M5-C's `rest.issues.listComments` surface. */
interface FakeIssueComment {
  node_id: string;
  body?: string | null;
  created_at: string;
  user?: FakeAuthor | null;
}
/** Fixture shape for M5-C's `rest.pulls.listReviews` surface. */
interface FakeReview {
  id: number;
  node_id: string;
  body?: string | null;
  submitted_at?: string | null;
  user?: FakeAuthor | null;
}
/** Fixture shape for M5-C's `rest.pulls.listReviewComments` surface. */
interface FakeReviewComment {
  node_id: string;
  pull_request_review_id?: number | null;
  created_at?: string;
}

/**
 * Builds a fake Octokit exposing exactly the surface the pipeline touches:
 * `rest.pulls.get` (called twice with different args — once for PR metadata
 * (now also carrying `head.sha`, used by the HEAD VERIFY race check — see
 * pipeline.ts), once by diff.ts with `mediaType: { format: "diff" }`),
 * `rest.pulls.listFiles` + `paginate` (diff.ts's file listing),
 * `issues.createComment` (publisher.ts), and — for M5-C's `readReviewState`/
 * `minimizeOutdated` (rereview.ts) — `rest.issues.listComments`,
 * `rest.pulls.listReviews`, `rest.pulls.listReviewComments`, and `graphql`.
 * Mirrors diff.test.ts's / publisher.test.ts's fake-Octokit pattern.
 *
 * `head.sha` defaults to `"deadbeef"` — the same default `testJob()` uses for
 * `headSha` — so every existing test gets a MATCHING head unless it opts into
 * a mismatch via `opts.head`.
 *
 * `paginate` dispatches on the FUNCTION IDENTITY of its first argument
 * (exactly like the real `octokit.paginate(fn, params)` API — see diff.ts's
 * `listPrChangedFiles`), so a single fake `paginate` can serve `listFiles`,
 * `listComments`, `listReviews`, and `listReviewComments` distinctly.
 */
function fakeOctokit(opts: {
  title: string;
  body: string | null;
  files: FakeFile[];
  diffText: string;
  head?: { sha: string };
  /**
   * Optional compare-API surface for incremental-review tests (M5-B). When set,
   * `rest.repos.compareCommitsWithBasehead` resolves to `{ status, files }` for
   * metadata calls and `compareDiffText` for the `format: "diff"` call, or
   * throws `compareError` to simulate a 404/API failure.
   */
  compare?: { status?: string; files?: FakeFile[]; compareDiffText?: string; compareError?: unknown };
  /**
   * Optional prior-review-state fixture for M5-C's dedup/minimize tests.
   * Defaults to no prior magpie activity at all (empty everything).
   */
  reviewState?: {
    issueComments?: FakeIssueComment[];
    reviews?: FakeReview[];
    reviewComments?: FakeReviewComment[];
  };
  /**
   * Override the fake `graphql`'s behavior (e.g. to simulate a minimize
   * failure). Defaults to resolving every call.
   */
  graphqlImpl?: (query: string, vars?: Record<string, unknown>) => Promise<unknown>;
}) {
  const listFiles = vi.fn();
  const listComments = vi.fn();
  const listReviews = vi.fn();
  const listReviewComments = vi.fn();
  const paginate = vi.fn(async (fn: unknown) => {
    if (fn === listFiles) return opts.files;
    if (fn === listComments) return opts.reviewState?.issueComments ?? [];
    if (fn === listReviews) return opts.reviewState?.reviews ?? [];
    if (fn === listReviewComments) return opts.reviewState?.reviewComments ?? [];
    return [];
  });
  const head = opts.head ?? { sha: "deadbeef" };
  const get = vi.fn(async (args: { mediaType?: { format: string } }) => {
    if (args?.mediaType?.format === "diff") {
      return { data: opts.diffText };
    }
    return { data: { title: opts.title, body: opts.body, head } };
  });
  const compareCommitsWithBasehead = vi.fn(
    async (args: { basehead: string; mediaType?: { format: string } }) => {
      const c = opts.compare ?? {};
      if (c.compareError !== undefined) throw c.compareError;
      if (args?.mediaType?.format === "diff") {
        return { data: c.compareDiffText ?? "" };
      }
      return { data: { status: c.status, files: c.files } };
    },
  );
  const createComment = vi.fn(async (_args: { owner: string; repo: string; issue_number: number; body: string }) => ({
    data: { id: 42, html_url: "https://github.com/acme/widgets/pull/7#issuecomment-42" },
  }));
  const createReview = vi.fn(async (_args: unknown) => ({
    data: { id: 43, html_url: "https://github.com/acme/widgets/pull/7#pullrequestreview-43" },
  }));
  const graphql = vi.fn(opts.graphqlImpl ?? (async () => ({})));

  const octokit = {
    paginate,
    rest: {
      pulls: { get, listFiles, listReviews, listReviewComments },
      repos: { compareCommitsWithBasehead },
      issues: { listComments },
    },
    issues: { createComment },
    pulls: { createReview },
    graphql,
  };

  return {
    octokit,
    get,
    listFiles,
    paginate,
    compareCommitsWithBasehead,
    createComment,
    createReview,
    listComments,
    listReviews,
    listReviewComments,
    graphql,
  };
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
      mintGatewayKey: fakeMintGatewayKey,
      revokeGatewayKey: fakeRevokeGatewayKey,
      getBotLogin: fakeGetBotLogin,
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

  it("threads the queue's job id into the reviewer's container name (--name magpie-<jobId>)", async () => {
    // M3-D: pipeline.ts must pass `jobId: job.id` through to runReview so
    // reviewer.ts's `buildContainerName` derives `magpie-<jobId>` (see
    // reviewer.ts) rather than a fresh random id per run — otherwise the
    // queue's `AbortController` -> reviewer.ts's `docker kill` path (already
    // proven at the reviewer.ts unit level in reviewer.test.ts) couldn't be
    // told which container name to target from outside runReview. Asserted
    // here via the fake docker's recorded argv (see `readRecordedArgv`)
    // rather than re-testing the kill mechanics themselves, which belong to
    // reviewer.test.ts.
    const { octokit } = fakeOctokit({
      title: "Add feature",
      body: "Some PR body",
      files: [{ filename: "src/a.ts", additions: 5, deletions: 1 }],
      diffText: "diff --git a/src/a.ts b/src/a.ts\n+hello\n",
    });
    const { factory } = fakeWorkspaceFactory();
    const piBinary = writeFakePi(fakePiScriptEmitting("Looks good, no issues found."));
    const mintToken = vi.fn(async () => ({ token: FAKE_TOKEN }));

    const { runJob } = createReviewPipeline(testConfig(), {
      mintToken,
      mintGatewayKey: fakeMintGatewayKey,
      revokeGatewayKey: fakeRevokeGatewayKey,
      getBotLogin: fakeGetBotLogin,
      makeOctokit: () => octokit as unknown as Octokit,
      createWorkspace: factory,
      piBinary,
    });

    await runJob(testJob({ id: "job-e2e-42" }), new AbortController().signal);

    const argv = readRecordedArgv();
    expect(argv).toBeDefined();
    const nameIdx = argv!.indexOf("--name");
    expect(nameIdx).toBeGreaterThanOrEqual(0);
    expect(argv![nameIdx + 1]).toBe("magpie-job-e2e-42");
  });

  it("threads the minted gateway key's socketDir into the reviewer's --network none /run/gw mount (M7-1, Design D)", async () => {
    // gateway.ts's mintGatewayKeyFromConfig now returns `socketDir` alongside
    // `id`/`key` (M7-1 — see gateway.ts's `GatewayKey` doc comment), and
    // pipeline.ts must thread it into reviewer.ts's `runReview` as
    // `gatewaySocketDir`, which reviewer.ts bind-mounts read-only at
    // `/run/gw` on a container that now runs `--network none` instead of the
    // old bridge network — see reviewer.test.ts for the reviewer.ts-level
    // unit coverage of the mount/flag themselves; this asserts pipeline.ts
    // actually threads the value through end to end.
    const { octokit } = fakeOctokit({
      title: "Add feature",
      body: "Some PR body",
      files: [{ filename: "src/a.ts", additions: 5, deletions: 1 }],
      diffText: "diff --git a/src/a.ts b/src/a.ts\n+hello\n",
    });
    const { factory } = fakeWorkspaceFactory();
    const piBinary = writeFakePi(fakePiScriptEmitting("Looks good, no issues found."));
    const mintToken = vi.fn(async () => ({ token: FAKE_TOKEN }));

    const { runJob } = createReviewPipeline(testConfig(), {
      mintToken,
      mintGatewayKey: fakeMintGatewayKey,
      revokeGatewayKey: fakeRevokeGatewayKey,
      getBotLogin: fakeGetBotLogin,
      makeOctokit: () => octokit as unknown as Octokit,
      createWorkspace: factory,
      piBinary,
    });

    await runJob(testJob(), new AbortController().signal);

    const argv = readRecordedArgv();
    expect(argv).toBeDefined();
    expect(argv).toContain(`${FAKE_GATEWAY_KEY.socketDir}:/run/gw:ro`);
    const netIdx = argv!.indexOf("--network");
    expect(netIdx).toBeGreaterThanOrEqual(0);
    expect(argv![netIdx + 1]).toBe("none");
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
      mintGatewayKey: fakeMintGatewayKey,
      revokeGatewayKey: fakeRevokeGatewayKey,
      getBotLogin: fakeGetBotLogin,
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
      mintGatewayKey: fakeMintGatewayKey,
      revokeGatewayKey: fakeRevokeGatewayKey,
      getBotLogin: fakeGetBotLogin,
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
      mintGatewayKey: fakeMintGatewayKey,
      revokeGatewayKey: fakeRevokeGatewayKey,
      getBotLogin: fakeGetBotLogin,
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
      mintGatewayKey: fakeMintGatewayKey,
      revokeGatewayKey: fakeRevokeGatewayKey,
      getBotLogin: fakeGetBotLogin,
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
        mintGatewayKey: fakeMintGatewayKey,
        revokeGatewayKey: fakeRevokeGatewayKey,
        getBotLogin: fakeGetBotLogin,
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
        mintGatewayKey: fakeMintGatewayKey,
        revokeGatewayKey: fakeRevokeGatewayKey,
        getBotLogin: fakeGetBotLogin,
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
        mintGatewayKey: fakeMintGatewayKey,
        revokeGatewayKey: fakeRevokeGatewayKey,
        getBotLogin: fakeGetBotLogin,
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
        mintGatewayKey: fakeMintGatewayKey,
        revokeGatewayKey: fakeRevokeGatewayKey,
        getBotLogin: fakeGetBotLogin,
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
          // In M3 this seam is spawned as `<dockerBin> run ...`, and on abort
          // reviewer.ts additionally spawns `<dockerBin> kill <name>` — handle
          // that subcommand by exiting immediately so no fake process lingers.
          `if (process.argv[2] === "kill") process.exit(0);`,
          `process.stdout.write(JSON.stringify({type:"session",version:3,id:"t",timestamp:"",cwd:process.cwd()}) + "\\n");`,
          `setTimeout(() => {}, 60000);`,
        ].join("\n"),
      );

      const { runJob } = createReviewPipeline(testConfig(), {
        mintToken,
        mintGatewayKey: fakeMintGatewayKey,
        revokeGatewayKey: fakeRevokeGatewayKey,
        getBotLogin: fakeGetBotLogin,
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
          mintGatewayKey: fakeMintGatewayKey,
          revokeGatewayKey: fakeRevokeGatewayKey,
          getBotLogin: fakeGetBotLogin,
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
          mintGatewayKey: fakeMintGatewayKey,
          revokeGatewayKey: fakeRevokeGatewayKey,
          getBotLogin: fakeGetBotLogin,
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
          mintGatewayKey: fakeMintGatewayKey,
          revokeGatewayKey: fakeRevokeGatewayKey,
          getBotLogin: fakeGetBotLogin,
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

// M4-B: the per-job gateway virtual-key lifecycle. These inject spy
// mint/revoke deps (rather than the default fakes above) to assert the
// pipeline mints one key per job and revokes it — by the id mint returned —
// on every exit path, best-effort.
describe("gateway virtual-key lifecycle (M4-B)", () => {
  /** Spy mint/revoke deps that record the minted key and every revoke id. */
  function gatewaySpies() {
    const minted = {
      id: "gw-live-key-id",
      key: "sk-magpie-live-should-never-leak",
      socketDir: "/run/magpie-gateway/jobs/gw-live-key-id",
    };
    const revokedIds: string[] = [];
    const mintGatewayKey = vi.fn(async (_config: Config, _jobId: string) => minted);
    const revokeGatewayKey = vi.fn(async (_config: Config, id: string) => {
      revokedIds.push(id);
    });
    return { minted, revokedIds, mintGatewayKey, revokeGatewayKey };
  }

  it("mints one key and revokes it by id on the happy path", async () => {
    const { octokit } = fakeOctokit({
      title: "Add feature",
      body: "Some PR body",
      files: [{ filename: "src/a.ts", additions: 5, deletions: 1 }],
      diffText: "diff --git a/src/a.ts b/src/a.ts\n+hello\n",
    });
    const { factory } = fakeWorkspaceFactory();
    const piBinary = writeFakePi(fakePiScriptEmitting("All good."));
    const mintToken = vi.fn(async () => ({ token: FAKE_TOKEN }));
    const { minted, revokedIds, mintGatewayKey, revokeGatewayKey } = gatewaySpies();

    const { runJob } = createReviewPipeline(testConfig(), {
      mintToken,
      mintGatewayKey,
      revokeGatewayKey,
      getBotLogin: fakeGetBotLogin,
      makeOctokit: () => octokit as unknown as Octokit,
      createWorkspace: factory,
      piBinary,
    });

    await runJob(testJob(), new AbortController().signal);

    expect(mintGatewayKey).toHaveBeenCalledTimes(1);
    expect(revokeGatewayKey).toHaveBeenCalledTimes(1);
    expect(revokedIds).toEqual([minted.id]);
  });

  it("threads the minted virtual key into the container's OPENROUTER_API_KEY env (M4-C)", async () => {
    // Not just "a key" flows through: the SPECIFIC minted virtual key from
    // step 2a (gatewaySpies()'s `minted.key`) must reach the container's env
    // verbatim — see reviewer.ts's `RunReviewParams.gatewayApiKey` wiring and
    // pipeline.ts's `gatewayApiKey: gatewayKey.key` call site.
    const { octokit } = fakeOctokit({
      title: "Add feature",
      body: "Some PR body",
      files: [{ filename: "src/a.ts", additions: 5, deletions: 1 }],
      diffText: "diff --git a/src/a.ts b/src/a.ts\n+hello\n",
    });
    const { factory } = fakeWorkspaceFactory();
    const piBinary = writeFakePi(fakePiScriptEmitting("All good."));
    const mintToken = vi.fn(async () => ({ token: FAKE_TOKEN }));
    const { minted, mintGatewayKey, revokeGatewayKey } = gatewaySpies();

    const { runJob } = createReviewPipeline(testConfig(), {
      mintToken,
      mintGatewayKey,
      revokeGatewayKey,
      getBotLogin: fakeGetBotLogin,
      makeOctokit: () => octokit as unknown as Octokit,
      createWorkspace: factory,
      piBinary,
    });

    await runJob(testJob(), new AbortController().signal);

    expect(readRecordedEnv()).toEqual({ openRouterKey: minted.key });
  });

  it("revokes the key even when the review fails (failure path)", async () => {
    const { octokit, createComment } = fakeOctokit({
      title: "Add feature",
      body: "Some PR body",
      files: [{ filename: "src/a.ts", additions: 5, deletions: 1 }],
      diffText: "diff --git a/src/a.ts b/src/a.ts\n+hello\n",
    });
    const { factory } = fakeWorkspaceFactory();
    const piBinary = writeFakePi(fakePiScriptFailing());
    const mintToken = vi.fn(async () => ({ token: FAKE_TOKEN }));
    const { minted, revokedIds, mintGatewayKey, revokeGatewayKey } = gatewaySpies();

    const { runJob } = createReviewPipeline(testConfig(), {
      mintToken,
      mintGatewayKey,
      revokeGatewayKey,
      getBotLogin: fakeGetBotLogin,
      makeOctokit: () => octokit as unknown as Octokit,
      createWorkspace: factory,
      piBinary,
    });

    await runJob(testJob(), new AbortController().signal);

    // The review failed and still posted its failure comment...
    expect(createComment).toHaveBeenCalledTimes(1);
    // ...and the key was still revoked.
    expect(revokeGatewayKey).toHaveBeenCalledTimes(1);
    expect(revokedIds).toEqual([minted.id]);
  });

  it("revokes the key when a post-mint stage throws (workspace/diff error path)", async () => {
    // A workspace factory that throws simulates a failure after the gateway
    // key is minted but before the inner workspace try is entered — the outer
    // finally must still revoke the key.
    const throwingWorkspace = async (): Promise<never> => {
      throw new Error("clone failed");
    };
    const { octokit } = fakeOctokit({ title: "x", body: "", files: [], diffText: "" });
    const mintToken = vi.fn(async () => ({ token: FAKE_TOKEN }));
    const { minted, revokedIds, mintGatewayKey, revokeGatewayKey } = gatewaySpies();

    const { runJob } = createReviewPipeline(testConfig(), {
      mintToken,
      mintGatewayKey,
      revokeGatewayKey,
      getBotLogin: fakeGetBotLogin,
      makeOctokit: () => octokit as unknown as Octokit,
      createWorkspace: throwingWorkspace,
    });

    await expect(runJob(testJob(), new AbortController().signal)).rejects.toThrow(/clone failed/);

    expect(mintGatewayKey).toHaveBeenCalledTimes(1);
    expect(revokedIds).toEqual([minted.id]);
  });

  it("revokes the key on the abort/timeout path (runReview resolves aborted)", async () => {
    const { octokit, createComment } = fakeOctokit({
      title: "Add feature",
      body: "Some PR body",
      files: [{ filename: "src/a.ts", additions: 5, deletions: 1 }],
      diffText: "diff --git a/src/a.ts b/src/a.ts\n+hello\n",
    });
    const { factory } = fakeWorkspaceFactory();
    const controller = new AbortController();
    // Fake docker that hangs until killed, so the abort is observed mid-review
    // (mirrors the AbortSignal test above); on the `kill` subcommand it exits.
    const piBinary = writeFakePi(
      [
        `if (process.argv[2] === "kill") process.exit(0);`,
        `process.stdout.write(JSON.stringify({type:"session",version:3,id:"t",timestamp:"",cwd:process.cwd()}) + "\\n");`,
        `setTimeout(() => {}, 60000);`,
      ].join("\n"),
    );
    const mintToken = vi.fn(async () => ({ token: FAKE_TOKEN }));
    const { minted, revokedIds, mintGatewayKey, revokeGatewayKey } = gatewaySpies();

    const { runJob } = createReviewPipeline(testConfig(), {
      mintToken,
      mintGatewayKey,
      revokeGatewayKey,
      getBotLogin: fakeGetBotLogin,
      makeOctokit: () => octokit as unknown as Octokit,
      createWorkspace: factory,
      piBinary,
    });

    const jobPromise = runJob(testJob(), controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    await jobPromise;

    expect(createComment).not.toHaveBeenCalled();
    expect(revokeGatewayKey).toHaveBeenCalledTimes(1);
    expect(revokedIds).toEqual([minted.id]);
  });

  it("does not mint a key when the job is rejected for a missing installationId", async () => {
    const { octokit } = fakeOctokit({ title: "x", body: "", files: [], diffText: "" });
    const { factory } = fakeWorkspaceFactory();
    const mintToken = vi.fn(async () => ({ token: FAKE_TOKEN }));
    const { mintGatewayKey, revokeGatewayKey } = gatewaySpies();

    const { runJob } = createReviewPipeline(testConfig(), {
      mintToken,
      mintGatewayKey,
      revokeGatewayKey,
      getBotLogin: fakeGetBotLogin,
      makeOctokit: () => octokit as unknown as Octokit,
      createWorkspace: factory,
    });

    await expect(runJob(testJob({ installationId: undefined }), new AbortController().signal)).rejects.toThrow();

    expect(mintGatewayKey).not.toHaveBeenCalled();
    expect(revokeGatewayKey).not.toHaveBeenCalled();
  });

  it("a gateway mint failure fails the job before any workspace is created", async () => {
    const { octokit, createComment } = fakeOctokit({ title: "x", body: "", files: [], diffText: "" });
    const { factory, createCalls } = fakeWorkspaceFactory();
    const mintToken = vi.fn(async () => ({ token: FAKE_TOKEN }));
    const mintGatewayKey = vi.fn(async () => {
      throw new Error("gateway unreachable");
    });
    const revokeGatewayKey = vi.fn(async () => {});

    const { runJob } = createReviewPipeline(testConfig(), {
      mintToken,
      mintGatewayKey,
      revokeGatewayKey,
      getBotLogin: fakeGetBotLogin,
      makeOctokit: () => octokit as unknown as Octokit,
      createWorkspace: factory,
    });

    await expect(runJob(testJob(), new AbortController().signal)).rejects.toThrow(/gateway unreachable/);

    // No key was allocated, so nothing to revoke; and we never got as far as
    // cloning or publishing.
    expect(revokeGatewayKey).not.toHaveBeenCalled();
    expect(createCalls).toHaveLength(0);
    expect(createComment).not.toHaveBeenCalled();
  });
});

/** A PipelineLogger that records every event payload for assertions. */
function capturingLogger() {
  const events: Record<string, unknown>[] = [];
  const logger = {
    info: (p: Record<string, unknown>) => events.push(p),
    error: (p: Record<string, unknown>) => events.push(p),
  };
  return { logger, events };
}

// M5-D (task_8a10): per-job cost/outcome telemetry. These drive the whole
// pipeline (as elsewhere in this file) and assert that EXACTLY ONE
// `event: "job-telemetry"` record is emitted per job, on both success and
// failure/kill paths, carrying the outcome, duration, Pi's usage, and the
// gateway's authoritative final spend (when a key was minted). The telemetry
// path is pointed at a temp file under `root` so the durable JSONL sink is
// also exercised without touching a real /var/lib/magpie.
describe("per-job cost telemetry (M5-D)", () => {
  /** testConfig() with the telemetry JSONL sink redirected under `root`. */
  function telemetryConfig(): Config {
    const config = testConfig();
    return { ...config, telemetry: { path: join(root, "telemetry.jsonl") } };
  }

  /** The single `job-telemetry` record from a capturing logger's events (fails if not exactly one). */
  function soleTelemetryRecord(events: Record<string, unknown>[]): Record<string, unknown> {
    const records = events.filter((e) => e.event === "job-telemetry");
    expect(records).toHaveLength(1);
    return records[0];
  }

  /** Spy mint/revoke deps where revoke resolves a caller-chosen final spend (M5-D). */
  function gatewaySpiesWithSpend(revocation: GatewayKeyRevocation | undefined) {
    const minted = {
      id: "gw-live-key-id",
      key: "sk-magpie-live-should-never-leak",
      socketDir: "/run/magpie-gateway/jobs/gw-live-key-id",
    };
    const mintGatewayKey = vi.fn(async (_config: Config, _jobId: string) => minted);
    const revokeGatewayKey = vi.fn(async (_config: Config, _id: string) => revocation);
    return { minted, mintGatewayKey, revokeGatewayKey };
  }

  it("emits one success record carrying the gateway's authoritative spend as costUsd", async () => {
    const { octokit } = fakeOctokit({
      title: "Add feature",
      body: "Some PR body",
      files: [{ filename: "src/a.ts", additions: 5, deletions: 1 }],
      diffText: "diff --git a/src/a.ts b/src/a.ts\n+hello\n",
    });
    const { factory } = fakeWorkspaceFactory();
    const piBinary = writeFakePi(fakePiScriptEmitting("All good."));
    const { logger, events } = capturingLogger();
    const { mintGatewayKey, revokeGatewayKey } = gatewaySpiesWithSpend({ spentUsd: 0.031, budgetUsd: 0.5 });

    const { runJob } = createReviewPipeline(telemetryConfig(), {
      mintToken: vi.fn(async () => ({ token: FAKE_TOKEN })),
      mintGatewayKey,
      revokeGatewayKey,
      getBotLogin: fakeGetBotLogin,
      makeOctokit: () => octokit as unknown as Octokit,
      createWorkspace: factory,
      piBinary,
      logger,
    });

    await runJob(testJob(), new AbortController().signal);

    const record = soleTelemetryRecord(events);
    expect(record).toMatchObject({
      outcome: "success",
      owner: "acme",
      repo: "widgets",
      prNumber: 7,
      headSha: "deadbeef",
      // Gateway's tracked spend (0.031), NOT Pi's self-reported cost (0.001).
      costUsd: 0.031,
      gateway: { keyId: "gw-live-key-id", spentUsd: 0.031, budgetUsd: 0.5 },
    });
    // Pi's self-reported usage is still carried alongside for cross-checking.
    expect(record.usage).toMatchObject({ costUsd: 0.001, totalTokens: 30 });
    expect(typeof record.durationMs).toBe("number");

    // The durable JSONL sink got the same single record.
    const lines = readFileSync(join(root, "telemetry.jsonl"), "utf-8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ event: "job-telemetry", outcome: "success", costUsd: 0.031 });
  });

  it("classifies a generic review failure as outcome:'error' and still emits one record", async () => {
    const { octokit, createComment } = fakeOctokit({
      title: "Add feature",
      body: "Some PR body",
      files: [{ filename: "src/a.ts", additions: 5, deletions: 1 }],
      diffText: "diff --git a/src/a.ts b/src/a.ts\n+hello\n",
    });
    const { factory } = fakeWorkspaceFactory();
    const piBinary = writeFakePi(fakePiScriptFailing());
    const { logger, events } = capturingLogger();
    const { mintGatewayKey, revokeGatewayKey } = gatewaySpiesWithSpend({ spentUsd: 0.0, budgetUsd: 0.5 });

    const { runJob } = createReviewPipeline(telemetryConfig(), {
      mintToken: vi.fn(async () => ({ token: FAKE_TOKEN })),
      mintGatewayKey,
      revokeGatewayKey,
      getBotLogin: fakeGetBotLogin,
      makeOctokit: () => octokit as unknown as Octokit,
      createWorkspace: factory,
      piBinary,
      logger,
    });

    await runJob(testJob(), new AbortController().signal);

    expect(createComment).toHaveBeenCalledTimes(1); // failure note still posted
    const record = soleTelemetryRecord(events);
    expect(record.outcome).toBe("error");
    expect(typeof record.reason).toBe("string");
  });

  it("reclassifies a failure as 'budget-exhausted' when the gateway's spend reached the budget", async () => {
    const { octokit } = fakeOctokit({
      title: "Add feature",
      body: "Some PR body",
      files: [{ filename: "src/a.ts", additions: 5, deletions: 1 }],
      diffText: "diff --git a/src/a.ts b/src/a.ts\n+hello\n",
    });
    const { factory } = fakeWorkspaceFactory();
    // A review that fails without ever writing findings (e.g. the 402 surfaced
    // to Pi as a failed model call) — the AUTHORITATIVE signal that it was a
    // budget kill is the gateway's own spend >= budget, not the error text.
    const piBinary = writeFakePi(fakePiScriptFailing());
    const { logger, events } = capturingLogger();
    const { mintGatewayKey, revokeGatewayKey } = gatewaySpiesWithSpend({ spentUsd: 0.5, budgetUsd: 0.5 });

    const { runJob } = createReviewPipeline(telemetryConfig(), {
      mintToken: vi.fn(async () => ({ token: FAKE_TOKEN })),
      mintGatewayKey,
      revokeGatewayKey,
      getBotLogin: fakeGetBotLogin,
      makeOctokit: () => octokit as unknown as Octokit,
      createWorkspace: factory,
      piBinary,
      logger,
    });

    await runJob(testJob(), new AbortController().signal);

    const record = soleTelemetryRecord(events);
    expect(record.outcome).toBe("budget-exhausted");
    expect(record.costUsd).toBe(0.5);
  });

  it("emits an 'already-reviewed' record (no gateway key minted) on the M5-C dedup no-op", async () => {
    const { octokit } = fakeOctokit({
      title: "x",
      body: "",
      files: [],
      diffText: "",
      // A prior Magpie review for this exact head SHA -> dedup skip.
      reviewState: {
        reviews: [
          magpieReview({
            id: 1,
            node_id: "PRR_1",
            body: `${MAGPIE_REVIEW_MARKER}${buildReviewedShaMarker("deadbeef")}\nAll good.`,
          }),
        ],
      },
    });
    const { factory } = fakeWorkspaceFactory();
    const { logger, events } = capturingLogger();
    const { mintGatewayKey, revokeGatewayKey } = gatewaySpiesWithSpend(undefined);

    const { runJob } = createReviewPipeline(telemetryConfig(), {
      mintToken: vi.fn(async () => ({ token: FAKE_TOKEN })),
      mintGatewayKey,
      revokeGatewayKey,
      getBotLogin: fakeGetBotLogin,
      makeOctokit: () => octokit as unknown as Octokit,
      createWorkspace: factory,
      logger,
    });

    await runJob(testJob(), new AbortController().signal);

    expect(mintGatewayKey).not.toHaveBeenCalled();
    const record = soleTelemetryRecord(events);
    expect(record.outcome).toBe("already-reviewed");
    expect(record.costUsd).toBe(0);
    expect(record.gateway).toBeUndefined();
  });

  it("still emits exactly one record when a post-mint stage throws (outcome:'error')", async () => {
    const throwingWorkspace = async (): Promise<never> => {
      throw new Error("clone failed");
    };
    const { octokit } = fakeOctokit({ title: "x", body: "", files: [], diffText: "" });
    const { logger, events } = capturingLogger();
    const { mintGatewayKey, revokeGatewayKey } = gatewaySpiesWithSpend({ spentUsd: 0, budgetUsd: 0.5 });

    const { runJob } = createReviewPipeline(telemetryConfig(), {
      mintToken: vi.fn(async () => ({ token: FAKE_TOKEN })),
      mintGatewayKey,
      revokeGatewayKey,
      getBotLogin: fakeGetBotLogin,
      makeOctokit: () => octokit as unknown as Octokit,
      createWorkspace: throwingWorkspace,
      logger,
    });

    await expect(runJob(testJob(), new AbortController().signal)).rejects.toThrow(/clone failed/);

    const record = soleTelemetryRecord(events);
    expect(record.outcome).toBe("error");
    expect(record.reason).toMatch(/clone failed/);
  });

  it("records a throw AFTER a successful review as outcome:'error' (a failed publish must not read as 'success')", async () => {
    const { octokit, createReview, createComment } = fakeOctokit({
      title: "Add feature",
      body: "Some PR body",
      files: [{ filename: "src/a.ts", additions: 5, deletions: 1 }],
      diffText: "diff --git a/src/a.ts b/src/a.ts\n+hello\n",
    });
    // The review runs and succeeds, but publishing it to GitHub fails — a
    // real, common failure (rate limit, 422, network). publishReviewWithFindings
    // has a two-level fallback (createReview retry, then issues.createComment),
    // so reject all three to model an unusable publish path. The job must throw
    // (so the queue marks it failed) AND telemetry must record 'error', not
    // 'success', even though a valid {ok:true} reviewResult was captured.
    createReview.mockRejectedValue(new Error("publish boom: 422"));
    createComment.mockRejectedValue(new Error("publish boom: 422"));
    const { factory } = fakeWorkspaceFactory();
    const piBinary = writeFakePi(fakePiScriptEmitting("All good."));
    const { logger, events } = capturingLogger();
    const { mintGatewayKey, revokeGatewayKey } = gatewaySpiesWithSpend({ spentUsd: 0.031, budgetUsd: 0.5 });

    const { runJob } = createReviewPipeline(telemetryConfig(), {
      mintToken: vi.fn(async () => ({ token: FAKE_TOKEN })),
      mintGatewayKey,
      revokeGatewayKey,
      getBotLogin: fakeGetBotLogin,
      makeOctokit: () => octokit as unknown as Octokit,
      createWorkspace: factory,
      piBinary,
      logger,
    });

    await expect(runJob(testJob(), new AbortController().signal)).rejects.toThrow(/publish boom/);

    const record = soleTelemetryRecord(events);
    expect(record.outcome).toBe("error");
    // The proximate cause (the thrown publish error) is the reason, not a
    // stale review-success signal — and cost is still the gateway's spend.
    expect(record.reason).toMatch(/publish boom/);
    expect(record.costUsd).toBe(0.031);
  });
});

// classifyJobOutcome is pure/exported — cover every distinct outcome class
// directly (the pipeline tests above prove the wiring; these prove the mapping).
describe("classifyJobOutcome (M5-D)", () => {
  const okResult = { ok: true as const, summary: "s", findings: [], verdict: "comment" as const };
  const fail = (reason: string) => ({ ok: false as const, reason });

  it("earlyOutcome always wins", () => {
    expect(classifyJobOutcome({ earlyOutcome: "already-reviewed", diffTooLarge: false })).toBe("already-reviewed");
    expect(classifyJobOutcome({ earlyOutcome: "head-sha-mismatch", diffTooLarge: false })).toBe("head-sha-mismatch");
    expect(classifyJobOutcome({ earlyOutcome: "aborted", diffTooLarge: false })).toBe("aborted");
  });

  it("no review result and no early outcome -> error (a pre-review throw)", () => {
    expect(classifyJobOutcome({ diffTooLarge: false })).toBe("error");
  });

  it("ok result -> success, or diff-too-large when it's the synthesized skip", () => {
    expect(classifyJobOutcome({ reviewResult: okResult, diffTooLarge: false })).toBe("success");
    expect(classifyJobOutcome({ reviewResult: okResult, diffTooLarge: true })).toBe("diff-too-large");
  });

  it("a throw AFTER a successful review is 'error', never 'success' (e.g. publish failed)", () => {
    // reviewResult is captured before publish; if a later stage throws, the
    // job failed and must not be recorded as success/diff-too-large.
    expect(classifyJobOutcome({ reviewResult: okResult, diffTooLarge: false, threw: true })).toBe("error");
    expect(classifyJobOutcome({ reviewResult: okResult, diffTooLarge: true, threw: true })).toBe("error");
  });

  it("timeout and abort failure reasons are classified distinctly", () => {
    expect(classifyJobOutcome({ reviewResult: fail("timeout after 600s"), diffTooLarge: false })).toBe("timeout-kill");
    expect(classifyJobOutcome({ reviewResult: fail("aborted"), diffTooLarge: false })).toBe("aborted");
  });

  it("a generic failure is 'error', but 'budget-exhausted' when gateway spend >= budget", () => {
    expect(classifyJobOutcome({ reviewResult: fail("pi did not call report_findings"), diffTooLarge: false })).toBe(
      "error",
    );
    expect(
      classifyJobOutcome({
        reviewResult: fail("pi review failed: 402 budget exhausted for this key"),
        diffTooLarge: false,
        gatewaySpend: { keyId: "k", spentUsd: 0.5, budgetUsd: 0.5 },
      }),
    ).toBe("budget-exhausted");
  });

  it("a timeout still classifies as timeout-kill even if spend reached budget (kill reason wins over budget)", () => {
    expect(
      classifyJobOutcome({
        reviewResult: fail("timeout after 600s"),
        diffTooLarge: false,
        gatewaySpend: { keyId: "k", spentUsd: 0.5, budgetUsd: 0.5 },
      }),
    ).toBe("timeout-kill");
  });
});

describe("createReviewPipeline / runJob — incremental re-review (M5-B)", () => {
  const AFTER = "deadbeef"; // matches testJob().headSha, so HEAD VERIFY passes
  const BEFORE = "b".repeat(40);

  it("synchronize: sends only the before...after range to Pi with the full-PR file list as context", async () => {
    const incrementalDiff = "diff --git a/src/new.ts b/src/new.ts\n+brand new line\n";
    const { octokit, get, compareCommitsWithBasehead } = fakeOctokit({
      title: "Add feature",
      body: "body",
      // Full-PR file list (listPrChangedFiles) — larger than the incremental set.
      files: [
        { filename: "src/old.ts", additions: 5, deletions: 0 },
        { filename: "src/new.ts", additions: 1, deletions: 0 },
      ],
      diffText: "diff --git a/WHOLE b/WHOLE\n+should NOT be sent\n",
      compare: {
        status: "ahead",
        files: [{ filename: "src/new.ts", additions: 1, deletions: 0 }],
        compareDiffText: incrementalDiff,
      },
    });
    const { factory } = fakeWorkspaceFactory();
    const piBinary = writeFakePi(fakePiScriptCapturingStdin("Reviewed the new changes."));
    const { logger, events } = capturingLogger();

    const { runJob } = createReviewPipeline(testConfig(), {
      mintToken: async () => ({ token: FAKE_TOKEN }),
      mintGatewayKey: fakeMintGatewayKey,
      revokeGatewayKey: fakeRevokeGatewayKey,
      getBotLogin: fakeGetBotLogin,
      makeOctokit: () => octokit as unknown as Octokit,
      createWorkspace: factory,
      piBinary,
      logger,
    });

    await runJob(testJob({ before: BEFORE, after: AFTER }), new AbortController().signal);

    // The incremental range was resolved via the compare API...
    expect(compareCommitsWithBasehead).toHaveBeenCalledWith(
      expect.objectContaining({ basehead: `${BEFORE}...${AFTER}` }),
    );
    // ...and the full PR diff body was NEVER fetched (only the metadata get).
    const diffGets = get.mock.calls.filter((c) => c[0]?.mediaType?.format === "diff");
    expect(diffGets).toHaveLength(0);

    const stdin = readRecordedStdin();
    expect(stdin).toBeDefined();
    // Only the incremental range reached Pi, not the whole-PR diff.
    expect(stdin).toContain("brand new line");
    expect(stdin).not.toContain("should NOT be sent");
    // The whole-PR file list is still present as context.
    expect(stdin).toContain("src/old.ts");
    expect(stdin).toContain("src/new.ts");
    // And Pi is told this is an incremental update.
    expect(stdin).toMatch(/INCREMENTAL update/);

    expect(events).toContainEqual(expect.objectContaining({ event: "incremental-diff" }));
  });

  it("synchronize: falls back to the full PR diff when the range is not a fast-forward", async () => {
    const wholeDiff = "diff --git a/WHOLE b/WHOLE\n+full pr line\n";
    const { octokit, get, compareCommitsWithBasehead } = fakeOctokit({
      title: "Rebased",
      body: "body",
      files: [{ filename: "src/x.ts", additions: 2, deletions: 0 }],
      diffText: wholeDiff,
      compare: { status: "diverged", files: [{ filename: "src/x.ts", additions: 2, deletions: 0 }] },
    });
    const { factory } = fakeWorkspaceFactory();
    const piBinary = writeFakePi(fakePiScriptCapturingStdin("Reviewed the full PR."));
    const { logger, events } = capturingLogger();

    const { runJob } = createReviewPipeline(testConfig(), {
      mintToken: async () => ({ token: FAKE_TOKEN }),
      mintGatewayKey: fakeMintGatewayKey,
      revokeGatewayKey: fakeRevokeGatewayKey,
      getBotLogin: fakeGetBotLogin,
      makeOctokit: () => octokit as unknown as Octokit,
      createWorkspace: factory,
      piBinary,
      logger,
    });

    await runJob(testJob({ before: BEFORE, after: AFTER }), new AbortController().signal);

    // Compare was attempted (metadata only — diverged, so no diff fetch)...
    expect(compareCommitsWithBasehead).toHaveBeenCalledTimes(1);
    // ...and the full PR diff body WAS fetched as the fallback.
    const diffGets = get.mock.calls.filter((c) => c[0]?.mediaType?.format === "diff");
    expect(diffGets).toHaveLength(1);

    const stdin = readRecordedStdin();
    expect(stdin).toContain("full pr line");
    // Full review => no incremental notice.
    expect(stdin).not.toMatch(/INCREMENTAL update/);

    expect(events).toContainEqual(
      expect.objectContaining({ event: "incremental-diff-fallback", reason: expect.stringMatching(/not a fast-forward/) }),
    );
  });

  it("non-synchronize (no before/after): never touches the compare API", async () => {
    const { octokit, get, compareCommitsWithBasehead } = fakeOctokit({
      title: "Opened",
      body: "body",
      files: [{ filename: "src/x.ts", additions: 2, deletions: 0 }],
      diffText: "diff --git a/x b/x\n+line\n",
    });
    const { factory } = fakeWorkspaceFactory();
    const piBinary = writeFakePi(fakePiScriptCapturingStdin("Reviewed."));

    const { runJob } = createReviewPipeline(testConfig(), {
      mintToken: async () => ({ token: FAKE_TOKEN }),
      mintGatewayKey: fakeMintGatewayKey,
      revokeGatewayKey: fakeRevokeGatewayKey,
      getBotLogin: fakeGetBotLogin,
      makeOctokit: () => octokit as unknown as Octokit,
      createWorkspace: factory,
      piBinary,
    });

    await runJob(testJob(), new AbortController().signal);

    expect(compareCommitsWithBasehead).not.toHaveBeenCalled();
    const diffGets = get.mock.calls.filter((c) => c[0]?.mediaType?.format === "diff");
    expect(diffGets).toHaveLength(1);
    expect(readRecordedStdin()).not.toMatch(/INCREMENTAL update/);
  });

  it("synchronize: an over-cap incremental range posts a summary-only skip and skips the whole-PR file fetch", async () => {
    // testConfig()'s maxDiffLines is 100; a 150-line incremental range is over
    // the cap, so the range is tooLarge -> summary-only, and the whole-PR file
    // list (a paginated listFiles call) must NOT be fetched.
    const { octokit, listFiles, compareCommitsWithBasehead, createComment, createReview } = fakeOctokit({
      title: "Big push",
      body: "body",
      files: [{ filename: "src/x.ts", additions: 1, deletions: 0 }],
      diffText: "unused",
      compare: { status: "ahead", files: [{ filename: "src/big.ts", additions: 150, deletions: 0 }] },
    });
    const { factory } = fakeWorkspaceFactory();
    const piBinary = writeFakePi(fakePiScriptCapturingStdin("should not run"));

    const { runJob } = createReviewPipeline(testConfig(), {
      mintToken: async () => ({ token: FAKE_TOKEN }),
      mintGatewayKey: fakeMintGatewayKey,
      revokeGatewayKey: fakeRevokeGatewayKey,
      getBotLogin: fakeGetBotLogin,
      makeOctokit: () => octokit as unknown as Octokit,
      createWorkspace: factory,
      piBinary,
    });

    await runJob(testJob({ before: BEFORE, after: AFTER }), new AbortController().signal);

    // Only the compare metadata call (no diff body fetch for an over-cap range).
    expect(compareCommitsWithBasehead).toHaveBeenCalledTimes(1);
    // Efficiency: the whole-PR file list (paginated listFiles) is skipped when
    // the range is tooLarge — reviewChangedFiles is never read on that branch.
    // (`paginate` itself IS still called for M5-C's readReviewState — see the
    // dedicated dedup/minimize describe block below — so assert on the
    // specific `listFiles` fetcher, not on `paginate` having never run at all.)
    expect(listFiles).not.toHaveBeenCalled();
    // Pi never ran; a summary-only skip comment was posted (not a review).
    expect(readRecordedStdin()).toBeUndefined();
    expect(createReview).not.toHaveBeenCalled();
    expect(createComment).toHaveBeenCalledTimes(1);
    expect(createComment.mock.calls[0][0].body).toMatch(/pushed since the last review/);
  });
});

/** Fixture builder for a magpie-authored `issues.listComments` entry (M5-C). */
function magpieIssueComment(overrides: Partial<{
  node_id: string;
  body: string;
  created_at: string;
  user: FakeAuthor | null;
}> = {}) {
  return {
    node_id: "IC_default",
    body: `${MAGPIE_REVIEW_MARKER}\nMagpie could not complete a review of this PR.`,
    created_at: "2026-01-01T00:00:00Z",
    // Matches fakeGetBotLogin()'s FAKE_BOT_LOGIN — this fixture represents a
    // GENUINE Magpie comment (see task_948f's author-identity check).
    user: { login: FAKE_BOT_LOGIN, type: "Bot" },
    ...overrides,
  };
}

/** Fixture builder for a magpie-authored `pulls.listReviews` entry (M5-C). */
function magpieReview(overrides: Partial<{
  id: number;
  node_id: string;
  body: string;
  submitted_at: string;
  user: FakeAuthor | null;
}> = {}) {
  return {
    id: 1,
    node_id: "PRR_default",
    body: `${MAGPIE_REVIEW_MARKER}\nAll good.`,
    submitted_at: "2026-01-01T00:00:00Z",
    user: { login: FAKE_BOT_LOGIN, type: "Bot" },
    ...overrides,
  };
}

describe("createReviewPipeline / runJob — re-review dedup + comment minimization (M5-C)", () => {
  it("dedup skip: a redelivered webhook for an already-reviewed head SHA is a complete no-op (no gateway key, no clone, no publish)", async () => {
    // testJob()'s headSha defaults to "deadbeef" — the prior magpie review's
    // reviewed-sha marker matches it exactly, so this delivery must be a
    // true no-op: not just "skip publishing" but "skip everything after the
    // token mint", per the module doc comment's placement of the dedup check
    // before the gateway key mint / workspace clone.
    const { octokit, createComment, createReview } = fakeOctokit({
      title: "Add feature",
      body: "Some PR body",
      files: [{ filename: "src/a.ts", additions: 5, deletions: 1 }],
      diffText: "diff --git a/src/a.ts b/src/a.ts\n+hello\n",
      reviewState: {
        reviews: [
          magpieReview({
            id: 1,
            node_id: "PRR_1",
            body: `${MAGPIE_REVIEW_MARKER}${buildReviewedShaMarker("deadbeef")}\nAll good.`,
          }),
        ],
      },
    });
    const { factory, createCalls } = fakeWorkspaceFactory();
    const mintToken = vi.fn(async () => ({ token: FAKE_TOKEN }));
    const mintGatewayKey = vi.fn(fakeMintGatewayKey);
    const { logger, events } = capturingLogger();

    const { runJob } = createReviewPipeline(testConfig(), {
      mintToken,
      mintGatewayKey,
      revokeGatewayKey: fakeRevokeGatewayKey,
      getBotLogin: fakeGetBotLogin,
      makeOctokit: () => octokit as unknown as Octokit,
      createWorkspace: factory,
      logger,
    });

    await runJob(testJob(), new AbortController().signal);

    expect(mintGatewayKey).not.toHaveBeenCalled();
    expect(createCalls).toHaveLength(0);
    expect(createComment).not.toHaveBeenCalled();
    expect(createReview).not.toHaveBeenCalled();
    expect(events).toContainEqual(
      expect.objectContaining({ event: "already-reviewed", lastReviewedSha: "deadbeef" }),
    );
  });

  it("proceeds normally when the last-reviewed SHA differs from the current head SHA", async () => {
    const { octokit, createReview } = fakeOctokit({
      title: "Add feature",
      body: "Some PR body",
      files: [{ filename: "src/a.ts", additions: 5, deletions: 1 }],
      diffText: "diff --git a/src/a.ts b/src/a.ts\n+hello\n",
      reviewState: {
        reviews: [
          magpieReview({
            id: 1,
            node_id: "PRR_1",
            body: `${MAGPIE_REVIEW_MARKER}${buildReviewedShaMarker("some-older-sha")}\nAll good.`,
          }),
        ],
      },
    });
    const { factory } = fakeWorkspaceFactory();
    const piBinary = writeFakePi(fakePiScriptEmitting("Looks good."));
    const { logger, events } = capturingLogger();

    const { runJob } = createReviewPipeline(testConfig(), {
      mintToken: async () => ({ token: FAKE_TOKEN }),
      mintGatewayKey: fakeMintGatewayKey,
      revokeGatewayKey: fakeRevokeGatewayKey,
      getBotLogin: fakeGetBotLogin,
      makeOctokit: () => octokit as unknown as Octokit,
      createWorkspace: factory,
      piBinary,
      logger,
    });

    await runJob(testJob(), new AbortController().signal); // headSha "deadbeef" != "some-older-sha"

    expect(createReview).toHaveBeenCalledTimes(1);
    expect(events).not.toContainEqual(expect.objectContaining({ event: "already-reviewed" }));
  });

  it("proceeds normally (no dedup skip) when there is no prior magpie activity at all", async () => {
    const { octokit, createReview } = fakeOctokit({
      title: "Add feature",
      body: "Some PR body",
      files: [{ filename: "src/a.ts", additions: 5, deletions: 1 }],
      diffText: "diff --git a/src/a.ts b/src/a.ts\n+hello\n",
    });
    const { factory } = fakeWorkspaceFactory();
    const piBinary = writeFakePi(fakePiScriptEmitting("Looks good."));

    const { runJob } = createReviewPipeline(testConfig(), {
      mintToken: async () => ({ token: FAKE_TOKEN }),
      mintGatewayKey: fakeMintGatewayKey,
      revokeGatewayKey: fakeRevokeGatewayKey,
      getBotLogin: fakeGetBotLogin,
      makeOctokit: () => octokit as unknown as Octokit,
      createWorkspace: factory,
      piBinary,
    });

    await runJob(testJob(), new AbortController().signal);

    expect(createReview).toHaveBeenCalledTimes(1);
  });

  it("a review-state-read error is swallowed: the job proceeds (no skip) and does not crash", async () => {
    const { octokit, createReview } = fakeOctokit({
      title: "Add feature",
      body: "Some PR body",
      files: [{ filename: "src/a.ts", additions: 5, deletions: 1 }],
      diffText: "diff --git a/src/a.ts b/src/a.ts\n+hello\n",
    });
    // Break just the review-state read surface, independent of the diff.ts
    // `listFiles` paginate call — simulates a transient GitHub API error
    // while reading Magpie's prior comments/reviews.
    const brokenPaginate = vi.fn(async (fn: unknown, params: unknown) => {
      if (
        fn === octokit.rest.issues.listComments ||
        fn === octokit.rest.pulls.listReviews ||
        fn === octokit.rest.pulls.listReviewComments
      ) {
        throw new Error("GitHub API unavailable");
      }
      return octokit.paginate(fn as never, params as never);
    });
    const brokenOctokit = { ...octokit, paginate: brokenPaginate };

    const { factory } = fakeWorkspaceFactory();
    const piBinary = writeFakePi(fakePiScriptEmitting("Looks good."));
    const { logger, events } = capturingLogger();

    const { runJob } = createReviewPipeline(testConfig(), {
      mintToken: async () => ({ token: FAKE_TOKEN }),
      mintGatewayKey: fakeMintGatewayKey,
      revokeGatewayKey: fakeRevokeGatewayKey,
      getBotLogin: fakeGetBotLogin,
      makeOctokit: () => brokenOctokit as unknown as Octokit,
      createWorkspace: factory,
      piBinary,
      logger,
    });

    await expect(runJob(testJob(), new AbortController().signal)).resolves.toBeUndefined();

    expect(createReview).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual(expect.objectContaining({ event: "review-state-read-failed" }));
    expect(events).not.toContainEqual(expect.objectContaining({ event: "already-reviewed" }));
  });

  it("embeds the reviewed-sha marker on a successful review", async () => {
    const { octokit, createReview } = fakeOctokit({
      title: "Add feature",
      body: "Some PR body",
      files: [{ filename: "src/a.ts", additions: 5, deletions: 1 }],
      diffText: "diff --git a/src/a.ts b/src/a.ts\n+hello\n",
    });
    const { factory } = fakeWorkspaceFactory();
    const piBinary = writeFakePi(fakePiScriptEmitting("Looks good."));

    const { runJob } = createReviewPipeline(testConfig(), {
      mintToken: async () => ({ token: FAKE_TOKEN }),
      mintGatewayKey: fakeMintGatewayKey,
      revokeGatewayKey: fakeRevokeGatewayKey,
      getBotLogin: fakeGetBotLogin,
      makeOctokit: () => octokit as unknown as Octokit,
      createWorkspace: factory,
      piBinary,
    });

    await runJob(testJob(), new AbortController().signal);

    const body = createReview.mock.calls[0][0].body as string;
    expect(body).toContain(buildReviewedShaMarker("deadbeef"));
  });

  it("embeds the reviewed-sha marker on a too-large skip", async () => {
    const { octokit, createComment } = fakeOctokit({
      title: "Huge PR",
      body: null,
      files: [{ filename: "big.ts", additions: 500, deletions: 500 }],
      diffText: "should never be fetched",
    });
    const { factory } = fakeWorkspaceFactory();

    const { runJob } = createReviewPipeline(testConfig({ maxDiffLines: 100 }), {
      mintToken: async () => ({ token: FAKE_TOKEN }),
      mintGatewayKey: fakeMintGatewayKey,
      revokeGatewayKey: fakeRevokeGatewayKey,
      getBotLogin: fakeGetBotLogin,
      makeOctokit: () => octokit as unknown as Octokit,
      createWorkspace: factory,
    });

    await runJob(testJob(), new AbortController().signal);

    const body = createComment.mock.calls[0][0].body as string;
    expect(body).toContain(buildReviewedShaMarker("deadbeef"));
  });

  it("does NOT embed the reviewed-sha marker on a failed review", async () => {
    const { octokit, createComment } = fakeOctokit({
      title: "Add feature",
      body: "Some PR body",
      files: [{ filename: "src/a.ts", additions: 5, deletions: 1 }],
      diffText: "diff --git a/src/a.ts b/src/a.ts\n+hello\n",
    });
    const { factory } = fakeWorkspaceFactory();
    const piBinary = writeFakePi(fakePiScriptFailing());

    const { runJob } = createReviewPipeline(testConfig(), {
      mintToken: async () => ({ token: FAKE_TOKEN }),
      mintGatewayKey: fakeMintGatewayKey,
      revokeGatewayKey: fakeRevokeGatewayKey,
      getBotLogin: fakeGetBotLogin,
      makeOctokit: () => octokit as unknown as Octokit,
      createWorkspace: factory,
      piBinary,
    });

    await runJob(testJob(), new AbortController().signal);

    const body = createComment.mock.calls[0][0].body as string;
    expect(body).not.toContain("magpie:reviewed:");
  });

  it("minimizes prior minimizable nodes as OUTDATED after a successful publish, using the pre-publish snapshot (never the just-posted review)", async () => {
    // Prior state: a magpie review (id 5) whose OWN node_id must NEVER be
    // minimized (PullRequestReview isn't Minimizable), plus an inline review
    // comment attached to that review, which MUST be minimized.
    const { octokit, createReview, graphql } = fakeOctokit({
      title: "Add feature",
      body: "Some PR body",
      files: [{ filename: "src/a.ts", additions: 5, deletions: 1 }],
      diffText: "diff --git a/src/a.ts b/src/a.ts\n+hello\n",
      reviewState: {
        reviews: [
          magpieReview({
            id: 5,
            node_id: "PRR_OLD",
            body: `${MAGPIE_REVIEW_MARKER}${buildReviewedShaMarker("older-sha")}\nOlder review.`,
          }),
        ],
        reviewComments: [{ node_id: "PRRC_OLD", pull_request_review_id: 5, created_at: "2026-01-01T00:00:00Z" }],
      },
    });
    const { factory } = fakeWorkspaceFactory();
    const piBinary = writeFakePi(fakePiScriptEmitting("Looks good."));

    const { runJob } = createReviewPipeline(testConfig(), {
      mintToken: async () => ({ token: FAKE_TOKEN }),
      mintGatewayKey: fakeMintGatewayKey,
      revokeGatewayKey: fakeRevokeGatewayKey,
      getBotLogin: fakeGetBotLogin,
      makeOctokit: () => octokit as unknown as Octokit,
      createWorkspace: factory,
      piBinary,
    });

    await runJob(testJob(), new AbortController().signal); // headSha "deadbeef" != "older-sha" -> proceeds

    expect(createReview).toHaveBeenCalledTimes(1);
    expect(graphql).toHaveBeenCalledTimes(1);
    const [query, vars] = graphql.mock.calls[0] as [string, { subjectId: string }];
    expect(query).toContain("OUTDATED");
    expect(vars.subjectId).toBe("PRRC_OLD");
    // The prior review's OWN node_id is never targeted (not Minimizable).
    expect(graphql.mock.calls.map((c) => (c[1] as { subjectId: string }).subjectId)).not.toContain("PRR_OLD");
  });

  it("does NOT minimize anything when the review fails", async () => {
    const { octokit, createComment, graphql } = fakeOctokit({
      title: "Add feature",
      body: "Some PR body",
      files: [{ filename: "src/a.ts", additions: 5, deletions: 1 }],
      diffText: "diff --git a/src/a.ts b/src/a.ts\n+hello\n",
      reviewState: {
        issueComments: [magpieIssueComment({ node_id: "IC_OLD" })],
      },
    });
    const { factory } = fakeWorkspaceFactory();
    const piBinary = writeFakePi(fakePiScriptFailing());

    const { runJob } = createReviewPipeline(testConfig(), {
      mintToken: async () => ({ token: FAKE_TOKEN }),
      mintGatewayKey: fakeMintGatewayKey,
      revokeGatewayKey: fakeRevokeGatewayKey,
      getBotLogin: fakeGetBotLogin,
      makeOctokit: () => octokit as unknown as Octokit,
      createWorkspace: factory,
      piBinary,
    });

    await runJob(testJob(), new AbortController().signal);

    expect(createComment).toHaveBeenCalledTimes(1);
    expect(graphql).not.toHaveBeenCalled();
  });

  it("a GraphQL minimize error is swallowed — the job still reports a successful publish", async () => {
    const { octokit, createReview, graphql } = fakeOctokit({
      title: "Add feature",
      body: "Some PR body",
      files: [{ filename: "src/a.ts", additions: 5, deletions: 1 }],
      diffText: "diff --git a/src/a.ts b/src/a.ts\n+hello\n",
      reviewState: {
        issueComments: [magpieIssueComment({ node_id: "IC_OLD" })],
      },
      graphqlImpl: async () => {
        throw new Error("minimizeComment failed: insufficient permissions");
      },
    });
    const { factory, cleanupCalls } = fakeWorkspaceFactory();
    const piBinary = writeFakePi(fakePiScriptEmitting("Looks good."));
    const { logger, events } = capturingLogger();

    const { runJob } = createReviewPipeline(testConfig(), {
      mintToken: async () => ({ token: FAKE_TOKEN }),
      mintGatewayKey: fakeMintGatewayKey,
      revokeGatewayKey: fakeRevokeGatewayKey,
      getBotLogin: fakeGetBotLogin,
      makeOctokit: () => octokit as unknown as Octokit,
      createWorkspace: factory,
      piBinary,
      logger,
    });

    await expect(runJob(testJob(), new AbortController().signal)).resolves.toBeUndefined();

    // The review itself still published successfully...
    expect(createReview).toHaveBeenCalledTimes(1);
    expect(graphql).toHaveBeenCalledTimes(1);
    // ...and the minimize failure was only logged, never thrown.
    expect(events).toContainEqual(expect.objectContaining({ event: "minimize-outdated-failed", nodeId: "IC_OLD" }));
    expect(cleanupCalls).toHaveLength(1);
  });

  it("incremental base preference: uses lastReviewedSha instead of job.before when available", async () => {
    const LAST_REVIEWED = "c".repeat(40);
    const BEFORE = "b".repeat(40);
    const AFTER = "deadbeef"; // matches testJob().headSha, so HEAD VERIFY passes
    const incrementalDiff = "diff --git a/src/new.ts b/src/new.ts\n+brand new line\n";

    const { octokit, compareCommitsWithBasehead } = fakeOctokit({
      title: "Add feature",
      body: "body",
      files: [{ filename: "src/new.ts", additions: 1, deletions: 0 }],
      diffText: "diff --git a/WHOLE b/WHOLE\n+should NOT be sent\n",
      compare: {
        status: "ahead",
        files: [{ filename: "src/new.ts", additions: 1, deletions: 0 }],
        compareDiffText: incrementalDiff,
      },
      reviewState: {
        reviews: [
          magpieReview({
            id: 1,
            node_id: "PRR_1",
            body: `${MAGPIE_REVIEW_MARKER}${buildReviewedShaMarker(LAST_REVIEWED)}\nAll good.`,
          }),
        ],
      },
    });
    const { factory } = fakeWorkspaceFactory();
    const piBinary = writeFakePi(fakePiScriptCapturingStdin("Reviewed the new changes."));

    const { runJob } = createReviewPipeline(testConfig(), {
      mintToken: async () => ({ token: FAKE_TOKEN }),
      mintGatewayKey: fakeMintGatewayKey,
      revokeGatewayKey: fakeRevokeGatewayKey,
      getBotLogin: fakeGetBotLogin,
      makeOctokit: () => octokit as unknown as Octokit,
      createWorkspace: factory,
      piBinary,
    });

    await runJob(testJob({ before: BEFORE, after: AFTER }), new AbortController().signal);

    // The compare range used lastReviewedSha, NOT job.before.
    expect(compareCommitsWithBasehead).toHaveBeenCalledWith(
      expect.objectContaining({ basehead: `${LAST_REVIEWED}...${AFTER}` }),
    );
    expect(compareCommitsWithBasehead).not.toHaveBeenCalledWith(
      expect.objectContaining({ basehead: `${BEFORE}...${AFTER}` }),
    );
  });

  it("incremental base falls back to job.before when there is no lastReviewedSha", async () => {
    const BEFORE = "b".repeat(40);
    const AFTER = "deadbeef";
    const { octokit, compareCommitsWithBasehead } = fakeOctokit({
      title: "Add feature",
      body: "body",
      files: [{ filename: "src/new.ts", additions: 1, deletions: 0 }],
      diffText: "diff --git a/WHOLE b/WHOLE\n+should NOT be sent\n",
      compare: {
        status: "ahead",
        files: [{ filename: "src/new.ts", additions: 1, deletions: 0 }],
        compareDiffText: "diff --git a/src/new.ts b/src/new.ts\n+brand new line\n",
      },
    });
    const { factory } = fakeWorkspaceFactory();
    const piBinary = writeFakePi(fakePiScriptCapturingStdin("Reviewed."));

    const { runJob } = createReviewPipeline(testConfig(), {
      mintToken: async () => ({ token: FAKE_TOKEN }),
      mintGatewayKey: fakeMintGatewayKey,
      revokeGatewayKey: fakeRevokeGatewayKey,
      getBotLogin: fakeGetBotLogin,
      makeOctokit: () => octokit as unknown as Octokit,
      createWorkspace: factory,
      piBinary,
    });

    await runJob(testJob({ before: BEFORE, after: AFTER }), new AbortController().signal);

    expect(compareCommitsWithBasehead).toHaveBeenCalledWith(
      expect.objectContaining({ basehead: `${BEFORE}...${AFTER}` }),
    );
  });
});
