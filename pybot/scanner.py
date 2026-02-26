"""Pair scanner — scans token pairs for arbitrage opportunities."""

import asyncio
import time
from dataclasses import dataclass
from typing import Optional

from loguru import logger

from quote_provider import QuoteProvider, Quote
from tokens import parse_pair, get_borrow_override
from fee_strategy import FeeStrategy, FeeParams


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
    # Dynamic fee params for execution
    dynamic_cu_price: int = 0
    dynamic_tip_lamports: int = 0


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
    fee_strategy: FeeStrategy,
    use_jito: bool,
    source: str,
) -> ArbitrageOpportunity:
    # Flash loan fee (ceiling division to match on-chain math)
    fee = (borrow_amount * pool_fee_bps + 9999) // 10000

    # Gross profit before any costs
    gross = leg2_out - borrow_amount

    # Dynamic fee calculation based on opportunity quality
    fee_params = fee_strategy.compute_fees(
        gross_profit_usdc=gross,
        flash_loan_fee=fee,
    )

    # SOL cost in USDC lamports
    sol_cost_in_token = fee_strategy.estimate_sol_cost_usdc(fee_params)
    if not use_jito:
        # Without Jito, remove tip from cost estimate
        no_tip_params = FeeParams(
            compute_unit_price=fee_params.compute_unit_price,
            jito_tip_lamports=0,
            total_sol_cost=fee_strategy._total_sol(fee_params.compute_unit_price, 0),
        )
        sol_cost_in_token = fee_strategy.estimate_sol_cost_usdc(no_tip_params)

    # Net profit
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
        dynamic_cu_price=fee_params.compute_unit_price,
        dynamic_tip_lamports=fee_params.jito_tip_lamports,
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
        self.use_jito = use_jito
        # Dynamic fee strategy
        self.fee_strategy = FeeStrategy(
            min_tip_lamports=max(1_000, jito_tip // 10),
            max_tip_lamports=jito_tip * 10,
            tip_profit_share=0.40,
            min_cu_price=max(1_000, priority_fee_micro // 10),
            max_cu_price=priority_fee_micro * 8,
            base_cu_price=priority_fee_micro,
            compute_units=compute_units,
        )
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
                    f"profit={opp.expected_profit / 1e6:.4f} USDC, "
                    f"borrow={borrow / 1e6:.0f}, cu={opp.dynamic_cu_price}, "
                    f"tip={opp.dynamic_tip_lamports}, via={opp.source}"
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
            fee_strategy=self.fee_strategy,
            use_jito=self.use_jito,
            source=q1.source,
        )
