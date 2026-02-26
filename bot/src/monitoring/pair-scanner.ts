import type pino from "pino";
import { JupiterClient } from "../providers/jupiter-client";
import {
  ArbitrageOpportunity,
  calculateProfit,
} from "../core/profit-calculator";

/**
 * Per-pair borrow sizing based on observed liquidity depth.
 * Smaller borrows reduce price impact on illiquid pairs.
 * Key = first 8 chars of the TARGET token mint.
 * Value = borrow amount in token smallest units (0 = use default).
 */
const PAIR_BORROW_OVERRIDES: Record<string, bigint> = {
  // SOL: deep liquidity, use full borrow
  So111111: 0n,
  // BONK: thin USDC liquidity — 20 USDC to keep price impact < 0.1%
  DezXAZ8z: 20_000_000n,
  // JUP: moderate — 50 USDC
  JUPyiwrY: 50_000_000n,
  // WIF: moderate — 50 USDC
  EKpQGSJt: 50_000_000n,
};

export class PairScanner {
  private jupiter: JupiterClient;
  private poolFeeBps: number;
  private minProfitBps: number;
  private slippageBps: number;
  private logger: pino.Logger;
  private priorityFeeMicroLamports: number;
  private computeUnitLimit: number;
  private jitoTipLamports: number;
  private useJito: boolean;

  // Learning: track best observed spread per pair
  private bestSpreads: Map<string, { bps: number; ts: number }> = new Map();

  constructor(
    jupiter: JupiterClient,
    poolFeeBps: number,
    minProfitBps: number,
    slippageBps: number,
    logger: pino.Logger,
    priorityFeeMicroLamports: number = 25000,
    computeUnitLimit: number = 400000,
    jitoTipLamports: number = 10000,
    useJito: boolean = false
  ) {
    this.jupiter = jupiter;
    this.poolFeeBps = poolFeeBps;
    this.minProfitBps = minProfitBps;
    this.slippageBps = slippageBps;
    this.logger = logger;
    this.priorityFeeMicroLamports = priorityFeeMicroLamports;
    this.computeUnitLimit = computeUnitLimit;
    this.jitoTipLamports = jitoTipLamports;
    this.useJito = useJito;
  }

  /**
   * Scan a single pair for arbitrage opportunity.
   * Uses per-pair borrow sizing to optimize for liquidity depth.
   */
  async scanPair(
    pair: string,
    tokenA: string,
    tokenB: string,
    borrowAmount: bigint
  ): Promise<ArbitrageOpportunity | null> {
    // Determine optimal borrow for this pair's target token
    const targetPrefix = tokenB.slice(0, 8);
    const override = PAIR_BORROW_OVERRIDES[targetPrefix];
    const effectiveBorrow =
      override !== undefined && override > 0n ? override : borrowAmount;

    try {
      const opportunity = await this.scanDirection(
        pair,
        tokenA,
        tokenB,
        effectiveBorrow
      );

      // Track best spread for learning
      const bps = opportunity?.profitBps ?? -9999;
      const prev = this.bestSpreads.get(pair);
      if (!prev || bps > prev.bps) {
        this.bestSpreads.set(pair, { bps, ts: Date.now() });
      }

      return opportunity;
    } catch (err) {
      this.logger.warn(
        { pair, error: (err as Error).message },
        "Pair scan failed"
      );
      return null;
    }
  }

  private async scanDirection(
    pair: string,
    tokenA: string,
    tokenB: string,
    borrowAmount: bigint
  ): Promise<ArbitrageOpportunity | null> {
    // Leg 1: tokenA -> tokenB
    const quoteLeg1 = await this.jupiter.getQuote(
      tokenA,
      tokenB,
      borrowAmount.toString(),
      this.slippageBps
    );

    const leg1Out = BigInt(quoteLeg1.outAmount);
    if (leg1Out === 0n) {
      this.logger.debug({ pair }, "Leg 1 returned 0 output, skipping");
      return null;
    }

    // Leg 2: tokenB -> tokenA (using leg1 output)
    const quoteLeg2 = await this.jupiter.getQuote(
      tokenB,
      tokenA,
      leg1Out.toString(),
      this.slippageBps
    );

    const leg2Out = BigInt(quoteLeg2.outAmount);

    const opportunity = calculateProfit(
      pair,
      tokenA,
      tokenB,
      borrowAmount,
      leg1Out,
      leg2Out,
      this.poolFeeBps,
      quoteLeg1.priceImpactPct,
      quoteLeg2.priceImpactPct,
      this.priorityFeeMicroLamports,
      this.computeUnitLimit,
      this.jitoTipLamports,
      this.useJito
    );

    if (opportunity.profitBps >= this.minProfitBps) {
      this.logger.info(
        {
          pair,
          profitBps: opportunity.profitBps,
          expectedProfit: opportunity.expectedProfit.toString(),
          flashLoanFee: opportunity.flashLoanFee.toString(),
          solCosts: opportunity.solCostsInToken.toString(),
          borrowUsed: borrowAmount.toString(),
          priceImpactLeg1: opportunity.priceImpactLeg1,
          priceImpactLeg2: opportunity.priceImpactLeg2,
        },
        "OPPORTUNITY FOUND"
      );
      return opportunity;
    }

    this.logger.debug(
      {
        pair,
        profitBps: opportunity.profitBps,
        threshold: this.minProfitBps,
        borrowUsed: borrowAmount.toString(),
      },
      "Below profit threshold"
    );

    return null;
  }

  /** Get snapshot of best observed spreads for monitoring. */
  getBestSpreads(): Map<string, { bps: number; ts: number }> {
    return new Map(this.bestSpreads);
  }
}
