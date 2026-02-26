"""Quote provider — Raydium (via curl_cffi) and Jupiter (via httpx).

curl_cffi impersonates Chrome's TLS fingerprint, bypassing Cloudflare bot detection
that blocks Node.js fetch and Python requests/httpx.
"""

import asyncio
import time
from dataclasses import dataclass
from typing import Optional

from curl_cffi.requests import AsyncSession
import httpx
from loguru import logger

RAYDIUM_API = "https://transaction-v1.raydium.io"
JUPITER_API = "https://api.jup.ag/swap/v1"


@dataclass
class Quote:
    input_mint: str
    output_mint: str
    in_amount: int
    out_amount: int
    price_impact_pct: float
    slippage_bps: int
    route_count: int
    source: str  # "raydium" or "jupiter"


class QuoteProvider:
    """Fetches swap quotes from Raydium (primary) and Jupiter (fallback).

    Raydium: No API key needed, generous rate limits, uses curl_cffi to bypass Cloudflare.
    Jupiter: Requires API key, 1 RPS on Basic tier, used as fallback and for swap instructions.
    """

    def __init__(self, jupiter_api_key: str = "", use_raydium: bool = True):
        self.jupiter_api_key = jupiter_api_key
        self.use_raydium = use_raydium
        self._raydium_cooldown_until = 0.0
        self._raydium_cooldown_sec = 60.0
        self._raydium_last_request = 0.0
        self._raydium_min_interval = 1.2  # seconds between Raydium requests
        self._cf_session: Optional[AsyncSession] = None
        self._httpx_client: Optional[httpx.AsyncClient] = None
        # Jupiter rate limiter (token bucket)
        self._jup_tokens = 3.0
        self._jup_max_tokens = 3.0
        self._jup_refill_rate = 0.9  # tokens/sec
        self._jup_last_refill = time.monotonic()

    async def _get_cf_session(self) -> AsyncSession:
        if self._cf_session is None:
            self._cf_session = AsyncSession(impersonate="chrome")
        return self._cf_session

    async def _get_httpx_client(self) -> httpx.AsyncClient:
        if self._httpx_client is None:
            headers = {}
            if self.jupiter_api_key:
                headers["x-api-key"] = self.jupiter_api_key
            self._httpx_client = httpx.AsyncClient(
                headers=headers,
                timeout=httpx.Timeout(10.0),
            )
        return self._httpx_client

    async def close(self):
        if self._cf_session:
            await self._cf_session.close()
            self._cf_session = None
        if self._httpx_client:
            await self._httpx_client.aclose()
            self._httpx_client = None

    # ── Rate limiter for Jupiter ──

    async def _jup_acquire(self):
        """Wait for a Jupiter rate-limit token."""
        now = time.monotonic()
        elapsed = now - self._jup_last_refill
        self._jup_tokens = min(
            self._jup_max_tokens,
            self._jup_tokens + elapsed * self._jup_refill_rate,
        )
        self._jup_last_refill = now

        if self._jup_tokens >= 1.0:
            self._jup_tokens -= 1.0
            return

        wait = (1.0 - self._jup_tokens) / self._jup_refill_rate
        await asyncio.sleep(wait)
        self._jup_tokens = 0.0
        self._jup_last_refill = time.monotonic()

    # ── Quote methods ──

    async def get_quote(
        self,
        input_mint: str,
        output_mint: str,
        amount: int,
        slippage_bps: int = 50,
    ) -> Quote:
        """Get best available quote. Tries Raydium first, falls back to Jupiter."""

        # Try Raydium (no rate limit, curl_cffi bypasses Cloudflare)
        if self.use_raydium and time.monotonic() > self._raydium_cooldown_until:
            try:
                return await self._raydium_quote(
                    input_mint, output_mint, amount, slippage_bps
                )
            except Exception as e:
                msg = str(e)
                if "429" in msg or "1015" in msg or "403" in msg:
                    self._raydium_cooldown_until = (
                        time.monotonic() + self._raydium_cooldown_sec
                    )
                    logger.warning(
                        f"Raydium rate-limited ({msg[:60]}), cooling down {self._raydium_cooldown_sec}s"
                    )
                else:
                    logger.debug(f"Raydium quote failed: {msg[:80]}")

        # Fallback to Jupiter
        return await self._jupiter_quote(
            input_mint, output_mint, amount, slippage_bps
        )

    async def _raydium_quote(
        self,
        input_mint: str,
        output_mint: str,
        amount: int,
        slippage_bps: int,
    ) -> Quote:
        # Pace Raydium requests to avoid Cloudflare rate limit
        now = time.monotonic()
        elapsed = now - self._raydium_last_request
        if elapsed < self._raydium_min_interval:
            await asyncio.sleep(self._raydium_min_interval - elapsed)
        self._raydium_last_request = time.monotonic()

        session = await self._get_cf_session()
        params = {
            "inputMint": input_mint,
            "outputMint": output_mint,
            "amount": str(amount),
            "slippageBps": str(slippage_bps),
            "txVersion": "V0",
        }
        url = f"{RAYDIUM_API}/compute/swap-base-in"
        resp = await session.get(url, params=params, timeout=8)

        if resp.status_code != 200:
            raise Exception(f"Raydium {resp.status_code}: {resp.text[:200]}")

        data = resp.json()
        if not data.get("success") or not data.get("data"):
            raise Exception(f"Raydium quote failed: {str(data)[:200]}")

        d = data["data"]
        return Quote(
            input_mint=d.get("inputMint", input_mint),
            output_mint=d.get("outputMint", output_mint),
            in_amount=int(d["inputAmount"]),
            out_amount=int(d["outputAmount"]),
            price_impact_pct=float(d.get("priceImpactPct", 0)),
            slippage_bps=slippage_bps,
            route_count=len(d.get("routePlan", [])),
            source="raydium",
        )

    async def _jupiter_quote(
        self,
        input_mint: str,
        output_mint: str,
        amount: int,
        slippage_bps: int,
    ) -> Quote:
        await self._jup_acquire()

        client = await self._get_httpx_client()
        params = {
            "inputMint": input_mint,
            "outputMint": output_mint,
            "amount": str(amount),
            "slippageBps": str(slippage_bps),
            "maxAccounts": "40",
        }

        resp = await client.get(f"{JUPITER_API}/quote", params=params)

        if resp.status_code == 429:
            raise Exception("Jupiter 429: rate limited")
        if resp.status_code != 200:
            raise Exception(f"Jupiter {resp.status_code}: {resp.text[:200]}")

        data = resp.json()
        if not data.get("outAmount"):
            raise Exception(f"Jupiter quote empty: {str(data)[:200]}")

        return Quote(
            input_mint=data["inputMint"],
            output_mint=data["outputMint"],
            in_amount=int(data["inAmount"]),
            out_amount=int(data["outAmount"]),
            price_impact_pct=float(data.get("priceImpactPct", 0)),
            slippage_bps=slippage_bps,
            route_count=len(data.get("routePlan", [])),
            source="jupiter",
        )

    async def get_jupiter_swap_instructions(
        self, quote_response: dict, user_pubkey: str
    ) -> dict:
        """Get swap instructions from Jupiter (execution only)."""
        await self._jup_acquire()
        client = await self._get_httpx_client()

        body = {
            "quoteResponse": quote_response,
            "userPublicKey": user_pubkey,
            "wrapAndUnwrapSol": True,
            "dynamicComputeUnitLimit": True,
            "prioritizationFeeLamports": 0,
        }

        resp = await client.post(
            f"{JUPITER_API}/swap-instructions",
            json=body,
        )

        if resp.status_code != 200:
            raise Exception(
                f"Jupiter swap-instructions {resp.status_code}: {resp.text[:200]}"
            )

        data = resp.json()
        if not data.get("swapInstruction"):
            raise Exception(f"No swap instruction: {str(data)[:200]}")

        return data
