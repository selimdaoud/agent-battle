#!/usr/bin/env bash
set -e

# ── Check for spaces in path (breaks native module compilation) ───────────────
if [[ "$PWD" == *" "* ]]; then
  echo "Error: the project path contains a space: $PWD" >&2
  echo "Rename the directory to remove spaces (e.g. agent-battle-gpt) and retry." >&2
  exit 1
fi

# ── Check Node.js ─────────────────────────────────────────────────────────────
if ! command -v node &>/dev/null; then
  echo "Error: Node.js is not installed. Please install Node.js 20 LTS from https://nodejs.org" >&2
  exit 1
fi

NODE_MAJOR=$(node -e "process.stdout.write(String(process.versions.node.split('.')[0]))")
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Error: Node.js 20+ required (found v$(node -v | tr -d v))" >&2
  echo "Install Node.js 20 LTS via nvm: nvm install 20 && nvm use 20" >&2
  exit 1
fi

echo "Node.js $(node -v) detected."

# ── Install npm dependencies ───────────────────────────────────────────────────
echo "Installing dependencies..."
npm install

# ── Check for .env ────────────────────────────────────────────────────────────
if [ ! -f .env ]; then
  if [ -f .env.example ]; then
    cp .env.example .env
    echo ""
    echo "Created .env from .env.example — set your OPENAI_API_KEY before starting."
  else
    echo ""
    echo "No .env file found. Create one with at minimum:"
    echo "  OPENAI_API_KEY=sk-..."
    echo "  WS_TOKEN=<random secret>"
  fi
else
  echo ".env already exists, skipping."
fi

echo ""
echo "Done. Start the engine with:"
echo "  npm run api       # engine + WebSocket server"
echo "  npm run dashboard # TUI dashboard (separate terminal)"
