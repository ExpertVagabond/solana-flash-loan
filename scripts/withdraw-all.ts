/**
 * Withdraw all USDC from flash loan pool + deactivate pool.
 * Uses the bot wallet (pool admin + depositor).
 *
 * Usage: npx tsx scripts/withdraw-all.ts
 */
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import * as anchor from "@coral-xyz/anchor";
import { Program, BN, AnchorProvider, Wallet } from "@coral-xyz/anchor";
import * as fs from "fs";

const RPC = "https://mainnet.helius-rpc.com/?api-key=021dc255-a17b-47d8-b5b4-c915ee29efff";
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const PROGRAM_ID = new PublicKey("2chVPk6DV21qWuyUA2eHAzATdFSHM7ykv1fVX7Gv6nor");

async function main() {
  // Load bot wallet (pool admin + depositor)
  const walletPath = "/Volumes/Virtual Server/projects/solana-flash-loan/bot/wallet.json";
  const walletData = JSON.parse(fs.readFileSync(walletPath, "utf-8"));
  const kp = Keypair.fromSecretKey(Uint8Array.from(walletData));
  const connection = new Connection(RPC, "confirmed");

  const provider = new AnchorProvider(connection, new Wallet(kp), { commitment: "confirmed" });
  anchor.setProvider(provider);

  const idl = JSON.parse(
    fs.readFileSync("/Volumes/Virtual Server/projects/solana-flash-loan/target/idl/solana_flash_loan.json", "utf-8")
  );
  const program = new Program(idl, provider);

  // Derive PDAs
  const [poolPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("lending_pool"), USDC_MINT.toBuffer()], PROGRAM_ID
  );
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool_vault"), poolPda.toBuffer()], PROGRAM_ID
  );
  const [receiptPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("deposit_receipt"), poolPda.toBuffer(), kp.publicKey.toBuffer()], PROGRAM_ID
  );

  console.log("=== WITHDRAWAL ===");
  console.log(`Wallet:  ${kp.publicKey.toBase58()}`);
  console.log(`Pool:    ${poolPda.toBase58()}`);
  console.log(`Vault:   ${vaultPda.toBase58()}`);
  console.log(`Receipt: ${receiptPda.toBase58()}`);

  // Fetch pool state
  const pool = await (program.account as any).lendingPool.fetch(poolPda);
  console.log(`\nPool State:`);
  console.log(`  Admin:          ${pool.admin.toBase58()}`);
  console.log(`  Total Deposits: ${(pool.totalDeposits.toNumber() / 1e6).toFixed(2)} USDC`);
  console.log(`  Total Shares:   ${pool.totalShares.toNumber()}`);
  console.log(`  Fees Earned:    ${(pool.totalFeesEarned.toNumber() / 1e6).toFixed(6)} USDC`);
  console.log(`  Active:         ${pool.isActive}`);

  // Fetch receipt
  const receipt = await (program.account as any).depositReceipt.fetch(receiptPda);
  console.log(`\nReceipt:`);
  console.log(`  Shares: ${receipt.shares.toNumber()}`);

  const sharesToBurn = receipt.shares;
  const expectedAmount = sharesToBurn.toNumber() * pool.totalDeposits.toNumber() / pool.totalShares.toNumber();
  console.log(`\nWithdrawing ALL shares: ${sharesToBurn.toNumber()}`);
  console.log(`Expected USDC back:    ${(expectedAmount / 1e6).toFixed(2)} USDC`);

  if (sharesToBurn.toNumber() === 0) {
    console.log("\nNo shares to withdraw!");
    return;
  }

  // Get depositor USDC ATA — create if it doesn't exist
  const usdcAta = await getAssociatedTokenAddress(USDC_MINT, kp.publicKey);
  const ataInfo = await connection.getAccountInfo(usdcAta);
  let createAtaIx: any = null;
  if (!ataInfo) {
    console.log("\nUSUSDC ATA doesn't exist — will create it in the tx");
    createAtaIx = createAssociatedTokenAccountInstruction(
      kp.publicKey, usdcAta, kp.publicKey, USDC_MINT
    );
  }

  // Step 1: Deactivate pool (prevent new borrows during withdrawal)
  console.log("\n1. Deactivating pool...");
  const deactivateIx = await program.methods
    .updatePoolConfig(null, false)
    .accountsStrict({
      pool: poolPda,
      admin: kp.publicKey,
    })
    .instruction();

  // Step 2: Withdraw all shares
  console.log("2. Withdrawing all USDC...");
  const withdrawIx = await program.methods
    .withdraw(sharesToBurn)
    .accountsStrict({
      pool: poolPda,
      receipt: receiptPda,
      vault: vaultPda,
      depositorTokenAccount: usdcAta,
      depositor: kp.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();

  // Send all in one tx
  const { blockhash } = await connection.getLatestBlockhash();
  const tx = new Transaction();
  if (createAtaIx) tx.add(createAtaIx);
  tx.add(deactivateIx, withdrawIx);
  tx.recentBlockhash = blockhash;
  tx.feePayer = kp.publicKey;
  tx.sign(kp);

  const sig = await connection.sendRawTransaction(tx.serialize());
  console.log(`\nTransaction sent: ${sig}`);
  await connection.confirmTransaction(sig, "confirmed");
  console.log("CONFIRMED!");

  // Verify
  const poolAfter = await (program.account as any).lendingPool.fetch(poolPda);
  const usdcBalance = await connection.getTokenAccountBalance(usdcAta);
  const solBalance = await connection.getBalance(kp.publicKey);

  console.log(`\n=== AFTER WITHDRAWAL ===`);
  console.log(`Pool deposits: ${(poolAfter.totalDeposits.toNumber() / 1e6).toFixed(2)} USDC`);
  console.log(`Pool active:   ${poolAfter.isActive}`);
  console.log(`Wallet USDC:   ${usdcBalance.value.uiAmountString} USDC`);
  console.log(`Wallet SOL:    ${(solBalance / 1e9).toFixed(6)} SOL`);
}

main().catch((err) => {
  console.error("ERROR:", err);
  process.exit(1);
});
