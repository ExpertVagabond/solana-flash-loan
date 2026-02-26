"""Transaction builder — assembles atomic arb transactions.

Builds V0 VersionedTransaction with:
  [compute budget] -> [borrow] -> [swap leg1] -> [swap leg2] -> [repay] -> [jito tip]
"""

import base64
from typing import Optional

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
