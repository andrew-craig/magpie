#!/usr/bin/env bash
#
# pack-host.sh — assemble the HOST-SERVICE release artifact (M7-3, task_d54c).
#
# Packages the two host systemd services — @magpie/orchestrator and
# @magpie/gateway — as a versioned tarball: prebuilt `dist/**` plus a lockfile
# pruned to exactly those two workspaces. The reviewer container
# (packages/review-extension + its @earendil-works/* dependencies) is NOT a
# host service and is deliberately EXCLUDED from this artifact — it ships
# separately as a published container image (see release-reviewer.yml /
# DISTRIBUTION.md §2/§3.1).
#
# This is the SINGLE code path for producing the release tarball: both local
# dev and CI (.github/workflows/release-host.yml) call this script. The
# adopter host does NOT run TypeScript at all — dist is prebuilt into the
# tarball; the adopter only runs `npm ci --omit=dev` to materialize
# node_modules for the two pure-JS workspaces (no native modules, so the
# tarball is architecture-independent).
#
# Usage:
#   npm run build && npm run gateway:build   # build first -- this script does not build
#   bash scripts/pack-host.sh [version]
#
#   version   Plain semver, e.g. 0.3.0 (a leading 'v' is stripped if given).
#             Defaults to `git describe --tags` (v-stripped), falling back to
#             the root package.json version if that fails (e.g. no tags, or
#             not a git checkout at all).
#
# Output:
#   dist-release/magpie-<version>.tar.gz
#   dist-release/magpie-<version>.tar.gz.sha256
#
# The tarball unpacks to a single top-level `magpie-<version>/` directory that
# mirrors the parts of the repo scripts/install.sh needs, so install.sh runs
# unchanged from inside an unpacked tarball.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

log()  { printf '[pack-host] %s\n' "$*"; }
die()  { printf '[pack-host] ERROR: %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# 1. Resolve the version.
# ---------------------------------------------------------------------------

VERSION="${1:-}"
if [[ -z "$VERSION" ]]; then
  if VERSION="$(cd "$REPO_ROOT" && git describe --tags 2>/dev/null)"; then
    :
  else
    VERSION="$(node -p "require('$REPO_ROOT/package.json').version" 2>/dev/null)" \
      || die "could not derive a version: no arg given, 'git describe --tags' failed, and reading package.json version failed"
    log "no version arg and no git tags — falling back to root package.json version: $VERSION"
  fi
fi
VERSION="${VERSION#v}"

[[ -n "$VERSION" ]] || die "resolved an empty version"

log "packaging version: $VERSION"

# ---------------------------------------------------------------------------
# 2. Preconditions: both packages must already be built.
# ---------------------------------------------------------------------------

ORCH_ENTRY="$REPO_ROOT/packages/orchestrator/dist/index.js"
GW_ENTRY="$REPO_ROOT/packages/gateway/dist/index.js"

[[ -f "$ORCH_ENTRY" ]] || die "missing $ORCH_ENTRY — run 'npm run build' first"
[[ -f "$GW_ENTRY" ]]   || die "missing $GW_ENTRY — run 'npm run gateway:build' first"

for f in systemd/magpie.service systemd/magpie-gateway.service scripts/install.sh \
         config.example.toml LICENSE INSTALL.md package-lock.json; do
  [[ -f "$REPO_ROOT/$f" ]] || die "missing required repo file: $f"
done

command -v npm >/dev/null 2>&1 || die "npm not found on PATH"
command -v node >/dev/null 2>&1 || die "node not found on PATH"

# ---------------------------------------------------------------------------
# 3. Stage.
# ---------------------------------------------------------------------------

OUT_DIR="$REPO_ROOT/dist-release"
mkdir -p "$OUT_DIR"

STAGE_PARENT="$(mktemp -d)"
trap 'rm -rf "$STAGE_PARENT"' EXIT

STAGE_NAME="magpie-$VERSION"
STAGE="$STAGE_PARENT/$STAGE_NAME"
mkdir -p "$STAGE"

log "staging tree: $STAGE"

# -- packages/orchestrator: dist + package.json only (no src, no node_modules)
mkdir -p "$STAGE/packages/orchestrator"
cp -a "$REPO_ROOT/packages/orchestrator/dist" "$STAGE/packages/orchestrator/dist"
cp "$REPO_ROOT/packages/orchestrator/package.json" "$STAGE/packages/orchestrator/package.json"

# -- packages/gateway: dist + package.json only
mkdir -p "$STAGE/packages/gateway"
cp -a "$REPO_ROOT/packages/gateway/dist" "$STAGE/packages/gateway/dist"
cp "$REPO_ROOT/packages/gateway/package.json" "$STAGE/packages/gateway/package.json"

# -- systemd units, install.sh, example config, license, docs
mkdir -p "$STAGE/systemd" "$STAGE/scripts"
cp "$REPO_ROOT/systemd/magpie.service" "$STAGE/systemd/magpie.service"
cp "$REPO_ROOT/systemd/magpie-gateway.service" "$STAGE/systemd/magpie-gateway.service"
cp "$REPO_ROOT/scripts/install.sh" "$STAGE/scripts/install.sh"
chmod +x "$STAGE/scripts/install.sh"
cp "$REPO_ROOT/config.example.toml" "$STAGE/config.example.toml"
cp "$REPO_ROOT/LICENSE" "$STAGE/LICENSE"
cp "$REPO_ROOT/INSTALL.md" "$STAGE/INSTALL.md"

# -- root package.json: same file, but workspaces trimmed to the two host
# services (review-extension excluded) and dev-only build/reviewer-image
# scripts dropped since the adopter host never runs tsc or builds the image.
# shellcheck disable=SC2016 # single-quoted on purpose: this is a literal JS
# script passed via process.argv below, not a shell variable expansion.
node -e '
const fs = require("fs");
const path = require("path");
const repoRoot = process.argv[1];
const stage = process.argv[2];
const version = process.argv[3];

const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));

