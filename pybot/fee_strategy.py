"""Dynamic fee strategy — scales priority fees and Jito tips based on opportunity quality.

Better opportunities get higher tips (more competitive for block inclusion).
Marginal opportunities get minimum tips (preserve profit).
"""

from dataclasses import dataclass
from loguru import logger


@dataclass
class FeeParams:
    """Computed fee parameters for a specific opportunity."""
    compute_unit_price: int   # micro-lamports per CU
    jito_tip_lamports: int    # Jito tip in lamports
    total_sol_cost: int       # estimated total SOL cost in lamports


class FeeStrategy:
    """Dynamic fee scaling based on profit margin.

    Strategy: bid a percentage of expected gross profit as fees/tips.
    Bigger opportunities = higher bids = faster inclusion.
    """

    def __init__(
        self,
        # Jito tip bounds
        min_tip_lamports: int = 1_000,       # 0.000001 SOL floor
        max_tip_lamports: int = 100_000,     # 0.0001 SOL ceiling
        tip_profit_share: float = 0.40,      # give 40% of gross profit to Jito
        # Priority fee bounds
        min_cu_price: int = 1_000,           # micro-lamports/CU floor
        max_cu_price: int = 200_000,         # micro-lamports/CU ceiling
        base_cu_price: int = 10_000,         # default when no opportunity
        # Compute budget
        compute_units: int = 400_000,
    ):
        self.min_tip = min_tip_lamports
        self.max_tip = max_tip_lamports
        self.tip_share = tip_profit_share
        self.min_cu_price = min_cu_price
        self.max_cu_price = max_cu_price
        self.base_cu_price = base_cu_price
        self.compute_units = compute_units

    def compute_fees(
        self,
        gross_profit_usdc: int,   # leg2_out - borrow_amount (in USDC lamports)
        flash_loan_fee: int,      # in USDC lamports
        sol_price_usdc: int = 85_000_000,  # SOL price in USDC lamports (6 dec)
    ) -> FeeParams:
        """Compute dynamic fees for a given opportunity.

        Args:
            gross_profit_usdc: raw difference between leg2_out and borrow_amount
            flash_loan_fee: the flash loan fee in USDC lamports
            sol_price_usdc: current SOL price in USDC lamports (default ~$85)
        """
        # Net profit after flash loan fee (before SOL costs)
        net_before_sol = gross_profit_usdc - flash_loan_fee

        if net_before_sol <= 0:
            # Not profitable even before SOL costs — use minimums
            return FeeParams(
                compute_unit_price=self.min_cu_price,
                jito_tip_lamports=self.min_tip,
                total_sol_cost=self._total_sol(self.min_cu_price, self.min_tip),
            )

        # Convert USDC profit to SOL lamports for tip sizing
        # net_before_sol is in USDC lamports (6 dec), sol_price is USDC/SOL
        profit_in_sol = (net_before_sol * 1_000_000_000) // sol_price_usdc

        # Jito tip: share of profit, clamped
        raw_tip = int(profit_in_sol * self.tip_share)
        tip = max(self.min_tip, min(raw_tip, self.max_tip))

        # Priority fee: scale with profit tier
        # Higher profit → higher CU price for faster inclusion
        profit_bps_approx = (net_before_sol * 10000) // max(flash_loan_fee * 10000 // 9, 1)
        if profit_bps_approx >= 50:
            cu_price = self.max_cu_price
        elif profit_bps_approx >= 20:
            cu_price = self.max_cu_price // 2
        elif profit_bps_approx >= 10:
            cu_price = self.base_cu_price * 2
        else:
            cu_price = self.base_cu_price

        cu_price = max(self.min_cu_price, min(cu_price, self.max_cu_price))

        total_sol = self._total_sol(cu_price, tip)

        # Safety: ensure SOL costs don't exceed profit
        max_sol_budget = int(profit_in_sol * 0.80)  # never spend >80% of profit on fees
        if total_sol > max_sol_budget and max_sol_budget > 0:
            # Scale down proportionally
            scale = max_sol_budget / total_sol
            tip = max(self.min_tip, int(tip * scale))
            cu_price = max(self.min_cu_price, int(cu_price * scale))
            total_sol = self._total_sol(cu_price, tip)

        logger.debug(
            f"Dynamic fees: cu_price={cu_price} tip={tip} "
            f"total_sol={total_sol} profit_sol={profit_in_sol}"
        )

        return FeeParams(
            compute_unit_price=cu_price,
            jito_tip_lamports=tip,
            total_sol_cost=total_sol,
        )

    def _total_sol(self, cu_price: int, tip: int) -> int:
        """Total SOL cost in lamports."""
        base_fee = 5000
        priority_fee = (cu_price * self.compute_units) // 1_000_000
        return base_fee + priority_fee + tip

    def estimate_sol_cost_usdc(
        self, fee_params: FeeParams, sol_price_usdc: int = 85_000_000
    ) -> int:
        """Convert total SOL cost to USDC lamports."""
        return (fee_params.total_sol_cost * sol_price_usdc) // 1_000_000_000
