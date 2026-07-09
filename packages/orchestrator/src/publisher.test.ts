import { describe, expect, it, vi } from "vitest";
import type { ReviewResult, ReviewUsage } from "./reviewer.js";
import type { Finding, InlineComment } from "./anchor.js";
import {
  fenceReason,
  MAGPIE_REVIEW_MARKER,
  publishReview,
  publishReviewWithFindings,
  type MinimalIssuesClient,
} from "./publisher.js";

// NOTE: fully offline — no real Octokit, no network. `MinimalIssuesClient` is
// the test seam (see publisher.ts's doc comment): a bare `vi.fn()` fake
// stands in for the real, already-authenticated client that production code
// gets from github.ts's `createInstallationOctokit`.

const FAKE_TOKEN = "ghs_super-secret-installation-token-should-never-appear";

/**
 * Builds a fake client whose createComment/createReview resolve with canned
 * id/urls. `createReview` defaults to succeeding; individual tests override
 * `client.pulls.createReview` (via `createReview.mockImplementationOnce` /
 * `.mockRejectedValueOnce`) to exercise the 422-retry / double-failure paths.
 */
function fakeClient(): {
  client: MinimalIssuesClient;
  createComment: ReturnType<typeof vi.fn>;
  createReview: ReturnType<typeof vi.fn>;
} {
  const createComment = vi.fn(async () => ({
    data: { id: 42, html_url: "https://github.com/acme/widgets/pull/7#issuecomment-42" },
  }));
  const createReview = vi.fn(async () => ({
    data: { id: 99, html_url: "https://github.com/acme/widgets/pull/7#pullrequestreview-99" },
  }));
  return {
    client: { issues: { createComment }, pulls: { createReview } },
    createComment,
    createReview,
  };
}

const BASE_PARAMS = { owner: "acme", repo: "widgets", prNumber: 7 };

