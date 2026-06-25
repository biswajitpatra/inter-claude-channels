#!/usr/bin/env bash
# Remove the inter-claude MCP registration and the shared bus directory.
set -euo pipefail

CLAUDE_JSON="$HOME/.claude.json"
BUS="${INTER_CLAUDE_HOME:-$HOME/.claude/channels/inter-claude}"

echo "==> removing 'inter-claude' from $CLAUDE_JSON"
if [ -f "$CLAUDE_JSON" ]; then
  python3 - "$CLAUDE_JSON" <<'PY'
import json, sys
path = sys.argv[1]
d = json.load(open(path))
removed = d.get("mcpServers", {}).pop("inter-claude", None)
json.dump(d, open(path, "w"), indent=2)
print("    removed" if removed else "    (not present)")
PY
fi

echo "==> removing bus directory $BUS"
rm -rf "$BUS" && echo "    ok"

echo "Done. Restart any running sessions to drop the channel."
