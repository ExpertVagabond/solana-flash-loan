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

/**
 * Build the atomic arbitrage transaction:
 *   [compute budget] -> [borrow] -> [swap A->B] -> [swap B->A] -> [repay]
 *
 * Uses VersionedTransaction (V0) with Address Lookup Tables from Jupiter.
 */
export async function buildArbitrageTransaction(
  params: BuildTransactionParams
): Promise<VersionedTransaction> {
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

  // 1. Get Jupiter swap instructions for both legs
  logger.debug("Fetching Jupiter quotes and swap instructions...");

  const quoteLeg1 = await jupiterClient.getQuote(
    opportunity.tokenA,
    opportunity.tokenB,
    opportunity.borrowAmount.toString(),
    slippageBps
  );

  const quoteLeg2 = await jupiterClient.getQuote(
    opportunity.tokenB,
    opportunity.tokenA,
    quoteLeg1.outAmount,
    slippageBps
  );

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

  // 5. Build and sign V0 transaction
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

  return tx;
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
