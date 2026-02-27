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
import { TriangularOpportunity } from "./triangular-scanner";

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

  // Use cached quotes directly — speed is critical for arb.
  // Flash loan repay is the safety net: if swap returns less, entire tx reverts.
  const quoteLeg1 = opportunity.quoteLeg1;
  const quoteLeg2 = opportunity.quoteLeg2;

  if (!quoteLeg1 || !quoteLeg2) {
    throw new Error("Missing cached quotes — scanner must attach quoteLeg1/quoteLeg2");
  }

  const quoteAgeMs = Date.now() - opportunity.timestamp;
  logger.debug(
    { quoteAgeMs, pair: opportunity.pair },
    "Building tx from cached quotes"
  );

  // Reject quotes older than 10 seconds — too stale even for Jito
  if (quoteAgeMs > 10_000) {
    throw new Error(`Quotes too stale: ${quoteAgeMs}ms old (max 10000ms)`);
  }

  // Determine if SOL is involved — disable wrapAndUnwrapSol to avoid SyncNative conflicts
  const SOL_MINT = "So11111111111111111111111111111111111111112";
  const involvesSol = opportunity.tokenA === SOL_MINT || opportunity.tokenB === SOL_MINT;

  // Fetch swap instructions — leg 2 uses tokenLedger to read actual leg 1 output
  // This prevents InsufficientFunds (6024) when leg 1 output differs from quote
  const [swapIxLeg1, swapIxLeg2] = await Promise.all([
    jupiterClient.getSwapInstructions(quoteLeg1, borrower.publicKey, !involvesSol),
    jupiterClient.getSwapInstructions(quoteLeg2, borrower.publicKey, !involvesSol, true),
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

    // Jupiter leg 2: tokenB -> tokenA (tokenLedger + setup + swap + cleanup)
    // tokenLedger snapshots the intermediate token balance so leg 2 uses
    // the ACTUAL output from leg 1, not the pre-quoted amount
    ...(swapIxLeg2.tokenLedgerInstruction ? [swapIxLeg2.tokenLedgerInstruction] : []),
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

// --- 3-leg triangular transaction builder ---

export interface BuildTriangularParams {
  connection: Connection;
  borrower: Keypair;
  borrowerTokenAccountA: PublicKey; // ATA for flash loan token (USDC)
  flashLoanClient: FlashLoanClient;
  jupiterClient: JupiterClient;
  opportunity: TriangularOpportunity;
  computeUnitPrice: number;
  computeUnitLimit: number;
  logger: pino.Logger;
  jitoTipInstruction?: TransactionInstruction;
}

/**
 * Build atomic 3-leg triangular arbitrage transaction:
 *   [compute budget] → [borrow A] → [swap A→B] → [swap B→C] → [swap C→A] → [repay A] → [tip]
 *
 * Uses cached quotes from scanner. V0 transaction with ALTs.
 * Increased CU budget (600k) for 3 swaps.
 */
export async function buildTriangularTransaction(
  params: BuildTriangularParams
): Promise<BuildTransactionResult> {
  const {
    connection,
    borrower,
    borrowerTokenAccountA,
    flashLoanClient,
    jupiterClient,
    opportunity,
    computeUnitPrice,
    computeUnitLimit,
    logger,
    jitoTipInstruction,
  } = params;

  const { route } = opportunity;

  logger.debug(
    { route: route.name },
    "Building 3-leg triangular transaction — re-quoting fresh"
  );

  // Check if SOL is involved in any leg
  const SOL_MINT = "So11111111111111111111111111111111111111112";
  const involvesSol = [route.tokenA, route.tokenB, route.tokenC].includes(SOL_MINT);
  const wrapSol = !involvesSol;

  // Fetch all 3 swap instructions — legs 2 & 3 use tokenLedger for actual amounts
  const [swapIx1, swapIx2, swapIx3] = await Promise.all([
    jupiterClient.getSwapInstructions(opportunity.quoteLeg1, borrower.publicKey, wrapSol),
    jupiterClient.getSwapInstructions(opportunity.quoteLeg2, borrower.publicKey, wrapSol, true),
    jupiterClient.getSwapInstructions(opportunity.quoteLeg3, borrower.publicKey, wrapSol, true),
  ]);

  // Flash loan borrow/repay
  const borrowIx = await flashLoanClient.buildBorrowIx(
    borrower.publicKey,
    borrowerTokenAccountA,
    new BN(route.borrowAmount.toString())
  );

  const repayIx = await flashLoanClient.buildRepayIx(
    borrower.publicKey,
    borrowerTokenAccountA
  );

  // Use higher CU limit for 3-leg transactions (3 swaps = more compute)
  const triCuLimit = Math.max(computeUnitLimit, 600_000);

  const instructions: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: triCuLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: computeUnitPrice }),

    // Borrow
    borrowIx,

    // Leg 1: A → B
    ...swapIx1.setupInstructions,
    swapIx1.swapInstruction,
    ...(swapIx1.cleanupInstruction ? [swapIx1.cleanupInstruction] : []),

    // Leg 2: B → C (tokenLedger for actual leg 1 output)
    ...(swapIx2.tokenLedgerInstruction ? [swapIx2.tokenLedgerInstruction] : []),
    ...swapIx2.setupInstructions,
    swapIx2.swapInstruction,
    ...(swapIx2.cleanupInstruction ? [swapIx2.cleanupInstruction] : []),

    // Leg 3: C → A (tokenLedger for actual leg 2 output)
    ...(swapIx3.tokenLedgerInstruction ? [swapIx3.tokenLedgerInstruction] : []),
    ...swapIx3.setupInstructions,
    swapIx3.swapInstruction,
    ...(swapIx3.cleanupInstruction ? [swapIx3.cleanupInstruction] : []),

    // Repay
    repayIx,
  ];

  if (jitoTipInstruction) {
    instructions.push(jitoTipInstruction);
  }

  logger.debug(
    { instructionCount: instructions.length, cuLimit: triCuLimit, route: route.name },
    "Triangular transaction assembled"
  );

  // Load ALTs from all 3 legs
  const allAltAddresses = [
    ...swapIx1.addressLookupTableAddresses,
    ...swapIx2.addressLookupTableAddresses,
    ...swapIx3.addressLookupTableAddresses,
  ];

  const lookupTables = await jupiterClient.loadAddressLookupTables(
    connection,
    allAltAddresses
  );

  // Build V0 transaction
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");

  const messageV0 = new TransactionMessage({
    payerKey: borrower.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message(lookupTables);

  const tx = new VersionedTransaction(messageV0);
  tx.sign([borrower]);

  const txBytes = tx.serialize().length;
  logger.debug(
    { txBytes, maxBytes: 1232, utilizationPct: ((txBytes / 1232) * 100).toFixed(1), route: route.name },
    "Triangular transaction built"
  );

  if (txBytes > 1232) {
    throw new Error(
      `Triangular tx too large: ${txBytes} bytes. Route ${route.name} needs simpler routing.`
    );
  }

  return { tx, blockhash, lastValidBlockHeight };
}
