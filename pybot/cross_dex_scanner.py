"""Cross-DEX scanner — detects price discrepancies between AMM pools.

Instead of quoting through Jupiter aggregator (which already optimizes routing),
this scanner reads pool states directly from on-chain accounts and compares
prices across different DEXes for the same pair.

Flow:
  1. Fetch all pool states for a pair (Raydium CLMM, Orca, Meteora, etc.)
  2. Compare prices across pools to find the best buy and best sell
  3. If the spread exceeds threshold, build a cross-DEX arb:
     borrow → swap on cheap DEX → swap back on expensive DEX → repay
"""

import time
from dataclasses import dataclass
from typing import Optional

from solana.rpc.async_api import AsyncClient
from loguru import logger

from pool_decoder import PoolState
from pool_registry import PoolRegistry
from tokens import parse_pair, get_borrow_override, decimals_for_mint


@dataclass
class CrossDexOpportunity:
    """A cross-DEX arbitrage opportunity."""
    pair: str
    token_a: str  # quote (USDC)
    token_b: str  # target
    borrow_amount: int
    # Pool details
    buy_pool: PoolState   # Buy target token here (cheaper)
    sell_pool: PoolState  # Sell target token here (more expensive)
    buy_price: float      # price on buy pool (lower)
    sell_price: float     # price on sell pool (higher)
    spread_bps: int       # (sell - buy) / buy * 10000
    # Estimated profit
    estimated_profit_bps: int  # after flash loan fee + SOL costs
    source: str = "cross_dex"


