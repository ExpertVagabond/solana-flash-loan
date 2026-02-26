"""Direct on-chain pool decoders — read AMM pool state from raw account data.

Supports:
  - Raydium CLMM (Concentrated Liquidity)
  - Raydium AMM v4 (Standard AMM)
  - Orca Whirlpool
  - Meteora DLMM

Each decoder reads raw bytes from getAccountInfo and extracts:
  - Current price
  - Token mints
  - Token vault addresses
  - Liquidity / reserves
"""

import struct
import math
from dataclasses import dataclass
from typing import Optional

from solders.pubkey import Pubkey
from loguru import logger

# ── Program IDs ──

RAYDIUM_CLMM_PROGRAM = Pubkey.from_string("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK")
RAYDIUM_AMM_V4_PROGRAM = Pubkey.from_string("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8")
ORCA_WHIRLPOOL_PROGRAM = Pubkey.from_string("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc")
METEORA_DLMM_PROGRAM = Pubkey.from_string("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo")


@dataclass
class PoolState:
    """Unified pool state across all AMM types."""
    pool_address: str
    dex: str  # "raydium_clmm", "raydium_v4", "orca", "meteora"
    token_mint_a: str
    token_mint_b: str
    token_vault_a: str
    token_vault_b: str
    price: float  # token_b per token_a (e.g., USDC per SOL)
    liquidity: int
    # Raw values for precise math
    sqrt_price_x64: int = 0  # CLMM/Whirlpool
    reserve_a: int = 0  # AMM v4 / Meteora
    reserve_b: int = 0
    tick: int = 0
    fee_rate: int = 0  # in bps or basis points


def _read_pubkey(data: bytes, offset: int) -> str:
    return str(Pubkey.from_bytes(data[offset:offset + 32]))


def _read_u8(data: bytes, offset: int) -> int:
    return data[offset]


def _read_u16(data: bytes, offset: int) -> int:
    return struct.unpack_from("<H", data, offset)[0]


def _read_i32(data: bytes, offset: int) -> int:
    return struct.unpack_from("<i", data, offset)[0]


def _read_u64(data: bytes, offset: int) -> int:
    return struct.unpack_from("<Q", data, offset)[0]


def _read_u128(data: bytes, offset: int) -> int:
    lo = struct.unpack_from("<Q", data, offset)[0]
    hi = struct.unpack_from("<Q", data, offset + 8)[0]
    return (hi << 64) | lo


# ──────────────────────────────────────────
# Raydium CLMM (Concentrated Liquidity)
# Program: CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK
# ──────────────────────────────────────────

# PoolState layout (packed, after 8-byte Anchor discriminator):
# offset  8: bump (u8)
# offset  9: amm_config (Pubkey, 32)
# offset 41: owner (Pubkey, 32)
# offset 73: token_mint_0 (Pubkey, 32)
# offset 105: token_mint_1 (Pubkey, 32)
# offset 137: token_vault_0 (Pubkey, 32)
# offset 169: token_vault_1 (Pubkey, 32)
# offset 201: observation_key (Pubkey, 32)
# offset 233: mint_decimals_0 (u8)
# offset 234: mint_decimals_1 (u8)
# offset 235: tick_spacing (u16)
# offset 237: liquidity (u128, 16)
# offset 253: sqrt_price_x64 (u128, 16)
# offset 269: tick_current (i32)

def decode_raydium_clmm(data: bytes, pool_address: str) -> Optional[PoolState]:
    """Decode Raydium CLMM PoolState from raw account data."""
    if len(data) < 273:
        return None

    token_mint_0 = _read_pubkey(data, 73)
    token_mint_1 = _read_pubkey(data, 105)
    token_vault_0 = _read_pubkey(data, 137)
    token_vault_1 = _read_pubkey(data, 169)
    decimals_0 = _read_u8(data, 233)
    decimals_1 = _read_u8(data, 234)
    liquidity = _read_u128(data, 237)
    sqrt_price_x64 = _read_u128(data, 253)
    tick_current = _read_i32(data, 269)

    # Price = (sqrt_price_x64 / 2^64)^2 * 10^(decimals_0 - decimals_1)
    price = sqrt_price_x64_to_price(sqrt_price_x64, decimals_0, decimals_1)

    return PoolState(
        pool_address=pool_address,
        dex="raydium_clmm",
        token_mint_a=token_mint_0,
        token_mint_b=token_mint_1,
        token_vault_a=token_vault_0,
        token_vault_b=token_vault_1,
        price=price,
        liquidity=liquidity,
        sqrt_price_x64=sqrt_price_x64,
        tick=tick_current,
    )


# ──────────────────────────────────────────
# Raydium AMM v4 (Standard AMM / Constant Product)
# Program: 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8
# ──────────────────────────────────────────

