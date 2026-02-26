"""Transaction builder — assembles atomic arb transactions.

Builds V0 VersionedTransaction with:
  [compute budget] -> [borrow] -> [swap leg1] -> [swap leg2] -> [repay] -> [jito tip]
"""

import asyncio as _asyncio
import base64
from typing import Optional

import httpx
from solders.keypair import Keypair
from solders.pubkey import Pubkey
from solders.instruction import Instruction, AccountMeta
from solders.hash import Hash
from solders.message import MessageV0
from solders.transaction import VersionedTransaction
from solders.address_lookup_table_account import AddressLookupTableAccount
from solders.compute_budget import set_compute_unit_limit, set_compute_unit_price
from solana.rpc.async_api import AsyncClient
from loguru import logger

from flash_loan_client import FlashLoanClient
from quote_provider import QuoteProvider
from scanner import ArbitrageOpportunity


def _deserialize_jupiter_ix(raw: dict) -> Instruction:
    """Deserialize a Jupiter swap instruction from JSON."""
    program_id = Pubkey.from_string(raw["programId"])
    data = base64.b64decode(raw["data"])
    accounts = [
        AccountMeta(
            Pubkey.from_string(a["pubkey"]),
            is_signer=a["isSigner"],
            is_writable=a["isWritable"],
        )
        for a in raw["accounts"]
    ]
    return Instruction(program_id, data, accounts)


# DEX name mapping: internal names → Jupiter API labels
INTERNAL_DEX_TO_JUPITER = {
    "raydium_clmm": "Raydium CLMM",
    "orca": "Whirlpool",
    "meteora": "Meteora DLMM",
    "raydium_v4": "Raydium",
}


async def _jup_quote(
    client: httpx.AsyncClient,
    input_mint: str,
    output_mint: str,
    amount: int,
    slippage_bps: int = 100,
    max_accounts: int = 20,
    dexes: Optional[list] = None,
) -> dict:
    """Fetch a Jupiter quote with optional DEX filtering."""
    params = {
        "inputMint": input_mint,
        "outputMint": output_mint,
        "amount": str(amount),
        "slippageBps": str(slippage_bps),
        "maxAccounts": str(max_accounts),
    }
    if dexes:
        params["dexes"] = ",".join(dexes)
    resp = await client.get("https://api.jup.ag/swap/v1/quote", params=params)
    if resp.status_code != 200:
        raise Exception(f"Jupiter quote {resp.status_code}: {resp.text[:200]}")
    return resp.json()


async def _jup_swap_ix(
    client: httpx.AsyncClient,
    quote: dict,
    user_pubkey: str,
) -> dict:
    """Fetch Jupiter swap instructions from a quote response."""
    resp = await client.post(
        "https://api.jup.ag/swap/v1/swap-instructions",
        json={
            "quoteResponse": quote,
            "userPublicKey": user_pubkey,
            "wrapAndUnwrapSol": True,
            "dynamicComputeUnitLimit": True,
            "prioritizationFeeLamports": 0,
        },
    )
    if resp.status_code != 200:
        raise Exception(f"Jupiter swap-ix {resp.status_code}: {resp.text[:200]}")
    return resp.json()


def _append_swap_ixs(instructions: list, swap_data: dict):
    """Append setup + swap + cleanup instructions from Jupiter swap response."""
    for ix_raw in swap_data.get("setupInstructions", []):
        instructions.append(_deserialize_jupiter_ix(ix_raw))
    instructions.append(_deserialize_jupiter_ix(swap_data["swapInstruction"]))
    if swap_data.get("cleanupInstruction"):
        instructions.append(_deserialize_jupiter_ix(swap_data["cleanupInstruction"]))


async def _load_address_lookup_tables(
    rpc: AsyncClient, addresses: list[str]
) -> list[AddressLookupTableAccount]:
    """Load ALTs from on-chain for V0 message compilation."""
    unique = list(set(addresses))
    if not unique:
        return []

    tables = []
    for addr in unique:
        pk = Pubkey.from_string(addr)
        resp = await rpc.get_account_info(pk)
        if resp.value is None:
            continue
        data = bytes(resp.value.data)
        # ALT layout: 56 bytes header, then 32-byte pubkeys
        if len(data) < 56:
            continue
        # Parse: authority (optional) at offset 22, deactivation_slot at 14
        # Addresses start at offset 56
        addr_data = data[56:]
        num_addrs = len(addr_data) // 32
        addrs = [Pubkey.from_bytes(addr_data[i*32:(i+1)*32]) for i in range(num_addrs)]
        tables.append(AddressLookupTableAccount(key=pk, addresses=addrs))

    logger.debug(f"Loaded {len(tables)}/{len(unique)} ALTs")
    return tables


