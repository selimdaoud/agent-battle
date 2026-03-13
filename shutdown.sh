#!/usr/bin/env bash
# shutdown.sh — send graceful shutdown command to the running api.js engine
# Usage: npm run shutdown   OR   ./shutdown.sh

set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"

# Load .env for WS_TOKEN and PORT
if [ -f "$ROOT/.env" ]; then
  export $(grep -v '^#' "$ROOT/.env" | xargs)
fi

HOST="${ABG_HOST:-localhost}"
PORT="${PORT:-3000}"
TOKEN="${WS_TOKEN:-}"

echo "── Shutdown agent-battle-gpt engine ──"
echo "Target: http://${HOST}:${PORT}"
echo ""
printf "Type SHUTDOWN to confirm: "
read -r CONFIRM
if [ "$CONFIRM" != "SHUTDOWN" ]; then
  echo "Aborted."
  exit 1
fi
echo ""

RESPONSE=$(curl -s -o /tmp/abg-shutdown.json -w "%{http_code}" \
  -X POST "http://${HOST}:${PORT}/command" \
  -H "Content-Type: application/json" \
  -d "{\"command\":\"shutdown\",\"token\":\"${TOKEN}\"}")

if [ "$RESPONSE" = "200" ]; then
  echo "✓ Shutdown command accepted — engine stopping"
  cat /tmp/abg-shutdown.json
  echo ""
else
  echo "✗ Failed (HTTP $RESPONSE)"
  cat /tmp/abg-shutdown.json
  echo ""
  exit 1
fi
