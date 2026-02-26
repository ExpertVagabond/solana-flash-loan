"""Token mint addresses, decimals, and pair utilities."""

WELL_KNOWN_MINTS: dict[str, str] = {
    # Major
    "SOL": "So11111111111111111111111111111111111111112",
    "USDC": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "USDT": "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    # DeFi blue chips
    "JUP": "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
    "RAY": "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",
    "ORCA": "orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE",
    "PYTH": "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3",
    "RENDER": "rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof",
    "HNT": "hntyVP6YFm1Hg25TN9WGLqM12b8TQmcknKrdu1oxWux",
    "W": "85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ",
    "TNSR": "TNSRxcUxoT9xBG3de7PiJyTDYu7kskLqcpddxnEJAS6",
    "JTO": "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL",
    # LSTs
    "MSOL": "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",
    "JITOSOL": "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn",
    "BSOL": "bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1",
    "INF": "5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm",
    # Meme / high volume
    "BONK": "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
    "WIF": "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm",
    "POPCAT": "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr",
    "MEW": "MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5",
    "TRUMP": "6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN",
    "FARTCOIN": "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump",
    # Mid liquidity
    "KMNO": "KMNo3nJsBXfcpJTVhZcXLW7RmTwTt4GVFE7suUBo9sS",
    "DRIFT": "DriFtupJYLTosbwoN8koMbEYSx54aFAVLddWsbksjwg7",
    # Low liquidity
    "SAMO": "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
    "MNDE": "MNDEFzGvMt87ueuHvVU9VcTqsAP5b3fTGPsHuuPA5ey",
    "STEP": "StepAscQoEioFxxWGnh2sLBDFp9d8rvKz2Yp39iDpyT",
    "SHDW": "SHDWyBxihqiCj6YekG2GUr7wqKLeLAMK1gHZck9pL6y",
    "DUST": "DUSTawucrTsGU8hcqRdHDCbuYhCPADMLM2VcCb8VnFnQ",
    "BLZE": "BLZEEuZUBVqFhj8adcCFPJvPVCiCyVmh3hkJMrU8KuJA",
    "ZEUS": "ZEUS1aR7aX8DFFJf5QjWj2ftDDdNTroMNGo8YoQm3Gq",
    "WEN": "WENWENvqqNya429ubCdR81ZmD69brwQaaBYY6p3LCpk",
    "BOME": "ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82",
    "SLERF": "7BgBvyjrZX1YKz4oh9mjb8ZScatkkwb8DzFx7LoiVkM3",
    "SILLY": "7EYnhQoR9YM3N7UoaKRoA44Uy8JeaZV3qyouov87awMs",
    "AI16Z": "HeLp6NuQkmYB4pYWo2zYs22mESHXPQYzXbB8n4V98jwC",
}

TOKEN_DECIMALS: dict[str, int] = {
    "SOL": 9, "USDC": 6, "USDT": 6, "JUP": 6, "RAY": 6, "ORCA": 6,
    "PYTH": 6, "RENDER": 8, "HNT": 8, "W": 6, "TNSR": 9, "JTO": 9,
    "MSOL": 9, "JITOSOL": 9, "BSOL": 9, "INF": 9, "BONK": 5, "WIF": 6,
    "POPCAT": 9, "MEW": 5, "TRUMP": 6, "FARTCOIN": 6, "SAMO": 9,
    "MNDE": 9, "STEP": 9, "SHDW": 9, "DUST": 9, "BLZE": 9, "KMNO": 6,
    "DRIFT": 6, "ZEUS": 6, "WEN": 5, "BOME": 6, "SLERF": 9, "SILLY": 6,
    "AI16Z": 9,
}

# Per-pair borrow overrides keyed by first 8 chars of TARGET mint
# Value = borrow amount in USDC smallest units (0 = use default)
PAIR_BORROW_OVERRIDES: dict[str, int] = {
    # Deep liquidity — full borrow ($200)
    "So111111": 0,  # SOL
    "Es9vMFrz": 0,  # USDT
    # High liquidity — $100
    "JUPyiwrY": 100_000_000,  # JUP
    "4k3Dyjzv": 100_000_000,  # RAY
    "orcaEKTd": 100_000_000,  # ORCA
    "mSoLzYCx": 100_000_000,  # mSOL
    "J1toso1u": 100_000_000,  # jitoSOL
    "jtojtome": 100_000_000,  # JTO
    "rndrizKT": 100_000_000,  # RENDER
    "85VBFQZC": 100_000_000,  # W
    # Moderate liquidity — $50
    "EKpQGSJt": 50_000_000,   # WIF
    "HZ1JovNi": 50_000_000,   # PYTH
    "hntyVP6Y": 50_000_000,   # HNT
    "TNSRxcUx": 50_000_000,   # TNSR
    "bSo13r4T": 50_000_000,   # bSOL
    "5oVNBeEE": 50_000_000,   # INF
    "KMNo3nJs": 50_000_000,   # KMNO
    "DriFtupJ": 50_000_000,   # DRIFT
    # Meme / volatile — $20
    "DezXAZ8z": 20_000_000,   # BONK
    "7GCihgDB": 20_000_000,   # POPCAT
    "MEW1gQWJ": 20_000_000,   # MEW
    "6p6xgHyF": 20_000_000,   # TRUMP
    "9BB6NFEc": 20_000_000,   # FARTCOIN
    "ukHH6c7m": 20_000_000,   # BOME
    "7BgBvyjr": 20_000_000,   # SLERF
    "WENWENvq": 20_000_000,   # WEN
    # Low liquidity — $10
    "7xKXtg2C": 10_000_000,   # SAMO
    "MNDEFzGv": 10_000_000,   # MNDE
    "StepAscQ": 10_000_000,   # STEP
    "SHDWyBxi": 10_000_000,   # SHDW
    "DUSTawuc": 10_000_000,   # DUST
    "BLZEEuZU": 10_000_000,   # BLZE
    "ZEUS1aR7": 10_000_000,   # ZEUS
    "7EYnhQoR": 10_000_000,   # SILLY
    "HeLp6NuQ": 10_000_000,   # AI16Z
}


def resolve_mint(symbol_or_mint: str) -> str:
    return WELL_KNOWN_MINTS.get(symbol_or_mint.upper(), symbol_or_mint)


def resolve_decimals(symbol_or_mint: str) -> int:
    return TOKEN_DECIMALS.get(symbol_or_mint.upper(), 6)


def parse_pair(pair: str) -> tuple[str, str]:
    """Parse 'TARGET/QUOTE' into (target_mint, quote_mint)."""
    parts = pair.split("/")
    if len(parts) != 2:
        raise ValueError(f"Invalid pair format: {pair}. Expected 'TOKEN_A/TOKEN_B'")
    return resolve_mint(parts[0]), resolve_mint(parts[1])


def get_borrow_override(target_mint: str) -> int:
    """Get per-pair borrow amount override. Returns 0 if no override (use default)."""
    prefix = target_mint[:8]
    return PAIR_BORROW_OVERRIDES.get(prefix, 0)