async def build_arb_transaction(
    rpc: AsyncClient,
    borrower: Keypair,
    borrower_token_account_a: Pubkey,  # ATA for USDC (flash loan token)
    flash_loan: FlashLoanClient,
    quote_provider: QuoteProvider,
    opportunity: ArbitrageOpportunity,
    slippage_bps: int = 50,
    compute_unit_price: int = 25000,
    compute_unit_limit: int = 400000,
    jito_tip_ix: Optional[Instruction] = None,
) -> tuple[VersionedTransaction, str, int]:
    """Build atomic arb transaction. Returns (tx, blockhash, last_valid_block_height)."""

    borrower_pk = borrower.pubkey()

    # 1. Get fresh Jupiter quotes + swap instructions
    logger.debug("Fetching Jupiter swap instructions...")

    # We need quotes from Jupiter API (not Raydium) to get swap instructions
    # Use the Jupiter-specific quote method for this
    import httpx
    jup_headers = {}
    if quote_provider.jupiter_api_key:
        jup_headers["x-api-key"] = quote_provider.jupiter_api_key

    async with httpx.AsyncClient(headers=jup_headers, timeout=10.0) as client:
        # Quote leg 1: USDC -> TARGET
        resp1 = await client.get(
            "https://api.jup.ag/swap/v1/quote",
            params={
                "inputMint": opportunity.token_a,
                "outputMint": opportunity.token_b,
                "amount": str(opportunity.borrow_amount),
                "slippageBps": str(slippage_bps),
                "maxAccounts": "40",
            },
        )
        if resp1.status_code != 200:
            raise Exception(f"Jupiter quote leg1 failed: {resp1.status_code}")
        quote1 = resp1.json()

        # Quote leg 2: TARGET -> USDC
        resp2 = await client.get(
            "https://api.jup.ag/swap/v1/quote",
            params={
                "inputMint": opportunity.token_b,
                "outputMint": opportunity.token_a,
                "amount": quote1["outAmount"],
                "slippageBps": str(slippage_bps),
                "maxAccounts": "40",
            },
        )
        if resp2.status_code != 200:
            raise Exception(f"Jupiter quote leg2 failed: {resp2.status_code}")
        quote2 = resp2.json()

        # Stale quote guard
        exec_leg2_out = int(quote2["outAmount"])
        flash_fee = (opportunity.borrow_amount * 9 + 9999) // 10000
        if exec_leg2_out <= opportunity.borrow_amount + flash_fee:
            raise Exception(
                f"No longer profitable: leg2_out={exec_leg2_out}, "
                f"needed>{opportunity.borrow_amount + flash_fee}"
            )

        # Get swap instructions for both legs
        swap_ix_resp1 = await client.post(
            "https://api.jup.ag/swap/v1/swap-instructions",
            json={
                "quoteResponse": quote1,
                "userPublicKey": str(borrower_pk),
                "wrapAndUnwrapSol": True,
                "dynamicComputeUnitLimit": True,
                "prioritizationFeeLamports": 0,
            },
        )
        if swap_ix_resp1.status_code != 200:
            raise Exception(f"Jupiter swap-ix leg1: {swap_ix_resp1.status_code}")
        swap1 = swap_ix_resp1.json()

        swap_ix_resp2 = await client.post(
            "https://api.jup.ag/swap/v1/swap-instructions",
            json={
                "quoteResponse": quote2,
                "userPublicKey": str(borrower_pk),
                "wrapAndUnwrapSol": True,
                "dynamicComputeUnitLimit": True,
                "prioritizationFeeLamports": 0,
            },
        )
        if swap_ix_resp2.status_code != 200:
            raise Exception(f"Jupiter swap-ix leg2: {swap_ix_resp2.status_code}")
        swap2 = swap_ix_resp2.json()

    # 2. Build flash loan borrow/repay
    borrow_ix = flash_loan.build_borrow_ix(
        borrower_pk, borrower_token_account_a, opportunity.borrow_amount
    )
    repay_ix = flash_loan.build_repay_ix(borrower_pk, borrower_token_account_a)

    # 3. Assemble instruction sequence
    instructions: list[Instruction] = [
        # Compute budget (must be first)
        set_compute_unit_limit(compute_unit_limit),
        set_compute_unit_price(compute_unit_price),
        # Flash loan borrow
        borrow_ix,
    ]

    # Leg 1 setup + swap + cleanup
    for ix_raw in swap1.get("setupInstructions", []):
        instructions.append(_deserialize_jupiter_ix(ix_raw))
    instructions.append(_deserialize_jupiter_ix(swap1["swapInstruction"]))
    if swap1.get("cleanupInstruction"):
        instructions.append(_deserialize_jupiter_ix(swap1["cleanupInstruction"]))

    # Leg 2 setup + swap + cleanup
    for ix_raw in swap2.get("setupInstructions", []):
        instructions.append(_deserialize_jupiter_ix(ix_raw))
    instructions.append(_deserialize_jupiter_ix(swap2["swapInstruction"]))
    if swap2.get("cleanupInstruction"):
        instructions.append(_deserialize_jupiter_ix(swap2["cleanupInstruction"]))

    # Flash loan repay
    instructions.append(repay_ix)

    # Jito tip last (only paid on success)
    if jito_tip_ix:
        instructions.append(jito_tip_ix)

    logger.debug(f"Tx assembled: {len(instructions)} instructions, jito_tip={jito_tip_ix is not None}")

    # 4. Load ALTs
    alt_addresses = (
        swap1.get("addressLookupTableAddresses", [])
        + swap2.get("addressLookupTableAddresses", [])
    )
    lookup_tables = await _load_address_lookup_tables(rpc, alt_addresses)

    # 5. Build V0 transaction
    blockhash_resp = await rpc.get_latest_blockhash("confirmed")
    blockhash = str(blockhash_resp.value.blockhash)
    last_valid = blockhash_resp.value.last_valid_block_height

    msg = MessageV0.try_compile(
        payer=borrower_pk,
        instructions=instructions,
        address_lookup_table_accounts=lookup_tables,
        recent_blockhash=Hash.from_string(blockhash),
    )

    tx = VersionedTransaction(msg, [borrower])

    tx_bytes = len(bytes(tx))
    logger.debug(f"Tx built: {tx_bytes} bytes ({tx_bytes/1232*100:.1f}% of max)")

    if tx_bytes > 1232:
        raise Exception(f"Tx too large: {tx_bytes} bytes (max 1232)")

    return tx, blockhash, last_valid


