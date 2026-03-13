#!/usr/bin/env bash
# reset.sh — wipe DB, session files, and event log for a clean slate
# Usage: npm run reset   OR   ./reset.sh

set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"
DB="$ROOT/data/sim.db"
SESSIONS="$ROOT/sessions"

echo "── Reset agent-battle-gpt ──"
echo "This will permanently delete all sessions, DB ticks, and event logs."
echo ""
printf "Type RESET to confirm: "
read -r CONFIRM
if [ "$CONFIRM" != "RESET" ]; then
  echo "Aborted."
  exit 1
fi
echo ""

# 1. DB — clear ticks and reset round counter + MEGA persistent state
if [ -f "$DB" ]; then
  node -e "
    const db = require('better-sqlite3')('$DB')
    db.exec('DELETE FROM ticks')
    db.prepare(\"UPDATE config SET value='0' WHERE key='current_round'\").run()
    db.prepare(\"DELETE FROM config WHERE key='mega_state'\").run()
    db.close()
    console.log('✓ DB cleared (ticks + current_round + mega_state)')
  "
else
  echo "  (no sim.db — will be created fresh on next start)"
fi

# 2. Session files
rm -f "$SESSIONS"/session-*.json \
       "$SESSIONS"/session-*.analysis.json \
       "$SESSIONS"/session-*.meta.json \
       "$SESSIONS"/session-*.report.md \
       "$SESSIONS"/latest-diff.md \
       "$SESSIONS"/trends.json \
       "$SESSIONS"/change-history.json
echo "✓ Session files cleared"

# 3. Event log
rm -f "$SESSIONS/events.jsonl"
echo "✓ Event log cleared"

# 4. Pending MEGA proposal
rm -f "$ROOT/agents/mega-changes-proposed.json"
echo "✓ Pending proposals cleared"

echo "── Reset complete — ready for a fresh session ──"
