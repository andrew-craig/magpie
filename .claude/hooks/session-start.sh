#!/bin/bash
set -euo pipefail

# Derive paths from script location, independent of env vars
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
TASK_DIR="$PROJECT_DIR/.chalk/scripts"

# Add task script to PATH for this session
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
   Harness supports env file injection — write an absolute path (not $CLAUDE_PROJECT_DIR)
  echo "export PATH=\"$TASK_DIR:\$PATH\"" >> "$CLAUDE_ENV_FILE"
else
  # Fallback: symlink into a directory already on PATH
  LOCAL_BIN="$HOME/.local/bin"
  mkdir -p "$LOCAL_BIN"
  ln -sf "$TASK_DIR/chalk" "$LOCAL_BIN/chalk"
fi