async def simulate_transaction(
    rpc: AsyncClient,
    tx: VersionedTransaction,
) -> tuple[bool, list[str], int]:
    """Simulate tx. Returns (success, logs, units_consumed)."""
    result = await rpc.simulate_transaction(tx)
    val = result.value
    logs = val.logs or []
    units = val.units_consumed or 0

    if val.err:
        logger.warning(f"Simulation FAILED: {val.err} | CU={units} | logs[-3:]={logs[-3:]}")
        return False, logs, units

    logger.debug(f"Simulation OK: CU={units}")
    return True, logs, units


async def build_triangular_transaction(
    rpc: AsyncClient,
    borrower: Keypair,
    borrower_token_account_a: Pubkey,
    flash_loan: FlashLoanClient,
    opportunity,  # TriangularOpportunity (avoid circular import)
    jupiter_api_key: str = "",
    slippage_bps: int = 100,
    compute_unit_price: int = 50000,
    compute_unit_limit: int = 600000,
    jito_tip_ix: Optional[Instruction] = None,
) -> tuple:
    """Build 3-leg triangular arb: Borrow -> Swap1 -> Swap2 -> Swap3 -> Repay.

    Sequential quotes (each leg depends on previous output), then parallel
    swap instruction fetches for speed. Returns (tx, blockhash, last_valid).
    """
    borrower_pk = borrower.pubkey()
    jup_headers = {"x-api-key": jupiter_api_key} if jupiter_api_key else {}

    # Extract DEX hints from scanner edges to force cross-DEX routing.
    # Without this, Jupiter freely routes each leg through whatever DEX is
    # cheapest, which eliminates the cross-DEX price discrepancy.
    edge_dexes = []
    if hasattr(opportunity, "edges") and opportunity.edges:
        for edge in opportunity.edges:
            jup_dex = INTERNAL_DEX_TO_JUPITER.get(edge.dex)
            edge_dexes.append([jup_dex] if jup_dex else None)
    else:
        edge_dexes = [None, None, None]

    async with httpx.AsyncClient(headers=jup_headers, timeout=15.0) as client:
        # Sequential quotes with DEX filtering: each leg forced through
        # the specific DEX where the scanner detected the price discrepancy
        try:
            q1 = await _jup_quote(
                client, opportunity.path[0], opportunity.path[1],
                opportunity.borrow_amount, slippage_bps,
                dexes=edge_dexes[0],
            )
        except Exception:
            # Fallback: no route on that DEX, try unrestricted
            q1 = await _jup_quote(
                client, opportunity.path[0], opportunity.path[1],
                opportunity.borrow_amount, slippage_bps,
            )

        try:
            q2 = await _jup_quote(
                client, opportunity.path[1], opportunity.path[2],
                int(q1["outAmount"]), slippage_bps,
                dexes=edge_dexes[1],
            )
        except Exception:
            q2 = await _jup_quote(
                client, opportunity.path[1], opportunity.path[2],
                int(q1["outAmount"]), slippage_bps,
            )

        try:
            q3 = await _jup_quote(
                client, opportunity.path[2], opportunity.path[3],
                int(q2["outAmount"]), slippage_bps,
                dexes=edge_dexes[2],
            )
        except Exception:
            q3 = await _jup_quote(
                client, opportunity.path[2], opportunity.path[3],
                int(q2["outAmount"]), slippage_bps,
            )

        # Live profitability check with per-leg diagnostics
        final_out = int(q3["outAmount"])
        flash_fee = (opportunity.borrow_amount * 9 + 9999) // 10000
        min_needed = opportunity.borrow_amount + flash_fee

        leg1_out = int(q1["outAmount"])
        leg2_out = int(q2["outAmount"])
        leg3_out = final_out
        dex_str = "→".join(
            (edge_dexes[i][0] if edge_dexes[i] else "any")
            for i in range(3)
        )

        if final_out <= min_needed:
            raise Exception(
                f"Triangular stale: out={final_out}, needed>{min_needed}, "
                f"shortfall={min_needed - final_out}, "
                f"legs={leg1_out}/{leg2_out}/{leg3_out}, "
                f"dexes={dex_str}"
            )

        live_profit_bps = int(
            (final_out - min_needed) / opportunity.borrow_amount * 10000
        )
        logger.info(
            f"Triangular live: {live_profit_bps:+d} bps "
            f"(scanner: {opportunity.net_profit_bps:+d} bps) "
            f"legs={leg1_out}/{leg2_out}/{leg3_out} "
            f"dexes={dex_str}"
        )

        # Parallel swap instruction fetches
        user_pk = str(borrower_pk)
        swap1, swap2, swap3 = await _asyncio.gather(
            _jup_swap_ix(client, q1, user_pk),
            _jup_swap_ix(client, q2, user_pk),
            _jup_swap_ix(client, q3, user_pk),
        )

    # Assemble: compute budget -> borrow -> 3 swaps -> repay -> tip
    borrow_ix = flash_loan.build_borrow_ix(
        borrower_pk, borrower_token_account_a, opportunity.borrow_amount
    )
    repay_ix = flash_loan.build_repay_ix(borrower_pk, borrower_token_account_a)

    instructions: list[Instruction] = [
        set_compute_unit_limit(compute_unit_limit),
        set_compute_unit_price(compute_unit_price),
        borrow_ix,
    ]
    _append_swap_ixs(instructions, swap1)
    _append_swap_ixs(instructions, swap2)
    _append_swap_ixs(instructions, swap3)
    instructions.append(repay_ix)
    if jito_tip_ix:
        instructions.append(jito_tip_ix)

    logger.debug(
        f"Triangular tx: {len(instructions)} instructions, "
        f"jito={jito_tip_ix is not None}"
    )

    # Load ALTs from all 3 swaps
    alt_addresses = (
        swap1.get("addressLookupTableAddresses", [])
        + swap2.get("addressLookupTableAddresses", [])
        + swap3.get("addressLookupTableAddresses", [])
    )
    lookup_tables = await _load_address_lookup_tables(rpc, alt_addresses)

    # Build V0 transaction
    blockhash_resp = await rpc.get_latest_blockhash("confirmed")
    blockhash = str(blockhash_resp.value.blockhash)
    last_valid = blockhash_resp.value.last_valid_block_height

    msg = MessageV0.try_compile(
        payer=borrower_pk,
        instructions=instructions,
        address_lookup_table_accounts=lookup_tables,
        recent_blockhash=Hash.from_string(blockhash),
    )

    tx = VersionedTransaction(msg, [borrower])
    tx_bytes = len(bytes(tx))
    logger.debug(
        f"Triangular tx: {tx_bytes} bytes ({tx_bytes/1232*100:.1f}% of max)"
    )

    if tx_bytes > 1232:
        raise Exception(f"Triangular tx too large: {tx_bytes} bytes (max 1232)")

    return tx, blockhash, last_valid


