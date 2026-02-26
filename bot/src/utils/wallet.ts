import { Keypair } from "@solana/web3.js";
import fs from "fs";
import path from "path";

export function loadKeypair(walletPath: string): Keypair {
  const resolved = walletPath.replace(/^~/, process.env.HOME!);
  const abs = path.resolve(resolved);

  if (!fs.existsSync(abs)) {
    throw new Error(`Wallet file not found: ${abs}`);
  }

  const secret = JSON.parse(fs.readFileSync(abs, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}
