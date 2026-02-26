#!/bin/bash
set -euo pipefail

# Flash Loan Arb Bot — launchd wrapper
# Runs from the bot directory, loads .env, starts the scanner

BOT_DIR="/Volumes/Virtual Server/projects/solana-flash-loan/bot"
LOG_DIR="$BOT_DIR/logs"
NODE_BIN="/opt/homebrew/bin/node"
NPX_BIN="/opt/homebrew/bin/npx"

# Ensure log directory exists
mkdir -p "$LOG_DIR"

cd "$BOT_DIR"

# Export PATH so npx/tsx can find node
export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:$PATH"

# Load .env into environment
set -a
source "$BOT_DIR/.env"
set +a

# Start the bot
exec "$NPX_BIN" tsx src/index.ts 2>&1
