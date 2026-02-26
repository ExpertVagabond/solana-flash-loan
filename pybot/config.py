"""Bot configuration — loaded from .env or environment variables."""

import os
from pathlib import Path
from dataclasses import dataclass, field
from dotenv import load_dotenv

# Load .env from the TypeScript bot dir (shared config)
_env_path = Path(__file__).parent.parent / "bot" / ".env"
if _env_path.exists():
    load_dotenv(_env_path)


@dataclass
class BotConfig:
    rpc_url: str = ""
    ws_url: str = ""
    wallet_path: str = ""
    flash_loan_program_id: str = "2chVPk6DV21qWuyUA2eHAzATdFSHM7ykv1fVX7Gv6nor"
    flash_loan_token_mint: str = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
    borrow_amount: int = 200_000_000  # 200 USDC (6 decimals)
    pairs: list[str] = field(default_factory=list)
    min_profit_bps: int = 5
    max_slippage_bps: int = 50
    poll_interval_ms: int = 15_000
    dry_run: bool = True
    priority_fee_micro_lamports: int = 25_000
    compute_unit_limit: int = 400_000
    max_consecutive_failures: int = 10
    # Jito
    use_jito: bool = False
    jito_region: str = "default"
    jito_tip_lamports: int = 10_000
    # Jupiter
    jupiter_api_key: str = ""
    # Raydium
    use_raydium: bool = True


def load_config() -> BotConfig:
    env = os.environ

    rpc_url = env.get("RPC_URL", "")
    if not rpc_url:
        raise ValueError("RPC_URL is required")

    pairs_raw = env.get("PAIRS", "SOL/USDC")
    pairs = [p.strip() for p in pairs_raw.split(",") if p.strip()]

    return BotConfig(
        rpc_url=rpc_url,
        ws_url=env.get("WS_URL", ""),
        wallet_path=env.get(
            "WALLET_PATH", str(Path.home() / ".config" / "solana" / "id.json")
        ),
        flash_loan_program_id=env.get(
            "FLASH_LOAN_PROGRAM_ID",
            "2chVPk6DV21qWuyUA2eHAzATdFSHM7ykv1fVX7Gv6nor",
        ),
        flash_loan_token_mint=env.get(
            "FLASH_LOAN_TOKEN_MINT",
            "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        ),
        borrow_amount=int(env.get("BORROW_AMOUNT", "200000000")),
        pairs=pairs,
        min_profit_bps=int(env.get("MIN_PROFIT_BPS", "5")),
        max_slippage_bps=int(env.get("MAX_SLIPPAGE_BPS", "50")),
        poll_interval_ms=int(env.get("POLL_INTERVAL_MS", "15000")),
        dry_run=env.get("DRY_RUN", "true").lower() == "true",
        priority_fee_micro_lamports=int(env.get("PRIORITY_FEE", "25000")),
        compute_unit_limit=int(env.get("COMPUTE_UNIT_LIMIT", "400000")),
        max_consecutive_failures=int(env.get("MAX_CONSECUTIVE_FAILURES", "10")),
        use_jito=env.get("USE_JITO", "false").lower() == "true",
        jito_region=env.get("JITO_REGION", "default"),
        jito_tip_lamports=int(env.get("JITO_TIP_LAMPORTS", "10000")),
        jupiter_api_key=env.get("JUPITER_API_KEY", ""),
        use_raydium=env.get("USE_RAYDIUM", "true").lower() != "false",
    )