# LIQUIDITY_STATE_LAYOUT_V4 (no Anchor discriminator):
# Fields 1-32 are u64 (8 bytes each) = 256 bytes
# Fields 33-34: u128 (16 each) = offset 256-287
# Field 35: u64 (8) = offset 288-295
# Field 36-37: u128 (16 each) = offset 296-327
# Field 38: u64 (8) = offset 328-335
# offset 336: baseVault (Pubkey, 32)
# offset 368: quoteVault (Pubkey, 32)
# offset 400: baseMint (Pubkey, 32)
# offset 432: quoteMint (Pubkey, 32)
# offset 464: lpMint (Pubkey, 32)
# offset 496: openOrders (Pubkey, 32)
# offset 528: marketId (Pubkey, 32)

# Key numeric fields in the first 256 bytes:
# offset  0: status (u64)
# offset  8: nonce (u64)
# offset 16: maxOrder (u64)
# offset 24: depth (u64)
# offset 32: baseDecimal (u64)
# offset 40: quoteDecimal (u64)
# offset 48: state (u64)
# offset 56: resetFlag (u64)
# offset 64: minSize (u64)
# offset 72: volMaxCutRatio (u64)
# offset 80: amountWaveRatio (u64)
# offset 88: baseLotSize (u64)
# offset 96: quoteLotSize (u64)
# offset 104: minPriceMultiplier (u64)
# offset 112: maxPriceMultiplier (u64)
# offset 120: systemDecimalValue (u64)
# ... (more u64 fields)
# offset 176: swapBaseInAmount (u64) -- cumulative
# offset 184: swapQuoteOutAmount (u64) -- cumulative
# offset 192: swapBase2QuoteFee (u64)
# offset 200: swapBaseOutAmount (u64)
# offset 208: swapQuoteInAmount (u64)
# offset 216: swapQuote2BaseFee (u64)
# offset 224: baseNeedTakePnl (u64)
# offset 232: quoteNeedTakePnl (u64)
# offset 240: quoteTotalPnl (u64)
# offset 248: baseTotalPnl (u64)

def decode_raydium_v4(data: bytes, pool_address: str) -> Optional[PoolState]:
    """Decode Raydium AMM v4 pool state from raw account data.

    Note: For actual reserves, you need to read the vault token accounts.
    The pool account stores cumulative swap amounts, not current reserves.
    """
    if len(data) < 560:
        return None

    base_decimal = _read_u64(data, 32)
    quote_decimal = _read_u64(data, 40)
    base_vault = _read_pubkey(data, 336)
    quote_vault = _read_pubkey(data, 368)
    base_mint = _read_pubkey(data, 400)
    quote_mint = _read_pubkey(data, 432)
    open_orders = _read_pubkey(data, 496)

    # Price needs to be computed from vault balances (fetched separately)
    # For now, store 0 and compute when vault balances are known
    return PoolState(
        pool_address=pool_address,
        dex="raydium_v4",
        token_mint_a=base_mint,
        token_mint_b=quote_mint,
        token_vault_a=base_vault,
        token_vault_b=quote_vault,
        price=0.0,  # Needs vault balance fetch
        liquidity=0,
        reserve_a=0,  # Populated after vault fetch
        reserve_b=0,
    )


# ──────────────────────────────────────────
# Orca Whirlpool
# Program: whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc
# ──────────────────────────────────────────

# Whirlpool account layout (borsh, after 8-byte Anchor discriminator):
# offset  8: whirlpools_config (Pubkey, 32)
# offset 40: whirlpool_bump (u8)
# offset 41: tick_spacing (u16)
# offset 43: fee_tier_index_seed (u8[2])
# offset 45: fee_rate (u16)
# offset 47: protocol_fee_rate (u16)
# offset 49: liquidity (u128, 16)
# offset 65: sqrt_price (u128, 16)
# offset 81: tick_current_index (i32)
# offset 85: protocol_fee_owed_a (u64)
# offset 93: protocol_fee_owed_b (u64)
# offset 101: token_mint_a (Pubkey, 32)
# offset 133: token_vault_a (Pubkey, 32)
# offset 165: fee_growth_global_a (u128, 16)
# offset 181: token_mint_b (Pubkey, 32)
# offset 213: token_vault_b (Pubkey, 32)

