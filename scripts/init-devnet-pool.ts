/**
 * Initialize a flash loan pool on devnet after program deployment.
 *
 * Usage: npx ts-node scripts/init-devnet-pool.ts
 *
 * Prerequisites:
 *   - Program deployed to devnet (run deploy-devnet.sh first)
 *   - ~/.config/solana/id.json funded with devnet SOL
 */

import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { SolanaFlashLoan } from "../target/types/solana_flash_loan";
import {
  createMint,
  createAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Connection,
  clusterApiUrl,
} from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const PROGRAM_ID = "2chVPk6DV21qWuyUA2eHAzATdFSHM7ykv1fVX7Gv6nor";
const FEE_BPS = 9; // 0.09%
const INITIAL_LIQUIDITY = 1_000_000_000; // 1,000 tokens (6 decimals)

async function main() {
  // Load wallet
  const walletPath = path.join(os.homedir(), ".config", "solana", "id.json");
  const walletData = JSON.parse(fs.readFileSync(walletPath, "utf-8"));
  const admin = Keypair.fromSecretKey(Uint8Array.from(walletData));

  // Connect to devnet
  const connection = new Connection(
    process.env.RPC_URL || clusterApiUrl("devnet"),
    "confirmed"
  );

  console.log("=== Devnet Pool Initialization ===");
  console.log(`Wallet: ${admin.publicKey.toBase58()}`);
  console.log(`Balance: ${(await connection.getBalance(admin.publicKey)) / 1e9} SOL`);

  // Set up Anchor provider
  const wallet = new anchor.Wallet(admin);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);

  const program = new Program(
    require("../target/idl/solana_flash_loan.json"),
    new PublicKey(PROGRAM_ID),
    provider
  ) as Program<SolanaFlashLoan>;

  // Step 1: Create test token mint (simulating USDC with 6 decimals)
  console.log("\n1. Creating test token mint...");
  const tokenMint = await createMint(
    connection,
    admin,
    admin.publicKey,
    null,
    6
  );
  console.log(`   Token Mint: ${tokenMint.toBase58()}`);

  // Step 2: Create admin token account
  console.log("2. Creating admin token account...");
  const adminTokenAccount = await createAccount(
    connection,
    admin,
    tokenMint,
    admin.publicKey
  );
  console.log(`   Admin ATA: ${adminTokenAccount.toBase58()}`);

  // Step 3: Mint initial liquidity
  console.log("3. Minting initial liquidity...");
  await mintTo(
    connection,
    admin,
    tokenMint,
    adminTokenAccount,
    admin,
    INITIAL_LIQUIDITY
  );
  console.log(`   Minted: ${INITIAL_LIQUIDITY / 1e6} tokens`);

  // Step 4: Derive PDAs
  const [poolPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("lending_pool"), tokenMint.toBuffer()],
    program.programId
  );
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool_vault"), poolPda.toBuffer()],
    program.programId
  );

  console.log(`   Pool PDA:  ${poolPda.toBase58()}`);
  console.log(`   Vault PDA: ${vaultPda.toBase58()}`);

  // Step 5: Initialize pool
  console.log("4. Initializing pool...");
  const initTx = await program.methods
    .initializePool(FEE_BPS)
    .accountsStrict({
      pool: poolPda,
      tokenMint,
      vault: vaultPda,
      admin: admin.publicKey,
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
  console.log(`   Pool initialized: tx=${initTx.slice(0, 20)}...`);

  // Step 6: Deposit liquidity
  console.log("5. Depositing liquidity...");
  const [receiptPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("deposit_receipt"),
      poolPda.toBuffer(),
      admin.publicKey.toBuffer(),
    ],
    program.programId
  );

  const depositTx = await program.methods
    .deposit(new BN(INITIAL_LIQUIDITY))
    .accountsStrict({
      pool: poolPda,
      receipt: receiptPda,
      vault: vaultPda,
      depositorTokenAccount: adminTokenAccount,
      depositor: admin.publicKey,
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
  console.log(`   Deposited: ${INITIAL_LIQUIDITY / 1e6} tokens, tx=${depositTx.slice(0, 20)}...`);

  // Summary
  console.log("\n=== Pool Ready ===");
  console.log(`Program ID:  ${PROGRAM_ID}`);
  console.log(`Token Mint:  ${tokenMint.toBase58()}`);
  console.log(`Pool PDA:    ${poolPda.toBase58()}`);
  console.log(`Vault PDA:   ${vaultPda.toBase58()}`);
  console.log(`Fee:         ${FEE_BPS} bps (0.09%)`);
  console.log(`Liquidity:   ${INITIAL_LIQUIDITY / 1e6} tokens`);
  console.log(`\nUpdate bot/.env with:`);
  console.log(`  FLASH_LOAN_TOKEN_MINT=${tokenMint.toBase58()}`);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