class CrossDexScanner:
    """Scans for price discrepancies across DEXes by reading pool accounts directly."""

    def __init__(
        self,
        rpc: AsyncClient,
        registry: PoolRegistry,
        pool_fee_bps: int = 9,
        min_spread_bps: int = 15,  # Need ~15 bps raw spread to profit after fees
    ):
        self.rpc = rpc
        self.registry = registry
        self.pool_fee_bps = pool_fee_bps
        self.min_spread_bps = min_spread_bps
        self.best_spreads: dict[str, tuple[int, float]] = {}

    async def scan_pair(
        self, pair: str, default_borrow: int
    ) -> Optional[CrossDexOpportunity]:
        """Scan a pair for cross-DEX arbitrage by comparing pool prices."""
        target_mint, quote_mint = parse_pair(pair)

        # Per-pair borrow sizing
        override = get_borrow_override(target_mint)
        borrow = override if override > 0 else default_borrow

        try:
            # Fetch all pool states for this pair
            states = await self.registry.fetch_pool_states(quote_mint, target_mint)

            if len(states) < 2:
                logger.debug(f"{pair}: only {len(states)} pools, need 2+ for cross-dex")
                return None

            # Filter pools with valid prices
            priced = [s for s in states if s.price > 0]
            if len(priced) < 2:
                logger.debug(f"{pair}: only {len(priced)} pools with valid prices")
                return None

            # Find best buy (lowest price = most target per USDC)
            # and best sell (highest price = most USDC per target)
            #
            # Price is token_b per token_a:
            #   High price = token_b is cheap relative to token_a
            #   Low price = token_b is expensive relative to token_a
            #
            # For buying target (USDC → target): want HIGH price (get more target per USDC)
            # For selling target (target → USDC): want LOW price (target is worth more USDC)
            #
            # Wait — this depends on the price convention. Let's use:
            #   price = USDC_per_target (how much USDC one target token costs)
            #   Buy target: want LOW price (cheaper to buy)
            #   Sell target: want HIGH price (more USDC when selling)

            # Since pool_decoder stores price as token_b/token_a, we need to know
            # which token is which. For CLMM/Whirlpool, token_mint_a is the first
            # mint in the pool. We need to normalize prices to USDC_per_target.

            normalized = []
            for s in priced:
                usdc_per_target = self._normalize_price(s, quote_mint, target_mint)
                if usdc_per_target and usdc_per_target > 0:
                    normalized.append((s, usdc_per_target))

            if len(normalized) < 2:
                return None

            # Sort by price: lowest first
            normalized.sort(key=lambda x: x[1])

            cheapest_pool, cheapest_price = normalized[0]
            dearest_pool, dearest_price = normalized[-1]

            # Spread in basis points
            spread_bps = int((dearest_price - cheapest_price) / cheapest_price * 10000)

            # Sanity check: extreme spreads are pricing bugs, not real opportunities
            # Real cross-DEX arb > 500 bps (5%) would be arbed instantly by pros
            if spread_bps > 500:
                logger.debug(
                    f"{pair}: cross-dex spread {spread_bps} bps too extreme, "
                    f"likely pricing/decimal bug "
                    f"({cheapest_pool.dex}@{cheapest_price:.6f} vs "
                    f"{dearest_pool.dex}@{dearest_price:.6f})"
                )
                return None

            # Track best spread
            prev = self.best_spreads.get(pair)
            if prev is None or spread_bps > prev[0]:
                self.best_spreads[pair] = (spread_bps, time.time())

            # Estimate profit after costs
            flash_fee_bps = self.pool_fee_bps
            # DEX swap fees: ~30 bps average per leg = 60 bps total
            swap_fee_bps = 60
            # SOL costs ~2 bps
            sol_cost_bps = 2
            total_cost_bps = flash_fee_bps + swap_fee_bps + sol_cost_bps
            estimated_profit_bps = spread_bps - total_cost_bps

            pool_info = (
                f"buy={cheapest_pool.dex}@{cheapest_price:.6f} "
                f"sell={dearest_pool.dex}@{dearest_price:.6f}"
            )

            if spread_bps >= self.min_spread_bps:
                logger.info(
                    f"CROSS-DEX {pair}: spread={spread_bps:+d} bps, "
                    f"est_profit={estimated_profit_bps:+d} bps, {pool_info}"
                )
                return CrossDexOpportunity(
                    pair=pair,
                    token_a=quote_mint,
                    token_b=target_mint,
                    borrow_amount=borrow,
                    buy_pool=cheapest_pool,
                    sell_pool=dearest_pool,
                    buy_price=cheapest_price,
                    sell_price=dearest_price,
                    spread_bps=spread_bps,
                    estimated_profit_bps=estimated_profit_bps,
                )

            logger.debug(
                f"{pair}: xdex={spread_bps:+d} bps "
                f"(need {self.min_spread_bps}), {pool_info}"
            )
            return None

        except Exception as e:
            logger.warning(f"Cross-DEX scan failed {pair}: {e}")
            return None

    def _normalize_price(
        self, state: PoolState, quote_mint: str, target_mint: str
    ) -> Optional[float]:
        """Normalize pool price to USDC_per_target.

        Different DEXes store prices differently:
          Raydium CLMM: decimal-adjusted (decimals stored in pool account)
          Orca Whirlpool: raw sqrt_price, needs 10^(dec_a - dec_b) correction
          Meteora DLMM: raw bin price, needs 10^(dec_a - dec_b) correction
          Raydium v4: price=0 (needs vault balance fetch, skipped)

        We normalize everything to: USDC per target token.
        """
        mint_a = state.token_mint_a
        mint_b = state.token_mint_b

        # Determine if this pool has our pair's tokens
        if not ((mint_a == target_mint and mint_b == quote_mint) or
                (mint_a == quote_mint and mint_b == target_mint)):
            return None

        # Skip Raydium v4 (price requires vault balance fetch)
        if state.dex == "raydium_v4":
            return None

        # Get decimal-adjusted price depending on DEX type
        if state.dex == "orca" and state.sqrt_price_x64 > 0:
            # Orca Whirlpool: raw sqrt_price without decimal adjustment
            dec_a = decimals_for_mint(mint_a)
            dec_b = decimals_for_mint(mint_b)
            raw = (state.sqrt_price_x64 / (1 << 64)) ** 2
            price = raw * (10 ** (dec_a - dec_b))
        elif state.dex == "meteora":
            # Meteora DLMM: raw bin price without decimal adjustment
            dec_a = decimals_for_mint(mint_a)
            dec_b = decimals_for_mint(mint_b)
            price = state.price * (10 ** (dec_a - dec_b))
        else:
            # Raydium CLMM: already decimal-adjusted from pool account
            price = state.price

        if price <= 0:
            return None

        # price = token_b per token_a (how much B you get per 1 A)
        # We want USDC_per_target
        if mint_a == target_mint and mint_b == quote_mint:
            return price
        elif mint_a == quote_mint and mint_b == target_mint:
            return 1.0 / price if price > 0 else None
        return None
