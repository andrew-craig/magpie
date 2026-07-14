#!/usr/bin/env bash
#
# build-reviewer-image.sh — build the magpie-reviewer container image (M3-A).
#
# NOTE (M7-2): the reviewer image is now PUBLISHED to GHCR
# (ghcr.io/andrew-craig/magpie/reviewer) multi-arch + cosign-signed by release
# CI (.github/workflows/release-reviewer.yml on `reviewer-v*` tags). This script
# is for LOCAL DEVELOPMENT builds only; production pulls the published image.
#
# The build context is the REPO ROOT, not docker/reviewer/, because the
# Dockerfile needs to COPY packages/review-extension/src and
# reviewer-prompt.md, which live outside docker/reviewer/. Idempotent: safe
# to re-run any time (docker layer-caches automatically; re-run after
# changing the extension, the prompt, or the Dockerfile itself to pick up the
# change -- none of those are mounted at run time, see docker/reviewer/README.md).
#
# Usage:
#   ./scripts/build-reviewer-image.sh
#   npm run build:reviewer-image
#
# Env vars (all optional):
#   MAGPIE_REVIEWER_IMAGE_TAG   Image tag to build. Default: magpie-reviewer:0.1.0
#                               (this default MUST match the `container.image`
#                               default in packages/orchestrator/src/config.ts
#                               -- see epic_a580 / task_037b).
#   MAGPIE_REVIEWER_TAG_LATEST  Set to "0" to skip also tagging :latest.
#                               Default: "1" (also tag :latest).
#   DOCKER_BIN                  docker CLI to use. Default: docker.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOCKERFILE="$REPO_ROOT/docker/reviewer/Dockerfile"

IMAGE_TAG="${MAGPIE_REVIEWER_IMAGE_TAG:-magpie-reviewer:0.1.0}"
TAG_LATEST="${MAGPIE_REVIEWER_TAG_LATEST:-1}"
DOCKER_BIN="${DOCKER_BIN:-docker}"

if ! command -v "$DOCKER_BIN" >/dev/null 2>&1; then
  echo "error: '$DOCKER_BIN' not found on PATH -- is docker installed?" >&2
  exit 1
fi

echo "Building $IMAGE_TAG (context: $REPO_ROOT, dockerfile: $DOCKERFILE)"
"$DOCKER_BIN" build -t "$IMAGE_TAG" -f "$DOCKERFILE" "$REPO_ROOT"

if [ "$TAG_LATEST" = "1" ]; then
  IMAGE_REPO="${IMAGE_TAG%%:*}"
  echo "Tagging ${IMAGE_REPO}:latest -> $IMAGE_TAG"
  "$DOCKER_BIN" tag "$IMAGE_TAG" "${IMAGE_REPO}:latest"
fi

echo "Built $IMAGE_TAG"
