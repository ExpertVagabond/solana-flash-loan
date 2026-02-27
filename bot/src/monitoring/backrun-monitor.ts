import { Connection, Logs, PublicKey } from "@solana/web3.js";
import type pino from "pino";
import { JupiterClient } from "../providers/jupiter-client";
import { WELL_KNOWN_MINTS } from "../utils/tokens";

/**
 * Watches for large swaps on DEX programs and emits backrun signals.
 * When a big trade displaces price on one DEX, we can arb it back.
 *
 * Strategy: Monitor token balance changes in swap transactions.
 * If a swap moves > $1k through a pool, the price is temporarily
 * displaced — probe Jupiter for a profitable return path.
 */

const USDC = WELL_KNOWN_MINTS.USDC;
const SOL = WELL_KNOWN_MINTS.SOL;

// Programs to watch for large swaps
const SWAP_PROGRAMS = {
  raydiumV4:   new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"),
  raydiumClmm: new PublicKey("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK"),
  raydiumCpmm: new PublicKey("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C"),
  orca:        new PublicKey("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc"),
  meteora:     new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo"),
} as const;

// Log patterns that indicate a swap (not pool creation/position management)
const SWAP_PATTERNS = [
  "Instruction: Swap",
  "Instruction: SwapV2",
  "Program log: Instruction: Swap",
  "swap_base_in",
  "swap_base_out",
  "swap_exact",
];

export interface BackrunSignal {
  dex: string;
  signature: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  amountOut: bigint;
  timestamp: number;
}

export class BackrunMonitor {
  private connection: Connection;
  private logger: pino.Logger;
  private jupiter: JupiterClient;
  private onSignal: (signal: BackrunSignal) => void;
  private wsSubscriptions: number[] = [];
  private running = false;
  private seenSigs: Set<string> = new Set();
  private parseCount = 0;
  private parseWindowStart = Date.now();

  constructor(
    connection: Connection,
    logger: pino.Logger,
    jupiter: JupiterClient,
    onSignal: (signal: BackrunSignal) => void
  ) {
    this.connection = connection;
    this.logger = logger;
    this.jupiter = jupiter;
    this.onSignal = onSignal;
  }

  async start(): Promise<void> {
    this.running = true;

    // Subscribe to DEX program logs — same WS connections as pool monitor
    // but filtered for swap events instead of pool creation
    for (const [dexName, programId] of Object.entries(SWAP_PROGRAMS)) {
      try {
        const subId = this.connection.onLogs(
          programId,
          (logs: Logs) => this.handleSwapLogs(dexName, logs),
          "confirmed"
        );
        this.wsSubscriptions.push(subId);
        await new Promise((r) => setTimeout(r, 500)); // Stagger
      } catch (err) {
        this.logger.warn(
          { dex: dexName, error: (err as Error).message },
          "Backrun: failed to subscribe"
        );
      }
    }

    this.logger.info(
      { subscriptions: this.wsSubscriptions.length },
      "Backrun monitor STARTED"
    );
  }

  stop(): void {
    this.running = false;
    for (const subId of this.wsSubscriptions) {
      this.connection.removeOnLogsListener(subId).catch(() => {});
    }
    this.wsSubscriptions = [];
    this.logger.info("Backrun monitor STOPPED");
  }

  private handleSwapLogs(dexName: string, logs: Logs): void {
    if (logs.err) return;

    // Check if this is a swap transaction
    const isSwap = logs.logs.some((line) =>
      SWAP_PATTERNS.some((pattern) => line.includes(pattern))
    );
    if (!isSwap) return;

    // Dedup
    if (this.seenSigs.has(logs.signature)) return;
    this.seenSigs.add(logs.signature);

    // Prevent unbounded memory growth — trim old sigs
    if (this.seenSigs.size > 10_000) {
      const entries = [...this.seenSigs];
      this.seenSigs = new Set(entries.slice(-5_000));
    }

    // Rate limit tx parsing: max 3 per 10 seconds
    const now = Date.now();
    if (now - this.parseWindowStart > 10_000) {
      this.parseCount = 0;
      this.parseWindowStart = now;
    }
    if (this.parseCount >= 3) return;
    this.parseCount++;

    // Parse the transaction to find large swaps
    this.parseSwapTransaction(dexName, logs.signature).catch(() => {});
  }

