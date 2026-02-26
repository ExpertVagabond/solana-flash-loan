import type pino from "pino";
import { JupiterQuote, JupiterClient } from "./jupiter-client";

/**
 * DEX identifiers — match Jupiter's dex labels for routing.
 * Jupiter supports filtering quotes to specific DEXes via the `dexes` param.
 */
export type DexId = "Raydium" | "Raydium CLMM" | "Orca" | "Orca (Whirlpools)" | "Meteora" | "Meteora DLMM" | "Lifinity" | "Lifinity V2";

/** Grouped DEX families for cross-DEX arb comparison */
export const DEX_FAMILIES: Record<string, DexId[]> = {
  raydium: ["Raydium", "Raydium CLMM"],
  orca: ["Orca", "Orca (Whirlpools)"],
  meteora: ["Meteora", "Meteora DLMM"],
  lifinity: ["Lifinity", "Lifinity V2"],
};

export interface DexQuote {
  dex: string;
  quote: JupiterQuote;
  outAmount: bigint;
  priceImpactPct: number;
}

export interface CrossDexOpportunity {
  pair: string;
  tokenA: string; // borrow token (USDC)
  tokenB: string; // target token
  borrowAmount: bigint;
  buyDex: string;
  sellDex: string;
  buyQuote: JupiterQuote;
  sellQuote: JupiterQuote;
  buyAmount: bigint; // tokenB received from buy leg
  sellAmount: bigint; // tokenA received from sell leg
  grossProfitBps: number;
  timestamp: number;
}

// Jupiter quote endpoint — use for DEX-specific routing
const JUPITER_QUOTE_URL = "https://lite-api.jup.ag/swap/v1/quote";

/**
 * Multi-DEX quote client.
 * Queries Jupiter with DEX-specific routing to get per-venue pricing.
 * Enables cross-DEX arbitrage: buy on cheapest venue, sell on most expensive.
 */
export class MultiDexClient {
  private logger: pino.Logger;
  private jupiterClient: JupiterClient;
  private activeDexFamilies: string[];
  // Rate limit tracking per source
  private cooldowns: Map<string, number> = new Map();
  private cooldownMs = 30_000;

  constructor(
    logger: pino.Logger,
    jupiterClient: JupiterClient,
    dexFamilies: string[] = ["raydium", "orca", "meteora", "lifinity"]
  ) {
    this.logger = logger;
    this.jupiterClient = jupiterClient;
    this.activeDexFamilies = dexFamilies;
  }

  /**
   * Get quotes from all active DEXes for a given swap direction.
   * Uses Jupiter's `dexes` param to force routing through specific venues.
   * Returns quotes sorted by best output (highest outAmount).
   */
  async getMultiDexQuotes(
    inputMint: string,
    outputMint: string,
    amount: string,
    slippageBps: number
  ): Promise<DexQuote[]> {
    const quotes: DexQuote[] = [];
    const now = Date.now();

    // Query each DEX family in parallel
    const promises = this.activeDexFamilies.map(async (family) => {
      // Skip if cooling down
      const cooldownUntil = this.cooldowns.get(family) ?? 0;
      if (now < cooldownUntil) return null;

      const dexIds = DEX_FAMILIES[family];
      if (!dexIds) return null;

      try {
        const quote = await this.getJupiterDexQuote(
          inputMint,
          outputMint,
          amount,
          slippageBps,
          dexIds
        );

        if (quote && BigInt(quote.outAmount) > 0n) {
          return {
            dex: family,
            quote,
            outAmount: BigInt(quote.outAmount),
            priceImpactPct: parseFloat(quote.priceImpactPct || "0"),
          } as DexQuote;
        }
      } catch (err) {
        const msg = (err as Error).message;
        if (msg.includes("429") || msg.includes("1015")) {
          this.cooldowns.set(family, now + this.cooldownMs);
          this.logger.debug(
            { dex: family },
            "DEX quote rate-limited, cooling down"
          );
        }
      }

      return null;
    });

    const results = await Promise.all(promises);
    for (const r of results) {
      if (r) quotes.push(r);
    }

    // Sort by best output (descending)
    quotes.sort((a, b) => (b.outAmount > a.outAmount ? 1 : -1));

    return quotes;
  }

