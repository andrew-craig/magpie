---
id: task_1a1a
type: task
title: "Post single summary comment to the PR"
status: open
priority: high
parent: epic_1a01
depends_on: [task_1a15, task_1a19]
created: 2026-07-05
---

# Post single summary comment to the PR

Publish the review result back to the PR as one summary comment authored by the
GitHub App identity.

## Context
For the walking skeleton we post a **single summary comment** (not a formal
review with inline comments — that's milestone 2). Use the per-job installation
token from task_1a15. If Pi failed to produce a review (task_1a19 failure path),
post a short "review failed" note instead of staying silent.

## Scope
- Using the authenticated installation client, post the review text as a single
  issue comment on the PR (`POST /repos/{owner}/{repo}/issues/{number}/comments`),
  or an equivalent single-comment mechanism.
- Include a small magpie header/marker in the comment body so magpie comments are
  identifiable (useful for later dedup/minimization milestones).
- On the Pi-failure path, post a concise "magpie review failed" comment.
- Keep it to **one** comment per job in this milestone.

## Acceptance criteria
- A successful job results in exactly one summary comment on the PR, authored by
  the App identity.
- A failed Pi run results in one clear failure comment, not silence.
- Comment includes an identifiable magpie marker.

## Dependencies
- task_1a15 (installation token / client), task_1a19 (review text to post)
