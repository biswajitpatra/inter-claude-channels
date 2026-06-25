#!/usr/bin/env bash
# Register inter-claude as a user-level MCP server so it is available from any
# directory, then print how to launch a session with the channel enabled.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLAUDE_JSON="$HOME/.claude.json"

command -v bun >/dev/null || { echo "error: bun is required — https://bun.sh"; exit 1; }

echo "==> installing dependencies"
(cd "$REPO" && bun install --silent)

echo "==> registering 'inter-claude' in $CLAUDE_JSON"
[ -f "$CLAUDE_JSON" ] && cp "$CLAUDE_JSON" "$CLAUDE_JSON.bak-inter-claude"
python3 - "$CLAUDE_JSON" "$REPO" <<'PY'
import json, sys, os
path, repo = sys.argv[1], sys.argv[2]
d = json.load(open(path)) if os.path.exists(path) else {}
d.setdefault("mcpServers", {})["inter-claude"] = {
    "command": "bun",
    "args": ["run", "--cwd", repo, "--silent", "start"],
}
json.dump(d, open(path, "w"), indent=2)
print("    ok")
PY

cat <<EOF

Done. Channels are a research-preview feature, so launch a session with:

    INTER_CLAUDE_NAME=frontend claude --dangerously-load-development-channels server:inter-claude

Open a second terminal and start another, e.g. INTER_CLAUDE_NAME=backend, then
ask either one to "list_peers" and "send_message".

Uninstall:  bash scripts/uninstall.sh
EOF
