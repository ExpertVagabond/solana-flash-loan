"""Pair scanner — scans token pairs for arbitrage opportunities."""

import asyncio
import time
from dataclasses import dataclass
from typing import Optional

from loguru import logger

from quote_provider import QuoteProvider, Quote
from tokens import parse_pair, get_borrow_override


@dataclass
class ArbitrageOpportunity:
    pair: str
    token_a: str  # quote token (USDC) — the borrowed token
    token_b: str  # target token
    borrow_amount: int
    leg1_out: int
    leg2_out: int
    flash_loan_fee: int
    profit_bps: int
    expected_profit: int  # in token_a units (USDC lamports)
    sol_costs: int  # estimated SOL costs in token_a units
    price_impact_leg1: float
    price_impact_leg2: float
    source: str  # quote source


def calculate_profit(
    pair: str,
    token_a: str,
    token_b: str,
    borrow_amount: int,
    leg1_out: int,
    leg2_out: int,
    pool_fee_bps: int,
    price_impact_1: float,
    price_impact_2: float,
    priority_fee_micro: int,
    compute_units: int,
    jito_tip: int,
    use_jito: bool,
    source: str,
) -> ArbitrageOpportunity:
    # Flash loan fee (ceiling division to match on-chain math)
    fee = (borrow_amount * pool_fee_bps + 9999) // 10000

    # Estimate SOL costs in token_a units using leg1 exchange rate
    sol_per_token = borrow_amount / max(leg1_out, 1)  # approximate
    base_fee_lamports = 5000
    priority_fee_lamports = (priority_fee_micro * compute_units) // 1_000_000
    jito_fee = jito_tip if use_jito else 0
    total_sol_lamports = base_fee_lamports + priority_fee_lamports + jito_fee
    # Rough SOL→token_a conversion: assume SOL price ~$85 → 85_000_000 USDC lamports per SOL
    sol_cost_in_token = (total_sol_lamports * 85_000_000) // 1_000_000_000

    # Net profit
    gross = leg2_out - borrow_amount
    net = gross - fee - sol_cost_in_token
    profit_bps = round((net / borrow_amount) * 10000) if borrow_amount > 0 else 0

    return ArbitrageOpportunity(
        pair=pair,
        token_a=token_a,
        token_b=token_b,
        borrow_amount=borrow_amount,
        leg1_out=leg1_out,
        leg2_out=leg2_out,
        flash_loan_fee=fee,
        profit_bps=profit_bps,
        expected_profit=max(0, net),
        sol_costs=sol_cost_in_token,
        price_impact_leg1=price_impact_1,
        price_impact_leg2=price_impact_2,
        source=source,
    )


class PairScanner:
    def __init__(
        self,
        quote_provider: QuoteProvider,
        pool_fee_bps: int = 9,
        min_profit_bps: int = 5,
        slippage_bps: int = 50,
        priority_fee_micro: int = 25000,
        compute_units: int = 400000,
        jito_tip: int = 10000,
        use_jito: bool = False,
    ):
        self.quotes = quote_provider
        self.pool_fee_bps = pool_fee_bps
        self.min_profit_bps = min_profit_bps
        self.slippage_bps = slippage_bps
        self.priority_fee_micro = priority_fee_micro
        self.compute_units = compute_units
        self.jito_tip = jito_tip
        self.use_jito = use_jito
        # Best observed spread per pair
        self.best_spreads: dict[str, tuple[int, float]] = {}  # pair -> (bps, timestamp)

    async def scan_pair(
        self,
        pair: str,
        default_borrow: int,
    ) -> Optional[ArbitrageOpportunity]:
        """Scan a single pair for arbitrage opportunity."""
        target_mint, quote_mint = parse_pair(pair)

        # Per-pair borrow sizing
        override = get_borrow_override(target_mint)
        borrow = override if override > 0 else default_borrow

        try:
            opp = await self._scan_direction(pair, quote_mint, target_mint, borrow)

            # Track best spread
            bps = opp.profit_bps if opp else -9999
            prev = self.best_spreads.get(pair)
            if prev is None or bps > prev[0]:
                self.best_spreads[pair] = (bps, time.time())

            if opp and opp.profit_bps >= self.min_profit_bps:
                logger.info(
                    f"OPPORTUNITY {pair}: {opp.profit_bps:+d} bps, "
                    f"profit={opp.expected_profit}, fee={opp.flash_loan_fee}, "
                    f"borrow={borrow}, via={opp.source}"
                )
                return opp

            logger.debug(
                f"{pair}: {bps:+d} bps (threshold={self.min_profit_bps}), "
                f"borrow={borrow}, via={opp.source if opp else '?'}"
            )
            return None

        except Exception as e:
            logger.warning(f"Pair scan failed {pair}: {e}")
            return None

    async def _scan_direction(
        self,
        pair: str,
        token_a: str,  # quote (USDC)
        token_b: str,  # target
        borrow_amount: int,
    ) -> ArbitrageOpportunity:
        # Leg 1: USDC → TARGET
        q1 = await self.quotes.get_quote(
            token_a, token_b, borrow_amount, self.slippage_bps
        )
        if q1.out_amount == 0:
            raise Exception("Leg 1 returned 0 output")

        # Leg 2: TARGET → USDC
        q2 = await self.quotes.get_quote(
            token_b, token_a, q1.out_amount, self.slippage_bps
        )

        return calculate_profit(
            pair=pair,
            token_a=token_a,
            token_b=token_b,
            borrow_amount=borrow_amount,
            leg1_out=q1.out_amount,
            leg2_out=q2.out_amount,
            pool_fee_bps=self.pool_fee_bps,
            price_impact_1=q1.price_impact_pct,
            price_impact_2=q2.price_impact_pct,
            priority_fee_micro=self.priority_fee_micro,
            compute_units=self.compute_units,
            jito_tip=self.jito_tip,
            use_jito=self.use_jito,
            source=q1.source,
        )
