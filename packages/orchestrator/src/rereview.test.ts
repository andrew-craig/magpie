import type { Octokit } from "@octokit/rest";
import { describe, expect, it, vi } from "vitest";
import { buildReviewedShaMarker, MAGPIE_REVIEW_MARKER } from "./publisher.js";
import { minimizeOutdated, readReviewState } from "./rereview.js";

// NOTE: fully offline — no real Octokit, no network. `readReviewState` and
// `minimizeOutdated` only ever touch `octokit.paginate` (keyed by function
// IDENTITY, exactly like the real Octokit's `paginate(fn, params)` API — see
// diff.ts's `listPrChangedFiles` for the same pattern) and `octokit.graphql`,
// so the fake octokit below only needs to stand up those three list
// endpoints plus `graphql`.

interface FakeIssueComment {
  node_id: string;
  body?: string | null;
  created_at: string;
}
interface FakeReview {
  id: number;
  node_id: string;
  body?: string | null;
  submitted_at?: string | null;
}
interface FakeReviewComment {
  node_id: string;
  pull_request_review_id?: number | null;
  created_at?: string;
}

function fakeOctokit(opts: {
  issueComments?: FakeIssueComment[];
  reviews?: FakeReview[];
  reviewComments?: FakeReviewComment[];
  graphqlImpl?: (query: string, vars?: Record<string, unknown>) => Promise<unknown>;
}) {
  const listComments = vi.fn();
  const listReviews = vi.fn();
  const listReviewComments = vi.fn();
  const paginate = vi.fn(async (fn: unknown) => {
    if (fn === listComments) return opts.issueComments ?? [];
    if (fn === listReviews) return opts.reviews ?? [];
    if (fn === listReviewComments) return opts.reviewComments ?? [];
    return [];
  });
  const graphql = vi.fn(opts.graphqlImpl ?? (async () => ({})));

  const octokit = {
    paginate,
    rest: {
      issues: { listComments },
      pulls: { listReviews, listReviewComments },
    },
    graphql,
  };

  return { octokit: octokit as unknown as Octokit, listComments, listReviews, listReviewComments, graphql, paginate };
}

const BASE_PARAMS = { owner: "acme", repo: "widgets", prNumber: 7 };

