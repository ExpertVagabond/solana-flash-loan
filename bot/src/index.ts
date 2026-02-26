#!/usr/bin/env node
import { Command } from "commander";
import { Connection, PublicKey } from "@solana/web3.js";
import { loadConfig } from "./config";
import { loadKeypair } from "./utils/wallet";
import { createLogger } from "./utils/logger";
import { createMetrics } from "./utils/metrics";
import { JupiterClient } from "./providers/jupiter-client";
import { FlashLoanClient } from "./providers/flash-loan-client";
import { PairScanner } from "./monitoring/pair-scanner";
import { ArbitrageEngine } from "./core/arbitrage-engine";
import { JitoClient, JitoRegion } from "./providers/jito-client";

const cli = new Command()
  .name("flash-arb")
  .description("Solana flash loan arbitrage bot")
  .version("0.1.0")
  .option("--rpc <url>", "Solana RPC URL")
  .option("--wallet <path>", "Keypair JSON path")
  .option("--pairs <pairs...>", "Token pairs (e.g., SOL/USDC BONK/USDC)")
  .option("--borrow-amount <amount>", "Borrow amount in token smallest units")
  .option("--min-profit-bps <bps>", "Minimum profit threshold (bps)")
  .option("--slippage <bps>", "Max slippage (bps)")
  .option("--poll-interval <ms>", "Price poll interval (ms)")
  .option("--priority-fee <microLamports>", "Compute unit price")
  .option("--compute-unit-limit <units>", "CU budget")
  .option("--program-id <pubkey>", "Flash loan program ID")
  .option("--token-mint <pubkey>", "Flash loan token mint")
  .option("--dry-run", "Simulate only, do not send transactions")
  .option("--jito", "Send transactions via Jito block engine")
  .option("--jito-region <region>", "Jito region (default, ny, amsterdam, frankfurt, tokyo, slc)")
  .option("--jito-tip <lamports>", "Jito tip amount in lamports")
  .option("--verbose", "Debug logging")
  .parse();

async function main(): Promise<void> {
  const opts = cli.opts();
  const config = loadConfig(opts);
  const logger = createLogger(config.verbose);

  logger.info("=== Solana Flash Loan Arbitrage Bot ===");
  logger.info({ version: "0.1.0", dryRun: config.dryRun });

  // Load wallet
  const wallet = loadKeypair(config.walletPath);
  logger.info(
    { pubkey: wallet.publicKey.toBase58() },
    "Wallet loaded"
  );

  // Connect to RPC
  const connection = new Connection(config.rpcUrl, {
    commitment: "confirmed",
    ...(config.wsUrl ? { wsEndpoint: config.wsUrl } : {}),
  });

  const slot = await connection.getSlot();
  logger.info({ rpc: config.rpcUrl.replace(/api-key=.*/, "api-key=***"), slot }, "Connected to RPC");

  // Initialize providers
  const jupiterClient = new JupiterClient(logger);

  const flashLoanClient = new FlashLoanClient(
    connection,
    new PublicKey(config.flashLoanProgramId),
    new PublicKey(config.flashLoanTokenMint),
    wallet,
    logger
  );

  // Get pool fee for scanner (default to 9 if pool not deployed yet)
  let poolFeeBps = 9;
  try {
    const poolState = await flashLoanClient.getPoolState();
    poolFeeBps = poolState.feeBasisPoints;
  } catch {
    logger.warn("Flash loan pool not found — using default 9 bps fee for calculations");
  }

  const scanner = new PairScanner(
    jupiterClient,
    poolFeeBps,
    config.minProfitBps,
    config.maxSlippageBps,
    logger,
    config.priorityFeeMicroLamports,
    config.computeUnitLimit,
    config.jitoTipLamports,
    config.useJito
  );

  const metrics = createMetrics();

  // Initialize Jito client if enabled
  let jitoClient: JitoClient | null = null;
  if (config.useJito) {
    jitoClient = new JitoClient(config.jitoRegion as JitoRegion, logger);
    logger.info(
      { region: config.jitoRegion, tipLamports: config.jitoTipLamports },
      "Jito bundle support ENABLED"
    );
  }

  // Create and start engine
  const engine = new ArbitrageEngine(
    connection,
    wallet,
    config,
    flashLoanClient,
    jupiterClient,
    scanner,
    metrics,
    logger,
    jitoClient
  );

  // Graceful shutdown
  const shutdown = () => {
    logger.info("Shutting down...");
    engine.stop();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await engine.start();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
