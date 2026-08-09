# Per-repo config: `.magpie.toml`

A repo that Magpie already reviews (i.e. it's in
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

## The overridable subset — exactly five keys

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

# Opt this repo into a real GitHub APPROVE review (an informational "tick")
# instead of Magpie's baseline COMMENT — but ONLY when the operator's own
# config.toml has ALSO set `[review] allow_approve = true` (see "Enabling the
# approve tick" below); a repo can request this, never grant it to itself.
# Even then, Magpie only ever posts APPROVE when the review is genuinely
# clean: the reviewer's own verdict is "approve" AND it found zero findings.
# Any finding at all, or a "comment" verdict, still posts a plain COMMENT
# review. Magpie never posts REQUEST_CHANGES and never merges anything,
# regardless of this setting. Default: false (unset). **Read the warning
# immediately below before enabling this.**
allow_approve = false
```

> **Warning — read before setting `allow_approve = true` in EITHER `.magpie.toml`
> or the operator's `config.toml`:**
>
> 1. **Branch protection / merge gate.** A bot `APPROVE` from Magpie's GitHub
>    App counts toward a repo's "required approving reviews" branch
>    protection rule exactly like a human approval does — there is no GitHub
>    API to mark a bot approval as "doesn't count." If a repo's branch
>    protection requires only **one** approving review, enabling this can let
>    a PR merge with **zero human sign-off**, as long as Magpie's own findings
>    happen to come back clean. Only enable this on a repo whose branch
>    protection either requires more than one approval, or where an operator
>    is comfortable with Magpie's tick alone being able to satisfy the rule.
> 2. **Prompt injection.** The `verdict` that drives this decision is
>    authored by the Pi reviewer from PR-supplied (and therefore
>    attacker-influenced) diff/title/body content — indirect prompt injection
>    against the review agent is Magpie's own named threat model (see
>    ARCHITECTURE.md's threat model section). Today, a manipulated
>    verdict/summary is low-stakes: a human reads a `COMMENT`. Once `verdict`
>    can drive a real GitHub `APPROVE`, a sufficiently crafted PR becomes a
>    materially higher-stakes target — the zero-findings condition raises the
>    bar, but does not eliminate it, since findings themselves are also
>    LLM-authored from the same untrusted input.
>
> Both risks are inherent to what "post a real GitHub review status from an
> LLM's read of untrusted PR content" means; they are not implementation bugs
> to be engineered around. The double opt-in (operator `config.toml` **and**
> repo `.magpie.toml`) exists specifically so this is never a silent
> default — an operator must consciously accept both risks for a specific
> repo before it takes effect.

Every other section a `.magpie.toml` might name — the container image or
isolation tier, the gateway URL, per-job budgets, timeouts, concurrency, the
reviewer's tool allowlist, the operator's `repo_allowlist` itself, workspace
paths, telemetry — is **server-only** and cannot be reached from this file at
all, by construction: the code that builds the effective per-job config
copies every one of those fields verbatim from the operator's `config.toml`
and only ever substitutes in the values above (`llm.model`,
`limits.max_diff_lines`) when they're present and valid — `review.allow_approve`
is handled the same way, but as a separate sidecar value rather than a
`Config` field (see repo-config.ts's `applyRepoConfig`).

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

## Enabling the approve tick (operator side)

By default, `.magpie.toml` cannot turn Magpie's `COMMENT` reviews into a real
GitHub `APPROVE` — `review.allow_approve` in the operator's own `config.toml`
starts `false`. To let repos opt into the approve tick:

```toml
[review]
allow_approve = true
```

Read the warning above the `[review]` example before setting this. Enabling
it here does **not** make Magpie start approving PRs by itself — it only
makes it *possible* for a repo to opt in via its own `.magpie.toml`; a repo
that never sets `[review] allow_approve = true` keeps getting plain `COMMENT`
reviews even after the operator flips this on. Treat this the same way you'd
treat granting a repo the ability to affect branch-protection outcomes at
all, because that is exactly what it does: only enable it for repos where an
operator has actually reviewed that repo's branch-protection configuration
and is comfortable with a clean Magpie review being able to satisfy it.

## Why this exists / threat model

See `packages/orchestrator/src/repo-config.ts`'s module doc comment for the
full rationale; in short: Magpie's core security property is that the review
agent never holds anything worth stealing and the *host* does all privileged
work. Per-repo config had to be added without creating a new lever a hostile
PR (or even a hostile default-branch commit, which is already a more trusted
position) could pull to reach budgets, network egress, the container image,
or the tool allowlist. The base-branch pin plus the fixed five-key subset
plus fail-soft-on-anything-else is how that property is preserved.
`review.allow_approve` is the one knob in that subset with a real security
consequence beyond "Magpie reviews slightly differently," which is why it
carries the extra server-side gate on top of the base-branch pin every other
knob relies on alone.
