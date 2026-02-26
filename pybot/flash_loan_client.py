"""Flash loan client — builds borrow/repay instructions for our Anchor program.

Derives PDAs and constructs raw Anchor instructions (discriminator + borsh args).
No Anchor SDK dependency — just solders.
"""

import struct

from solders.pubkey import Pubkey
from solders.instruction import Instruction, AccountMeta
from solders.system_program import ID as SYSTEM_PROGRAM_ID
from solana.rpc.async_api import AsyncClient
from loguru import logger

# SPL Token program ID
TOKEN_PROGRAM_ID = Pubkey.from_string("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")

# Anchor instruction discriminators (from IDL)
BORROW_DISCRIMINATOR = bytes([64, 203, 133, 3, 2, 181, 8, 180])
REPAY_DISCRIMINATOR = bytes([119, 239, 18, 45, 194, 107, 31, 238])

# PDA seeds
LENDING_POOL_SEED = b"lending_pool"
POOL_VAULT_SEED = b"pool_vault"
FLASH_LOAN_RECEIPT_SEED = b"flash_loan_receipt"


class FlashLoanClient:
    def __init__(
        self,
        rpc: AsyncClient,
        program_id: str,
        token_mint: str,
    ):
        self.rpc = rpc
        self.program_id = Pubkey.from_string(program_id)
        self.token_mint = Pubkey.from_string(token_mint)

        # Derive PDAs
        self.pool_pda, self.pool_bump = Pubkey.find_program_address(
            [LENDING_POOL_SEED, bytes(self.token_mint)],
            self.program_id,
        )
        self.vault_pda, self.vault_bump = Pubkey.find_program_address(
            [POOL_VAULT_SEED, bytes(self.pool_pda)],
            self.program_id,
        )

        logger.info(f"Flash loan pool PDA: {self.pool_pda}")
        logger.info(f"Flash loan vault PDA: {self.vault_pda}")

    def derive_receipt_pda(self, borrower: Pubkey) -> tuple[Pubkey, int]:
        return Pubkey.find_program_address(
            [FLASH_LOAN_RECEIPT_SEED, bytes(self.pool_pda), bytes(borrower)],
            self.program_id,
        )

    async def get_pool_state(self) -> dict:
        """Fetch and parse pool account data."""
        resp = await self.rpc.get_account_info(self.pool_pda)
        if resp.value is None:
            raise Exception("Pool account not found")

        data = bytes(resp.value.data)
        # Skip 8-byte Anchor discriminator
        offset = 8
        admin = Pubkey.from_bytes(data[offset:offset + 32]); offset += 32
        token_mint = Pubkey.from_bytes(data[offset:offset + 32]); offset += 32
        vault = Pubkey.from_bytes(data[offset:offset + 32]); offset += 32
        total_deposits = int.from_bytes(data[offset:offset + 8], "little"); offset += 8
        total_shares = int.from_bytes(data[offset:offset + 8], "little"); offset += 8
        total_fees = int.from_bytes(data[offset:offset + 8], "little"); offset += 8
        fee_bps = int.from_bytes(data[offset:offset + 2], "little"); offset += 2
        bump = data[offset]; offset += 1
        vault_bump = data[offset]; offset += 1
        is_active = bool(data[offset]); offset += 1

        return {
            "admin": str(admin),
            "token_mint": str(token_mint),
            "vault": str(vault),
            "total_deposits": total_deposits,
            "total_shares": total_shares,
            "total_fees_earned": total_fees,
            "fee_bps": fee_bps,
            "bump": bump,
            "vault_bump": vault_bump,
            "is_active": is_active,
        }

    def build_borrow_ix(
        self,
        borrower: Pubkey,
        borrower_token_account: Pubkey,
        amount: int,
    ) -> Instruction:
        """Build borrow_flash_loan instruction."""
        receipt_pda, _ = self.derive_receipt_pda(borrower)

        # Anchor: discriminator (8 bytes) + amount (u64 LE)
        ix_data = BORROW_DISCRIMINATOR + struct.pack("<Q", amount)

        accounts = [
            AccountMeta(self.pool_pda, is_signer=False, is_writable=True),
            AccountMeta(receipt_pda, is_signer=False, is_writable=True),
            AccountMeta(self.vault_pda, is_signer=False, is_writable=True),
            AccountMeta(borrower_token_account, is_signer=False, is_writable=True),
            AccountMeta(borrower, is_signer=True, is_writable=True),
            AccountMeta(SYSTEM_PROGRAM_ID, is_signer=False, is_writable=False),
            AccountMeta(TOKEN_PROGRAM_ID, is_signer=False, is_writable=False),
        ]

        return Instruction(self.program_id, ix_data, accounts)

    def build_repay_ix(
        self,
        borrower: Pubkey,
        borrower_token_account: Pubkey,
    ) -> Instruction:
        """Build repay_flash_loan instruction."""
        receipt_pda, _ = self.derive_receipt_pda(borrower)

        # Anchor: discriminator only (no args)
        ix_data = REPAY_DISCRIMINATOR

        accounts = [
            AccountMeta(self.pool_pda, is_signer=False, is_writable=True),
            AccountMeta(receipt_pda, is_signer=False, is_writable=True),
            AccountMeta(self.vault_pda, is_signer=False, is_writable=True),
            AccountMeta(borrower_token_account, is_signer=False, is_writable=True),
            AccountMeta(borrower, is_signer=True, is_writable=True),
            AccountMeta(TOKEN_PROGRAM_ID, is_signer=False, is_writable=False),
        ]

        return Instruction(self.program_id, ix_data, accounts)
