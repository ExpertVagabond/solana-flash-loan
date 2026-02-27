#!/bin/bash
# Flash loan bot launcher for launchd
# Uses node directly (not npx) to avoid orphan child processes

# Wait for VS volume
while [ ! -d "/Volumes/Virtual Server/projects/solana-flash-loan/bot" ]; do
  sleep 30
done

cd "/Volumes/Virtual Server/projects/solana-flash-loan/bot"

# Ensure log directory exists
mkdir -p /tmp/flash-arb-logs

# exec into node directly — no npx wrapper to orphan
exec /opt/homebrew/bin/node \
  --require ./node_modules/tsx/dist/preflight.cjs \
  --import 'file:///Volumes/Virtual%20Server/projects/solana-flash-loan/bot/node_modules/tsx/dist/loader.mjs' \
  src/index.ts