describe("publishReview", () => {
  it("posts exactly one comment on the ok:true path, containing the marker, header, and summary", async () => {
    const { client, createComment } = fakeClient();
    const result: ReviewResult = { ok: true, summary: "No issues found in this diff." };

    const published = await publishReview({ ...BASE_PARAMS, octokit: client, result });

    expect(createComment).toHaveBeenCalledTimes(1);
    const call = createComment.mock.calls[0][0];
    expect(call).toMatchObject({ owner: "acme", repo: "widgets", issue_number: 7 });
    expect(call.body).toContain(MAGPIE_REVIEW_MARKER);
    expect(call.body).toContain("Magpie review");
    expect(call.body).toContain("No issues found in this diff.");
    expect(published).toEqual({
      id: 42,
      url: "https://github.com/acme/widgets/pull/7#issuecomment-42",
    });
  });

  it("appends a compact usage footer when usage telemetry is present", async () => {
    const { client, createComment } = fakeClient();
    const usage: ReviewUsage = {
      turns: 2,
      inputTokens: 111,
      outputTokens: 222,
      totalTokens: 333,
      costUsd: 0.0042,
    };
    const result: ReviewResult = { ok: true, summary: "All good.", usage };

    await publishReview({ ...BASE_PARAMS, octokit: client, result });

    const body = createComment.mock.calls[0][0].body as string;
    expect(body).toMatch(/turns=2/);
    expect(body).toMatch(/tokens=333/);
    expect(body).toMatch(/cost=\$0\.0042/);
  });

  it("omits the usage footer when no usage telemetry is available", async () => {
    const { client, createComment } = fakeClient();
    const result: ReviewResult = { ok: true, summary: "All good." };

    await publishReview({ ...BASE_PARAMS, octokit: client, result });

    const body = createComment.mock.calls[0][0].body as string;
    expect(body).not.toMatch(/turns=/);
    expect(body).not.toMatch(/cost=/);
  });

  it("posts exactly one clear failure comment on the ok:false path, surfacing the reason", async () => {
    const { client, createComment } = fakeClient();
    const result: ReviewResult = {
      ok: false,
      reason: "pi exited with code 1: boom: something went wrong",
    };

    const published = await publishReview({ ...BASE_PARAMS, octokit: client, result });

    expect(createComment).toHaveBeenCalledTimes(1);
    const body = createComment.mock.calls[0][0].body as string;
    expect(body).toContain(MAGPIE_REVIEW_MARKER);
    // Clearly worded, not a silent comment.
    expect(body).toMatch(/could not complete a review/i);
    // The underlying provider/exit detail is still surfaced for debugging.
    expect(body).toContain("pi exited with code 1: boom: something went wrong");
    expect(published).toEqual({
      id: 42,
      url: "https://github.com/acme/widgets/pull/7#issuecomment-42",
    });
  });

  it("never includes a secret/token-shaped string in the comment body on either path", async () => {
    const { client: okClient } = fakeClient();
    const { client: failClient } = fakeClient();

    // A malicious/careless upstream reason string containing something that
    // *looks* like a token should still pass through only as review text —
    // the point of this test is that publisher.ts never itself introduces a
    // credential, not that it redacts one. It builds the body solely from
    // `summary`/`reason`, never from any credential-bearing param.
    await publishReview({
      ...BASE_PARAMS,
      octokit: okClient,
      result: { ok: true, summary: "Reviewed the diff; no findings." },
    });
    await publishReview({
      ...BASE_PARAMS,
      octokit: failClient,
      result: { ok: false, reason: "network error contacting provider" },
    });

    const okBody = (okClient.issues.createComment as ReturnType<typeof vi.fn>).mock.calls[0][0]
      .body as string;
    const failBody = (failClient.issues.createComment as ReturnType<typeof vi.fn>).mock.calls[0][0]
      .body as string;
    expect(okBody).not.toContain(FAKE_TOKEN);
    expect(failBody).not.toContain(FAKE_TOKEN);
    expect(okBody).not.toMatch(/ghs_/);
    expect(failBody).not.toMatch(/ghs_/);
  });

  it("renders a markdown-sensitive failure reason verbatim inside a code fence", async () => {
    const { client, createComment } = fakeClient();
    const reason = "pi exited: _foo_ **bar** <tag> at path/to/file_name.ts";
    const result: ReviewResult = { ok: false, reason };

    await publishReview({ ...BASE_PARAMS, octokit: client, result });

    const body = createComment.mock.calls[0][0].body as string;
    // The raw text is preserved intact (underscores/asterisks/tags untouched).
    expect(body).toContain(reason);
    // ...and it sits inside a fenced code block that renders it verbatim.
    expect(body).toContain(`\`\`\`\n${reason}\n\`\`\``);
  });

  it("widens the code fence so an embedded backtick run cannot break out", async () => {
    const { client, createComment } = fakeClient();
    // Reason contains a triple-backtick run — a naive ``` fence would be closed
    // early by it, letting the tail escape into interpreted markdown.
    const reason = "provider said: ```rm -rf``` then _crashed_";
    const result: ReviewResult = { ok: false, reason };

    await publishReview({ ...BASE_PARAMS, octokit: client, result });

    const body = createComment.mock.calls[0][0].body as string;
    // Reason still appears verbatim, unbroken.
    expect(body).toContain(reason);
    // The chosen fence is at least 4 backticks (one longer than the run of 3),
    // wrapping the reason on its own line.
    expect(body).toContain(`\`\`\`\`\n${reason}\n\`\`\`\``);
  });

  it("includes the marker constant identically on both the ok and failure paths", async () => {
    const { client: okClient } = fakeClient();
    const { client: failClient } = fakeClient();

    await publishReview({
      ...BASE_PARAMS,
      octokit: okClient,
      result: { ok: true, summary: "fine" },
    });
    await publishReview({
      ...BASE_PARAMS,
      octokit: failClient,
      result: { ok: false, reason: "boom" },
    });

    const okBody = (okClient.issues.createComment as ReturnType<typeof vi.fn>).mock.calls[0][0]
      .body as string;
    const failBody = (failClient.issues.createComment as ReturnType<typeof vi.fn>).mock.calls[0][0]
      .body as string;
    expect(okBody).toContain(MAGPIE_REVIEW_MARKER);
    expect(failBody).toContain(MAGPIE_REVIEW_MARKER);
  });
});

