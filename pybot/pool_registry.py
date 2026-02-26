"""Pool registry — maps token pairs to known AMM pool addresses across DEXes.

Pools are discovered via Jupiter API and cached. Each pair can have multiple pools
on different DEXes, which is what enables cross-DEX arbitrage.
"""

import asyncio
from dataclasses import dataclass, field
from typing import Optional

import httpx
from solders.pubkey import Pubkey
from solana.rpc.async_api import AsyncClient
from loguru import logger

from pool_decoder import (
    RAYDIUM_CLMM_PROGRAM,
    RAYDIUM_AMM_V4_PROGRAM,
    ORCA_WHIRLPOOL_PROGRAM,
    METEORA_DLMM_PROGRAM,
    decode_pool,
    PoolState,
)

# Known program IDs we can decode
KNOWN_PROGRAMS = {
    str(RAYDIUM_CLMM_PROGRAM): "raydium_clmm",
    str(RAYDIUM_AMM_V4_PROGRAM): "raydium_v4",
    str(ORCA_WHIRLPOOL_PROGRAM): "orca",
    str(METEORA_DLMM_PROGRAM): "meteora",
}


@dataclass
class PoolInfo:
    """Registered pool with metadata."""
    address: str
    program_id: str
    dex: str
    token_a: str  # mint
    token_b: str  # mint
    label: str = ""  # e.g. "Raydium CLMM SOL/USDC"


@dataclass
class PairPools:
    """All known pools for a token pair across DEXes."""
    token_a: str
    token_b: str
    pools: list[PoolInfo] = field(default_factory=list)

    @property
    def dex_count(self) -> int:
        return len(set(p.dex for p in self.pools))