async def build_cross_dex_transaction(
    rpc: AsyncClient,
    borrower: Keypair,
    borrower_token_account_a: Pubkey,
    flash_loan: FlashLoanClient,
    opportunity,  # CrossDexOpportunity (avoid circular import)
    jupiter_api_key: str = "",
    slippage_bps: int = 50,
    compute_unit_price: int = 25000,
    compute_unit_limit: int = 400000,
    jito_tip_ix: Optional[Instruction] = None,
) -> tuple:
    """Build 2-leg cross-DEX arb with Jupiter DEX filtering.

    Buy on cheap DEX, sell on expensive DEX, within one atomic transaction.
    Returns (tx, blockhash, last_valid).
    """
    borrower_pk = borrower.pubkey()
    jup_headers = {"x-api-key": jupiter_api_key} if jupiter_api_key else {}
    buy_jup = INTERNAL_DEX_TO_JUPITER.get(opportunity.buy_pool.dex)
    sell_jup = INTERNAL_DEX_TO_JUPITER.get(opportunity.sell_pool.dex)

    async with httpx.AsyncClient(headers=jup_headers, timeout=10.0) as client:
        # Leg 1: Buy target on cheap DEX (USDC -> target)
        q1 = await _jup_quote(
            client, opportunity.token_a, opportunity.token_b,
            opportunity.borrow_amount, slippage_bps,
            dexes=[buy_jup] if buy_jup else None,
        )

        # Leg 2: Sell target on expensive DEX (target -> USDC)
        q2 = await _jup_quote(
            client, opportunity.token_b, opportunity.token_a,
            int(q1["outAmount"]), slippage_bps,
            dexes=[sell_jup] if sell_jup else None,
        )

        # Profitability check
        final_out = int(q2["outAmount"])
        flash_fee = (opportunity.borrow_amount * 9 + 9999) // 10000
        min_needed = opportunity.borrow_amount + flash_fee
        if final_out <= min_needed:
            raise Exception(
                f"Cross-DEX stale: out={final_out}, needed>{min_needed}"
            )

        live_bps = int(
            (final_out - min_needed) / opportunity.borrow_amount * 10000
        )
        logger.info(
            f"Cross-DEX live: {live_bps:+d} bps "
            f"(scanner: {opportunity.estimated_profit_bps:+d} bps)"
        )

        # Parallel swap instructions
        user_pk = str(borrower_pk)
        swap1, swap2 = await _asyncio.gather(
            _jup_swap_ix(client, q1, user_pk),
            _jup_swap_ix(client, q2, user_pk),
        )

    # Assemble
    borrow_ix = flash_loan.build_borrow_ix(
        borrower_pk, borrower_token_account_a, opportunity.borrow_amount
    )
    repay_ix = flash_loan.build_repay_ix(borrower_pk, borrower_token_account_a)

    instructions: list[Instruction] = [
        set_compute_unit_limit(compute_unit_limit),
        set_compute_unit_price(compute_unit_price),
        borrow_ix,
    ]
    _append_swap_ixs(instructions, swap1)
    _append_swap_ixs(instructions, swap2)
    instructions.append(repay_ix)
    if jito_tip_ix:
        instructions.append(jito_tip_ix)

    # Load ALTs
    alt_addresses = (
        swap1.get("addressLookupTableAddresses", [])
        + swap2.get("addressLookupTableAddresses", [])
    )
    lookup_tables = await _load_address_lookup_tables(rpc, alt_addresses)

    # Build V0 transaction
    blockhash_resp = await rpc.get_latest_blockhash("confirmed")
    blockhash = str(blockhash_resp.value.blockhash)
    last_valid = blockhash_resp.value.last_valid_block_height

    msg = MessageV0.try_compile(
        payer=borrower_pk,
        instructions=instructions,
        address_lookup_table_accounts=lookup_tables,
        recent_blockhash=Hash.from_string(blockhash),
    )

    tx = VersionedTransaction(msg, [borrower])
    tx_bytes = len(bytes(tx))
    logger.debug(
        f"Cross-DEX tx: {tx_bytes} bytes ({tx_bytes/1232*100:.1f}% of max)"
    )

    if tx_bytes > 1232:
        raise Exception(f"Cross-DEX tx too large: {tx_bytes} bytes (max 1232)")

    return tx, blockhash, last_valid
