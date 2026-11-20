#!/usr/bin/env bash
# Single-command local Linux startup, with real website verification before
# the dashboard is launched. Fails rather than claiming unverified connectivity.
set -Eeuo pipefail
cd "$(dirname "$0")/.."

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "BrowserBro requires Node.js 22+ and npm to be installed." >&2
  exit 1
fi
if [[ ! -d node_modules/playwright ]]; then
  echo "[BrowserBro] Installing locked npm dependencies..."
  npm ci
fi

echo "[BrowserBro] Checking/installing local Chromium..."
npx playwright install chromium
echo "[BrowserBro] Running terminal unit tests..."
npm run terminal-test
echo "[BrowserBro] Verifying public DNS + real Chromium URL loading from this Linux machine..."
npm run verify:public
echo "[BrowserBro] Public URL loading verified; starting private local dashboard."
exec npm start
