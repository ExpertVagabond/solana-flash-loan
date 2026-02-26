import { Connection, PublicKey, Logs } from "@solana/web3.js";
import type pino from "pino";
import { JupiterClient } from "../providers/jupiter-client";
import { WELL_KNOWN_MINTS } from "../utils/tokens";

// --- DEX Program IDs ---
const DEX_PROGRAMS = {
  raydiumV4:  new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"),
  raydiumClmm: new PublicKey("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK"),
  raydiumCpmm: new PublicKey("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C"),
  orca:       new PublicKey("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc"),
  meteora:    new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo"),
  meteoraAmm: new PublicKey("Eo7WjKq67rjJQSZxS6z3YkapzY3eBj6xfkMa2AERjo2G"),
} as const;

// Instruction discriminators for pool creation events (first 8 bytes of ix data)
const POOL_INIT_KEYWORDS = [
  "initialize",
  "create_pool",
  "open_position",
  "init_pool",
  "initialize_pool",
  "create_amm",
  "Initialize2", // Raydium v4
  "initializeReward", // CLMM
];

// USDC and SOL mints — pools paired with these are tradeable
const QUOTE_MINTS = new Set([
  WELL_KNOWN_MINTS.USDC,
  WELL_KNOWN_MINTS.SOL,
  WELL_KNOWN_MINTS.USDT,
]);

export interface NewPoolEvent {
  dex: string;
  signature: string;
  tokenA: string;
  tokenB: string;
  timestamp: number;
  poolAddress?: string;
}

export interface DexScreenerPair {
  pairAddress: string;
  baseToken: { address: string; symbol: string; name: string };
  quoteToken: { address: string; symbol: string; name: string };
  priceUsd: string;
  liquidity: { usd: number };
  volume: { h24: number };
  pairCreatedAt: number;
  dexId: string;
  url: string;
}

/**
 * Monitors for new pool creations across Solana DEXes.
 *
 * Two strategies:
 * 1. WebSocket: Subscribe to DEX program logs for real-time pool creation events
 * 2. DexScreener: Poll for new pairs (backup, ~30s delay)
 *
 * When a new pool is detected, emits the pair info so the scanner can add it.
 */
export class NewPoolMonitor {
  private connection: Connection;
  private logger: pino.Logger;
  private jupiter: JupiterClient;
  private onNewPool: (event: NewPoolEvent) => void;
  private wsSubscriptions: number[] = [];
  private dexScreenerInterval: ReturnType<typeof setInterval> | null = null;
  private seenPools: Set<string> = new Set(); // dedup
  private seenDexScreenerPairs: Set<string> = new Set();
  private running = false;

  // Track discovered pools
  public discoveredPools: NewPoolEvent[] = [];

  constructor(
    connection: Connection,
    logger: pino.Logger,
    jupiter: JupiterClient,
    onNewPool: (event: NewPoolEvent) => void
  ) {
    this.connection = connection;
    this.logger = logger;
    this.jupiter = jupiter;
    this.onNewPool = onNewPool;
  }

  async start(): Promise<void> {
    this.running = true;

    // Strategy 1: WebSocket subscriptions to DEX programs
    await this.startWebSocketMonitor();

    // Strategy 2: DexScreener polling (every 30s)
    this.startDexScreenerPolling();

    this.logger.info(
      {
        dexPrograms: Object.keys(DEX_PROGRAMS).length,
        wsSubscriptions: this.wsSubscriptions.length,
        dexScreenerPollMs: 30_000,
      },
      "New pool monitor STARTED"
    );
  }

  stop(): void {
    this.running = false;

    // Unsubscribe WebSocket listeners
    for (const subId of this.wsSubscriptions) {
      this.connection.removeOnLogsListener(subId).catch(() => {});
    }
    this.wsSubscriptions = [];

    if (this.dexScreenerInterval) {
      clearInterval(this.dexScreenerInterval);
      this.dexScreenerInterval = null;
    }

    this.logger.info("New pool monitor STOPPED");
  }

  // --- WebSocket Strategy ---

  private async startWebSocketMonitor(): Promise<void> {
    for (const [dexName, programId] of Object.entries(DEX_PROGRAMS)) {
      try {
        const subId = this.connection.onLogs(
          programId,
          (logs: Logs) => this.handleProgramLogs(dexName, logs),
          "confirmed"
        );
        this.wsSubscriptions.push(subId);
        this.logger.debug({ dex: dexName, programId: programId.toBase58() }, "Subscribed to program logs");
      } catch (err) {
        this.logger.warn(
          { dex: dexName, error: (err as Error).message },
          "Failed to subscribe to program logs"
        );
      }
    }
  }

