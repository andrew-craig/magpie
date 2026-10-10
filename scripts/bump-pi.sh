#!/usr/bin/env bash
#
# bump-pi.sh — bump the pinned Pi coding-agent version across the repo.
#
# Pi (`@earendil-works/pi-coding-agent`) is pinned in TWO places that must
# stay in lockstep (see docker/reviewer/extension-package.json's own doc
# comment for why): the host-side extension workspace
# (packages/review-extension/package.json, caret ranges) and the
# container-image install manifest (docker/reviewer/extension-package.json,
# exact pins) -- the `pi` CLI and the baked-in report_findings extension are
# installed TOGETHER there so both resolve against the exact same on-disk
# copy. `@earendil-works/pi-tui` and `typebox` are extension runtime deps
# that must also match whatever pi-coding-agent ITSELF depends on at the
# target version, so the extension and Pi never end up with two different
# installed copies of either.
#
# This script resolves ONE target pi-coding-agent version, reads that
# version's own declared pi-tui/typebox deps straight from the npm
# registry, and rewrites all three pins in both package.json files --
# nothing is hand-guessed. It then refreshes package-lock.json and reports
# any remaining prose mentions of the OLD version for a human to update by
# hand (version-specific claims in comments/docs can't be rewritten
# mechanically -- some may no longer even be true at the new version, see
# docker/reviewer/README.md's "Bumping Pi" section).
#
# This script does NOT: review the changelog for breaking changes, run
# tests, rebuild the reviewer image, or publish anything -- see the
# follow-up steps it prints at the end.
#
# Usage:
#   ./scripts/bump-pi.sh            # bump to the latest published version
#   ./scripts/bump-pi.sh latest     # same, explicit
#   ./scripts/bump-pi.sh 1.1.0      # bump to an exact version
#
# Idempotent: re-running against the same already-pinned version is a
# harmless no-op (package.json contents end up byte-identical, `npm
# install` is a no-op, and the stale-mentions search finds nothing to
# report). Fails loudly (nonzero exit, no files touched) if the requested
# version -- or its declared pi-tui/typebox deps -- can't be resolved on the
# npm registry.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

REQUESTED="${1:-latest}"

PI_PKG="@earendil-works/pi-coding-agent"
PI_TUI_PKG="@earendil-works/pi-tui"
TYPEBOX_PKG="typebox"

REVIEW_EXT_PKG_JSON="$REPO_ROOT/packages/review-extension/package.json"
REVIEWER_EXT_PKG_JSON="$REPO_ROOT/docker/reviewer/extension-package.json"

log() { printf '[bump-pi] %s\n' "$*" >&2; }
die() { printf '[bump-pi] error: %s\n' "$*" >&2; exit 1; }

command -v npm >/dev/null 2>&1 || die "'npm' not found on PATH"
command -v node >/dev/null 2>&1 || die "'node' not found on PATH"

for f in "$REVIEW_EXT_PKG_JSON" "$REVIEWER_EXT_PKG_JSON"; do
  [ -f "$f" ] || die "expected file not found: $f"
done

# --- resolve_version PKG SPEC -------------------------------------------------
# Prints the single concrete version npm resolves PKG@SPEC to. `npm view ...
# version` prints one line PER matching version when SPEC is a range or partial
# (e.g. "1.1", "^1.1.0") -- and Pi's own deps are caret ranges, so pi-tui/
# typebox hit this as soon as a newer patch is published. Ask for --json
# instead (a string for one match, an array otherwise), take the highest match
# (npm lists ascending -- the same version `npm install` would pick), and
# refuse anything that isn't one well-formed semver string rather than write
# it into the pins.
resolve_version() {
  local pkg="$1" spec="$2" raw v
  raw="$(npm view "${pkg}@${spec}" version --json 2>/dev/null || true)"
  [ -n "$raw" ] || return 1
  v="$(RAW="$raw" node -e '
    const r = JSON.parse(process.env.RAW);
    const v = Array.isArray(r) ? r[r.length - 1] : r;
    if (typeof v !== "string") process.exit(1);
    process.stdout.write(v);
  ')" || return 1
  [[ "$v" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$ ]] || return 1
  printf '%s' "$v"
}

