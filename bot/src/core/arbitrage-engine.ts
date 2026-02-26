import {
  Connection,
  Keypair,
  PublicKey,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  getAccount,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
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
import { MultiDexClient, CrossDexOpportunity } from "../providers/multi-dex-client";
import { OracleClient } from "../providers/oracle-client";

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
  private multiDex: MultiDexClient;
  private oracle: OracleClient;
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
    this.multiDex = new MultiDexClient(logger, jupiterClient);
    this.oracle = new OracleClient(connection, logger);
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
        priorityFee: this.config.priorityFeeMicroLamports,
        computeUnitLimit: this.config.computeUnitLimit,
      },
      "Arbitrage engine STARTED"
    );

    // Main loop
    while (this.running) {
      const cycleStart = Date.now();
      this.metrics.scanCycles++;

      try {
        for (let i = 0; i < this.config.pairs.length; i++) {
          if (!this.running) break;
          const pair = this.config.pairs[i];

          // Stagger pairs by 300ms — Raydium handles this volume fine
          if (i > 0) {
            await new Promise((r) => setTimeout(r, 300));
          }

          const [targetToken, quoteToken] = parsePair(pair);

          // We borrow quoteToken (USDC) via flash loan, so:
          //   tokenA = quoteToken (flash loan / borrow token)
          //   tokenB = targetToken (intermediate / swap token)
          // Flow: borrow USDC -> swap USDC->TARGET -> swap TARGET->USDC -> repay
          const opportunity = await this.scanner.scanPair(
            pair,
            quoteToken,
            targetToken,
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
                  solCosts: opportunity.solCostsInToken.toString(),
                },
                "DRY RUN: would execute arbitrage"
              );
              continue;
            }

            await this.executeArbitrage(opportunity);
          }
        }

        // Phase 2: Cross-DEX arb scan — only on top 5 tightest-spread pairs
        // (saves rate budget by not scanning all 37+ pairs across 4 DEXes)
        const bestPairs = this.scanner.getBestSpreads();
        const sortedPairs = [...bestPairs.entries()]
          .sort((a, b) => b[1].bps - a[1].bps)
          .slice(0, 5)
          .map(([pair]) => pair);

        for (const pair of sortedPairs) {
          const [targetToken, quoteToken] = parsePair(pair);

          try {
            const crossDex = await this.multiDex.findCrossDexArb(
              pair,
              quoteToken,
              targetToken,
              this.config.borrowAmount,
              9 // pool fee bps
            );

            if (crossDex && crossDex.grossProfitBps >= this.config.minProfitBps) {
              this.metrics.opportunitiesFound++;
              if (this.config.dryRun) {
                this.logger.info(
                  {
                    pair,
                    buyDex: crossDex.buyDex,
                    sellDex: crossDex.sellDex,
                    profitBps: crossDex.grossProfitBps,
                  },
                  "DRY RUN: cross-DEX arb found"
                );
              }
              // TODO: Build cross-DEX execution path (buy on one DEX, sell on another)
            }
          } catch (err) {
            this.logger.debug(
              { pair, error: (err as Error).message },
              "Cross-DEX scan error"
            );
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
      let ataFails = 0;
      for (const mint of mints) {
        try {
          await this.ensureAta(mint);
        } catch (err) {
          ataFails++;
          this.logger.warn(
            { mint: mint.slice(0, 8), error: (err as Error).message },
            "ATA setup failed — pairs using this mint will be skipped"
          );
        }
      }
      if (ataFails > 0) {
        this.logger.warn({ failed: ataFails, total: mints.size }, "Some ATAs could not be created");
      }
    } else {
      this.logger.debug("Skipping ATA creation in dry-run mode");
    }

    this.logger.info("Pre-flight checks PASSED");
  }

  /**
   * Detect whether a mint uses Token-2022 or standard SPL Token program.
   */
  private async getTokenProgramForMint(mintPk: PublicKey): Promise<PublicKey> {
    const info = await this.connection.getAccountInfo(mintPk);
    if (!info) throw new Error(`Mint account not found: ${mintPk.toBase58()}`);
    if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
    return TOKEN_PROGRAM_ID;
  }

  private async ensureAta(mint: string): Promise<PublicKey> {
    if (this.ataCache.has(mint)) return this.ataCache.get(mint)!;

    const mintPk = new PublicKey(mint);

    // Detect Token-2022 vs standard SPL Token
    let tokenProgram: PublicKey;
    try {
      tokenProgram = await this.getTokenProgramForMint(mintPk);
    } catch (err) {
      this.logger.warn(
        { mint: mint.slice(0, 8), error: (err as Error).message },
        "Cannot resolve token program for mint — skipping"
      );
      throw err;
    }

    const isToken2022 = tokenProgram.equals(TOKEN_2022_PROGRAM_ID);
    if (isToken2022) {
      this.logger.debug({ mint: mint.slice(0, 8) }, "Token-2022 mint detected");
    }

    const ata = await getAssociatedTokenAddress(
      mintPk,
      this.wallet.publicKey,
      false, // allowOwnerOffCurve
      tokenProgram,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    try {
      await getAccount(this.connection, ata, undefined, tokenProgram);
      this.logger.debug(
        { mint: mint.slice(0, 8), ata: ata.toBase58(), token2022: isToken2022 },
        "ATA exists"
      );
    } catch {
      // ATA doesn't exist — create it
      this.logger.info(
        { mint: mint.slice(0, 8), ata: ata.toBase58(), token2022: isToken2022 },
        "Creating ATA"
      );
      const ix = createAssociatedTokenAccountInstruction(
        this.wallet.publicKey,
        ata,
        this.wallet.publicKey,
        mintPk,
        tokenProgram,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );
      const { blockhash } = await this.connection.getLatestBlockhash();
      const { Transaction } = await import("@solana/web3.js");
      const tx = new Transaction().add(ix);
      tx.recentBlockhash = blockhash;
      tx.feePayer = this.wallet.publicKey;
      tx.sign(this.wallet);
      await this.connection.sendRawTransaction(tx.serialize());
      this.logger.info({ mint: mint.slice(0, 8), token2022: isToken2022 }, "ATA created");
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

      // Build the atomic transaction — returns blockhash for confirmation (C-04 fix)
      const { tx, blockhash, lastValidBlockHeight } =
        await buildArbitrageTransaction({
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
        // Standard RPC path — skip preflight since we already simulated (W-05 fix)
        sig = await this.connection.sendTransaction(tx, {
          skipPreflight: true,
          maxRetries: 2,
        });

        this.logger.info(
          { signature: sig, pair: opportunity.pair, via: "rpc" },
          "Transaction SENT via RPC"
        );
      }

      // Confirm using the SAME blockhash from build time (C-04 fix)
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
            solCosts: opportunity.solCostsInToken.toString(),
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
