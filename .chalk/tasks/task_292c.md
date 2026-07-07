---
id: task_292c
title: Post single summary comment to the PR
type: task
status: open
priority: 1
labels: []
blocked_by: []
parent: epic_04f9
remote_task_url: null
created_at: 2026-07-05T22:58:08Z
updated_at: 2026-07-07T22:57:57Z
---
Publish the review result back to the PR as one summary comment authored by the GitHub App identity.

Context: For the walking skeleton we post a SINGLE summary comment (not a formal review with inline comments — that's M2). Use the per-job installation token from the GitHub App auth task. If Pi failed to produce a review (Pi runner failure path), post a short review-failed note instead of staying silent.

Scope:
- Using the authenticated installation client, post the review text as a single issue comment on the PR (POST /repos/{owner}/{repo}/issues/{number}/comments), or an equivalent single-comment mechanism.
- Include a small magpie header/marker in the comment body so magpie comments are identifiable (useful for later dedup/minimization milestones).
- On the Pi-failure path, post a concise magpie review failed comment.
- Keep it to ONE comment per job in this milestone.

Acceptance criteria:
- A successful job results in exactly one summary comment on the PR, authored by the App identity.
- A failed Pi run results in one clear failure comment, not silence.
- Comment includes an identifiable magpie marker.

Dependencies: task_b5cf (installation token/client), task_c53d (review text to post).