# --- Resolve the target pi-coding-agent version -----------------------------
log "Resolving ${PI_PKG}@${REQUESTED} ..."
PI_VERSION="$(resolve_version "$PI_PKG" "$REQUESTED")" || die "could not resolve ${PI_PKG}@${REQUESTED} -- does that version exist on the npm registry?"
log "Resolved: ${PI_PKG}@${PI_VERSION}"

# --- Read pi-coding-agent's OWN declared pi-tui/typebox deps ----------------
# So the extension and Pi always share exactly one installed copy of each --
# never hand-guessed, never left to drift (see this script's header comment).
DEPS_JSON="$(npm view "${PI_PKG}@${PI_VERSION}" dependencies --json 2>/dev/null || true)"
[ -n "$DEPS_JSON" ] && [ "$DEPS_JSON" != "null" ] || die "could not read ${PI_PKG}@${PI_VERSION}'s dependencies from npm"

PI_TUI_RANGE="$(DEPS_JSON="$DEPS_JSON" PKG="$PI_TUI_PKG" node -e '
  const deps = JSON.parse(process.env.DEPS_JSON);
  const v = deps[process.env.PKG];
  if (!v) process.exit(1);
  process.stdout.write(v);
')" || die "${PI_PKG}@${PI_VERSION} declares no ${PI_TUI_PKG} dependency"

TYPEBOX_RANGE="$(DEPS_JSON="$DEPS_JSON" PKG="$TYPEBOX_PKG" node -e '
  const deps = JSON.parse(process.env.DEPS_JSON);
  const v = deps[process.env.PKG];
  if (!v) process.exit(1);
  process.stdout.write(v);
')" || die "${PI_PKG}@${PI_VERSION} declares no ${TYPEBOX_PKG} dependency"

log "${PI_PKG}@${PI_VERSION} declares ${PI_TUI_PKG}@${PI_TUI_RANGE}, ${TYPEBOX_PKG}@${TYPEBOX_RANGE}"

# Resolve both to concrete versions (ranges like "^1.1.0" aren't valid exact
# pins for docker/reviewer/extension-package.json, which pins exactly).
PI_TUI_VERSION="$(resolve_version "$PI_TUI_PKG" "$PI_TUI_RANGE")" || die "could not resolve ${PI_TUI_PKG}@${PI_TUI_RANGE}"

TYPEBOX_VERSION="$(resolve_version "$TYPEBOX_PKG" "$TYPEBOX_RANGE")" || die "could not resolve ${TYPEBOX_PKG}@${TYPEBOX_RANGE}"

log "Resolved ${PI_TUI_PKG}@${PI_TUI_VERSION}, ${TYPEBOX_PKG}@${TYPEBOX_VERSION}"

# Capture the CURRENTLY pinned pi-coding-agent version (before rewriting
# anything below) so the stale-mentions search at the end has an "old
# version" to look for. Strips a leading ^/~ from the review-extension
# package.json's caret range.
OLD_VERSION="$(PKG_JSON_PATH="$REVIEW_EXT_PKG_JSON" PKG="$PI_PKG" node -e '
  const fs = require("fs");
  const pkg = JSON.parse(fs.readFileSync(process.env.PKG_JSON_PATH, "utf8"));
  const raw = (pkg.dependencies && pkg.dependencies[process.env.PKG]) || "";
  process.stdout.write(raw.replace(/^[\^~]/, ""));
')"

# --- Rewrite packages/review-extension/package.json (caret ranges) ---------
# node -e (not jq -- jq isn't guaranteed present) with JSON.stringify(...,
# null, 2) so 2-space indent is preserved; writes only the three dependency
# fields, leaving everything else in the file untouched.
PKG_JSON_PATH="$REVIEW_EXT_PKG_JSON" \
PI_PKG="$PI_PKG" PI_VERSION="$PI_VERSION" \
PI_TUI_PKG="$PI_TUI_PKG" PI_TUI_RANGE="$PI_TUI_RANGE" \
TYPEBOX_PKG="$TYPEBOX_PKG" TYPEBOX_VERSION="$TYPEBOX_VERSION" \
node -e '
  const fs = require("fs");
  const path = process.env.PKG_JSON_PATH;
  const pkg = JSON.parse(fs.readFileSync(path, "utf8"));
  pkg.dependencies[process.env.PI_PKG] = "^" + process.env.PI_VERSION;
  pkg.dependencies[process.env.PI_TUI_PKG] = process.env.PI_TUI_RANGE;
  pkg.dependencies[process.env.TYPEBOX_PKG] = process.env.TYPEBOX_VERSION;
  fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n");
