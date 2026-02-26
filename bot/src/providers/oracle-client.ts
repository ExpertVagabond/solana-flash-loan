import { Connection, PublicKey } from "@solana/web3.js";
import type pino from "pino";

/**
 * Pyth price feed IDs for major Solana tokens.
 * These are on-chain Pyth price accounts (mainnet).
 * Pyth Network: https://pyth.network/price-feeds
 */
const PYTH_PRICE_FEEDS: Record<string, string> = {
  // SOL/USD
  So11111111111111111111111111111111111111112:
    "H6ARHf6YXhGYeQfUzQNGk6rDNnLBQKrenN712K4AQJEG",
  // BONK/USD
  DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263:
    "8ihFLu5FimgTQ1Unh4dVyEHUGodJ5gJQCR9to2to8839",
  // JUP/USD
  JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN:
    "g6eRCbboSwK4tSWngn773RCMexr1APQr4uA9bGZBYfo",
  // WIF/USD
  EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm:
    "6ABgrEZk8urs6kJ1JNdC1sspH5zKXRqxy8sg3ZG2cQps",
  // RAY/USD
  "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R":
    "AnLf8tVYCM816gmBjiy8n53eXKKEDydT5piYjjQDPXRc",
  // RENDER/USD
  rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof:
    "HAm5DZhrgrWa12heKSbodJCbxpGGMSLqMjV2FnPGKbCG",
  // PYTH/USD
  HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3:
    "nrYkQQQur7z8rYTST3G9GqATviK5SZTKyHKsCKuNQJN",
  // HNT/USD
  hntyVP6YFm1Hg25TN9WGLqM12b8TQmcknKrdu1oxWux:
    "7moA1i5vQUpfDwSpK6Pw9s56ahB7WFGidtbL2ujWrVvm",
  // ORCA/USD
  orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE:
    "4ivThkX8uRxBpHsdWSqyXYihzKF3zpRGAUCqyusSRWqK",
};

/**
 * Switchboard V2 feed accounts for Solana tokens (mainnet).
 */
const SWITCHBOARD_FEEDS: Record<string, string> = {
  // SOL/USD
  So11111111111111111111111111111111111111112:
    "GvDMxPzN1sCj7L26YDK2HnMRXEQmQ2aemov8YBtPS7vR",
};

export interface OraclePrice {
  source: "pyth" | "switchboard";
  mint: string;
  price: number; // USD price
  confidence: number; // confidence interval (Pyth)
  slot: number;
  timestamp: number;
  stale: boolean; // true if price is > 30s old
}

/**
 * Oracle price client — reads on-chain Pyth and Switchboard price feeds.
 * Used to validate DEX quotes against oracle prices and detect stale/manipulated prices.
 */
export class OracleClient {
  private connection: Connection;
  private logger: pino.Logger;
  private priceCache: Map<string, OraclePrice> = new Map();
  private cacheTtlMs = 5_000; // 5s cache

  constructor(connection: Connection, logger: pino.Logger) {
    this.connection = connection;
    this.logger = logger;
  }

  /**
   * Get the oracle price for a token mint.
   * Tries Pyth first (more feeds), falls back to Switchboard.
   * Returns null if no feed is configured for this mint.
   */
  async getPrice(mint: string): Promise<OraclePrice | null> {
    // Check cache
    const cached = this.priceCache.get(mint);
    if (cached && Date.now() - cached.timestamp < this.cacheTtlMs) {
      return cached;
    }

    // Try Pyth
    const pythFeed = PYTH_PRICE_FEEDS[mint];
    if (pythFeed) {
      try {
        const price = await this.readPythPrice(mint, pythFeed);
        if (price) {
          this.priceCache.set(mint, price);
          return price;
        }
      } catch (err) {
        this.logger.debug(
          { mint: mint.slice(0, 8), error: (err as Error).message },
          "Pyth price read failed"
        );
      }
    }

    // Try Switchboard
    const sbFeed = SWITCHBOARD_FEEDS[mint];
    if (sbFeed) {
      try {
        const price = await this.readSwitchboardPrice(mint, sbFeed);
        if (price) {
          this.priceCache.set(mint, price);
          return price;
        }
      } catch (err) {
        this.logger.debug(
          { mint: mint.slice(0, 8), error: (err as Error).message },
          "Switchboard price read failed"
        );
      }
    }

    return null;
  }

