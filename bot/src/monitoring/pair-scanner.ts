import type pino from "pino";
import { JupiterClient } from "../providers/jupiter-client";
import {
  ArbitrageOpportunity,
  calculateProfit,
} from "../core/profit-calculator";

export class PairScanner {
  private jupiter: JupiterClient;
  private poolFeeBps: number;
  private minProfitBps: number;
  private slippageBps: number;
  private logger: pino.Logger;

  constructor(
    jupiter: JupiterClient,
    poolFeeBps: number,
    minProfitBps: number,
    slippageBps: number,
    logger: pino.Logger
  ) {
    this.jupiter = jupiter;
    this.poolFeeBps = poolFeeBps;
    this.minProfitBps = minProfitBps;
    this.slippageBps = slippageBps;
    this.logger = logger;
  }

  /**
   * Scan a single pair for arbitrage opportunity.
   * Returns the opportunity if profit exceeds threshold, null otherwise.
   */
  async scanPair(
    pair: string,
    tokenA: string,
    tokenB: string,
    borrowAmount: bigint
  ): Promise<ArbitrageOpportunity | null> {
    try {
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
        quoteLeg2.priceImpactPct
      );

      if (opportunity.profitBps >= this.minProfitBps) {
        this.logger.info(
          {
            pair,
            profitBps: opportunity.profitBps,
            expectedProfit: opportunity.expectedProfit.toString(),
            flashLoanFee: opportunity.flashLoanFee.toString(),
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
        },
        "Below profit threshold"
      );

      return null;
    } catch (err) {
      this.logger.warn(
        { pair, error: (err as Error).message },
        "Pair scan failed"
      );
      return null;
    }
  }
}
