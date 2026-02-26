"""Jito block engine client — sends transactions/bundles for MEV-competitive landing."""

import random
import httpx
import base58
from loguru import logger
from solders.pubkey import Pubkey
from solders.system_program import transfer, TransferParams
from solders.instruction import Instruction
from solders.transaction import VersionedTransaction

JITO_TIP_ACCOUNTS = [
    "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
    "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
    "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
    "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
    "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
    "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
    "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
    "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
]

JITO_ENDPOINTS = {
    "default": "https://mainnet.block-engine.jito.wtf",
    "ny": "https://ny.mainnet.block-engine.jito.wtf",
    "amsterdam": "https://amsterdam.mainnet.block-engine.jito.wtf",
    "frankfurt": "https://frankfurt.mainnet.block-engine.jito.wtf",
    "tokyo": "https://tokyo.mainnet.block-engine.jito.wtf",
    "slc": "https://slc.mainnet.block-engine.jito.wtf",
}


class JitoClient:
    def __init__(self, region: str = "default"):
        self.endpoint = JITO_ENDPOINTS.get(region, JITO_ENDPOINTS["default"])
        self._client = httpx.AsyncClient(timeout=10.0)
        logger.info(f"Jito client initialized: {self.endpoint}")

    async def close(self):
        await self._client.aclose()

    def get_random_tip_account(self) -> Pubkey:
        return Pubkey.from_string(random.choice(JITO_TIP_ACCOUNTS))

    def build_tip_instruction(self, payer: Pubkey, tip_lamports: int) -> Instruction:
        tip_account = self.get_random_tip_account()
        # solders transfer returns an Instruction directly
        return transfer(TransferParams(
            from_pubkey=payer,
            to_pubkey=tip_account,
            lamports=tip_lamports,
        ))

    async def send_transaction(self, tx: VersionedTransaction) -> str:
        serialized = base58.b58encode(bytes(tx)).decode()
        resp = await self._client.post(
            f"{self.endpoint}/api/v1/transactions",
            json={
                "jsonrpc": "2.0",
                "id": 1,
                "method": "sendTransaction",
                "params": [serialized, {"encoding": "base58"}],
            },
        )
        data = resp.json()
        if "error" in data and data["error"]:
            raise Exception(f"Jito sendTransaction failed: {data['error'].get('message', data['error'])}")
        sig = data.get("result", "")
        logger.info(f"Tx sent via Jito: {sig}")
        return sig

    async def send_bundle(self, txs: list[VersionedTransaction]) -> str:
        if not 1 <= len(txs) <= 5:
            raise ValueError(f"Bundle must contain 1-5 txs, got {len(txs)}")
        serialized = [base58.b58encode(bytes(tx)).decode() for tx in txs]
        resp = await self._client.post(
            f"{self.endpoint}/api/v1/bundles",
            json={
                "jsonrpc": "2.0",
                "id": 1,
                "method": "sendBundle",
                "params": [serialized],
            },
        )
        data = resp.json()
        if "error" in data and data["error"]:
            raise Exception(f"Jito sendBundle failed: {data['error'].get('message', data['error'])}")
        bundle_id = data.get("result", "")
        logger.info(f"Bundle sent via Jito: {bundle_id} ({len(txs)} txs)")
        return bundle_id