const WITH_FINDINGS_PARAMS = { owner: "acme", repo: "widgets", prNumber: 7 };

const SINGLE_LINE_COMMENT: InlineComment = {
  path: "src/foo.ts",
  line: 10,
  side: "RIGHT",
  message: "**Blocking** (correctness)\n\nThis is broken.",
};

const RANGE_COMMENT: InlineComment = {
  path: "src/bar.ts",
  line: 25,
  side: "RIGHT",
  start_line: 20,
  start_side: "RIGHT",
  message: "**Nit** (style)\n\nTidy this up.",
};

const CODE_BLOCK_COMMENT: InlineComment = {
  path: "src/qux.ts",
  line: 42,
  side: "RIGHT",
  message: "**Blocking** (correctness)\n\nBug here.\n\n**Suggestion:**\n```\nfix()\n```",
};

const OTHER_FINDING: Finding = {
  path: "src/baz.ts",
  line: 5,
  severity: "important",
  category: "security",
  message: "Unvalidated input reaches a sink.",
};

describe("publishReviewWithFindings", () => {
  it("builds comments[] from inline findings: path/line/side, start_line/start_side only for ranges, body == message", async () => {
    const { client, createReview } = fakeClient();

    await publishReviewWithFindings({
      ...WITH_FINDINGS_PARAMS,
      octokit: client,
      summary: "Overall looks fine.",
      inline: [SINGLE_LINE_COMMENT, RANGE_COMMENT],
      other: [],
    });

    expect(createReview).toHaveBeenCalledTimes(1);
    const call = createReview.mock.calls[0][0];
    expect(call).toMatchObject({ owner: "acme", repo: "widgets", pull_number: 7 });
    expect(call.comments).toHaveLength(2);

    const [single, range] = call.comments;
    expect(single).toEqual({
      path: "src/foo.ts",
      line: 10,
      side: "RIGHT",
      body: SINGLE_LINE_COMMENT.message,
    });
    expect(single.start_line).toBeUndefined();
    expect(single.start_side).toBeUndefined();

    expect(range).toEqual({
      path: "src/bar.ts",
      line: 25,
      side: "RIGHT",
      start_line: 20,
      start_side: "RIGHT",
      body: RANGE_COMMENT.message,
    });
  });

  it("renders other[] findings in the body under 'Other observations' with path:line and finding text", async () => {
    const { client, createReview } = fakeClient();

    await publishReviewWithFindings({
      ...WITH_FINDINGS_PARAMS,
      octokit: client,
      summary: "Overall looks fine.",
      inline: [],
      other: [OTHER_FINDING],
    });

    const body = createReview.mock.calls[0][0].body as string;
    expect(body).toContain("Other observations");
    expect(body).toContain("src/baz.ts:5");
    expect(body).toContain("Unvalidated input reaches a sink.");
  });

  it("always uses event: COMMENT, even when verdict: 'approve' is passed", async () => {
    const { client, createReview } = fakeClient();

    await publishReviewWithFindings({
      ...WITH_FINDINGS_PARAMS,
      octokit: client,
      summary: "Ship it.",
      inline: [],
      other: [],
      verdict: "approve",
    });

    expect(createReview.mock.calls[0][0].event).toBe("COMMENT");
  });

  it("on a 422 from createReview, retries once with comments:[] and inline findings folded into the body", async () => {
    const { client, createReview, createComment } = fakeClient();
    const conflictError = Object.assign(new Error("Unprocessable Entity"), { status: 422 });
    createReview.mockRejectedValueOnce(conflictError);

    const published = await publishReviewWithFindings({
      ...WITH_FINDINGS_PARAMS,
      octokit: client,
      summary: "Overall looks fine.",
      inline: [SINGLE_LINE_COMMENT],
      other: [OTHER_FINDING],
    });

    expect(createReview).toHaveBeenCalledTimes(2);
    const retryCall = createReview.mock.calls[1][0];
    expect(retryCall).toMatchObject({ owner: "acme", repo: "widgets", pull_number: 7, event: "COMMENT" });
    expect(retryCall.comments).toEqual([]);
    // The would-be inline finding is preserved as text, not dropped.
    expect(retryCall.body).toContain("Other observations");
    expect(retryCall.body).toContain("src/foo.ts:10");
    expect(retryCall.body).toContain("This is broken.");
    // The original other[] finding is still present too.
    expect(retryCall.body).toContain("src/baz.ts:5");

    expect(createComment).not.toHaveBeenCalled();
    expect(published).toEqual({
      id: 99,
      url: "https://github.com/acme/widgets/pull/7#pullrequestreview-99",
    });
  });

  it("on a 422, folds a multi-line inline finding (with a fenced code block) into the body without flattening it", async () => {
    const { client, createReview } = fakeClient();
    const conflictError = Object.assign(new Error("Unprocessable Entity"), { status: 422 });
    createReview.mockRejectedValueOnce(conflictError);

    await publishReviewWithFindings({
      ...WITH_FINDINGS_PARAMS,
      octokit: client,
      summary: "Overall looks fine.",
      inline: [CODE_BLOCK_COMMENT],
      other: [],
    });

    const retryCall = createReview.mock.calls[1][0];
    const body = retryCall.body as string;
    expect(body).toContain("src/qux.ts:42");
    // The fenced code block survives, indented under the bullet, rather than
    // being collapsed onto one line with the rest of the message.
    expect(body).toContain("  ```\n  fix()\n  ```");
    // Sanity check the finding's rendered block isn't a single flattened line.
    const findingBlock = body.slice(body.indexOf("src/qux.ts:42"));
    expect(findingBlock).toContain("\n");
  });

  it("falls back to issues.createComment once when both createReview attempts fail, and never throws", async () => {
    const { client, createReview, createComment } = fakeClient();
    createReview.mockRejectedValueOnce(new Error("first failure"));
    createReview.mockRejectedValueOnce(new Error("second failure"));

    const published = await publishReviewWithFindings({
      ...WITH_FINDINGS_PARAMS,
      octokit: client,
      summary: "Overall looks fine.",
      inline: [SINGLE_LINE_COMMENT],
      other: [OTHER_FINDING],
    });

    expect(createReview).toHaveBeenCalledTimes(2);
    expect(createComment).toHaveBeenCalledTimes(1);
    const fallbackCall = createComment.mock.calls[0][0];
    expect(fallbackCall).toMatchObject({ owner: "acme", repo: "widgets", issue_number: 7 });
    expect(fallbackCall.body).toContain("Other observations");
    expect(fallbackCall.body).toContain("src/foo.ts:10");
    expect(fallbackCall.body).toContain("src/baz.ts:5");
    expect(published).toEqual({
      id: 42,
      url: "https://github.com/acme/widgets/pull/7#issuecomment-42",
    });
  });

  it("never includes a secret/token-shaped string in the review body", async () => {
    const { client, createReview } = fakeClient();

    await publishReviewWithFindings({
      ...WITH_FINDINGS_PARAMS,
      octokit: client,
      summary: "Reviewed the diff.",
      inline: [SINGLE_LINE_COMMENT],
      other: [OTHER_FINDING],
    });

    const call = createReview.mock.calls[0][0];
    expect(call.body).not.toContain(FAKE_TOKEN);
    expect(call.body).not.toMatch(/ghs_/);
    for (const comment of call.comments) {
      expect(comment.body).not.toContain(FAKE_TOKEN);
      expect(comment.body).not.toMatch(/ghs_/);
    }
  });
});

describe("fenceReason", () => {
  it("uses a 3-backtick fence when the reason has no backticks", () => {
    expect(fenceReason("plain error")).toBe("```\nplain error\n```");
  });

  it("uses a fence one backtick longer than the longest embedded run", () => {
    // Longest run is 4 backticks -> fence must be 5.
    const reason = "a ```` b `` c";
    const fenced = fenceReason(reason);
    expect(fenced).toBe("`````\n" + reason + "\n`````");
    // The inner run can never match the wider fence, so nothing breaks out.
    expect(fenced.startsWith("`````\n")).toBe(true);
  });
});