pkg.version = version;
pkg.workspaces = ["packages/orchestrator", "packages/gateway"];
pkg.private = true;
pkg.type = "module";

// Keep only the scripts that make sense on an adopter host running the
// prebuilt tarball: starting the two services. Drop build/dev/smee/
// reviewer-image scripts (dev-only, or reference review-extension /
// docker tooling not shipped here).
pkg.scripts = {
  start: pkg.scripts.start,
  "gateway:start": pkg.scripts["gateway:start"],
};

// No devDependencies on the adopter host at all -- npm ci --omit=dev.
delete pkg.devDependencies;

fs.writeFileSync(
  path.join(stage, "package.json"),
  JSON.stringify(pkg, null, 2) + "\n",
);
' "$REPO_ROOT" "$STAGE" "$VERSION"

log "wrote staged root package.json (workspaces: orchestrator, gateway only)"

# ---------------------------------------------------------------------------
# 4. Pruned package-lock.json.
# ---------------------------------------------------------------------------
#
# Start from the repo's own committed lockfile (so orchestrator/gateway deps
# resolve to the exact versions already vetted/committed) and let npm
# reconcile it to the trimmed root package.json's workspace set. This drops
# every package.json entry, packages entry, and dependency subtree that only
# review-extension (or the root devDependencies) needed --
# --package-lock-only means npm edits the lockfile without touching
# node_modules or actually installing anything.

cp "$REPO_ROOT/package-lock.json" "$STAGE/package-lock.json"

(
  cd "$STAGE"
  npm install --package-lock-only --omit=dev >/dev/null
)

log "pruned package-lock.json in staging"

# Verify: no @earendil-works / review-extension leakage.
# shellcheck disable=SC2016 # single-quoted on purpose: literal JS, args via process.argv.
if node -e '
  const lock = require(process.argv[1]);
  const bad = Object.keys(lock.packages || {}).filter((k) =>
    k.includes("@earendil-works") || k.includes("review-extension"),
  );
  process.exit(bad.length ? 1 : 0);
' "$STAGE/package-lock.json"; then
  log "verified: pruned lockfile has no @earendil-works / review-extension entries"
else
  die "pruned package-lock.json still references @earendil-works or review-extension -- refusing to ship"
fi

# Verify: orchestrator/gateway dependency versions are unchanged vs the
# source (committed) lockfile -- npm must not have drifted anything while
# reconciling. Compare the resolved "version" field for every package whose
# key does NOT start with "node_modules/@earendil-works" or reference
# review-extension (those are expected to disappear, not just their versions
# to differ).
# shellcheck disable=SC2016 # single-quoted on purpose: literal JS, args via process.argv.
node -e '
  const fs = require("fs");
  const src = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const pruned = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));

  const isExcluded = (key) =>
    key.includes("@earendil-works") || key.includes("review-extension");

  const drifted = [];
  for (const [key, prunedEntry] of Object.entries(pruned.packages || {})) {
    if (isExcluded(key)) continue;
    const srcEntry = src.packages ? src.packages[key] : undefined;
    if (!srcEntry) continue; // new key with no source counterpart -- not a drift of an existing dep
    if (srcEntry.version !== undefined && prunedEntry.version !== srcEntry.version) {
      drifted.push(`${key}: source=${srcEntry.version} pruned=${prunedEntry.version}`);
    }
  }

  if (drifted.length) {
    console.error("DRIFT DETECTED:");
    for (const d of drifted) console.error("  " + d);
    process.exit(1);
  }
' "$REPO_ROOT/package-lock.json" "$STAGE/package-lock.json" \
  || die "npm drifted one or more orchestrator/gateway dependency versions while pruning the lockfile -- refusing to ship a drifted lockfile"

log "verified: orchestrator/gateway dependency versions unchanged vs source lockfile"

# ---------------------------------------------------------------------------
# 5. Archive + checksum.
# ---------------------------------------------------------------------------

TARBALL="$OUT_DIR/magpie-$VERSION.tar.gz"
SHAFILE="$TARBALL.sha256"

tar czf "$TARBALL" -C "$STAGE_PARENT" "$STAGE_NAME"

(
  cd "$OUT_DIR"
  sha256sum "$(basename "$TARBALL")" > "$(basename "$SHAFILE")"
)

log "wrote $TARBALL"
log "wrote $SHAFILE"
log "sha256: $(cut -d' ' -f1 "$SHAFILE")"
