export interface ArbitrageOpportunity {
  pair: string;
  tokenA: string; // flash loan token mint
  tokenB: string; // intermediate token mint
  borrowAmount: bigint;
  leg1OutAmount: bigint; // A -> B output
  leg2OutAmount: bigint; // B -> A output
  flashLoanFee: bigint;
  expectedProfit: bigint; // leg2Out - borrowAmount - fee
  profitBps: number;
  priceImpactLeg1: string;
  priceImpactLeg2: string;
  timestamp: number;
}

/**
 * Calculate expected profit from a two-leg arbitrage.
 * Flash loan fee uses ceiling division (matches on-chain math).
 */
export function calculateProfit(
  pair: string,
  tokenA: string,
  tokenB: string,
  borrowAmount: bigint,
  leg1OutAmount: bigint,
  leg2OutAmount: bigint,
  feeBasisPoints: number,
  priceImpactLeg1: string,
  priceImpactLeg2: string
): ArbitrageOpportunity {
  // Ceiling division: (amount * fee + 9999) / 10000 — matches on-chain
  const flashLoanFee =
    (borrowAmount * BigInt(feeBasisPoints) + 9999n) / 10000n;

  const expectedProfit = leg2OutAmount - borrowAmount - flashLoanFee;

  // Profit in basis points relative to borrow amount
  const profitBps =
    borrowAmount > 0n
      ? Number((expectedProfit * 10000n) / borrowAmount)
      : 0;

  return {
    pair,
    tokenA,
    tokenB,
    borrowAmount,
    leg1OutAmount,
    leg2OutAmount,
    flashLoanFee,
    expectedProfit,
    profitBps,
    priceImpactLeg1,
    priceImpactLeg2,
    timestamp: Date.now(),
  };
}