  private handleProgramLogs(dexName: string, logs: Logs): void {
    if (logs.err) return; // Skip failed transactions

    // Check if any log line indicates a pool creation
    const isPoolCreation = logs.logs.some((line) =>
      POOL_INIT_KEYWORDS.some((kw) =>
        line.toLowerCase().includes(kw.toLowerCase())
      )
    );

    if (!isPoolCreation) return;

    // Dedup by signature
    if (this.seenPools.has(logs.signature)) return;
    this.seenPools.add(logs.signature);

    // Extract token mints from log lines
    // Most pool init logs include the token mints as base58 pubkeys
    const mints = this.extractMintsFromLogs(logs.logs);

    if (mints.length >= 2) {
      const event: NewPoolEvent = {
        dex: dexName,
        signature: logs.signature,
        tokenA: mints[0],
        tokenB: mints[1],
        timestamp: Date.now(),
      };

      this.discoveredPools.push(event);
      this.logger.info(
        {
          dex: dexName,
          tokenA: mints[0].slice(0, 12) + "...",
          tokenB: mints[1].slice(0, 12) + "...",
          signature: logs.signature.slice(0, 20) + "...",
        },
        "NEW POOL DETECTED (WebSocket)"
      );

      this.onNewPool(event);
    } else {
      // Couldn't extract mints from logs — fetch the transaction to parse accounts
      this.fetchAndParseTransaction(dexName, logs.signature).catch((err) => {
        this.logger.debug(
          { sig: logs.signature.slice(0, 16), error: (err as Error).message },
          "Failed to parse pool creation tx"
        );
      });
    }
  }

  private extractMintsFromLogs(logs: string[]): string[] {
    // Look for base58-encoded public keys (32-44 chars of alphanumeric)
    const mintRegex = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;
    const candidates: string[] = [];

    for (const line of logs) {
      const matches = line.match(mintRegex);
      if (matches) {
        for (const m of matches) {
          // Filter: must be 32-44 chars, not a known program ID, not already seen
          if (m.length >= 32 && m.length <= 44 && !candidates.includes(m)) {
            // Quick check: skip well-known program addresses
            if (m.startsWith("1111") || m.startsWith("Token") || m.startsWith("Sysvar")) continue;
            candidates.push(m);
          }
        }
      }
    }

    return candidates.slice(0, 4); // Return up to 4 candidates
  }

