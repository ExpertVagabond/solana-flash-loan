import {
  Connection,
  Keypair,
  PublicKey,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  getAccount,
} from "@solana/spl-token";
import type pino from "pino";
import { BotConfig } from "../config";
import { JupiterClient } from "../providers/jupiter-client";
import { FlashLoanClient } from "../providers/flash-loan-client";
import { PairScanner } from "../monitoring/pair-scanner";
import {
  buildArbitrageTransaction,
  simulateTransaction,
} from "./transaction-builder";
import { BotMetrics, printMetricsSummary } from "../utils/metrics";
import { parsePair } from "../utils/tokens";
import { ArbitrageOpportunity } from "./profit-calculator";
import { JitoClient } from "../providers/jito-client";

export class ArbitrageEngine {
  private connection: Connection;
  private wallet: Keypair;
  private config: BotConfig;
  private flashLoanClient: FlashLoanClient;
  private jupiterClient: JupiterClient;
  private scanner: PairScanner;
  private metrics: BotMetrics;
  private logger: pino.Logger;
  private jitoClient: JitoClient | null;
  private running = false;
  private consecutiveFailures = 0;
  private metricsIntervalId: ReturnType<typeof setInterval> | null = null;

  // Cache ATAs per mint
  private ataCache: Map<string, PublicKey> = new Map();

  constructor(
    connection: Connection,
    wallet: Keypair,
    config: BotConfig,
    flashLoanClient: FlashLoanClient,
    jupiterClient: JupiterClient,
    scanner: PairScanner,
    metrics: BotMetrics,
    logger: pino.Logger,
    jitoClient: JitoClient | null = null
  ) {
    this.connection = connection;
    this.wallet = wallet;
    this.config = config;
    this.flashLoanClient = flashLoanClient;
    this.jupiterClient = jupiterClient;
    this.scanner = scanner;
    this.metrics = metrics;
    this.logger = logger;
    this.jitoClient = jitoClient;
  }

  async start(): Promise<void> {
    this.running = true;

    // Pre-flight checks
    await this.preflight();

    // Print metrics summary every 60 seconds
    this.metricsIntervalId = setInterval(() => {
      printMetricsSummary(this.metrics, this.logger);
    }, 60_000);

    this.logger.info(
      {
        pairs: this.config.pairs,
        borrowAmount: this.config.borrowAmount.toString(),
        minProfitBps: this.config.minProfitBps,
        dryRun: this.config.dryRun,
        pollIntervalMs: this.config.pollIntervalMs,
        jito: this.config.useJito,
        jitoTipLamports: this.config.useJito ? this.config.jitoTipLamports : undefined,
      },
      "Arbitrage engine STARTED"
    );

    // Main loop
    while (this.running) {
      const cycleStart = Date.now();
      this.metrics.scanCycles++;

      try {
        for (const pair of this.config.pairs) {
          if (!this.running) break;

          const [tokenA, tokenB] = parsePair(pair);

          const opportunity = await this.scanner.scanPair(
            pair,
            tokenA,
            tokenB,
            this.config.borrowAmount
          );

          if (opportunity) {
            this.metrics.opportunitiesFound++;

            if (this.config.dryRun) {
              this.logger.info(
                {
                  pair,
                  profitBps: opportunity.profitBps,
                  expectedProfit: opportunity.expectedProfit.toString(),
                },
                "DRY RUN: would execute arbitrage"
              );
              continue;
            }

            await this.executeArbitrage(opportunity);
          }
        }

        this.consecutiveFailures = 0;
      } catch (err) {
        this.consecutiveFailures++;
        this.logger.error(
          {
            error: (err as Error).message,
            consecutiveFailures: this.consecutiveFailures,
          },
          "Scan cycle error"
        );

        if (
          this.consecutiveFailures >= this.config.maxConsecutiveFailures
        ) {
          this.logger.error(
            "KILL SWITCH: too many consecutive failures, halting"
          );
          this.stop();
          break;
        }
      }

      // Throttle
      const elapsed = Date.now() - cycleStart;
      const sleepMs = Math.max(0, this.config.pollIntervalMs - elapsed);
      if (sleepMs > 0 && this.running) {
        await new Promise((r) => setTimeout(r, sleepMs));
      }
    }

    // Cleanup
    if (this.metricsIntervalId) clearInterval(this.metricsIntervalId);
    printMetricsSummary(this.metrics, this.logger);
    this.logger.info("Arbitrage engine STOPPED");
  }

  stop(): void {
    this.running = false;
  }

  private async preflight(): Promise<void> {
    this.logger.info("Running pre-flight checks...");

    // 1. Check wallet SOL balance
    const balance = await this.connection.getBalance(this.wallet.publicKey);
    const solBalance = balance / 1e9;
    this.logger.info(
      { wallet: this.wallet.publicKey.toBase58(), solBalance },
      "Wallet"
    );
    if (solBalance < 0.05 && !this.config.dryRun) {
      throw new Error(
        `Insufficient SOL: ${solBalance}. Need at least 0.05 SOL for rent + tx fees.`
      );
    }
    if (solBalance < 0.05) {
      this.logger.warn(`Low SOL balance: ${solBalance}. Fund wallet before switching off dry-run.`);
    }

    // 2. Check flash loan pool
    try {
      const pool = await this.flashLoanClient.getPoolState();
      this.logger.info(
        {
          pool: this.flashLoanClient.poolPda.toBase58(),
          totalDeposits: pool.totalDeposits.toString(),
          feeBps: pool.feeBasisPoints,
          isActive: pool.isActive,
        },
        "Flash loan pool"
      );

      if (!pool.isActive) {
        throw new Error("Flash loan pool is paused");
      }

      if (pool.totalDeposits.lt(new (require("@coral-xyz/anchor").BN)(this.config.borrowAmount.toString()))) {
        this.logger.warn(
          "Pool liquidity is less than borrow amount — arb may fail"
        );
      }
    } catch (err) {
      this.logger.warn(
        { error: (err as Error).message },
        "Flash loan pool not found — will only do dry-run quote scanning"
      );
    }

    // 3. Ensure ATAs exist for all tokens in configured pairs
    const mints = new Set<string>();
    mints.add(this.config.flashLoanTokenMint);
    for (const pair of this.config.pairs) {
      const [tokenA, tokenB] = parsePair(pair);
      mints.add(tokenA);
      mints.add(tokenB);
    }

    if (!this.config.dryRun) {
      for (const mint of mints) {
        await this.ensureAta(mint);
      }
    } else {
      this.logger.debug("Skipping ATA creation in dry-run mode");
    }

    this.logger.info("Pre-flight checks PASSED");
  }