  /**
   * Find cross-DEX arbitrage: buy tokenB on cheapest venue, sell on most expensive.
   * The "buy" leg swaps USDC → tokenB, the "sell" leg swaps tokenB → USDC.
   */
  async findCrossDexArb(
    pair: string,
    tokenA: string, // borrow token (USDC)
    tokenB: string, // target token
    borrowAmount: bigint,
    poolFeeBps: number
  ): Promise<CrossDexOpportunity | null> {
    // Get buy quotes: USDC → target (we want cheapest = most tokenB per USDC)
    const buyQuotes = await this.getMultiDexQuotes(
      tokenA,
      tokenB,
      borrowAmount.toString(),
      50 // slippage for quoting
    );

    if (buyQuotes.length === 0) return null;

    // Best buy = most tokenB received (already sorted descending)
    const bestBuy = buyQuotes[0];

    // Get sell quotes: target → USDC (using the best buy amount)
    const sellQuotes = await this.getMultiDexQuotes(
      tokenB,
      tokenA,
      bestBuy.outAmount.toString(),
      50
    );

    if (sellQuotes.length === 0) return null;

    // Best sell = most USDC received
    const bestSell = sellQuotes[0];

    // Calculate profit
    const flashLoanFee =
      (borrowAmount * BigInt(poolFeeBps) + 9999n) / 10000n;
    const grossReturn = bestSell.outAmount;
    const netReturn = grossReturn - borrowAmount - flashLoanFee;
    const grossProfitBps =
      borrowAmount > 0n ? Number((netReturn * 10000n) / borrowAmount) : 0;

    // Only report if different DEXes and profitable
    if (bestBuy.dex === bestSell.dex) {
      // Same DEX — this is just a regular round-trip, not cross-DEX
      this.logger.debug(
        {
          pair,
          dex: bestBuy.dex,
          profitBps: grossProfitBps,
        },
        "Same-DEX round-trip"
      );
      return null;
    }

    this.logger.info(
      {
        pair,
        buyDex: bestBuy.dex,
        sellDex: bestSell.dex,
        buyOut: bestBuy.outAmount.toString(),
        sellOut: bestSell.outAmount.toString(),
        profitBps: grossProfitBps,
      },
      "Cross-DEX opportunity"
    );

    return {
      pair,
      tokenA,
      tokenB,
      borrowAmount,
      buyDex: bestBuy.dex,
      sellDex: bestSell.dex,
      buyQuote: bestBuy.quote,
      sellQuote: bestSell.quote,
      buyAmount: bestBuy.outAmount,
      sellAmount: bestSell.outAmount,
      grossProfitBps,
      timestamp: Date.now(),
    };
  }

  /**
   * Jupiter quote with DEX-specific routing.
   * Uses the `dexes` param to restrict routing to specific venues.
   */
  private async getJupiterDexQuote(
    inputMint: string,
    outputMint: string,
    amount: string,
    slippageBps: number,
    dexes: DexId[]
  ): Promise<JupiterQuote | null> {
    const params = new URLSearchParams({
      inputMint,
      outputMint,
      amount,
      slippageBps: slippageBps.toString(),
      onlyDirectRoutes: "true", // Force single-hop through the specified DEX
      maxAccounts: "40",
    });

    // Jupiter uses comma-separated dex names
    if (dexes.length > 0) {
      params.set("dexes", dexes.join(","));
    }

    const url = `${JUPITER_QUOTE_URL}?${params}`;
    const res = await fetch(url);

    if (res.status === 429) {
      throw new Error("429: Jupiter rate limited");
    }

    if (!res.ok) {
      const text = await res.text();
      // Some DEXes may not have the pair — that's OK
      if (res.status === 400 || text.includes("No routes found")) {
        return null;
      }
      throw new Error(`Jupiter ${res.status}: ${text}`);
    }

    const data = await res.json() as JupiterQuote;
    if (!data.outAmount || data.outAmount === "0") return null;

    return data;
  }
}
