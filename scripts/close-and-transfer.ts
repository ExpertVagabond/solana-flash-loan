/**
 * Close empty ATAs, transfer all USDC + SOL to main wallet.
 * Usage: npx tsx scripts/close-and-transfer.ts
 */
import {
  Connection, Keypair, PublicKey, Transaction,
  LAMPORTS_PER_SOL, SystemProgram,
} from "@solana/web3.js";
import {
  createCloseAccountInstruction, createTransferInstruction,
  createAssociatedTokenAccountInstruction, getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import * as fs from "fs";

const RPC = "https://mainnet.helius-rpc.com/?api-key=021dc255-a17b-47d8-b5b4-c915ee29efff";
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const MAIN_WALLET = new PublicKey("39NsBBAySg8kjeWEBpdiYt1oWtbPCv3A6YFd86ZGyeyv");
const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

async function main() {
  const walletData = JSON.parse(
    fs.readFileSync("/Volumes/Virtual Server/projects/solana-flash-loan/bot/wallet.json", "utf-8")
  );
  const kp = Keypair.fromSecretKey(Uint8Array.from(walletData));
  const conn = new Connection(RPC, "confirmed");

  console.log(`Bot wallet:  ${kp.publicKey.toBase58()}`);
  console.log(`Main wallet: ${MAIN_WALLET.toBase58()}`);

  // Find all token accounts
  const spl = await conn.getParsedTokenAccountsByOwner(kp.publicKey, { programId: TOKEN_PROGRAM_ID });
  const t22 = await conn.getParsedTokenAccountsByOwner(kp.publicKey, { programId: TOKEN_2022 });
  const all = [...spl.value, ...t22.value];

  const tx = new Transaction();

  // Close empty ATAs
  for (const acct of all) {
    const info = acct.account.data.parsed.info;
    const balance = parseFloat(info.tokenAmount.uiAmountString || "0");
    if (balance === 0) {
      tx.add(createCloseAccountInstruction(
        acct.pubkey, kp.publicKey, kp.publicKey, [], new PublicKey(acct.account.owner)
      ));
      console.log(`Closing empty: ${acct.pubkey.toBase58().slice(0, 12)}... (mint=${info.mint.slice(0, 8)})`);
    }
  }

  // Transfer USDC to main wallet
  const botUsdcAta = await getAssociatedTokenAddress(USDC_MINT, kp.publicKey);
  const mainUsdcAta = await getAssociatedTokenAddress(USDC_MINT, MAIN_WALLET);

  const botUsdcInfo = await conn.getAccountInfo(botUsdcAta);
  if (botUsdcInfo) {
    const usdcBal = await conn.getTokenAccountBalance(botUsdcAta);
    const amount = BigInt(usdcBal.value.amount);

    if (amount > 0n) {
      // Ensure main wallet has USDC ATA
      const mainAtaInfo = await conn.getAccountInfo(mainUsdcAta);
      if (mainAtaInfo === null) {
        console.log("Creating USDC ATA for main wallet...");
        tx.add(createAssociatedTokenAccountInstruction(kp.publicKey, mainUsdcAta, MAIN_WALLET, USDC_MINT));
      }

      tx.add(createTransferInstruction(botUsdcAta, mainUsdcAta, kp.publicKey, amount));
      console.log(`Transferring ${usdcBal.value.uiAmountString} USDC to main wallet`);

      // Close USDC ATA after transfer
      tx.add(createCloseAccountInstruction(botUsdcAta, kp.publicKey, kp.publicKey));
      console.log("Closing USDC ATA after transfer");
    }
  }

  if (tx.instructions.length > 0) {
    const { blockhash } = await conn.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = kp.publicKey;
    tx.sign(kp);
    const sig = await conn.sendRawTransaction(tx.serialize());
    console.log(`\nToken tx: ${sig}`);
    await conn.confirmTransaction(sig, "confirmed");
    console.log("CONFIRMED!");
  }

  // Transfer remaining SOL
  const solBal = await conn.getBalance(kp.publicKey);
  const fee = 5000;
  const solToSend = solBal - fee;

  if (solToSend > 0) {
    console.log(`\nTransferring ${(solToSend / LAMPORTS_PER_SOL).toFixed(6)} SOL to main wallet...`);
    const solTx = new Transaction().add(
      SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: MAIN_WALLET, lamports: solToSend })
    );
    const { blockhash: bh2 } = await conn.getLatestBlockhash();
    solTx.recentBlockhash = bh2;
    solTx.feePayer = kp.publicKey;
    solTx.sign(kp);
    const sig2 = await conn.sendRawTransaction(solTx.serialize());
    console.log(`SOL tx: ${sig2}`);
    await conn.confirmTransaction(sig2, "confirmed");
    console.log("CONFIRMED!");
  }

  // Final balances
  const finalBot = await conn.getBalance(kp.publicKey);
  const finalMain = await conn.getBalance(MAIN_WALLET);
  const mainUsdcBal = await conn.getTokenAccountBalance(mainUsdcAta).catch(() => null);

  console.log(`\n=== FINAL BALANCES ===`);
  console.log(`Bot wallet:  ${(finalBot / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
  console.log(`Main wallet: ${(finalMain / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
  console.log(`Main USDC:   ${mainUsdcBal?.value.uiAmountString || "0"} USDC`);
}

main().catch((err) => {
  console.error("ERROR:", err);
  process.exit(1);
});
