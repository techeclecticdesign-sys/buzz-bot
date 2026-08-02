#!/bin/bash
# RPC Logger Bot launcher (macOS) -- double-click to run.
# Backfills recent history once, then starts the bot and keeps it alive,
# restarting it automatically if it crashes. Close this window to stop.
#
# One-time setup on a Mac (Finder won't run it until it's executable):
#   chmod +x start-bot.command

# Common install locations, in case Finder launches us with a bare PATH
# (official Node installer -> /usr/local/bin, Homebrew on Apple Silicon
# -> /opt/homebrew/bin). nvm users: run it from a terminal instead.
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"

cd "$(dirname "$0")" || exit 1

pause_and_exit() {
  echo
  read -n1 -s -r -p "Press any key to close this window..."
  exit 1
}

# --- Node installed? ---
if ! command -v node >/dev/null 2>&1; then
  echo
  echo "ERROR: Node.js was not found on this machine."
  echo "Install Node 18 or newer from https://nodejs.org then double-click this file again."
  pause_and_exit
fi

# --- config present? ---
if [ ! -f .env ]; then
  echo
  echo "ERROR: .env not found in this folder."
  echo "Copy .env.example to .env and fill in your token / database URL first."
  pause_and_exit
fi

# --- first run: install dependencies ---
if [ ! -d node_modules ]; then
  echo "First run: installing dependencies, this may take a minute..."
  if ! npm install; then
    echo
    echo "npm install failed -- see the messages above."
    pause_and_exit
  fi
fi

# --- backfill recent history once ---
echo "Backfilling recent history..."
npm run backfill

# --- run the bot, restarting if it crashes ---
while true; do
  echo
  echo "Starting bot..."
  npm start
  echo
  echo "Bot stopped. Restarting in 5s -- close this window to stop."
  sleep 5
done
