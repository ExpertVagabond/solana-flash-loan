"""Triangular arbitrage scanner — finds profitable 3-leg paths across DEXes.

Builds a price graph from on-chain pool states and searches for profitable
triangular cycles that start and end with USDC:

  USDC →(DEX A)→ Token X →(DEX B)→ Token Y →(DEX C)→ USDC

If the product of exchange rates exceeds 1 + costs, there's profit.

Why this works when direct pair arb doesn't:
  - Jupiter optimizes single-pair routes, making direct spreads < 15 bps
  - But Jupiter doesn't explore every 3-leg combination across every DEX
  - Cross-DEX triangular paths through mid/low-liquidity tokens can have
    wider spreads that persist longer

Supported DEXes:
  Raydium CLMM, Raydium AMM v4, Orca Whirlpool, Meteora DLMM
"""

import time
from dataclasses import dataclass, field
from typing import Optional

from solana.rpc.async_api import AsyncClient
from loguru import logger

from pool_decoder import PoolState
from pool_registry import PoolRegistry, PoolInfo
from tokens import (
    WELL_KNOWN_MINTS, TOKEN_DECIMALS, decimals_for_mint,
    resolve_mint,
)


@dataclass
class PriceEdge:
    """A directed price edge in the token graph."""
    from_mint: str
    to_mint: str
    rate: float           # How much to_token you get per 1 from_token
    pool_address: str
    dex: str
    pool_state: PoolState
    fee_bps: int = 30     # Estimated swap fee for this pool


@dataclass
class TriangularOpportunity:
    """A profitable 3-leg arbitrage path."""
    path: list[str]       # [USDC, token_x, token_y, USDC] (4 elements, first==last)
    edges: list[PriceEdge]  # 3 edges
    round_trip_rate: float  # Product of rates (>1 means profit before fees)
    gross_profit_bps: int   # (rate - 1) * 10000
    net_profit_bps: int     # After fees (flash loan + swap fees + SOL)
    borrow_amount: int
    source: str = "triangular"


# Tokens to include in the triangular graph
# Focus on tokens with deep liquidity on multiple DEXes
GRAPH_TOKENS = [
    "USDC", "SOL", "USDT",
    # DeFi blue chips
    "JUP", "RAY", "ORCA", "PYTH", "JTO", "W", "TNSR",
    # LSTs (trade against SOL and each other)
    "MSOL", "JITOSOL", "BSOL", "INF",
    # High volume
    "BONK", "WIF", "POPCAT", "TRUMP", "FARTCOIN",
    # Mid liquidity
    "KMNO", "DRIFT", "HNT", "RENDER",
]


