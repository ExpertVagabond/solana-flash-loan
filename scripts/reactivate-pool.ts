/**
 * Reactivate (unpause) the flash loan pool.
 * Sets isActive = true without changing the fee.
 *
 * Usage: npx tsx scripts/reactivate-pool.ts
 *   (run from the project root)
 */
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { Program, AnchorProvider, Wallet } from "@coral-xyz/anchor";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

// Load .env from the bot/ directory
dotenv.config({ path: path.resolve(__dirname, "../bot/.env") });

const RPC_URL = process.env.RPC_URL!;
const WALLET_PATH = process.env.WALLET_PATH!;
const PROGRAM_ID = new PublicKey(process.env.FLASH_LOAN_PROGRAM_ID || "2chVPk6DV21qWuyUA2eHAzATdFSHM7ykv1fVX7Gv6nor");
const USDC_MINT = new PublicKey(process.env.FLASH_LOAN_TOKEN_MINT || "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

async function main() {
  if (!RPC_URL) throw new Error("RPC_URL not set in bot/.env");
  if (!WALLET_PATH) throw new Error("WALLET_PATH not set in bot/.env");

  // Load bot wallet (pool admin)
  const walletData = JSON.parse(fs.readFileSync(WALLET_PATH, "utf-8"));
  const kp = Keypair.fromSecretKey(Uint8Array.from(walletData));
  const connection = new Connection(RPC_URL, "confirmed");

  const provider = new AnchorProvider(connection, new Wallet(kp), { commitment: "confirmed" });
  anchor.setProvider(provider);

  const idlPath = path.resolve(__dirname, "../target/idl/solana_flash_loan.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
  const program = new Program(idl, provider);

  // Derive pool PDA
  const [poolPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("lending_pool"), USDC_MINT.toBuffer()],
    PROGRAM_ID
  );

  console.log("=== REACTIVATE POOL ===");
  console.log(`Wallet:  ${kp.publicKey.toBase58()}`);
  console.log(`Pool:    ${poolPda.toBase58()}`);

  // Fetch current pool state
  const pool = await (program.account as any).lendingPool.fetch(poolPda);
  console.log(`\nCurrent Pool State:`);
  console.log(`  Admin:          ${pool.admin.toBase58()}`);
  console.log(`  Total Deposits: ${(pool.totalDeposits.toNumber() / 1e6).toFixed(2)} USDC`);
  console.log(`  Fee (bps):      ${pool.feeBasisPoints}`);
  console.log(`  Active:         ${pool.isActive}`);

  if (pool.isActive) {
    console.log("\nPool is already active. Nothing to do.");
    return;
  }

  // Reactivate: set isActive = true, keep fee unchanged (null)
  console.log("\nSending updatePoolConfig(null, true)...");
  const ix = await program.methods
    .updatePoolConfig(null, true)
    .accountsStrict({
      pool: poolPda,
      admin: kp.publicKey,
    })
    .instruction();

  const { blockhash } = await connection.getLatestBlockhash();
  const tx = new Transaction().add(ix);
  tx.recentBlockhash = blockhash;
  tx.feePayer = kp.publicKey;
  tx.sign(kp);

  const sig = await connection.sendRawTransaction(tx.serialize());
  console.log(`Transaction sent: ${sig}`);
  await connection.confirmTransaction(sig, "confirmed");
  console.log("CONFIRMED!");

  // Verify
  const poolAfter = await (program.account as any).lendingPool.fetch(poolPda);
  console.log(`\n=== AFTER REACTIVATION ===`);
  console.log(`  Active:         ${poolAfter.isActive}`);
  console.log(`  Total Deposits: ${(poolAfter.totalDeposits.toNumber() / 1e6).toFixed(2)} USDC`);
  console.log(`  Fee (bps):      ${poolAfter.feeBasisPoints}`);
  console.log(`  Fees Earned:    ${(poolAfter.totalFeesEarned.toNumber() / 1e6).toFixed(6)} USDC`);
}

main().catch((err) => {
  console.error("ERROR:", err);
  process.exit(1);
});
