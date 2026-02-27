"""Address Lookup Table manager for raw swap transactions.

Creates and maintains an ALT with frequently-used accounts to keep
raw swap transactions under the 1232-byte Solana limit.

Each account moved to an ALT saves 31 bytes (32-byte pubkey → 1-byte index).
A 3-leg raw swap tx has ~25-30 unique accounts, easily exceeding the limit
without ALTs.

Usage:
    alt_mgr = ALTManager(rpc, borrower_keypair)
    await alt_mgr.initialize()   # creates or loads existing ALT
    await alt_mgr.ensure_accounts([...])  # extends ALT if needed
    table = alt_mgr.table_account  # pass to MessageV0.try_compile
"""

import json
import os
import struct
from typing import Optional

from solders.pubkey import Pubkey
from solders.keypair import Keypair
from solders.instruction import Instruction, AccountMeta
from solders.hash import Hash
from solders.message import MessageV0
from solders.transaction import VersionedTransaction
from solders.address_lookup_table_account import AddressLookupTableAccount
from solders.compute_budget import set_compute_unit_limit, set_compute_unit_price
from solana.rpc.async_api import AsyncClient
from solana.rpc.types import TxOpts
from solana.rpc.commitment import Confirmed
from loguru import logger

# Send opts: match preflight commitment to blockhash commitment
_TX_OPTS = TxOpts(skip_preflight=False, preflight_commitment=Confirmed)

# Address Lookup Table Program
ALT_PROGRAM_ID = Pubkey.from_string("AddressLookupTab1e1111111111111111111111111")
SYSTEM_PROGRAM_ID = Pubkey.from_string("11111111111111111111111111111111")

# Persist ALT address across bot restarts
ALT_STATE_FILE = os.path.join(os.path.dirname(__file__), ".alt_state.json")


def _derive_lookup_table_address(authority: Pubkey, recent_slot: int) -> tuple:
    """Derive the ALT PDA address from authority + slot."""
    pda, bump = Pubkey.find_program_address(
        [bytes(authority), struct.pack("<Q", recent_slot)],
        ALT_PROGRAM_ID,
    )
    return pda, bump


def _build_create_lookup_table_ix(
    authority: Pubkey, payer: Pubkey, recent_slot: int
) -> tuple:
    """Build CreateLookupTable instruction. Returns (instruction, table_address)."""
    table_address, bump = _derive_lookup_table_address(authority, recent_slot)

    # discriminator=0 (CreateLookupTable), recent_slot (u64), bump (u8)
    data = struct.pack("<IQB", 0, recent_slot, bump)

    accounts = [
        AccountMeta(table_address, is_signer=False, is_writable=True),
        AccountMeta(authority, is_signer=True, is_writable=False),
        AccountMeta(payer, is_signer=True, is_writable=True),
        AccountMeta(SYSTEM_PROGRAM_ID, is_signer=False, is_writable=False),
    ]

    return Instruction(ALT_PROGRAM_ID, data, accounts), table_address


def _build_extend_lookup_table_ix(
    table_address: Pubkey, authority: Pubkey, payer: Pubkey,
    new_addresses: list,
) -> Instruction:
    """Build ExtendLookupTable instruction."""
    # discriminator=2 (ExtendLookupTable), count (u64), then pubkeys
    data = struct.pack("<IQ", 2, len(new_addresses))
    for addr in new_addresses:
        data += bytes(addr)

    accounts = [
        AccountMeta(table_address, is_signer=False, is_writable=True),
        AccountMeta(authority, is_signer=True, is_writable=False),
        AccountMeta(payer, is_signer=True, is_writable=True),
        AccountMeta(SYSTEM_PROGRAM_ID, is_signer=False, is_writable=False),
    ]

    return Instruction(ALT_PROGRAM_ID, data, accounts)


def _parse_alt_account(key: Pubkey, data: bytes) -> Optional[AddressLookupTableAccount]:
    """Parse ALT account data into AddressLookupTableAccount."""
    if len(data) < 56:
        return None
    addr_data = data[56:]
    num_addrs = len(addr_data) // 32
    addrs = [Pubkey.from_bytes(addr_data[i * 32:(i + 1) * 32]) for i in range(num_addrs)]
    return AddressLookupTableAccount(key=key, addresses=addrs)


