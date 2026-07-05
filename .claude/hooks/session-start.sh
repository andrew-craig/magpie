#!/bin/bash
set -euo pipefail

# Only run in remote Claude environments (e.g. Claude Code Web).
# If chalk is already on PATH, we're in a local environment — nothing to do.
if command -v chalk &>/dev/null; then
  exit 0
fi

curl -fsSL https://raw.githubusercontent.com/andrew-craig/chalk/main/install.sh | bash

echo "export PATH=\"${CHALK_INSTALL_DIR:-$HOME/.local/bin}:\$PATH\"" >> "$CLAUDE_ENV_FILE"

# Install semble tool for code analysis (idempotent)
command -v semble &>/dev/null || uv tool install semble