  private async parseSwapTransaction(dexName: string, signature: string): Promise<void> {
    const tx = await this.connection.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0,
    });

    if (!tx?.meta) return;

    // Find token balance changes — large swaps show big deltas
    const pre = tx.meta.preTokenBalances || [];
    const post = tx.meta.postTokenBalances || [];

    // Build a map of mint -> total delta
    const deltas = new Map<string, bigint>();

    for (const postBal of post) {
      if (!postBal.mint) continue;
      const preBal = pre.find(
        (p) => p.accountIndex === postBal.accountIndex
      );
      const preAmount = BigInt(preBal?.uiTokenAmount?.amount || "0");
      const postAmount = BigInt(postBal.uiTokenAmount?.amount || "0");
      const delta = postAmount - preAmount;

      if (delta !== 0n) {
        const existing = deltas.get(postBal.mint) || 0n;
        deltas.set(postBal.mint, existing + delta);
      }
    }

    // Find the swap: look for a pair where one mint increased and one decreased
    // Filter to significant amounts (> $10 equivalent)
    let tokenIn = "";
    let tokenOut = "";
    let amountIn = 0n;
    let amountOut = 0n;

    for (const [mint, delta] of deltas) {
      // Skip dust amounts
      const absDelta = delta < 0n ? -delta : delta;

      // Check if this is a significant USDC amount (> 10 USDC = 10_000_000)
      if (mint === USDC && absDelta > 10_000_000n) {
        if (delta < 0n) {
          tokenIn = mint;
          amountIn = absDelta;
        } else {
          tokenOut = mint;
          amountOut = absDelta;
        }
      }
      // Check SOL (> 0.1 SOL = 100_000_000 lamports)
      else if (mint === SOL && absDelta > 100_000_000n) {
        if (delta < 0n) {
          tokenIn = mint;
          amountIn = absDelta;
        } else {
          tokenOut = mint;
          amountOut = absDelta;
        }
      }
      // Any other token with a large delta (we'll use USDC equivalent later)
      else if (absDelta > 0n) {
        if (delta < 0n && amountIn === 0n) {
          tokenIn = mint;
          amountIn = absDelta;
        } else if (delta > 0n && amountOut === 0n) {
          tokenOut = mint;
          amountOut = absDelta;
        }
      }
    }

    // Only care about swaps involving USDC or SOL — those are the ones we can arb
    if (tokenIn && tokenOut && (tokenIn === USDC || tokenOut === USDC || tokenIn === SOL || tokenOut === SOL)) {
      // Is this a "large" swap? Check USDC amount > $1000
      const usdcAmount = tokenIn === USDC ? amountIn : tokenOut === USDC ? amountOut : 0n;
      const isLarge = usdcAmount > 1_000_000_000n; // > $1000 USDC

      // For SOL-denominated swaps, check > 5 SOL
      const solAmount = tokenIn === SOL ? amountIn : tokenOut === SOL ? amountOut : 0n;
      const isLargeSol = solAmount > 5_000_000_000n; // > 5 SOL

      if (isLarge || isLargeSol) {
        const signal: BackrunSignal = {
          dex: dexName,
          signature,
          tokenIn,
          tokenOut,
          amountIn,
          amountOut,
          timestamp: Date.now(),
        };

        this.logger.info(
          {
            dex: dexName,
            tokenIn: tokenIn.slice(0, 12) + "...",
            tokenOut: tokenOut.slice(0, 12) + "...",
            amountIn: amountIn.toString(),
            amountOut: amountOut.toString(),
            sig: signature.slice(0, 16) + "...",
          },
          "LARGE SWAP DETECTED — backrun candidate"
        );

        this.onSignal(signal);
      }
    }
  }
}