def decode_orca_whirlpool(data: bytes, pool_address: str) -> Optional[PoolState]:
    """Decode Orca Whirlpool state from raw account data."""
    if len(data) < 245:
        return None

    fee_rate = _read_u16(data, 45)
    liquidity = _read_u128(data, 49)
    sqrt_price = _read_u128(data, 65)
    tick_current = _read_i32(data, 81)
    token_mint_a = _read_pubkey(data, 101)
    token_vault_a = _read_pubkey(data, 133)
    token_mint_b = _read_pubkey(data, 181)
    token_vault_b = _read_pubkey(data, 213)

    # Whirlpool uses same sqrt_price_x64 format as Raydium CLMM
    # Need decimals from token mints to compute price
    # For now use raw conversion (caller adjusts for decimals)
    raw_price = (sqrt_price / (1 << 64)) ** 2

    return PoolState(
        pool_address=pool_address,
        dex="orca",
        token_mint_a=token_mint_a,
        token_mint_b=token_mint_b,
        token_vault_a=token_vault_a,
        token_vault_b=token_vault_b,
        price=raw_price,
        liquidity=liquidity,
        sqrt_price_x64=sqrt_price,
        tick=tick_current,
        fee_rate=fee_rate,  # In hundredths of a bps (1 = 0.0001%)
    )


# ──────────────────────────────────────────
# Meteora DLMM
# Program: LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo
# ──────────────────────────────────────────

# LbPair layout (after 8-byte discriminator):
# offset  8: static_parameters (32 bytes)
# offset 40: variable_parameters (32 bytes)
# offset 72: bump_seed (u8[1])
# offset 73: bin_step_seed (u8[2])
# offset 75: pair_type (u8)
# offset 76: active_id (i32)
# offset 80: bin_step (u16)
# offset 82: status (u8)
# offset 83: require_base_factor_seed (u8)
# offset 84: base_factor_seed (u8[2])
# offset 86: activation_type (u8)
# offset 87: creator_pool_on_off_control (u8)
# offset 88: token_x_mint (Pubkey, 32)
# offset 120: token_y_mint (Pubkey, 32)
# offset 152: reserve_x (Pubkey, 32) — vault address
# offset 184: reserve_y (Pubkey, 32) — vault address
# offset 216: protocol_fee (16 bytes)
# ... (reward_infos, oracle, bitmap follow)

def decode_meteora_dlmm(data: bytes, pool_address: str) -> Optional[PoolState]:
    """Decode Meteora DLMM LbPair state from raw account data."""
    if len(data) < 216:
        return None

    active_id = _read_i32(data, 76)
    bin_step = _read_u16(data, 80)
    token_x_mint = _read_pubkey(data, 88)
    token_y_mint = _read_pubkey(data, 120)
    reserve_x = _read_pubkey(data, 152)  # vault address
    reserve_y = _read_pubkey(data, 184)  # vault address

    # Price = (1 + bin_step / 10000) ^ active_id
    # bin_step is in basis points (e.g., 1 = 0.01%)
    price = dlmm_bin_price(active_id, bin_step)

    return PoolState(
        pool_address=pool_address,
        dex="meteora",
        token_mint_a=token_x_mint,
        token_mint_b=token_y_mint,
        token_vault_a=reserve_x,
        token_vault_b=reserve_y,
        price=price,
        liquidity=0,
        tick=active_id,
        fee_rate=bin_step,
    )


# ── Price math ──

def sqrt_price_x64_to_price(sqrt_price_x64: int, decimals_a: int, decimals_b: int) -> float:
    """Convert sqrt_price_x64 to human-readable price.

    sqrt_price_x64 = sqrt(price_raw) * 2^64
    price_raw = token_b_amount / token_a_amount (in raw lamports)
    price_human = price_raw * 10^(decimals_a - decimals_b)
    """
    if sqrt_price_x64 == 0:
        return 0.0
    sqrt_price = sqrt_price_x64 / (1 << 64)
    price_raw = sqrt_price ** 2
    decimal_adj = 10 ** (decimals_a - decimals_b)
    return price_raw * decimal_adj


def dlmm_bin_price(active_id: int, bin_step: int) -> float:
    """Compute DLMM bin price from active_id and bin_step.

    price = (1 + bin_step / 10000) ^ active_id
    bin_step is in basis points.
    """
    base = 1.0 + bin_step / 10000.0
    return base ** active_id


# ── Decoder dispatch ──

def decode_pool(data: bytes, pool_address: str, program_id: str) -> Optional[PoolState]:
    """Decode pool state based on program ID."""
    pid = Pubkey.from_string(program_id) if isinstance(program_id, str) else program_id

    if pid == RAYDIUM_CLMM_PROGRAM:
        return decode_raydium_clmm(data, pool_address)
    elif pid == RAYDIUM_AMM_V4_PROGRAM:
        return decode_raydium_v4(data, pool_address)
    elif pid == ORCA_WHIRLPOOL_PROGRAM:
        return decode_orca_whirlpool(data, pool_address)
    elif pid == METEORA_DLMM_PROGRAM:
        return decode_meteora_dlmm(data, pool_address)
    else:
        logger.warning(f"Unknown program ID: {program_id}")
        return None