  private async ensureAta(mint: string): Promise<PublicKey> {
    if (this.ataCache.has(mint)) return this.ataCache.get(mint)!;

    const mintPk = new PublicKey(mint);
    const ata = await getAssociatedTokenAddress(mintPk, this.wallet.publicKey);

    try {
      await getAccount(this.connection, ata);
      this.logger.debug(
        { mint: mint.slice(0, 8), ata: ata.toBase58() },
        "ATA exists"
      );
    } catch {
      // ATA doesn't exist — create it
      this.logger.info(
        { mint: mint.slice(0, 8), ata: ata.toBase58() },
        "Creating ATA"
      );
      const ix = createAssociatedTokenAccountInstruction(
        this.wallet.publicKey,
        ata,
        this.wallet.publicKey,
        mintPk
      );
      const { blockhash } = await this.connection.getLatestBlockhash();
      const { Transaction } = await import("@solana/web3.js");
      const tx = new Transaction().add(ix);
      tx.recentBlockhash = blockhash;
      tx.feePayer = this.wallet.publicKey;
      tx.sign(this.wallet);
      await this.connection.sendRawTransaction(tx.serialize());
      this.logger.info({ mint: mint.slice(0, 8) }, "ATA created");
    }

    this.ataCache.set(mint, ata);
    return ata;
  }

  private async executeArbitrage(
    opportunity: ArbitrageOpportunity
  ): Promise<void> {
    const borrowerTokenAccountA = await this.ensureAta(opportunity.tokenA);
    const borrowerTokenAccountB = await this.ensureAta(opportunity.tokenB);

    try {
      // Build Jito tip instruction if enabled
      const jitoTipInstruction =
        this.jitoClient && this.config.useJito
          ? this.jitoClient.buildTipInstruction(
              this.wallet.publicKey,
              this.config.jitoTipLamports
            )
          : undefined;

      // Build the atomic transaction
      const tx = await buildArbitrageTransaction({
        connection: this.connection,
        borrower: this.wallet,
        borrowerTokenAccountA,
        borrowerTokenAccountB,
        flashLoanClient: this.flashLoanClient,
        jupiterClient: this.jupiterClient,
        opportunity,
        slippageBps: this.config.maxSlippageBps,
        computeUnitPrice: this.config.priorityFeeMicroLamports,
        computeUnitLimit: this.config.computeUnitLimit,
        logger: this.logger,
        jitoTipInstruction,
      });

      // Simulate first
      const sim = await simulateTransaction(
        this.connection,
        tx,
        this.logger
      );

      if (!sim.success) {
        this.metrics.simulationFailures++;
        this.logger.warn(
          { pair: opportunity.pair },
          "Skipping — simulation failed"
        );
        return;
      }

      // Send via Jito or regular RPC
      let sig: string;

      if (this.jitoClient && this.config.useJito) {
        // Jito path: send single tx directly to block engine
        sig = await this.jitoClient.sendTransaction(tx);

        this.logger.info(
          { signature: sig, pair: opportunity.pair, via: "jito" },
          "Transaction SENT via Jito"
        );
        this.metrics.jitoSubmissions++;
      } else {
        // Standard RPC path
        sig = await this.connection.sendTransaction(tx, {
          skipPreflight: false,
          maxRetries: 2,
        });

        this.logger.info(
          { signature: sig, pair: opportunity.pair, via: "rpc" },
          "Transaction SENT via RPC"
        );
      }

      // Confirm
      const { blockhash, lastValidBlockHeight } =
        await this.connection.getLatestBlockhash();
      const confirmation = await this.connection.confirmTransaction(
        {
          signature: sig,
          blockhash,
          lastValidBlockHeight,
        },
        "confirmed"
      );

      if (confirmation.value.err) {
        this.metrics.executionFailures++;
        this.logger.error(
          {
            signature: sig,
            error: confirmation.value.err,
          },
          "Transaction FAILED on-chain"
        );
      } else {
        this.metrics.successfulArbs++;
        this.metrics.totalProfitLamports += opportunity.expectedProfit;
        this.logger.info(
          {
            signature: sig,
            pair: opportunity.pair,
            profitBps: opportunity.profitBps,
            expectedProfit: opportunity.expectedProfit.toString(),
            via: this.config.useJito ? "jito" : "rpc",
          },
          "ARBITRAGE SUCCESS"
        );
      }
    } catch (err) {
      this.metrics.executionFailures++;
      this.logger.error(
        {
          pair: opportunity.pair,
          error: (err as Error).message,
        },
        "Arbitrage execution failed"
      );
    }
  }
}