'
log "Updated ${REVIEW_EXT_PKG_JSON#"$REPO_ROOT"/}"

# --- Rewrite docker/reviewer/extension-package.json (exact pins) -----------
PKG_JSON_PATH="$REVIEWER_EXT_PKG_JSON" \
PI_PKG="$PI_PKG" PI_VERSION="$PI_VERSION" \
PI_TUI_PKG="$PI_TUI_PKG" PI_TUI_VERSION="$PI_TUI_VERSION" \
TYPEBOX_PKG="$TYPEBOX_PKG" TYPEBOX_VERSION="$TYPEBOX_VERSION" \
node -e '
  const fs = require("fs");
  const path = process.env.PKG_JSON_PATH;
  const pkg = JSON.parse(fs.readFileSync(path, "utf8"));
  pkg.dependencies[process.env.PI_PKG] = process.env.PI_VERSION;
  pkg.dependencies[process.env.PI_TUI_PKG] = process.env.PI_TUI_VERSION;
  pkg.dependencies[process.env.TYPEBOX_PKG] = process.env.TYPEBOX_VERSION;
  fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n");
'
log "Updated ${REVIEWER_EXT_PKG_JSON#"$REPO_ROOT"/}"

# --- Refresh package-lock.json ----------------------------------------------
log "Running 'npm install' to refresh package-lock.json ..."
(cd "$REPO_ROOT" && npm install)

# --- Report stale prose mentions of the OLD version -------------------------
echo >&2
if [ -n "$OLD_VERSION" ] && [ "$OLD_VERSION" != "$PI_VERSION" ]; then
  log "Searching for remaining mentions of the old pinned version (${OLD_VERSION}) in docs/comments ..."
  if git -C "$REPO_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    MATCHES="$(cd "$REPO_ROOT" && git grep -n -- "$OLD_VERSION" -- ':!package-lock.json' ':!.chalk' 2>/dev/null || true)"
  else
    MATCHES="$(grep -rn -- "$OLD_VERSION" "$REPO_ROOT" \
      --exclude=package-lock.json --exclude-dir=.chalk --exclude-dir=node_modules --exclude-dir=.git 2>/dev/null || true)"
  fi
  if [ -n "$MATCHES" ]; then
    echo "[bump-pi] The following docs/comments still mention the OLD version (${OLD_VERSION}) -- update them by hand (some claims may no longer even be true at the new version, not just the number):" >&2
    echo "$MATCHES" >&2
  else
    log "No remaining mentions of ${OLD_VERSION} found outside package-lock.json/.chalk."
  fi
else
  log "Pinned version unchanged (already at ${PI_VERSION}) -- nothing to search for."
fi

cat >&2 <<EOF

[bump-pi] Done: pinned ${PI_PKG}@${PI_VERSION} (${PI_TUI_PKG}@${PI_TUI_VERSION}, ${TYPEBOX_PKG}@${TYPEBOX_VERSION}).

Follow-up steps this script does NOT do for you:
  1. Review the pi-coding-agent CHANGELOG between the old and new version for
     breaking changes affecting Magpie (extension API/registerTool, the
     --mode json NDJSON event shapes reviewer.ts parses, the models.json
     baseUrl override entrypoint.sh relies on, CLI flags, --no-session, new
     default behaviours in a sandboxed/network-less container):
       less node_modules/@earendil-works/pi-coding-agent/CHANGELOG.md
  2. Fix anything that breaks, then run the full build + test suite
     (npm run build, npm test, per-workspace typecheck).
  3. Rebuild the reviewer image (./scripts/build-reviewer-image.sh or
     npm run build:reviewer-image) and smoke-test it -- see
     docker/reviewer/README.md's "Smoke-testing a build".
  4. Cut a new reviewer-v* release tag so CI publishes the updated image to
     GHCR (.github/workflows/release-reviewer.yml).
  5. Bump the digest pin (container.image default in
     packages/orchestrator/src/config.ts, config.example.toml, and any other
     live config) to the newly published image's digest, then validate live.
EOF