function magpieComment(overrides: Partial<FakeIssueComment> = {}): FakeIssueComment {
  return {
    node_id: "IC_default",
    body: `${MAGPIE_REVIEW_MARKER}\nMagpie could not complete a review of this PR.`,
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function magpieReview(overrides: Partial<FakeReview> = {}): FakeReview {
  return {
    id: 1,
    node_id: "PRR_default",
    body: `${MAGPIE_REVIEW_MARKER}\nAll good.`,
    submitted_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("readReviewState", () => {
  it("returns an empty state (no lastReviewedSha, no minimizable nodes) when there's no prior magpie activity", async () => {
    const { octokit } = fakeOctokit({});
    const state = await readReviewState({ octokit, ...BASE_PARAMS });
    expect(state).toEqual({ lastReviewedSha: undefined, minimizableNodeIds: [] });
  });

  it("parses lastReviewedSha from the most recent (by timestamp) magpie post, across mixed issue-comments and reviews", async () => {
    const { octokit } = fakeOctokit({
      issueComments: [
        magpieComment({
          node_id: "IC_old",
          body: `${MAGPIE_REVIEW_MARKER}${buildReviewedShaMarker("sha-old")}\nToo large, skipped.`,
          created_at: "2026-01-01T00:00:00Z",
        }),
      ],
      reviews: [
        magpieReview({
          id: 1,
          node_id: "PRR_new",
          body: `${MAGPIE_REVIEW_MARKER}${buildReviewedShaMarker("sha-new")}\nAll good.`,
          submitted_at: "2026-01-02T00:00:00Z",
        }),
      ],
    });

    const state = await readReviewState({ octokit, ...BASE_PARAMS });

    expect(state.lastReviewedSha).toBe("sha-new");
  });

  it("ignores non-magpie comments/reviews entirely, even when they are the most recent by timestamp", async () => {
    const { octokit } = fakeOctokit({
      issueComments: [
        {
          node_id: "IC_human",
          body: "This is a human comment with no marker at all.",
          created_at: "2026-01-05T00:00:00Z",
        },
      ],
      reviews: [
        magpieReview({
          id: 1,
          node_id: "PRR_magpie",
          body: `${MAGPIE_REVIEW_MARKER}${buildReviewedShaMarker("sha-magpie")}\nAll good.`,
          submitted_at: "2026-01-01T00:00:00Z",
        }),
      ],
    });

    const state = await readReviewState({ octokit, ...BASE_PARAMS });

    // The human comment is later but carries no marker, so it never enters
    // the "most recent magpie post" candidate set at all.
    expect(state.lastReviewedSha).toBe("sha-magpie");
  });

  it("resolves lastReviewedSha to undefined when the most recent magpie post is a failure note (no reviewed-sha marker), even though an older definitive review exists", async () => {
    const { octokit } = fakeOctokit({
      reviews: [
        magpieReview({
          id: 1,
          node_id: "PRR_old_success",
          body: `${MAGPIE_REVIEW_MARKER}${buildReviewedShaMarker("sha-old")}\nAll good.`,
          submitted_at: "2026-01-01T00:00:00Z",
        }),
      ],
      issueComments: [
        magpieComment({
          node_id: "IC_new_failure",
          // Failure notes carry MAGPIE_REVIEW_MARKER (identity) but never the
          // reviewed-sha marker — see publisher.ts's buildFailureBody.
          body: `${MAGPIE_REVIEW_MARKER}\nMagpie could not complete a review of this PR.`,
          created_at: "2026-01-02T00:00:00Z",
        }),
      ],
    });

    const state = await readReviewState({ octokit, ...BASE_PARAMS });

    expect(state.lastReviewedSha).toBeUndefined();
  });

  it("links inline review comments to magpie via pull_request_review_id, not via their own body", async () => {
    const { octokit } = fakeOctokit({
      reviews: [
        magpieReview({ id: 10, node_id: "PRR_magpie", body: `${MAGPIE_REVIEW_MARKER}\nAll good.` }),
        { id: 20, node_id: "PRR_human", body: "A human's own review, no marker." },
      ],
      reviewComments: [
        { node_id: "RC_from_magpie_review", pull_request_review_id: 10, created_at: "2026-01-01T00:00:00Z" },
        { node_id: "RC_from_human_review", pull_request_review_id: 20, created_at: "2026-01-01T00:00:00Z" },
        { node_id: "RC_orphan", pull_request_review_id: null, created_at: "2026-01-01T00:00:00Z" },
      ],
    });

    const state = await readReviewState({ octokit, ...BASE_PARAMS });

    expect(state.minimizableNodeIds).toContain("RC_from_magpie_review");
    expect(state.minimizableNodeIds).not.toContain("RC_from_human_review");
    expect(state.minimizableNodeIds).not.toContain("RC_orphan");
  });

  it("minimizableNodeIds = magpie issue comments UNION magpie inline review comments — NEVER review node_ids", async () => {
    const { octokit } = fakeOctokit({
      issueComments: [
        magpieComment({ node_id: "IC_magpie_1" }),
        { node_id: "IC_human", body: "no marker here", created_at: "2026-01-01T00:00:00Z" },
      ],
      reviews: [magpieReview({ id: 1, node_id: "PRR_magpie_1" })],
      reviewComments: [{ node_id: "RC_magpie_1", pull_request_review_id: 1, created_at: "2026-01-01T00:00:00Z" }],
    });

    const state = await readReviewState({ octokit, ...BASE_PARAMS });

    expect(state.minimizableNodeIds.sort()).toEqual(["IC_magpie_1", "RC_magpie_1"].sort());
    // The review's own node_id is explicitly never in the minimizable set —
    // PullRequestReview is not GitHub's `Minimizable` interface (see
    // rereview.ts's module doc comment / SCOPE CONSTRAINT).
    expect(state.minimizableNodeIds).not.toContain("PRR_magpie_1");
  });
});

describe("minimizeOutdated", () => {
  it("calls the minimizeComment GraphQL mutation with classifier OUTDATED for every node id", async () => {
    const { octokit, graphql } = fakeOctokit({});

    await minimizeOutdated({ octokit, nodeIds: ["IC_1", "RC_1"] });

    expect(graphql).toHaveBeenCalledTimes(2);
    for (const call of graphql.mock.calls) {
      const [query, vars] = call as [string, { subjectId: string }];
      expect(query).toContain("minimizeComment");
      expect(query).toContain("OUTDATED");
      expect(["IC_1", "RC_1"]).toContain(vars.subjectId);
    }
  });

  it("never calls graphql when nodeIds is empty", async () => {
    const { octokit, graphql } = fakeOctokit({});

    await minimizeOutdated({ octokit, nodeIds: [] });

    expect(graphql).not.toHaveBeenCalled();
  });

  it("swallows a per-node GraphQL error, logs it, and still attempts the remaining nodes", async () => {
    const { octokit, graphql } = fakeOctokit({
      graphqlImpl: async (_query, vars) => {
        const subjectId = (vars as { subjectId: string }).subjectId;
        if (subjectId === "IC_fails") throw new Error("permission denied");
        return { minimizeComment: { minimizedComment: { isMinimized: true } } };
      },
    });
    const errors: Record<string, unknown>[] = [];
    const logger = { info: vi.fn(), error: (p: Record<string, unknown>) => errors.push(p) };

    await expect(
      minimizeOutdated({ octokit, nodeIds: ["IC_fails", "IC_succeeds"], logger }),
    ).resolves.toBeUndefined();

    expect(graphql).toHaveBeenCalledTimes(2);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ event: "minimize-outdated-failed", nodeId: "IC_fails" });
  });
});
