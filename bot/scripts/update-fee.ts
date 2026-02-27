/**
 * Update flash loan pool fee.
 * Usage: npx tsx scripts/update-fee.ts <new_fee_bps>
 * Example: npx tsx scripts/update-fee.ts 1   (set fee to 1 basis point = 0.01%)
 */
import { Connection, Keypair } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";
import { FlashLoanClient } from "../src/providers/flash-loan-client";
import { createLogger } from "../src/utils/logger";
import * as fs from "fs";
import * as dotenv from "dotenv";

dotenv.config();

async function main() {
  const newFeeBps = parseInt(process.argv[2]);
  if (isNaN(newFeeBps) || newFeeBps < 0 || newFeeBps > 10000) {
    console.error("Usage: npx tsx scripts/update-fee.ts <fee_bps>");
    console.error("  fee_bps: 0-10000 (basis points)");
    process.exit(1);
  }

  const rpcUrl = process.env.RPC_URL!;
  const walletPath = process.env.WALLET_PATH!;
  const programId = process.env.FLASH_LOAN_PROGRAM_ID!;
  const tokenMint = process.env.FLASH_LOAN_TOKEN_MINT!;

  const connection = new Connection(rpcUrl, "confirmed");
  const walletKey = JSON.parse(fs.readFileSync(walletPath, "utf-8"));
  const wallet = Keypair.fromSecretKey(Uint8Array.from(walletKey));
  const logger = createLogger(false);

  const client = new FlashLoanClient(
    connection,
    new PublicKey(programId),
    new PublicKey(tokenMint),
    wallet,
    logger
  );

  // Show current state
  const before = await client.getPoolState();
  console.log(`Current fee: ${before.feeBasisPoints} bps`);
  console.log(`New fee:     ${newFeeBps} bps`);
  console.log(`Admin:       ${before.admin.toBase58()}`);
  console.log(`Wallet:      ${wallet.publicKey.toBase58()}`);

  if (!before.admin.equals(wallet.publicKey)) {
    console.error("ERROR: Wallet is not the pool admin!");
    process.exit(1);
  }

  // Update
  const sig = await client.updatePoolConfig(wallet, connection, newFeeBps);
  console.log(`Fee updated! Signature: ${sig}`);

  // Verify
  const after = await client.getPoolState();
  console.log(`Verified fee: ${after.feeBasisPoints} bps`);
}

main().catch((err) => {
  console.error("Failed:", err.message);
  process.exit(1);
});
