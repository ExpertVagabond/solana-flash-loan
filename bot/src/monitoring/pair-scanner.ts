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
  // === Deep liquidity — full borrow ($200) ===
  So111111: 0n,  // SOL
  Es9vMFrz: 0n,  // USDT

  // === High liquidity — $100 ===
  JUPyiwrY: 100_000_000n,  // JUP
  "4k3Dyjzv": 100_000_000n, // RAY
  orcaEKTd: 100_000_000n,  // ORCA
  mSoLzYCx: 100_000_000n,  // mSOL
  J1toso1u: 100_000_000n,  // jitoSOL
  jtojtome: 100_000_000n,  // JTO
  rndrizKT: 100_000_000n,  // RENDER
  "85VBFQZC": 100_000_000n, // W

  // === Moderate liquidity — $50 ===
  EKpQGSJt: 50_000_000n,   // WIF
  HZ1JovNi: 50_000_000n,   // PYTH
  hntyVP6Y: 50_000_000n,   // HNT
  TNSRxcUx: 50_000_000n,   // TNSR
  bSo13r4T: 50_000_000n,   // bSOL
  "5oVNBeEE": 50_000_000n,  // INF
  KMNo3nJs: 50_000_000n,   // KMNO
  DriFtupJ: 50_000_000n,   // DRIFT

  // === Meme / volatile — $20 (wider spreads, more opportunity) ===
  DezXAZ8z: 20_000_000n,   // BONK
  "7GCihgDB": 20_000_000n,  // POPCAT
  MEW1gQWJ: 20_000_000n,   // MEW
  "6p6xgHyF": 20_000_000n,  // TRUMP
  "9BB6NFEc": 20_000_000n,  // FARTCOIN
  ukHH6c7m: 20_000_000n,   // BOME
  "7BgBvyjr": 20_000_000n,  // SLERF
  WENWENvq: 20_000_000n,   // WEN

  // === Low liquidity — $10 (most arb potential, thin books) ===
  "7xKXtg2C": 10_000_000n,  // SAMO
  MNDEFzGv: 10_000_000n,   // MNDE
  StepAscQ: 10_000_000n,   // STEP
  SHDWyBxi: 10_000_000n,   // SHDW
  DUSTawuc: 10_000_000n,   // DUST
  "4vMsoUT2": 10_000_000n,  // HONEY
  BLZEEuZU: 10_000_000n,   // BLZE
  ZEUS1aR7: 10_000_000n,   // ZEUS
  PARCLdS3: 10_000_000n,   // PARCL
  "7EYnhQoR": 10_000_000n,  // SILLY
  HeLp6NuQ: 10_000_000n,   // AI16Z
  "2nnGAqbW": 10_000_000n,  // GRIFFAIN
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
   * borrowAmount is passed through directly — caller controls sizing.
   */
  async scanPair(
    pair: string,
    tokenA: string,
    tokenB: string,
    borrowAmount: bigint
  ): Promise<ArbitrageOpportunity | null> {
    try {
      const opportunity = await this.scanDirection(
        pair,
        tokenA,
        tokenB,
        borrowAmount
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

    // Cache quotes with opportunity — avoids re-quoting latency in execution
    opportunity.quoteLeg1 = quoteLeg1;
    opportunity.quoteLeg2 = quoteLeg2;

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
          quoteAgeMs: 0,
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
