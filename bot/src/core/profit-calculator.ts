export interface ArbitrageOpportunity {
  pair: string;
  tokenA: string; // flash loan token mint
  tokenB: string; // intermediate token mint
  borrowAmount: bigint;
  leg1OutAmount: bigint; // A -> B output
  leg2OutAmount: bigint; // B -> A output
  flashLoanFee: bigint;
  solCostsInToken: bigint; // base fee + priority fee + Jito tip, converted to token units
  expectedProfit: bigint; // leg2Out - borrowAmount - fee - solCosts
  profitBps: number;
  priceImpactLeg1: string;
  priceImpactLeg2: string;
  timestamp: number;
  // Cached quotes from scan — passed directly to execution to avoid re-quoting latency
  quoteLeg1?: any;
  quoteLeg2?: any;
}

/**
 * Estimate SOL-denominated costs (base tx fee + priority fee + Jito tip)
 * converted to the flash loan token (e.g. USDC) units.
 *
 * Uses the leg1 quote to derive the SOL/token price:
 *   If we're borrowing USDC and swapping to SOL, the quote tells us
 *   how much SOL we get per USDC. Invert that for the conversion.
 */
export function estimateSolCostsInToken(
  borrowAmount: bigint,
  leg1OutAmount: bigint,
  tokenAMint: string,
  tokenBMint: string,
  priorityFeeMicroLamports: number,
  computeUnitLimit: number,
  jitoTipLamports: number,
  useJito: boolean
): bigint {
  const BASE_TX_FEE_LAMPORTS = 5000n;
  const priorityFeeLamports = BigInt(
    Math.ceil((computeUnitLimit * priorityFeeMicroLamports) / 1_000_000)
  );
  const jitoLamports = useJito ? BigInt(jitoTipLamports) : 0n;

  // Total SOL cost in lamports
  const totalSolCostLamports =
    BASE_TX_FEE_LAMPORTS + priorityFeeLamports + jitoLamports;

  // Native SOL mint
  const SOL_MINT = "So11111111111111111111111111111111111111112";

  // If one of the legs is SOL, use the quote ratio to convert
  if (tokenBMint === SOL_MINT && leg1OutAmount > 0n) {
    // borrowAmount USDC -> leg1OutAmount lamports (SOL)
    // price: 1 lamport = borrowAmount / leg1OutAmount token-units
    // cost in token = totalSolCostLamports * borrowAmount / leg1OutAmount
    return (totalSolCostLamports * borrowAmount) / leg1OutAmount;
  }

  if (tokenAMint === SOL_MINT && borrowAmount > 0n) {
    // SOL is the borrow token — costs are already in the same unit
    return totalSolCostLamports;
  }

  // Neither leg is SOL — use a conservative estimate
  // Assume SOL ~ $140, USDC 6 decimals -> 1 SOL = 140_000_000 USDC-units
  // 1 lamport = 140_000_000 / 1_000_000_000 = 0.14 USDC-units
  // This is a fallback; most pairs include SOL
  const CONSERVATIVE_SOL_PRICE_USDC = 140_000_000n; // 140 USDC in 6-decimal
  const costInUsdc =
    (totalSolCostLamports * CONSERVATIVE_SOL_PRICE_USDC) / 1_000_000_000n;
  return costInUsdc;
}

/**
 * Calculate expected profit from a two-leg arbitrage.
 * Accounts for: flash loan fee (ceiling division) + SOL-denominated costs.
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
  priceImpactLeg2: string,
  priorityFeeMicroLamports: number = 25000,
  computeUnitLimit: number = 400000,
  jitoTipLamports: number = 10000,
  useJito: boolean = false
): ArbitrageOpportunity {
  // Ceiling division: (amount * fee + 9999) / 10000 — matches on-chain
  const flashLoanFee =
    (borrowAmount * BigInt(feeBasisPoints) + 9999n) / 10000n;

  // SOL costs converted to token units
  const solCostsInToken = estimateSolCostsInToken(
    borrowAmount,
    leg1OutAmount,
    tokenA,
    tokenB,
    priorityFeeMicroLamports,
    computeUnitLimit,
    jitoTipLamports,
    useJito
  );

  const expectedProfit =
    leg2OutAmount - borrowAmount - flashLoanFee - solCostsInToken;

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
    solCostsInToken,
    expectedProfit,
    profitBps,
    priceImpactLeg1,
    priceImpactLeg2,
    timestamp: Date.now(),
  };
}