class ALTManager:
    """Manages an Address Lookup Table for raw swap transactions."""

    def __init__(self, rpc: AsyncClient, authority: Keypair):
        self.rpc = rpc
        self.authority = authority
        self.table_address: Optional[Pubkey] = None
        self.table_account: Optional[AddressLookupTableAccount] = None
        self.known_addresses: set[str] = set()

    async def initialize(self) -> Optional[AddressLookupTableAccount]:
        """Load existing ALT or create a new one. Returns the table account."""
        # Try to load saved ALT
        if os.path.exists(ALT_STATE_FILE):
            try:
                with open(ALT_STATE_FILE) as f:
                    state = json.load(f)
                self.table_address = Pubkey.from_string(state["address"])
                table = await self._load_table()
                if table:
                    self.table_account = table
                    self.known_addresses = {str(a) for a in table.addresses}
                    logger.info(
                        f"ALT loaded: {state['address'][:16]}... "
                        f"({len(table.addresses)} addresses)"
                    )
                    return table
                logger.warning("Saved ALT not found on-chain, creating new")
            except Exception as e:
                logger.warning(f"Failed to load ALT state: {e}")

        # Create new ALT
        await self._create_table()
        return self.table_account

    async def _create_table(self):
        """Create a new ALT on-chain."""
        # Use confirmed slot (finalized can be too old for the blockhash)
        slot_resp = await self.rpc.get_slot("confirmed")
        recent_slot = slot_resp.value

        ix, table_addr = _build_create_lookup_table_ix(
            self.authority.pubkey(), self.authority.pubkey(), recent_slot
        )

        blockhash_resp = await self.rpc.get_latest_blockhash("confirmed")
        blockhash = str(blockhash_resp.value.blockhash)

        msg = MessageV0.try_compile(
            payer=self.authority.pubkey(),
            instructions=[
                set_compute_unit_limit(50_000),
                set_compute_unit_price(25_000),
                ix,
            ],
            address_lookup_table_accounts=[],
            recent_blockhash=Hash.from_string(blockhash),
        )
        tx = VersionedTransaction(msg, [self.authority])

        resp = await self.rpc.send_transaction(tx, opts=_TX_OPTS)
        sig = str(resp.value)
        logger.info(f"ALT create tx: {sig[:24]}... table={str(table_addr)[:16]}...")

        self.table_address = table_addr
        self.known_addresses = set()

        # Save for reuse across restarts
        with open(ALT_STATE_FILE, "w") as f:
            json.dump({"address": str(table_addr)}, f)

        # Wait for confirmation
        await self.rpc.confirm_transaction(resp.value, "confirmed")
        logger.info(f"ALT created and confirmed: {str(table_addr)[:16]}...")

        self.table_account = await self._load_table()

    async def extend(self, addresses: list) -> bool:
        """Add new addresses to the ALT. Returns True if extended."""
        if not self.table_address:
            return False

        # Filter out already-known addresses and the authority (signer)
        authority_str = str(self.authority.pubkey())
        new_addrs = [
            a for a in addresses
            if str(a) not in self.known_addresses and str(a) != authority_str
        ]
        if not new_addrs:
            return False

        # Max 20 addresses per extend tx (conservative, limit is ~30)
        for i in range(0, len(new_addrs), 20):
            batch = new_addrs[i:i + 20]
            ix = _build_extend_lookup_table_ix(
                self.table_address, self.authority.pubkey(),
                self.authority.pubkey(), batch,
            )

            blockhash_resp = await self.rpc.get_latest_blockhash("confirmed")
            blockhash = str(blockhash_resp.value.blockhash)

            msg = MessageV0.try_compile(
                payer=self.authority.pubkey(),
                instructions=[
                    set_compute_unit_limit(100_000),
                    set_compute_unit_price(25_000),
                    ix,
                ],
                address_lookup_table_accounts=[],
                recent_blockhash=Hash.from_string(blockhash),
            )
            tx = VersionedTransaction(msg, [self.authority])
            resp = await self.rpc.send_transaction(tx, opts=_TX_OPTS)
            await self.rpc.confirm_transaction(resp.value, "confirmed")

            for a in batch:
                self.known_addresses.add(str(a))
            logger.debug(f"ALT extended: +{len(batch)} addresses")

        # Reload table with new addresses
        self.table_account = await self._load_table()
        return True

    async def ensure_accounts(self, accounts: list) -> Optional[AddressLookupTableAccount]:
        """Ensure all given accounts are in the ALT. Extends if needed.

        Call this before building a transaction. Returns the table account
        ready to pass to MessageV0.try_compile.
        """
        if not self.table_address:
            await self.initialize()

        await self.extend(accounts)
        return self.table_account

    def get_tables(self) -> list:
        """Return list of ALT accounts for MessageV0.try_compile."""
        if self.table_account:
            return [self.table_account]
        return []

    async def _load_table(self) -> Optional[AddressLookupTableAccount]:
        """Load ALT account data from on-chain at confirmed commitment."""
        if not self.table_address:
            return None

        # Must use confirmed commitment to see recently-extended addresses.
        # Default (finalized) lags behind and returns stale data.
        resp = await self.rpc.get_account_info(self.table_address, Confirmed)
        if resp.value is None:
            return None

        return _parse_alt_account(self.table_address, bytes(resp.value.data))
