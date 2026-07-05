---
id: task_1a16
type: task
title: "Workspace clone + credential stripping"
status: open
priority: high
parent: epic_1a01
depends_on: [task_1a15]
created: 2026-07-05
---

# Workspace clone + credential stripping

Check out the PR head into a per-job workspace on the host, then remove all
credentials from the checkout.

## Context
Always fetch `refs/pull/{N}/head` from the **base** repo — this works identically
for fork and same-repo PRs with no fork remote. Use the tokenised URL from
task_1a15 as the HTTP password. Use a shallow/blobless clone
(`--filter=blob:none`) to stay fast on large repos. Even though milestone 1 runs
Pi on the host (no container yet), still strip credentials so the handoff matches
what the containerised version (milestone 3) will expect.

## Scope
- Create a per-job workspace directory under the configured work dir
  (e.g. `<workdir>/<owner>-<repo>-<number>-<sha>`).
- Clone the base repo blobless with the tokenised URL, fetch
  `refs/pull/{N}/head`, and check that ref out.
- **Strip credentials** after checkout: `git remote set-url origin
  https://github.com/owner/repo` (tokenless); never write a credential helper or
  `.git-credentials`. Token must not persist anywhere in the workspace.
- Provide a cleanup function that removes the workspace directory (called on job
  completion/failure/timeout).

## Acceptance criteria
- After the task runs, the PR head is checked out at the expected commit.
- No token appears in `.git/config`, remotes, or any workspace file.
- Cleanup fully removes the workspace directory.

## Dependencies
- task_1a15 (installation token for the clone URL)
