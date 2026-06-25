#!/usr/bin/env bash
# Install agentbus: dependencies + enable the Claude Code module (registers it as
# a user-level MCP server so it is reachable from any directory). Manage modules
# afterwards with `bun run agentbus <list|enable|disable|doctor|uninstall>`.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
command -v bun >/dev/null || { echo "error: bun is required — https://bun.sh"; exit 1; }

echo "==> installing dependencies"
(cd "$REPO" && bun install --silent)

echo "==> enabling the claude-mcp module"
(cd "$REPO" && bun cli.ts enable claude-mcp)