  private async fetchAndParseTransaction(dexName: string, signature: string): Promise<void> {
    const tx = await this.connection.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0,
    });

    if (!tx?.meta || !tx.transaction) return;

    // Look for token account creations or mint references in inner instructions
    const accountKeys = tx.transaction.message.accountKeys.map((k) =>
      typeof k === "string" ? k : k.pubkey.toBase58()
    );

    // Find mints from token balances
    const preBalances = tx.meta.preTokenBalances || [];
    const postBalances = tx.meta.postTokenBalances || [];
    const mints = new Set<string>();

    for (const b of [...preBalances, ...postBalances]) {
      if (b.mint) mints.add(b.mint);
    }

    const mintArray = [...mints];
    if (mintArray.length >= 2) {
      const event: NewPoolEvent = {
        dex: dexName,
        signature,
        tokenA: mintArray[0],
        tokenB: mintArray[1],
        timestamp: Date.now(),
      };

      if (!this.seenPools.has(`${event.tokenA}-${event.tokenB}`)) {
        this.seenPools.add(`${event.tokenA}-${event.tokenB}`);
        this.discoveredPools.push(event);

        this.logger.info(
          {
            dex: dexName,
            tokenA: mintArray[0].slice(0, 12) + "...",
            tokenB: mintArray[1].slice(0, 12) + "...",
            signature: signature.slice(0, 20) + "...",
            mintsInTx: mintArray.length,
          },
          "NEW POOL DETECTED (tx parse)"
        );

        this.onNewPool(event);
      }
    }
  }

  // --- DexScreener Polling Strategy ---

  private startDexScreenerPolling(): void {
    // Initial poll
    this.pollDexScreener().catch(() => {});

    // Then every 30 seconds
    this.dexScreenerInterval = setInterval(() => {
      if (this.running) {
        this.pollDexScreener().catch((err) => {
          this.logger.debug(
            { error: (err as Error).message },
            "DexScreener poll failed"
          );
        });
      }
    }, 30_000);
  }

  private async pollDexScreener(): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    try {
      // DexScreener latest pairs endpoint for Solana
      const res = await fetch(
        "https://api.dexscreener.com/token-profiles/latest/v1",
        {
          signal: controller.signal,
          headers: { Accept: "application/json" },
        }
      );

      if (!res.ok) {
        if (res.status === 429) {
          this.logger.debug("DexScreener rate-limited");
          return;
        }
        return;
      }

      const profiles: any[] = (await res.json()) as any[];

      // Filter to Solana tokens
      const solanaTokens = profiles.filter(
        (p: any) => p.chainId === "solana" && p.tokenAddress
      );

      for (const token of solanaTokens) {
        const mint = token.tokenAddress;
        if (this.seenDexScreenerPairs.has(mint)) continue;
        this.seenDexScreenerPairs.add(mint);

        // Check if this token has liquidity by trying a Jupiter quote
        this.probeNewToken(mint, token.description || token.tokenAddress).catch(() => {});
      }
    } finally {
      clearTimeout(timeout);
    }

    // Also check the pairs endpoint for trending new pairs
    await this.pollDexScreenerNewPairs();
  }

  private async pollDexScreenerNewPairs(): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    try {
      // Search for very recent Solana pairs
      const res = await fetch(
        "https://api.dexscreener.com/latest/dex/search?q=solana",
        {
          signal: controller.signal,
          headers: { Accept: "application/json" },
        }
      );

      if (!res.ok) return;

      const data: any = await res.json();
      const pairs = (data.pairs || []) as DexScreenerPair[];

      // Filter for new pairs (< 1 hour old) with decent liquidity
      const now = Date.now();
      const newPairs = pairs.filter((p) => {
        if (!p.pairCreatedAt) return false;
        const ageMs = now - p.pairCreatedAt;
        return ageMs < 3_600_000 && // < 1 hour old
               p.liquidity?.usd > 1000 && // > $1k liquidity
               !this.seenDexScreenerPairs.has(p.pairAddress);
      });

      for (const pair of newPairs) {
        this.seenDexScreenerPairs.add(pair.pairAddress);

        const event: NewPoolEvent = {
          dex: pair.dexId || "unknown",
          signature: pair.pairAddress,
          tokenA: pair.baseToken.address,
          tokenB: pair.quoteToken.address,
          timestamp: pair.pairCreatedAt,
        };

        this.discoveredPools.push(event);

        this.logger.info(
          {
            dex: pair.dexId,
            base: pair.baseToken.symbol,
            quote: pair.quoteToken.symbol,
            liquidity: pair.liquidity?.usd,
            age: `${Math.round((now - pair.pairCreatedAt) / 60_000)}min`,
            price: pair.priceUsd,
          },
          "NEW PAIR (DexScreener)"
        );

        this.onNewPool(event);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Probe a newly discovered token to see if Jupiter can route it.
   * If quotable, emit as a new pool event.
   */
  private async probeNewToken(mint: string, label: string): Promise<void> {
    // Skip if it's a known token
    const knownMints = new Set(Object.values(WELL_KNOWN_MINTS));
    if (knownMints.has(mint)) return;

    try {
      // Try getting a small quote: USDC → new token
      const quote = await this.jupiter.getQuote(
        WELL_KNOWN_MINTS.USDC,
        mint,
        "1000000", // $1 USDC
        100, // 1% slippage for new tokens
        true // direct routes only
      );

      if (BigInt(quote.outAmount) > 0n) {
        this.logger.info(
          {
            mint: mint.slice(0, 12) + "...",
            label,
            outAmount: quote.outAmount,
            routes: quote.routePlan?.length || 0,
          },
          "NEW TOKEN QUOTABLE — adding to scan"
        );

        const event: NewPoolEvent = {
          dex: quote.routePlan?.[0]?.swapInfo?.label || "jupiter",
          signature: `probe-${mint}`,
          tokenA: WELL_KNOWN_MINTS.USDC,
          tokenB: mint,
          timestamp: Date.now(),
        };

        this.onNewPool(event);
      }
    } catch {
      // Not quotable yet — skip
    }
  }
}