class TriangularScanner:
    """Scans for profitable triangular arbitrage paths.

    Builds a price graph from registered pool states and finds 3-cycles
    that yield positive returns after fees.
    """

    def __init__(
        self,
        rpc: AsyncClient,
        registry: PoolRegistry,
        flash_fee_bps: int = 9,
        min_profit_bps: int = 15,
    ):
        self.rpc = rpc
        self.registry = registry
        self.flash_fee_bps = flash_fee_bps
        self.min_profit_bps = min_profit_bps
        # price graph: from_mint -> list[PriceEdge]
        self._graph: dict[str, list[PriceEdge]] = {}
        self.best_triangles: dict[str, tuple[int, float]] = {}  # path_key -> (bps, time)

    def _estimate_fee_bps(self, state: PoolState) -> int:
        """Estimate swap fee in bps for a pool."""
        if state.dex == "orca" and state.fee_rate > 0:
            # Orca fee_rate is in hundredths of a bps (1 = 0.01%)
            return max(1, state.fee_rate // 100)
        elif state.dex == "raydium_clmm":
            return 25  # Raydium CLMM typically 25 bps
        elif state.dex == "raydium_v4":
            return 25  # Raydium v4 typically 25 bps
        elif state.dex == "meteora":
            # Meteora uses dynamic fees based on bin_step
            return max(10, state.fee_rate)  # bin_step as rough fee estimate
        return 30  # Default

    def _compute_rate(
        self, state: PoolState, from_mint: str, to_mint: str
    ) -> Optional[float]:
        """Compute the exchange rate from_token → to_token using pool state.

        Returns how much to_token you get per 1 from_token (human-readable).
        """
        mint_a = state.token_mint_a
        mint_b = state.token_mint_b

        if not ((mint_a == from_mint and mint_b == to_mint) or
                (mint_a == to_mint and mint_b == from_mint)):
            return None

        # Skip pools we can't price
        if state.dex == "raydium_v4":
            return None
        if state.dex in ("raydium_clmm", "orca") and state.liquidity == 0:
            return None

        # Get decimal-adjusted price (token_b per token_a)
        if state.dex == "orca" and state.sqrt_price_x64 > 0:
            dec_a = decimals_for_mint(mint_a)
            dec_b = decimals_for_mint(mint_b)
            raw = (state.sqrt_price_x64 / (1 << 64)) ** 2
            price = raw * (10 ** (dec_a - dec_b))
        elif state.dex == "meteora":
            dec_a = decimals_for_mint(mint_a)
            dec_b = decimals_for_mint(mint_b)
            price = state.price * (10 ** (dec_a - dec_b))
        else:
            # Raydium CLMM: already adjusted
            price = state.price

        if price <= 0:
            return None

        # price = token_b per token_a
        if mint_a == from_mint and mint_b == to_mint:
            # Direct: from=A, to=B → rate = price (B per A)
            return price
        elif mint_a == to_mint and mint_b == from_mint:
            # Inverted: from=B, to=A → rate = 1/price (A per B)
            return 1.0 / price
        return None

    async def build_graph(self):
        """Build the price graph from all registered pools.

        Fetches current state for all pools and creates directed edges
        for both directions of each pool.

        Applies median-based outlier filtering: for each directed edge
        (from_mint → to_mint), if there are multiple pools, only keep
        rates within 2x of the median to filter out broken prices.
        """
        self._graph.clear()
        edges_added = 0
        pools_fetched = 0

        # Collect all candidate edges first, then filter
        # Key: (from_mint, to_mint) -> list[PriceEdge]
        candidate_edges: dict[tuple[str, str], list[PriceEdge]] = {}

        for pair_key, pair_pools in self.registry._pairs.items():
            try:
                states = await self.registry.fetch_pool_states(
                    pair_pools.token_a, pair_pools.token_b
                )
                pools_fetched += len(states)

                for state in states:
                    mint_a = state.token_mint_a
                    mint_b = state.token_mint_b
                    fee = self._estimate_fee_bps(state)

                    # Edge A → B
                    rate_ab = self._compute_rate(state, mint_a, mint_b)
                    if rate_ab and rate_ab > 0:
                        edge = PriceEdge(
                            from_mint=mint_a, to_mint=mint_b,
                            rate=rate_ab, pool_address=state.pool_address,
                            dex=state.dex, pool_state=state, fee_bps=fee,
                        )
                        candidate_edges.setdefault((mint_a, mint_b), []).append(edge)

                    # Edge B → A
                    rate_ba = self._compute_rate(state, mint_b, mint_a)
                    if rate_ba and rate_ba > 0:
                        edge = PriceEdge(
                            from_mint=mint_b, to_mint=mint_a,
                            rate=rate_ba, pool_address=state.pool_address,
                            dex=state.dex, pool_state=state, fee_bps=fee,
                        )
                        candidate_edges.setdefault((mint_b, mint_a), []).append(edge)

            except Exception as e:
                logger.debug(f"Graph build error for {pair_key}: {e}")

        # Filter outlier edges: for each (from, to), keep only rates within 2x of median
        outliers_removed = 0
        for key, edges in candidate_edges.items():
            if len(edges) >= 2:
                rates = sorted(e.rate for e in edges)
                median_rate = rates[len(rates) // 2]
                filtered = [
                    e for e in edges
                    if 0.5 * median_rate <= e.rate <= 2.0 * median_rate
                ]
                outliers_removed += len(edges) - len(filtered)
                edges = filtered

            for edge in edges:
                self._graph.setdefault(edge.from_mint, []).append(edge)
                edges_added += 1

        logger.info(
            f"Price graph built: {len(self._graph)} tokens, "
            f"{edges_added} edges from {pools_fetched} pool states "
            f"({outliers_removed} outlier edges removed)"
        )

    async def scan_triangles(
        self, borrow_amount: int = 200_000_000,
        focus_mints: Optional[set] = None,
    ) -> list[TriangularOpportunity]:
        """Find all profitable triangular paths starting/ending at USDC.

        Searches for 3-cycles: USDC → X → Y → USDC where the product
        of exchange rates exceeds 1 + costs.
        """
        usdc_mint = resolve_mint("USDC")
        opportunities = []

        usdc_edges = self._graph.get(usdc_mint, [])
        if not usdc_edges:
            logger.debug("No USDC edges in graph")
            return []

        # For each first hop: USDC → X
        for edge1 in usdc_edges:
            x_mint = edge1.to_mint
            if x_mint == usdc_mint:
                continue
            # Focus filtering: only check triangles through batch tokens
            if focus_mints and x_mint not in focus_mints:
                continue

            x_edges = self._graph.get(x_mint, [])
            if not x_edges:
                continue

            # For each second hop: X → Y
            for edge2 in x_edges:
                y_mint = edge2.to_mint
                if y_mint == usdc_mint or y_mint == x_mint:
                    continue

                y_edges = self._graph.get(y_mint, [])
                if not y_edges:
                    continue

                # For each third hop: Y → USDC
                for edge3 in y_edges:
                    if edge3.to_mint != usdc_mint:
                        continue

                    # Skip if same pool used twice (can't swap both directions atomically)
                    pools_used = {edge1.pool_address, edge2.pool_address, edge3.pool_address}
                    if len(pools_used) < 3:
                        continue

                    # Compute round-trip rate (product of rates)
                    round_trip = edge1.rate * edge2.rate * edge3.rate

                    # Sanity check: rate > 1.5% is almost certainly a pricing bug
                    # (marginal pool prices overestimate executable rates by 100-300 bps)
                    if round_trip > 1.015 or round_trip < 0.5:
                        continue

                    # Total swap fees (sum of all 3 legs)
                    total_swap_fee_bps = edge1.fee_bps + edge2.fee_bps + edge3.fee_bps
                    # After fee multiplier: (1 - fee1/10000) * (1 - fee2/10000) * (1 - fee3/10000)
                    fee_mult = (
                        (1 - edge1.fee_bps / 10000) *
                        (1 - edge2.fee_bps / 10000) *
                        (1 - edge3.fee_bps / 10000)
                    )
                    # Net rate after swap fees
                    net_rate = round_trip * fee_mult

                    # Gross profit (before flash loan fee)
                    gross_bps = int((net_rate - 1.0) * 10000)
                    # Net profit (after flash loan fee + SOL costs)
                    sol_cost_bps = 3  # ~3 bps for SOL tx fees
                    net_bps = gross_bps - self.flash_fee_bps - sol_cost_bps

                    # Track best triangle per path
                    path_key = f"{x_mint[:8]}→{y_mint[:8]}"
                    prev = self.best_triangles.get(path_key)
                    if prev is None or net_bps > prev[0]:
                        self.best_triangles[path_key] = (net_bps, time.time())

                    if net_bps >= self.min_profit_bps:
                        mint_to_sym = {v: k for k, v in WELL_KNOWN_MINTS.items()}
                        x_sym = mint_to_sym.get(x_mint, x_mint[:8])
                        y_sym = mint_to_sym.get(y_mint, y_mint[:8])

                        opp = TriangularOpportunity(
                            path=[usdc_mint, x_mint, y_mint, usdc_mint],
                            edges=[edge1, edge2, edge3],
                            round_trip_rate=round_trip,
                            gross_profit_bps=gross_bps,
                            net_profit_bps=net_bps,
                            borrow_amount=borrow_amount,
                        )
                        opportunities.append(opp)

                        logger.info(
                            f"TRIANGLE: USDC→{x_sym}({edge1.dex})→"
                            f"{y_sym}({edge2.dex})→USDC({edge3.dex}) "
                            f"rate={round_trip:.6f} gross={gross_bps:+d} "
                            f"net={net_bps:+d} bps "
                            f"fees={total_swap_fee_bps} bps"
                        )

        # Sort by net profit (best first) and deduplicate by path
        opportunities.sort(key=lambda o: o.net_profit_bps, reverse=True)

        # Deduplicate: keep only best opportunity per unique path
        seen_paths = set()
        deduped = []
        for opp in opportunities:
            path_key = f"{opp.path[1][:8]}→{opp.path[2][:8]}"
            if path_key not in seen_paths:
                seen_paths.add(path_key)
                deduped.append(opp)
        opportunities = deduped

        if opportunities:
            logger.info(f"Found {len(opportunities)} triangular opportunities (deduped)")
        else:
            top = sorted(self.best_triangles.items(), key=lambda x: x[1][0], reverse=True)[:5]
            if top:
                near_miss = ", ".join(f"{k}={v[0]:+d}bps" for k, v in top)
                logger.debug(f"No triangular opps. Best near-misses: {near_miss}")

        return opportunities

    async def scan_once(
        self, borrow_amount: int = 200_000_000
    ) -> list[TriangularOpportunity]:
        """Full scan: rebuild graph from on-chain state, then search triangles."""
        await self.build_graph()
        return await self.scan_triangles(borrow_amount)