  /**
   * Validate a DEX quote against oracle price.
   * Returns deviation in basis points. Positive = quote is better than oracle.
   * Large deviations (> 100 bps) may indicate stale oracle or manipulated pool.
   */
  async validateQuote(
    inputMint: string,
    outputMint: string,
    inAmount: bigint,
    outAmount: bigint,
    inputDecimals: number,
    outputDecimals: number
  ): Promise<{ deviationBps: number; oraclePrice: number; dexPrice: number } | null> {
    // USDC is the base — always $1
    const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

    let tokenMint: string;
    let usdcAmount: bigint;
    let tokenAmount: bigint;
    let usdcDecimals: number;
    let tokenDecimals: number;

    if (inputMint === USDC_MINT) {
      tokenMint = outputMint;
      usdcAmount = inAmount;
      tokenAmount = outAmount;
      usdcDecimals = inputDecimals;
      tokenDecimals = outputDecimals;
    } else if (outputMint === USDC_MINT) {
      tokenMint = inputMint;
      tokenAmount = inAmount;
      usdcAmount = outAmount;
      tokenDecimals = inputDecimals;
      usdcDecimals = outputDecimals;
    } else {
      // Neither side is USDC — can't validate against USD oracle
      return null;
    }

    const oraclePrice = await this.getPrice(tokenMint);
    if (!oraclePrice) return null;

    // DEX implied price: usdcAmount / tokenAmount (adjusted for decimals)
    const usdcFloat =
      Number(usdcAmount) / Math.pow(10, usdcDecimals);
    const tokenFloat =
      Number(tokenAmount) / Math.pow(10, tokenDecimals);
    const dexPrice = usdcFloat / tokenFloat;

    // Deviation in bps
    const deviationBps = Math.round(
      ((dexPrice - oraclePrice.price) / oraclePrice.price) * 10000
    );

    if (Math.abs(deviationBps) > 100) {
      this.logger.warn(
        {
          mint: tokenMint.slice(0, 8),
          oraclePrice: oraclePrice.price.toFixed(6),
          dexPrice: dexPrice.toFixed(6),
          deviationBps,
          oracleSource: oraclePrice.source,
          stale: oraclePrice.stale,
        },
        "Large oracle deviation detected"
      );
    }

    return { deviationBps, oraclePrice: oraclePrice.price, dexPrice };
  }

  /**
   * Read Pyth price account on-chain.
   * Pyth V2 account layout: price at offset 208, exponent at offset 20,
   * confidence at offset 216, slot at offset 240.
   */
  private async readPythPrice(
    mint: string,
    feedAddress: string
  ): Promise<OraclePrice | null> {
    const accountInfo = await this.connection.getAccountInfo(
      new PublicKey(feedAddress)
    );
    if (!accountInfo || !accountInfo.data) return null;

    const data = accountInfo.data;
    if (data.length < 248) return null;

    // Pyth V2 price account layout
    const exponent = data.readInt32LE(20);
    const priceRaw = data.readBigInt64LE(208);
    const confidenceRaw = data.readBigUInt64LE(216);
    const slot = Number(data.readBigUInt64LE(240));

    const price = Number(priceRaw) * Math.pow(10, exponent);
    const confidence = Number(confidenceRaw) * Math.pow(10, exponent);

    // Check staleness: Pyth prices should update every slot (~400ms)
    const currentSlot = await this.connection.getSlot();
    const slotAge = currentSlot - slot;
    const stale = slotAge > 75; // ~30 seconds at 400ms/slot

    return {
      source: "pyth",
      mint,
      price,
      confidence,
      slot,
      timestamp: Date.now(),
      stale,
    };
  }

  /**
   * Read Switchboard V2 aggregator account.
   * Result value at offset 112 (8 bytes mantissa + 4 bytes scale).
   */
  private async readSwitchboardPrice(
    mint: string,
    feedAddress: string
  ): Promise<OraclePrice | null> {
    const accountInfo = await this.connection.getAccountInfo(
      new PublicKey(feedAddress)
    );
    if (!accountInfo || !accountInfo.data) return null;

    const data = accountInfo.data;
    if (data.length < 124) return null;

    // Switchboard V2 AggregatorAccountData layout
    // latestConfirmedRound.result at offset 112
    const mantissa = data.readBigInt64LE(112);
    const scale = data.readUInt32LE(120);
    const price = Number(mantissa) / Math.pow(10, scale);

    const currentSlot = await this.connection.getSlot();

    return {
      source: "switchboard",
      mint,
      price,
      confidence: 0, // Switchboard doesn't have confidence bands in the same way
      slot: currentSlot,
      timestamp: Date.now(),
      stale: false, // We can't easily check Switchboard staleness without parsing more fields
    };
  }
}
