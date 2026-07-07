---
id: task_ada6
title: Workspace clone + credential stripping
type: task
status: closed
priority: 1
labels: []
blocked_by: []
parent: epic_04f9
remote_task_url: null
created_at: 2026-07-05T22:57:34Z
updated_at: 2026-07-06T12:43:45Z
---
Check out the PR head into a per-job workspace on the host, then remove all credentials from the checkout.

Context: Always fetch refs/pull/{N}/head from the BASE repo — this works identically for fork and same-repo PRs with no fork remote. Use the tokenised URL from the GitHub App auth task as the HTTP password. Use a shallow/blobless clone (--filter=blob:none) to stay fast on large repos. Even though M1 runs Pi on the host (no container yet), still strip credentials so the handoff matches what the containerised version (M3) will expect.

Scope:
- Create a per-job workspace directory under the configured work dir (e.g. <workdir>/<owner>-<repo>-<number>-<sha>).
- Clone the base repo blobless with the tokenised URL, fetch refs/pull/{N}/head, and check that ref out.
- STRIP credentials after checkout: git remote set-url origin https://github.com/owner/repo (tokenless); never write a credential helper or .git-credentials. Token must not persist anywhere in the workspace.
- Provide a cleanup function that removes the workspace directory (called on job completion/failure/timeout).

Acceptance criteria:
- After the task runs, the PR head is checked out at the expected commit.
- No token appears in .git/config, remotes, or any workspace file.
- Cleanup fully removes the workspace directory.

Dependencies: task_b5cf (installation token for the clone URL).

## Review (tech lead) — APPROVED (security-critical, scrutinized)
workspace.ts: createWorkspace({owner,repo,prNumber,headSha,token,workDir,baseUrlOverride?}) -> {dir, cleanup}. git init + named origin remote + fetch --filter=blob:none refs/pull/N/head + checkout --detach FETCH_HEAD. CORRECT ORDER: stripCredentials runs AFTER checkout, so blobless on-demand blob fetch still has an authenticated origin. Credential scrub: remote set-url origin <tokenless> (derived via URL parse, works for github + file:// fixture), rm .git/FETCH_HEAD, rm .git/logs; never writes credential helper/.git-credentials. All git via execFile (no shell); token redacted from all thrown git errors. Test greps ENTIRE workspace tree incl .git for token -> zero matches; also tests wrong-sha throw+cleanup, missing ref, double cleanup. Base URL injectable seam for hermetic local-fixture testing. 8 tests. Re-ran independently; merged tree 53/53.
