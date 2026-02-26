"""Raw AMM swap instruction builders — bypass Jupiter for direct pool swaps.

Builds Solana instructions directly against DEX programs:
  - Orca Whirlpool (whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc)
  - Raydium CLMM (CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK)

This eliminates Jupiter's routing optimizer which collapses cross-DEX spreads,
preserving the exact pool-to-pool price discrepancies the scanner detects.
"""

import hashlib
import math
import struct

from solders.pubkey import Pubkey
from solders.instruction import Instruction, AccountMeta
from loguru import logger

from pool_decoder import PoolState

# ── Program IDs ──

ORCA_WHIRLPOOL_PROGRAM = Pubkey.from_string("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc")
RAYDIUM_CLMM_PROGRAM = Pubkey.from_string("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK")
TOKEN_PROGRAM_ID = Pubkey.from_string("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
ASSOCIATED_TOKEN_PROGRAM_ID = Pubkey.from_string("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")
SYSTEM_PROGRAM_ID = Pubkey.from_string("11111111111111111111111111111111")

# ── Anchor Discriminators ──

def _anchor_discriminator(name: str) -> bytes:
    """Compute Anchor instruction discriminator: SHA256("global:{name}")[:8]."""
    return hashlib.sha256(f"global:{name}".encode()).digest()[:8]

ORCA_SWAP_DISCRIMINATOR = _anchor_discriminator("swap")
RAYDIUM_CLMM_SWAP_DISCRIMINATOR = _anchor_discriminator("swap")

# ── Price Limits ──

# Orca/Raydium CLMM sqrt_price_x64 boundaries
MIN_SQRT_PRICE_X64 = 4295048016
MAX_SQRT_PRICE_X64 = 79226673515401279992447579055

# ── Tick Array Math ──

TICK_ARRAY_SIZE = 88  # Both Orca and Raydium use 88 ticks per array


def tick_array_start_index(tick: int, tick_spacing: int, offset: int = 0) -> int:
    """Compute the start tick index for a tick array.

    Args:
        tick: Current tick index.
        tick_spacing: Pool's tick spacing.
        offset: Array offset from current (0 = current, +1/-1 = next/prev).

    Returns:
        Start tick index of the array.
    """
    ticks_in_array = TICK_ARRAY_SIZE * tick_spacing
    real_index = math.floor(tick / ticks_in_array) * ticks_in_array
    return real_index + offset * ticks_in_array


# ── PDA Derivation ──

def derive_orca_tick_array(whirlpool: Pubkey, start_index: int) -> Pubkey:
    """Derive Orca Whirlpool tick array PDA."""
    pda, _ = Pubkey.find_program_address(
        [b"tick_array", bytes(whirlpool), str(start_index).encode()],
        ORCA_WHIRLPOOL_PROGRAM,
    )
    return pda


def derive_orca_oracle(whirlpool: Pubkey) -> Pubkey:
    """Derive Orca Whirlpool oracle PDA."""
    pda, _ = Pubkey.find_program_address(
        [b"oracle", bytes(whirlpool)],
        ORCA_WHIRLPOOL_PROGRAM,
    )
    return pda


def derive_raydium_tick_array(pool_id: Pubkey, start_index: int) -> Pubkey:
    """Derive Raydium CLMM tick array PDA."""
    pda, _ = Pubkey.find_program_address(
        [b"tick_array", bytes(pool_id), struct.pack("<i", start_index)],
        RAYDIUM_CLMM_PROGRAM,
    )
    return pda


def get_associated_token_address(owner: Pubkey, mint: Pubkey) -> Pubkey:
    """Derive ATA address for owner + mint."""
    ata, _ = Pubkey.find_program_address(
        [bytes(owner), bytes(TOKEN_PROGRAM_ID), bytes(mint)],
        ASSOCIATED_TOKEN_PROGRAM_ID,
    )
    return ata


# ── ATA Creation ──

def build_create_ata_idempotent_ix(
    payer: Pubkey, owner: Pubkey, mint: Pubkey
) -> Instruction:
    """Build SPL Associated Token createIdempotent instruction (index 1).

    No-op if ATA already exists. Safe to include in every transaction.
    """
    ata = get_associated_token_address(owner, mint)

    accounts = [
        AccountMeta(payer, is_signer=True, is_writable=True),
        AccountMeta(ata, is_signer=False, is_writable=True),
        AccountMeta(owner, is_signer=False, is_writable=False),
        AccountMeta(mint, is_signer=False, is_writable=False),
        AccountMeta(SYSTEM_PROGRAM_ID, is_signer=False, is_writable=False),
        AccountMeta(TOKEN_PROGRAM_ID, is_signer=False, is_writable=False),
    ]

    # createIdempotent is instruction index 1 in ATA program
    return Instruction(ASSOCIATED_TOKEN_PROGRAM_ID, bytes([1]), accounts)


# ── Orca Whirlpool Swap ──

def build_orca_whirlpool_swap_ix(
    pool: PoolState,
    payer: Pubkey,
    amount_in: int,
    a_to_b: bool,
    token_account_a: Pubkey,
    token_account_b: Pubkey,
    min_out: int = 0,
) -> Instruction:
    """Build Orca Whirlpool swap instruction.

    Accounts (11):
      0. token_program
      1. token_authority (signer) — the payer/wallet
      2. whirlpool
      3. token_owner_account_a — payer's ATA for token A
      4. token_vault_a — pool's vault for token A
      5. token_owner_account_b — payer's ATA for token B
      6. token_vault_b — pool's vault for token B
      7. tick_array_0 — current tick array
      8. tick_array_1 — next tick array in swap direction
      9. tick_array_2 — next-next tick array
     10. oracle — Whirlpool oracle PDA

    Data (34 bytes):
      amount (u64) + other_amount_threshold (u64) + sqrt_price_limit (u128)
      + amount_specified_is_input (bool) + a_to_b (bool)
    """
    whirlpool_pk = Pubkey.from_string(pool.pool_address)
    vault_a = Pubkey.from_string(pool.token_vault_a)
    vault_b = Pubkey.from_string(pool.token_vault_b)

    # Derive tick arrays: 3 consecutive arrays in swap direction
    direction = -1 if a_to_b else 1
    ta0_start = tick_array_start_index(pool.tick, pool.tick_spacing, 0)
    ta1_start = tick_array_start_index(pool.tick, pool.tick_spacing, direction)
    ta2_start = tick_array_start_index(pool.tick, pool.tick_spacing, direction * 2)

    ta0 = derive_orca_tick_array(whirlpool_pk, ta0_start)
    ta1 = derive_orca_tick_array(whirlpool_pk, ta1_start)
    ta2 = derive_orca_tick_array(whirlpool_pk, ta2_start)

    oracle = derive_orca_oracle(whirlpool_pk)

    # sqrt_price_limit: push to boundary in swap direction
    sqrt_price_limit = MIN_SQRT_PRICE_X64 if a_to_b else MAX_SQRT_PRICE_X64

    # Pack instruction data
    data = ORCA_SWAP_DISCRIMINATOR
    data += struct.pack("<Q", amount_in)            # amount
    data += struct.pack("<Q", min_out)              # other_amount_threshold
    # u128 as two u64s (little-endian)
    data += struct.pack("<QQ", sqrt_price_limit & 0xFFFFFFFFFFFFFFFF,
                        sqrt_price_limit >> 64)
    data += struct.pack("<?", True)                 # amount_specified_is_input
    data += struct.pack("<?", a_to_b)               # a_to_b

    accounts = [
        AccountMeta(TOKEN_PROGRAM_ID, is_signer=False, is_writable=False),
        AccountMeta(payer, is_signer=True, is_writable=False),  # token_authority
        AccountMeta(whirlpool_pk, is_signer=False, is_writable=True),
        AccountMeta(token_account_a, is_signer=False, is_writable=True),
        AccountMeta(vault_a, is_signer=False, is_writable=True),
        AccountMeta(token_account_b, is_signer=False, is_writable=True),
        AccountMeta(vault_b, is_signer=False, is_writable=True),
        AccountMeta(ta0, is_signer=False, is_writable=True),
        AccountMeta(ta1, is_signer=False, is_writable=True),
        AccountMeta(ta2, is_signer=False, is_writable=True),
        AccountMeta(oracle, is_signer=False, is_writable=False),
    ]

    return Instruction(ORCA_WHIRLPOOL_PROGRAM, data, accounts)


# ── Raydium CLMM Swap ──

def build_raydium_clmm_swap_ix(
    pool: PoolState,
    payer: Pubkey,
    amount_in: int,
    a_to_b: bool,
    input_token_account: Pubkey,
    output_token_account: Pubkey,
    min_out: int = 0,
) -> Instruction:
    """Build Raydium CLMM swap instruction.

    Accounts (12+):
      0. payer (signer)
      1. amm_config
      2. pool_state (writable)
      3. input_token_account (writable)
      4. output_token_account (writable)
      5. input_vault (writable)
      6. output_vault (writable)
      7. observation_state (writable)
      8. token_program
      9. tick_array_0 (writable)
     10. tick_array_1 (writable)
     11. tick_array_2 (writable)

    Data (33 bytes):
      amount (u64) + other_amount_threshold (u64) + sqrt_price_limit_x64 (u128)
      + is_base_input (bool)
    """
    pool_pk = Pubkey.from_string(pool.pool_address)
    vault_a = Pubkey.from_string(pool.token_vault_a)
    vault_b = Pubkey.from_string(pool.token_vault_b)

    if pool.amm_config is None or pool.observation_key is None:
        raise ValueError(
            f"Raydium CLMM pool {pool.pool_address} missing amm_config or observation_key"
        )

    input_vault = vault_a if a_to_b else vault_b
    output_vault = vault_b if a_to_b else vault_a

    # Derive tick arrays: 3 consecutive arrays in swap direction
    direction = -1 if a_to_b else 1
    ta0_start = tick_array_start_index(pool.tick, pool.tick_spacing, 0)
    ta1_start = tick_array_start_index(pool.tick, pool.tick_spacing, direction)
    ta2_start = tick_array_start_index(pool.tick, pool.tick_spacing, direction * 2)

    ta0 = derive_raydium_tick_array(pool_pk, ta0_start)
    ta1 = derive_raydium_tick_array(pool_pk, ta1_start)
    ta2 = derive_raydium_tick_array(pool_pk, ta2_start)

    # sqrt_price_limit: push to boundary in swap direction
    sqrt_price_limit = MIN_SQRT_PRICE_X64 if a_to_b else MAX_SQRT_PRICE_X64

    # Pack instruction data
    data = RAYDIUM_CLMM_SWAP_DISCRIMINATOR
    data += struct.pack("<Q", amount_in)            # amount
    data += struct.pack("<Q", min_out)              # other_amount_threshold
    data += struct.pack("<QQ", sqrt_price_limit & 0xFFFFFFFFFFFFFFFF,
                        sqrt_price_limit >> 64)     # sqrt_price_limit_x64
    data += struct.pack("<?", True)                 # is_base_input

    accounts = [
        AccountMeta(payer, is_signer=True, is_writable=False),
        AccountMeta(pool.amm_config, is_signer=False, is_writable=False),
        AccountMeta(pool_pk, is_signer=False, is_writable=True),
        AccountMeta(input_token_account, is_signer=False, is_writable=True),
        AccountMeta(output_token_account, is_signer=False, is_writable=True),
        AccountMeta(input_vault, is_signer=False, is_writable=True),
        AccountMeta(output_vault, is_signer=False, is_writable=True),
        AccountMeta(pool.observation_key, is_signer=False, is_writable=True),
        AccountMeta(TOKEN_PROGRAM_ID, is_signer=False, is_writable=False),
        AccountMeta(ta0, is_signer=False, is_writable=True),
        AccountMeta(ta1, is_signer=False, is_writable=True),
        AccountMeta(ta2, is_signer=False, is_writable=True),
    ]

    return Instruction(RAYDIUM_CLMM_PROGRAM, data, accounts)


# ── Dispatcher ──

def build_raw_swap_ix(
    pool: PoolState,
    payer: Pubkey,
    amount_in: int,
    a_to_b: bool,
    token_account_a: Pubkey,
    token_account_b: Pubkey,
    min_out: int = 0,
) -> Instruction:
    """Build a raw swap instruction, dispatching to the correct DEX builder.

    Args:
        pool: Decoded pool state (must have tick_spacing set).
        payer: Wallet pubkey (signer).
        amount_in: Input amount in raw lamports/smallest unit.
        a_to_b: True if swapping token_a → token_b.
        token_account_a: Payer's ATA for token A.
        token_account_b: Payer's ATA for token B.
        min_out: Minimum output amount (0 = no slippage guard, flash loan repay is the guard).

    Returns:
        Solana Instruction ready to include in transaction.

    Raises:
        ValueError: If DEX type not supported for raw swaps.
    """
    if pool.dex == "orca":
        return build_orca_whirlpool_swap_ix(
            pool, payer, amount_in, a_to_b,
            token_account_a, token_account_b, min_out,
        )
    elif pool.dex == "raydium_clmm":
        input_acct = token_account_a if a_to_b else token_account_b
        output_acct = token_account_b if a_to_b else token_account_a
        return build_raydium_clmm_swap_ix(
            pool, payer, amount_in, a_to_b,
            input_acct, output_acct, min_out,
        )
    else:
        raise ValueError(
            f"Raw swap not supported for DEX: {pool.dex}. "
            f"Only orca (Whirlpool) and raydium_clmm are supported."
        )
