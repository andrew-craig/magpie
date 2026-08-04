# Per-repo config: `.magpie.toml`

Milestone 6-B (`task_220f`). A repo that Magpie already reviews (i.e. it's in
the operator's `repo_allowlist`) can tune a small, pre-approved slice of
review behaviour by committing a `.magpie.toml` file to its **default
branch**. No operator action is needed to pick this file up — it's read
fresh on every job — but the *set* of things it can change is fixed by this
document and by the operator's own `config.toml` (see `allowed_models`
below), not by anything the repo itself can expand.

This is operator/repo-owner documentation, not reviewer-facing: nothing in
`.magpie.toml` is ever shown to a PR author, and Magpie never tells a PR "your
repo's config did X" — overrides only show up in the operator's own
structured logs (`event: "repo-config-overrides"`).

## The base-branch rule

`.magpie.toml` is read via the GitHub Contents API from the repo's
**default branch only** — never the PR's base branch (`base.ref`, which a PR
can freely choose to target) and never the PR's head (fully attacker
controlled). Concretely: whoever can push to the default branch controls
`.magpie.toml`; a PR author who can't push there cannot influence it at all,
even from their own PR.

The same `.magpie.toml` content sitting on a PR branch (including the PR
being reviewed) has **no effect whatsoever** — Magpie's fetch is pinned to
the default branch ref before the PR is even looked at.

If the file is missing, unreadable, oversized, malformed TOML, or fails
schema validation in any way, Magpie silently falls back to the operator's
server config and runs the review normally. A broken `.magpie.toml` never
fails or skips a review — it just means no overrides apply for that job.

## The overridable subset — exactly four keys

Nothing outside this list has any effect. An unrecognized top-level section
or an unrecognized key inside a recognized section invalidates the **whole
file** (not just that key) — the file is treated exactly like "no
`.magpie.toml` at all" for that job, and every knob falls back to the server
default. This is deliberately blunt: a `.magpie.toml` that mentions
`[container]` or `[gateway]` is far more likely to be a probe than a typo.

```toml
[llm]
# Switch the review model for this repo — ONLY if the value is a member of
# the operator's own `llm.allowed_models` in config.toml (see below). If
# `allowed_models` is empty/unset (the default), every repo-requested model
# is refused and the operator's configured model is used instead.
model = "anthropic/claude-sonnet-4.5"

[limits]
# Tighten (never loosen) the operator's diff-size review cap. The effective
# cap is always `min(this value, the operator's config.toml limits.max_diff_lines)`
# — a repo can make Magpie review less, never more, than the operator allowed.
max_diff_lines = 2000

[review]
# Freeform guidance appended to the reviewer's prompt in its own clearly-
# labelled advisory block — e.g. house style conventions or areas to focus
# on. This is NOT a system instruction: it cannot override, relax, or
# countermand Magpie's system prompt or safety behaviour, and the reviewer is
# told exactly that. Hard capped at 4 KiB; longer text is truncated.
guidance = "This is a Rust codebase; flag `unwrap()`/`expect()` outside tests. Prefer `anyhow::Result` over stringly-typed errors."

# Glob patterns (supporting `*`, `**`, `?`) for paths to exclude from review
# entirely — both the diff Magpie sends to the model and the changed-file
# list. Excluded files never count against `max_diff_lines` either, so
# ignoring a large vendored/generated directory can let an otherwise
# oversized PR through the cap.
ignore_paths = ["vendor/**", "**/*.min.js", "dist/**"]
```

Every other section a `.magpie.toml` might name — the container image or
isolation tier, the gateway URL, per-job budgets, timeouts, concurrency, the
reviewer's tool allowlist, the operator's `repo_allowlist` itself, workspace
paths, telemetry — is **server-only** and cannot be reached from this file at
all, by construction: the code that builds the effective per-job config
copies every one of those fields verbatim from the operator's `config.toml`
and only ever substitutes in the two values above (`llm.model`,
`limits.max_diff_lines`) when they're present and valid.

## Enabling the model override (operator side)

By default, `.magpie.toml` cannot switch models — `llm.allowed_models` in the
operator's own `config.toml` starts empty. To let repos opt into a specific
set of models:

```toml
[llm]
model = "anthropic/claude-sonnet-4.5"   # the server's own default
allowed_models = ["anthropic/claude-sonnet-4.5", "openai/gpt-5"]
```

The server's own `model` does **not** need to appear in `allowed_models` for
its own default to keep working — that list only gates a repo's *override*.
Choose this list with the same care as the per-job budget
(`gateway.per_job_budget_usd`): a repo-chosen model is what the per-job
gateway virtual key gets scoped to, so only list models you're comfortable
any allowlisted repo choosing to run against.

## Why this exists / threat model

See `packages/orchestrator/src/repo-config.ts`'s module doc comment for the
full rationale; in short: Magpie's core security property is that the review
agent never holds anything worth stealing and the *host* does all privileged
work. Per-repo config had to be added without creating a new lever a hostile
PR (or even a hostile default-branch commit, which is already a more trusted
position) could pull to reach budgets, network egress, the container image,
or the tool allowlist. The base-branch pin plus the fixed four-key subset
plus fail-soft-on-anything-else is how that property is preserved.
