import { Connection } from "@solana/web3.js";

const conn = new Connection("https://mainnet.helius-rpc.com/?api-key=021dc255-a17b-47d8-b5b4-c915ee29efff");

async function main() {
  const sig = process.argv[2] || "2TwfraWwwthyQxjXKiTu8bYcD3q2AoAWtvPaWaa5KoNC4Tx7kP6fwHiSBKvBsdpJkUceriD5LMyhyw7UPQNTSzaa";
  const tx = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0 });
  if (tx === null) {
    console.log("TX not found — may not be on-chain yet or was dropped");
    return;
  }
  console.log("Error:", JSON.stringify(tx.meta?.err));
  console.log("Slot:", tx.slot);
  console.log("CU consumed:", tx.meta?.computeUnitsConsumed);
  console.log("\nLog messages:");
  const logs = tx.meta?.logMessages || [];
  for (let i = 0; i < logs.length; i++) {
    console.log(`  ${i}: ${logs[i]}`);
  }
}

main().catch(console.error);
