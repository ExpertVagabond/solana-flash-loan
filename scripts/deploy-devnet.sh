#!/usr/bin/env bash
set -euo pipefail

# Deploy flash loan program to Solana devnet
# Requires ~5 SOL for upgradeable deploy, ~2.5 SOL for non-upgradeable (--final)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PROGRAM_SO="$PROJECT_DIR/target/deploy/solana_flash_loan.so"
PROGRAM_KEYPAIR="$PROJECT_DIR/target/deploy/solana_flash_loan-keypair.json"

# Use Agave 3.0 if available
if [ -f "$HOME/.local/share/solana/install/active_release/bin/solana" ]; then
  export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
fi

echo "=== Solana Flash Loan — Devnet Deploy ==="
echo ""

# Check balance
BALANCE=$(solana balance -u devnet --output json 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin))" 2>/dev/null || solana balance -u devnet 2>&1)
echo "Wallet: $(solana address)"
echo "Balance: $BALANCE"

# Check program binary
if [ ! -f "$PROGRAM_SO" ]; then
  echo "ERROR: Program binary not found. Run 'anchor build' first."
  exit 1
fi

SIZE=$(stat -f%z "$PROGRAM_SO" 2>/dev/null || stat -c%s "$PROGRAM_SO")
echo "Binary: $SIZE bytes"
echo ""

# Try non-upgradeable first (cheaper: ~2.5 SOL)
echo "Deploying as NON-UPGRADEABLE (cheaper rent)..."
echo "Run: solana program deploy $PROGRAM_SO --program-id $PROGRAM_KEYPAIR --final -u devnet"
echo ""

solana program deploy "$PROGRAM_SO" \
  --program-id "$PROGRAM_KEYPAIR" \
  --final \
  -u devnet \
  --with-compute-unit-price 0

echo ""
echo "=== Deploy complete ==="
echo "Program ID: $(solana-keygen pubkey "$PROGRAM_KEYPAIR")"
echo ""
echo "Next steps:"
echo "  1. Create test SPL token: spl-token create-token --decimals 6 -u devnet"
echo "  2. Run devnet E2E test or initialize pool via bot"