class PoolRegistry:
    """Discovers and tracks AMM pools across DEXes for arbitrage pairs."""

    def __init__(self, rpc: AsyncClient, jupiter_api_key: str = ""):
        self.rpc = rpc
        self.jupiter_api_key = jupiter_api_key
        # pair_key -> PairPools
        self._pairs: dict[str, PairPools] = {}
        # pool_address -> PoolInfo
        self._pools: dict[str, PoolInfo] = {}

    def _pair_key(self, mint_a: str, mint_b: str) -> str:
        """Canonical pair key (sorted)."""
        return f"{min(mint_a, mint_b)}:{max(mint_a, mint_b)}"

    def register_pool(self, pool: PoolInfo):
        """Register a pool for tracking."""
        key = self._pair_key(pool.token_a, pool.token_b)
        if key not in self._pairs:
            self._pairs[key] = PairPools(token_a=pool.token_a, token_b=pool.token_b)

        # Don't duplicate
        if pool.address not in self._pools:
            self._pairs[key].pools.append(pool)
            self._pools[pool.address] = pool

    async def discover_pools_for_pair(
        self, mint_a: str, mint_b: str, pair_label: str = ""
    ) -> list[PoolInfo]:
        """Discover pools for a token pair using Jupiter route API.

        Jupiter's quote response includes routePlan which shows which AMM pools
        are used for routing. We extract pool addresses and program IDs from this.
        """
        discovered = []

        headers = {}
        if self.jupiter_api_key:
            headers["x-api-key"] = self.jupiter_api_key

        try:
            async with httpx.AsyncClient(headers=headers, timeout=10.0) as client:
                # Get route for a→b
                resp = await client.get(
                    "https://api.jup.ag/swap/v1/quote",
                    params={
                        "inputMint": mint_a,
                        "outputMint": mint_b,
                        "amount": "1000000",  # 1 USDC
                        "slippageBps": "100",
                        "maxAccounts": "64",
                    },
                )
                if resp.status_code == 200:
                    data = resp.json()
                    discovered.extend(
                        self._extract_pools_from_route(data, mint_a, mint_b, pair_label)
                    )

                # Also get route for b→a (might use different pools)
                resp2 = await client.get(
                    "https://api.jup.ag/swap/v1/quote",
                    params={
                        "inputMint": mint_b,
                        "outputMint": mint_a,
                        "amount": "1000000000",  # 1 SOL
                        "slippageBps": "100",
                        "maxAccounts": "64",
                    },
                )
                if resp2.status_code == 200:
                    data2 = resp2.json()
                    discovered.extend(
                        self._extract_pools_from_route(data2, mint_b, mint_a, pair_label)
                    )

        except Exception as e:
            logger.warning(f"Pool discovery failed for {pair_label}: {e}")

        # Register all discovered pools
        for pool in discovered:
            self.register_pool(pool)

        key = self._pair_key(mint_a, mint_b)
        pair_pools = self._pairs.get(key)
        if pair_pools:
            unique_dexes = set(p.dex for p in pair_pools.pools)
            logger.info(
                f"Pools for {pair_label or key}: {len(pair_pools.pools)} pools "
                f"on {len(unique_dexes)} DEXes ({', '.join(sorted(unique_dexes))})"
            )

        return discovered

    def _extract_pools_from_route(
        self, quote_data: dict, mint_a: str, mint_b: str, label: str
    ) -> list[PoolInfo]:
        """Extract pool addresses from Jupiter route response."""
        pools = []
        route_plan = quote_data.get("routePlan", [])

        for step in route_plan:
            swap_info = step.get("swapInfo", {})
            amm_key = swap_info.get("ammKey", "")
            amm_label = swap_info.get("label", "")

            if not amm_key:
                continue

            # Determine program ID from the label
            program_id = self._label_to_program(amm_label)
            if not program_id:
                continue

            dex = KNOWN_PROGRAMS.get(program_id, "unknown")

            pool = PoolInfo(
                address=amm_key,
                program_id=program_id,
                dex=dex,
                token_a=swap_info.get("inputMint", mint_a),
                token_b=swap_info.get("outputMint", mint_b),
                label=f"{amm_label} {label}".strip(),
            )
            pools.append(pool)

        return pools

    def _label_to_program(self, label: str) -> Optional[str]:
        """Map Jupiter AMM label to program ID."""
        label_lower = label.lower()
        if "raydium" in label_lower and "clmm" in label_lower:
            return str(RAYDIUM_CLMM_PROGRAM)
        elif "raydium" in label_lower and ("amm" in label_lower or "v4" in label_lower):
            return str(RAYDIUM_AMM_V4_PROGRAM)
        elif "raydium" in label_lower and "cp" in label_lower:
            return str(RAYDIUM_AMM_V4_PROGRAM)
        elif "raydium" in label_lower:
            # Default Raydium to CLMM (most common)
            return str(RAYDIUM_CLMM_PROGRAM)
        elif "whirlpool" in label_lower or "orca" in label_lower:
            return str(ORCA_WHIRLPOOL_PROGRAM)
        elif "meteora" in label_lower and "dlmm" in label_lower:
            return str(METEORA_DLMM_PROGRAM)
        elif "meteora" in label_lower:
            return str(METEORA_DLMM_PROGRAM)
        # Skip DEXes we can't decode (Phoenix, Lifinity, Manifest, PancakeSwap, etc.)
        return None

    async def discover_pools_for_pair_multi(
        self, mint_a: str, mint_b: str, pair_label: str = ""
    ) -> list[PoolInfo]:
        """Discover pools using multiple quote amounts to get diverse routes.

        Jupiter picks different pools for different amounts, so querying
        with multiple sizes reveals more pool addresses.
        """
        all_discovered = []

        headers = {}
        if self.jupiter_api_key:
            headers["x-api-key"] = self.jupiter_api_key

        # Try different amounts to get different route compositions
        amounts_a = ["100000", "1000000", "10000000", "100000000", "500000000"]
        amounts_b = ["10000000", "100000000", "1000000000", "5000000000"]

        try:
            async with httpx.AsyncClient(headers=headers, timeout=10.0) as client:
                for amount in amounts_a:
                    resp = await client.get(
                        "https://api.jup.ag/swap/v1/quote",
                        params={
                            "inputMint": mint_a,
                            "outputMint": mint_b,
                            "amount": amount,
                            "slippageBps": "100",
                            "maxAccounts": "64",
                        },
                    )
                    if resp.status_code == 200:
                        all_discovered.extend(
                            self._extract_pools_from_route(
                                resp.json(), mint_a, mint_b, pair_label
                            )
                        )
                    await asyncio.sleep(1.2)  # Rate limit

                for amount in amounts_b:
                    resp = await client.get(
                        "https://api.jup.ag/swap/v1/quote",
                        params={
                            "inputMint": mint_b,
                            "outputMint": mint_a,
                            "amount": amount,
                            "slippageBps": "100",
                            "maxAccounts": "64",
                        },
                    )
                    if resp.status_code == 200:
                        all_discovered.extend(
                            self._extract_pools_from_route(
                                resp.json(), mint_b, mint_a, pair_label
                            )
                        )
                    await asyncio.sleep(1.2)

        except Exception as e:
            logger.warning(f"Multi pool discovery failed for {pair_label}: {e}")

        for pool in all_discovered:
            self.register_pool(pool)

        key = self._pair_key(mint_a, mint_b)
        pair_pools = self._pairs.get(key)
        if pair_pools:
            unique_dexes = set(p.dex for p in pair_pools.pools)
            logger.info(
                f"Pools for {pair_label or key}: {len(pair_pools.pools)} pools "
                f"on {len(unique_dexes)} DEXes ({', '.join(sorted(unique_dexes))})"
            )

        return all_discovered

    async def discover_from_dex_apis(
        self, mint_a: str, mint_b: str, pair_label: str = ""
    ) -> list[PoolInfo]:
        """Discover pools directly from DEX APIs (more reliable than Jupiter routes).

        Queries Raydium and Orca pool list APIs to find all pools for a token pair.
        """
        discovered = []

        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                # ── Raydium CLMM pools ──
                try:
                    resp = await client.get(
                        "https://api-v3.raydium.io/pools/info/mint",
                        params={
                            "mint1": mint_a,
                            "mint2": mint_b,
                            "poolType": "concentrated",
                            "poolSortField": "liquidity",
                            "sortType": "desc",
                            "pageSize": "10",
                            "page": "1",
                        },
                    )
                    if resp.status_code == 200:
                        data = resp.json()
                        for pool in data.get("data", {}).get("data", []):
                            pool_id = pool.get("id", "")
                            if pool_id:
                                # mintA/mintB are objects with .address
                                ma = pool.get("mintA", {})
                                mb = pool.get("mintB", {})
                                ma_addr = ma.get("address", mint_a) if isinstance(ma, dict) else ma
                                mb_addr = mb.get("address", mint_b) if isinstance(mb, dict) else mb
                                discovered.append(PoolInfo(
                                    address=pool_id,
                                    program_id=str(RAYDIUM_CLMM_PROGRAM),
                                    dex="raydium_clmm",
                                    token_a=ma_addr,
                                    token_b=mb_addr,
                                    label=f"Raydium CLMM {pair_label}",
                                ))
                except Exception as e:
                    logger.debug(f"Raydium CLMM discovery: {e}")

                await asyncio.sleep(0.5)

                # ── Raydium AMM v4 pools ──
                try:
                    resp = await client.get(
                        "https://api-v3.raydium.io/pools/info/mint",
                        params={
                            "mint1": mint_a,
                            "mint2": mint_b,
                            "poolType": "standard",
                            "poolSortField": "liquidity",
                            "sortType": "desc",
                            "pageSize": "5",
                            "page": "1",
                        },
                    )
                    if resp.status_code == 200:
                        data = resp.json()
                        for pool in data.get("data", {}).get("data", []):
                            pool_id = pool.get("id", "")
                            if pool_id:
                                ma = pool.get("mintA", {})
                                mb = pool.get("mintB", {})
                                ma_addr = ma.get("address", mint_a) if isinstance(ma, dict) else ma
                                mb_addr = mb.get("address", mint_b) if isinstance(mb, dict) else mb
                                discovered.append(PoolInfo(
                                    address=pool_id,
                                    program_id=str(RAYDIUM_AMM_V4_PROGRAM),
                                    dex="raydium_v4",
                                    token_a=ma_addr,
                                    token_b=mb_addr,
                                    label=f"Raydium v4 {pair_label}",
                                ))
                except Exception as e:
                    logger.debug(f"Raydium v4 discovery: {e}")

                await asyncio.sleep(0.5)

                # ── Orca Whirlpool pools ──
                try:
                    # Orca's Whirlpool API
                    resp = await client.get(
                        "https://api.mainnet.orca.so/v1/whirlpool/list",
                    )
                    if resp.status_code == 200:
                        data = resp.json()
                        for wp in data.get("whirlpools", []):
                            ta = wp.get("tokenA", {}).get("mint", "")
                            tb = wp.get("tokenB", {}).get("mint", "")
                            addr = wp.get("address", "")
                            # Check if this pool matches our pair (either direction)
                            if addr and (
                                (ta == mint_a and tb == mint_b) or
                                (ta == mint_b and tb == mint_a)
                            ):
                                discovered.append(PoolInfo(
                                    address=addr,
                                    program_id=str(ORCA_WHIRLPOOL_PROGRAM),
                                    dex="orca",
                                    token_a=ta,
                                    token_b=tb,
                                    label=f"Orca Whirlpool {pair_label}",
                                ))
                except Exception as e:
                    logger.debug(f"Orca discovery: {e}")

        except Exception as e:
            logger.warning(f"DEX API discovery failed for {pair_label}: {e}")

        for pool in discovered:
            self.register_pool(pool)

        key = self._pair_key(mint_a, mint_b)
        pair_pools = self._pairs.get(key)
        if pair_pools:
            unique_dexes = set(p.dex for p in pair_pools.pools)
            logger.info(
                f"DEX API pools for {pair_label}: {len(pair_pools.pools)} pools "
                f"on {len(unique_dexes)} DEXes ({', '.join(sorted(unique_dexes))})"
            )

        return discovered

    async def fetch_pool_states(
        self, mint_a: str, mint_b: str
    ) -> list[PoolState]:
        """Fetch current state for all registered pools of a pair."""
        key = self._pair_key(mint_a, mint_b)
        pair_pools = self._pairs.get(key)
        if not pair_pools:
            return []

        states = []
        for pool_info in pair_pools.pools:
            try:
                pk = Pubkey.from_string(pool_info.address)
                resp = await self.rpc.get_account_info(pk)
                if resp.value is None:
                    continue

                data = bytes(resp.value.data)
                state = decode_pool(data, pool_info.address, pool_info.program_id)
                if state:
                    states.append(state)
            except Exception as e:
                logger.debug(f"Failed to fetch pool {pool_info.address}: {e}")

        return states

    def get_pair_pools(self, mint_a: str, mint_b: str) -> Optional[PairPools]:
        key = self._pair_key(mint_a, mint_b)
        return self._pairs.get(key)

    @property
    def total_pools(self) -> int:
        return len(self._pools)

    @property
    def total_pairs(self) -> int:
        return len(self._pairs)
