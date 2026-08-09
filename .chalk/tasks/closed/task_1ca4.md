---
id: task_1ca4
title: Support owner/* glob patterns in repo_allowlist
type: task
status: closed
priority: 2
labels: []
blocked_by: []
parent: null
remote_task_url: null
created_at: 2026-08-09T04:22:33Z
updated_at: 2026-08-09T04:28:09Z
---

## Context

`repo_allowlist` in `filter.ts` (`packages/orchestrator/src/filter.ts:150`) currently does an
exact `Set.has(fullName)` match against the PR's base-repo `owner/repo`. This forces every repo
under an owner to be listed individually and silently rots when a repo is moved/renamed (found
2026-08-09: a repo moved from `cairn-app/cairn-reader` to `andrew-craig/cairn-reader`, the config
entry wasn't updated, and PRs were silently dropped with `pr-filter-drop-not-allowlisted`).

Operator (andrew-craig) wants to allowlist an entire owner (e.g. `"andrew-craig/*"`) so future
repos under that owner don't need a config edit.

## Plan

- [ ] Reuse the existing glob matcher (`glob-match.ts`, currently used for `.magpie.toml`
      `ignore_paths`) for repo_allowlist matching instead of the exact `Set.has` check in
      `filter.ts`. `matchesAnyGlob(fullName, config.repoAllowlist)` — `*` already stays within a
      `/`-delimited segment, so `"andrew-craig/*"` naturally matches `andrew-craig/foo` but not
      anything with an extra `/`, which is exactly the owner-wildcard semantics wanted. No new
      matcher needed.
  - [ ] Update `filter.ts`'s doc comment (currently describes allowlist as exact match).
  - [ ] Update/add unit tests in `filter.test.ts` for: exact-match entries still work,
        `"owner/*"` matches any repo under that owner, `"owner/*"` does NOT match a different
        owner or a nested path, mixed exact + wildcard entries in the same list.
- [ ] Update `config.example.toml` repo_allowlist comment to mention glob support.
- [ ] Check `docs/` (repo-config.md, ARCHITECTURE.md, INSTALL.md) for any prose describing
      repo_allowlist as exact-match and update if found.
- [ ] Run full orchestrator test suite + typecheck.
- [ ] Open PR to main.

## Notes

- This is a security-relevant change (repo_allowlist is documented as "the last line of defense"
  against the App running on repos the operator didn't opt into) — the wildcard is opt-in per
  entry (operator writes `"andrew-craig/*"` explicitly), so this doesn't change behavior for
  anyone using exact entries today. Worth calling out in the PR description.
- Live host config was hotfixed 2026-08-09 (exact-match `andrew-craig/cairn-reader` swapped in
  for stale `cairn-app/cairn-reader`) to unblock review right now — that fix does NOT depend on
  this task. Once this ships and is deployed (next release/reinstall cycle), the operator may
  want to collapse the whole live `repo_allowlist` down to `"andrew-craig/*"` (every current
  entry is already under that owner).
