#!/usr/bin/env bash
# Fully remove inter-claude from this machine: the MCP registration, the SQLite
# bus (db + WAL/SHM sidecars), wake files, the init lock, and the install
# backup. Pass --yes / -y to skip the confirmation prompt.
#
# The cloned repo itself is left in place — delete it manually if you want.
set -uo pipefail

CLAUDE_JSON="$HOME/.claude.json"
BUS_DIR="${INTER_CLAUDE_HOME:-$HOME/.claude/channels/inter-claude}"
BACKUP="$HOME/.claude.json.bak-inter-claude"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

YES=0
case "${1:-}" in -y | --yes) YES=1 ;; esac

echo "inter-claude uninstall — this will remove:"
echo "  - the 'inter-claude' MCP server from $CLAUDE_JSON"
echo "  - the bus (db, wake files, lock) under $BUS_DIR"
echo "  - the install backup $BACKUP (if present)"
echo

if [ "$YES" != 1 ] && [ -t 0 ]; then
  printf "Proceed? [y/N] "
  read -r ans
  case "$ans" in y | Y | yes | YES) ;; *) echo "Aborted."; exit 0 ;; esac
fi

# Warn if a session is still running the channel (its server keeps going until restart).
if pgrep -f "$REPO" >/dev/null 2>&1; then
  echo "note: a session still has the channel loaded — restart it to fully drop inter-claude."
fi

# 1. de-register the MCP server
if [ -f "$CLAUDE_JSON" ]; then
  python3 - "$CLAUDE_JSON" <<'PY'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
removed = d.get("mcpServers", {}).pop("inter-claude", None)
json.dump(d, open(p, "w"), indent=2)
print("  ✓ removed MCP registration" if removed else "  - MCP registration not present")
PY
else
  echo "  - $CLAUDE_JSON not found"
fi

# 2. remove our bus artifacts (targeted, so a custom INTER_CLAUDE_HOME that holds
#    other files is not wiped); drop the directory only if it ends up empty.
if [ -d "$BUS_DIR" ]; then
  rm -f "$BUS_DIR"/bus.db "$BUS_DIR"/bus.db-wal "$BUS_DIR"/bus.db-shm "$BUS_DIR"/bus.db.init.lock
  rm -rf "$BUS_DIR"/wake
  rmdir "$BUS_DIR" 2>/dev/null && echo "  ✓ removed bus dir $BUS_DIR" || echo "  ✓ removed bus files in $BUS_DIR"
else
  echo "  - bus dir already gone"
fi

# 3. remove the install backup
if [ -f "$BACKUP" ]; then rm -f "$BACKUP" && echo "  ✓ removed install backup"; fi

echo
echo "Done. inter-claude is uninstalled."
echo "Delete the repo too with:  rm -rf \"$REPO\""
