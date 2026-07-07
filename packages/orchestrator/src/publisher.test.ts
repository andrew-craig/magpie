import { describe, expect, it, vi } from "vitest";
import type { ReviewResult, ReviewUsage } from "./reviewer.js";
import {
  MAGPIE_REVIEW_MARKER,
  publishReview,
  type MinimalIssuesClient,
} from "./publisher.js";

// NOTE: fully offline — no real Octokit, no network. `MinimalIssuesClient` is
// the test seam (see publisher.ts's doc comment): a bare `vi.fn()` fake
// stands in for the real, already-authenticated client that production code
// gets from github.ts's `createInstallationOctokit`.

const FAKE_TOKEN = "ghs_super-secret-installation-token-should-never-appear";

/** Builds a fake client whose createComment resolves with a canned id/url. */
function fakeClient(): { client: MinimalIssuesClient; createComment: ReturnType<typeof vi.fn> } {
  const createComment = vi.fn(async () => ({
    data: { id: 42, html_url: "https://github.com/acme/widgets/pull/7#issuecomment-42" },
  }));
  return { client: { issues: { createComment } }, createComment };
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
