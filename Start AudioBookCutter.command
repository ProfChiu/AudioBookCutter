#!/bin/bash
# Double-click this file to launch AudioBookCutter.
# (macOS runs .command files in Terminal. Keep this window open while using
#  the app — closing it stops the app. Press Ctrl+C or close the window to quit.)

# Always run from the folder this script lives in, regardless of where it's launched.
cd "$(dirname "$0")" || exit 1

echo "Starting AudioBookCutter…"

# Stop any leftover dev instance so the port is free.
pkill -f electron-vite 2>/dev/null

# Install dependencies on first run if needed.
if [ ! -d node_modules ]; then
  echo "First run: installing dependencies (this can take a minute)…"
  npm install || { echo "npm install failed"; read -r -p "Press Return to close…"; exit 1; }
fi

# Launch the app.
npm run dev

# Keep the window from vanishing if the app exits with an error.
echo ""
read -r -p "AudioBookCutter has stopped. Press Return to close this window…"
