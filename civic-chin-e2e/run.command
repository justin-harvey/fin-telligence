#!/usr/bin/env bash
# Double-click launcher (macOS / Linux).
# Sets everything up on first run, then opens the Playwright GUI.
set -e
cd "$(dirname "$0")"

echo "============================================"
echo "  CivicChain screen-driver"
echo "============================================"
echo

# 1. Node present?
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js isn't installed. Grab the LTS installer from:"
  echo "    https://nodejs.org"
  echo "then double-click this file again."
  echo
  read -n 1 -s -r -p "Press any key to close..."
  exit 1
fi

# 2. Dependencies
if [ ! -d node_modules ]; then
  echo "First run: installing Playwright (a minute or two)..."
  npm install
fi

# 3. Browser
echo "Making sure the test browser is present..."
npx playwright install chromium

# 4. Config
if [ ! -f .env ]; then
  cp .env.example .env
  echo
  echo ">> Created .env — open it and set BASE_URL to your site's address,"
  echo "   then run this again. (Right-click .env -> Open With -> TextEdit.)"
  echo
  read -n 1 -s -r -p "Press any key to close..."
  exit 0
fi

# 5. Go — opens the graphical test runner
echo
echo "Opening the test runner. Click a test, watch it drive."
echo "Close that window (or press Ctrl+C here) when you're done."
echo
npm run test:ui
