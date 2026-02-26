import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import type pino from "pino";
import { JupiterClient } from "../providers/jupiter-client";
import { FlashLoanClient } from "../providers/flash-loan-client";
import { ArbitrageOpportunity } from "./profit-calculator";

export interface BuildTransactionParams {
  connection: Connection;
  borrower: Keypair;
  borrowerTokenAccountA: PublicKey; // ATA for flash loan token (e.g., USDC)
  borrowerTokenAccountB: PublicKey; // ATA for intermediate token (e.g., wSOL)
  flashLoanClient: FlashLoanClient;
  jupiterClient: JupiterClient;
  opportunity: ArbitrageOpportunity;
  slippageBps: number;
  computeUnitPrice: number;
  computeUnitLimit: number;
  logger: pino.Logger;
  // Jito tip (optional — appended as last instruction if provided)
  jitoTipInstruction?: TransactionInstruction;
}

export interface BuildTransactionResult {
  tx: VersionedTransaction;
  blockhash: string;
  lastValidBlockHeight: number;
}

/**
 * Build the atomic arbitrage transaction:
 *   [compute budget] -> [borrow] -> [swap A->B] -> [swap B->A] -> [repay]
 *
 * Uses VersionedTransaction (V0) with Address Lookup Tables from Jupiter.
 * Returns the tx AND the blockhash used, so confirmation uses the same one.
 */
export async function buildArbitrageTransaction(
  params: BuildTransactionParams
): Promise<BuildTransactionResult> {
  const {
    connection,
    borrower,
    borrowerTokenAccountA,
    flashLoanClient,
    jupiterClient,
    opportunity,
    slippageBps,
    computeUnitPrice,
    computeUnitLimit,
    logger,
    jitoTipInstruction,
  } = params;

  logger.debug("Building atomic arbitrage transaction...");

  // Use scanner's cached quotes if available (saves ~2s of re-quoting latency).
  // The on-chain flash loan repayment check + simulation are the real safety nets —
  // if quotes are stale, the tx simply reverts with no funds lost.
  const quoteLeg1 = opportunity.quoteLeg1;
  const quoteLeg2 = opportunity.quoteLeg2;

  if (!quoteLeg1 || !quoteLeg2) {
    throw new Error("Missing cached quotes — scanner must attach quoteLeg1/quoteLeg2");
  }

  const quoteAgeMs = Date.now() - opportunity.timestamp;
  logger.debug(
    { quoteAgeMs, pair: opportunity.pair },
    "Using cached quotes from scanner"
  );

  // Reject quotes older than 30 seconds — too stale for reliable execution
  if (quoteAgeMs > 30_000) {
    throw new Error(
      `Quotes too stale: ${quoteAgeMs}ms old (max 30000ms)`
    );
  }

  // Fetch swap instructions for both legs in parallel
  const [swapIxLeg1, swapIxLeg2] = await Promise.all([
    jupiterClient.getSwapInstructions(quoteLeg1, borrower.publicKey),
    jupiterClient.getSwapInstructions(quoteLeg2, borrower.publicKey),
  ]);

  // 2. Build flash loan borrow/repay instructions
  const borrowIx = await flashLoanClient.buildBorrowIx(
    borrower.publicKey,
    borrowerTokenAccountA,
    new BN(opportunity.borrowAmount.toString())
  );

  const repayIx = await flashLoanClient.buildRepayIx(
    borrower.publicKey,
    borrowerTokenAccountA
  );

  // 3. Compose the full instruction sequence
  const instructions: TransactionInstruction[] = [
    // Compute budget (must be first)
    ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: computeUnitPrice,
    }),

    // Flash loan borrow — tokens land in borrowerTokenAccountA
    borrowIx,

    // Jupiter leg 1: tokenA -> tokenB (setup + swap + cleanup)
    ...swapIxLeg1.setupInstructions,
    swapIxLeg1.swapInstruction,
    ...(swapIxLeg1.cleanupInstruction ? [swapIxLeg1.cleanupInstruction] : []),

    // Jupiter leg 2: tokenB -> tokenA (setup + swap + cleanup)
    ...swapIxLeg2.setupInstructions,
    swapIxLeg2.swapInstruction,
    ...(swapIxLeg2.cleanupInstruction ? [swapIxLeg2.cleanupInstruction] : []),

    // Flash loan repay — returns principal + fee from borrowerTokenAccountA
    repayIx,
  ];

  // Jito tip goes LAST — after repay, so the bundle tip is only paid on success
  if (jitoTipInstruction) {
    instructions.push(jitoTipInstruction);
  }

  logger.debug(
    { instructionCount: instructions.length, hasJitoTip: !!jitoTipInstruction },
    "Transaction instructions assembled"
  );

  // 4. Load Address Lookup Tables (needed for V0 transactions)
  const allAltAddresses = [
    ...swapIxLeg1.addressLookupTableAddresses,
    ...swapIxLeg2.addressLookupTableAddresses,
  ];

  const lookupTables = await jupiterClient.loadAddressLookupTables(
    connection,
    allAltAddresses
  );

  // 5. Build and sign V0 transaction — store blockhash for confirmation (C-04)
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");

  const messageV0 = new TransactionMessage({
    payerKey: borrower.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message(lookupTables);

  const tx = new VersionedTransaction(messageV0);
  tx.sign([borrower]);

  // Log transaction size
  const txBytes = tx.serialize().length;
  logger.debug(
    {
      txBytes,
      maxBytes: 1232,
      utilizationPct: ((txBytes / 1232) * 100).toFixed(1),
      lastValidBlockHeight,
    },
    "Transaction built"
  );

  if (txBytes > 1232) {
    throw new Error(
      `Transaction too large: ${txBytes} bytes (max 1232). Try onlyDirectRoutes or fewer accounts.`
    );
  }

  return { tx, blockhash, lastValidBlockHeight };
}

/**
 * Simulate the transaction to check for errors before sending.
 */
export async function simulateTransaction(
  connection: Connection,
  tx: VersionedTransaction,
  logger: pino.Logger
): Promise<{ success: boolean; logs: string[]; unitsConsumed: number }> {
  const result = await connection.simulateTransaction(tx, {
    commitment: "confirmed",
  });

  const logs = result.value.logs || [];
  const unitsConsumed = result.value.unitsConsumed || 0;

  if (result.value.err) {
    logger.warn(
      {
        error: result.value.err,
        unitsConsumed,
        logTail: logs.slice(-5),
      },
      "Simulation FAILED"
    );
    return { success: false, logs, unitsConsumed };
  }

  logger.debug(
    { unitsConsumed, logCount: logs.length },
    "Simulation SUCCESS"
  );
  return { success: true, logs, unitsConsumed };
}
