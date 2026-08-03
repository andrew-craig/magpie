---
id: task_ad15
title: M6-A: @magpie review — on-demand re-review via PR comment command
type: task
status: closed
priority: 3
labels: []
blocked_by: []
parent: epic_3c41
remote_task_url: null
created_at: 2026-07-10T21:52:56Z
updated_at: 2026-08-03T11:51:53Z
---
PLAN.md milestone 6. Let a human request a review by commenting '@magpie review' on a PR.

- Subscribe the GitHub App to issue_comment events; webhook filter accepts created comments on PRs whose body matches the command (tolerant of surrounding whitespace/text).
- Authorization: only act on commenters with write/admin association on the repo — comment bodies are attacker-controlled (the threat model's whole point), so the command must not be triggerable by arbitrary users. Repo allowlist still applies.
- Reuse the normal pipeline (queue dedup, current head SHA); force a full (non-incremental) review even if the head SHA was already reviewed — that's the use case. React to the comment (eyes/rocket) or reply briefly so the requester knows it was picked up.

Done when: a maintainer comment triggers a fresh review, and the same comment from a non-collaborator does nothing (logged, no reply).

## Implementation plan (2026-08-03)

Researched current architecture first (server.ts/filter.ts/queue.ts/pipeline.ts/rereview.ts/github.ts). Key findings:
- Only `pull_request` is subscribed today (`server.ts`); no `issue_comment` seam exists.
- `filter.ts` is pure/sync (no network calls) — the comment path needs an authorization check via a live API call, so it can't reuse that module as-is.
- Pipeline already has an implicit "force full review" path: a `JobDescriptor` with `before`/`after` unset takes the full-diff branch (`pipeline.ts` ~L478-538). The only real gap is the dedup-skip check (`pipeline.ts` ~L367-409: `if (reviewState.lastReviewedSha === job.headSha) { earlyOutcome = "already-reviewed"; return; }`) — needs a bypass flag.
- No existing code calls the reactions API or `getCollaboratorPermissionLevel` — both new.
- GitHub App is currently only subscribed to `pull_request` events (manual setup via QUICKSTART.md §6); needs `issue_comment` added, plus verify/add `Issues: Read and write` permission (needed for posting reactions on issue/PR comments — `getCollaboratorPermissionLevel` should already be covered by existing repo access).

### Steps
- [ ] `queue.ts`: add `forceFullReview?: boolean` to `JobDescriptor`.
- [ ] `pipeline.ts`: gate the dedup-skip on `&& !job.forceFullReview`.
- [ ] New module `packages/orchestrator/src/comment-command.ts` (async, unlike filter.ts):
  - Accept only `action === "created"` issue_comment events where `payload.issue.pull_request` is present (i.e. a PR, not a plain issue).
  - Match body against `/@magpie\s+review\b/i` anywhere in the text (tolerant of surrounding whitespace/text per spec).
  - Check `config.repoAllowlist` (same allowlist as filter.ts).
  - Mint a short-lived installation token (reuse `github.ts`'s `mintInstallationToken`, using `payload.installation.id`).
  - Authorize: `octokit.rest.repos.getCollaboratorPermissionLevel({owner, repo, username: payload.comment.user.login})`, require `"write"` or `"admin"`. Note: the comment *body* is attacker-controlled but `payload.comment.user.login` is not (asserted by GitHub, same trust argument as rereview.ts's bot-identity check) — that's what authorization keys off, never body content.
  - On unauthorized/non-match/non-PR/non-allowlisted: log only, return — no reply, no reaction (matches "Done when" spec).
  - On authorized: `octokit.rest.pulls.get({owner, repo, pull_number: payload.issue.number})` to get the *current* head SHA (issue_comment payload's minimal `issue.pull_request` doesn't include it) — deliberately ignore draft status here (a human explicitly asking for review should get one even on a draft PR — different from the webhook heuristic).
  - Post a `👀` (`eyes`) reaction via `octokit.rest.reactions.createForIssueComment(...)` as the ack (per spec's react-or-reply option; reaction is quieter/cheaper than a reply comment).
  - Build `JobDescriptor` with `forceFullReview: true` and no `before`/`after`, call `enqueue(job)` (same `queue.ts` used by the pull_request path — dedup by `owner/repo#prNumber` applies naturally).
- [ ] `server.ts`: add `webhooks.on("issue_comment", onIssueComment)` alongside the existing `pull_request` handler; new `OnIssueComment` type mirroring `OnPullRequest`.
- [ ] `index.ts`: wire the new handler the same way `onPullRequest` is wired today.
- [ ] Tests: `comment-command.test.ts` (mirror `filter.test.ts` patterns: match/no-match, non-PR issue, non-allowlisted repo, unauthorized commenter, authorized commenter → job shape); extend `pipeline.test.ts` for the `forceFullReview` bypass; extend `server.test.ts` for the new event wiring.
- [ ] Docs: `QUICKSTART.md` §6 — add "Issue comment" to the Subscribe-to-events step, and add/confirm `Issues: Read and write` permission. Optionally regenerate `docs/review-flow.md`'s Mermaid diagram (it documents it reflects `pipeline.ts`/`reviewer.ts`/`tier-ladder.ts` shape — this doesn't change those, likely skip unless the diagram also depicts the webhook entry points).

### Open question to confirm with CTO/user before/while implementing
- Exact permission scope needed for `reactions.createForIssueComment` — flagged as "verify" rather than asserted; if reactions turn out to need a scope we don't want to grant, fall back to a short reply comment instead (spec allows either).

