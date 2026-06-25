#!/usr/bin/env bash
# Diagnose an inter-claude setup: runtime, registration, and live peers.
set -uo pipefail

BUS="${INTER_CLAUDE_HOME:-$HOME/.claude/channels/inter-claude}"
CLAUDE_JSON="$HOME/.claude.json"
ok() { printf '  \033[32m✔\033[0m %s\n' "$1"; }
no() { printf '  \033[31m✗\033[0m %s\n' "$1"; }

echo "inter-claude doctor"
echo "-------------------"

if command -v bun >/dev/null; then ok "bun $(bun --version)"; else no "bun not found (https://bun.sh)"; fi

if command -v claude >/dev/null; then
  ok "claude $(claude --version 2>/dev/null | head -1)  (channels need >= 2.1.80)"
else
  no "claude CLI not found"
fi

if [ -f "$CLAUDE_JSON" ] && python3 -c "import json,sys; sys.exit(0 if 'inter-claude' in json.load(open('$CLAUDE_JSON')).get('mcpServers',{}) else 1)" 2>/dev/null; then
  ok "registered in ~/.claude.json"
else
  no "not registered — run: bash scripts/install.sh"
fi

echo
echo "Live peers (heartbeat within 45s):"
if [ -d "$BUS/peers" ]; then
  now=$(date +%s)
  found=0
  for f in "$BUS"/peers/*.json; do
    [ -e "$f" ] || continue
    python3 - "$f" "$now" <<'PY'
import json, sys, time
f, now = sys.argv[1], int(sys.argv[2])
try:
    p = json.load(open(f))
    age = now - p["lastSeen"] // 1000
    state = "online" if age <= 45 else f"stale ({age}s)"
    print(f"  - {p['name']:20} pid {p['pid']:<7} {state}")
except Exception:
    pass
PY
    found=1
  done
  [ "$found" = 0 ] && echo "  (none)"
else
  echo "  (no bus yet — start a session first)"
fi
