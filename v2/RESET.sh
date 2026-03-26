#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo ""
echo "=========================================="
echo "  agent-battle-gpt v2 — FULL RESET"
echo "=========================================="
echo ""
echo "This will permanently delete:"
echo "  • All trade history (events.db)"
echo "  • All agent states (capital, positions)"
echo "  • All adaptation posteriors"
echo "  • All config backups (keeps base configs)"
echo "  • Performance state"
echo ""
read -rp "Type RESET to confirm: " confirmation

if [ "$confirmation" != "RESET" ]; then
  echo "Aborted."
  exit 1
fi

echo ""

# ── Stop engine if running ────────────────────────────────────────────────────

ENGINE_PID=$(lsof -ti tcp:3001 2>/dev/null || true)
if [ -n "$ENGINE_PID" ]; then
  echo "→ Stopping engine (pid $ENGINE_PID)..."
  kill "$ENGINE_PID" 2>/dev/null || true
  sleep 1
  echo "  Engine stopped."
else
  echo "→ Engine not running."
fi

# ── Delete event database ─────────────────────────────────────────────────────

echo "→ Removing event database..."
rm -f "$DIR/data/events.db"
rm -f "$DIR/data/events.db-shm"
rm -f "$DIR/data/events.db-wal"

# ── Delete agent states ───────────────────────────────────────────────────────

echo "→ Removing agent states..."
rm -f "$DIR/data/agent-states/"*.json

# ── Delete adaptation posteriors ──────────────────────────────────────────────

echo "→ Removing adaptation posteriors..."
rm -f "$DIR/data/posteriors/posteriors.json"

# ── Delete performance state ──────────────────────────────────────────────────

echo "→ Removing performance state..."
rm -f "$DIR/data/perf-state.json"

# ── Remove config backups (keep active agent-*.json) ─────────────────────────

echo "→ Removing config backups..."
find "$DIR/data/configs" -name "agent-*.v[0-9]*.json" -delete

# ── Reset active agent configs to defaults ────────────────────────────────────

echo "→ Resetting agent configs to version 0..."
for f in "$DIR/data/configs/agent-"*.json; do
  # Only process files that don't have a version timestamp in the name
  [[ "$f" =~ \.v[0-9]+\. ]] && continue
  # Reset version to 0, keep config and personality as-is
  node -e "
    const fs   = require('fs');
    const data = JSON.parse(fs.readFileSync('$f', 'utf8'));
    data.version = 0;
    data.reason  = 'reset';
    fs.writeFileSync('$f', JSON.stringify(data, null, 2));
  "
done

echo ""
echo "=========================================="
echo "  Reset complete."
echo "  Run: npm start"
echo "=========================================="
echo ""
