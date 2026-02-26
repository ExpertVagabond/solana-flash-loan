"""Wallet loading — reads Solana keypair from JSON file."""

import json
from pathlib import Path

from solders.keypair import Keypair


def load_keypair(wallet_path: str) -> Keypair:
    resolved = Path(wallet_path).expanduser().resolve()
    if not resolved.exists():
        raise FileNotFoundError(f"Wallet file not found: {resolved}")

    secret = json.loads(resolved.read_text())
    return Keypair.from_bytes(bytes(secret))
