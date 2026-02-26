import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  VersionedTransaction,
} from "@solana/web3.js";
import type pino from "pino";
import bs58 from "bs58";

// Jito tip accounts — pick one at random to reduce contention
const JITO_TIP_ACCOUNTS = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
];

/** Jito block engine endpoints by region */
export const JITO_ENDPOINTS = {
  default: "https://mainnet.block-engine.jito.wtf",
  ny: "https://ny.mainnet.block-engine.jito.wtf",
  amsterdam: "https://amsterdam.mainnet.block-engine.jito.wtf",
  frankfurt: "https://frankfurt.mainnet.block-engine.jito.wtf",
  tokyo: "https://tokyo.mainnet.block-engine.jito.wtf",
  slc: "https://slc.mainnet.block-engine.jito.wtf",
} as const;

export type JitoRegion = keyof typeof JITO_ENDPOINTS;

export interface JitoBundleResult {
  bundleId: string;
}

export interface JitoBundleStatus {
  bundleId: string;
  status: "Invalid" | "Pending" | "Failed" | "Landed";
  landedSlot?: number;
  err?: unknown;
}

export class JitoClient {
  private endpoint: string;
  private logger: pino.Logger;

  constructor(region: JitoRegion, logger: pino.Logger) {
    this.endpoint = JITO_ENDPOINTS[region];
    this.logger = logger;
    this.logger.info(
      { endpoint: this.endpoint, region },
      "Jito client initialized"
    );
  }

  /** Get a random tip account to distribute load */
  getRandomTipAccount(): PublicKey {
    const idx = Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length);
    return new PublicKey(JITO_TIP_ACCOUNTS[idx]);
  }

  /** Build a tip instruction (SOL transfer to Jito tip account) */
  buildTipInstruction(
    payer: PublicKey,
    tipLamports: number
  ): TransactionInstruction {
    const tipAccount = this.getRandomTipAccount();
    this.logger.debug(
      { tipAccount: tipAccount.toBase58(), tipLamports },
      "Jito tip target"
    );
    return SystemProgram.transfer({
      fromPubkey: payer,
      toPubkey: tipAccount,
      lamports: tipLamports,
    });
  }

  /**
   * Send a single transaction via Jito's sendTransaction endpoint.
   * Simpler than a full bundle when you only have one transaction.
   */
  async sendTransaction(tx: VersionedTransaction): Promise<string> {
    const serialized = bs58.encode(tx.serialize());

    const res = await fetch(`${this.endpoint}/api/v1/transactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "sendTransaction",
        params: [serialized, { encoding: "base58" }],
      }),
    });

    const json = await res.json() as { result?: string; error?: { code: number; message: string } };
    if (json.error) {
      throw new Error(`Jito sendTransaction failed: ${json.error.message}`);
    }

    this.logger.info(
      { signature: json.result },
      "Transaction sent via Jito"
    );
    return json.result!;
  }

  /**
   * Send a bundle of transactions (up to 5) to Jito block engine.
   * Transactions execute atomically in the order provided.
   * The last transaction MUST include a tip to a Jito tip account.
   */
  async sendBundle(
    transactions: VersionedTransaction[]
  ): Promise<JitoBundleResult> {
    if (transactions.length === 0 || transactions.length > 5) {
      throw new Error(
        `Bundle must contain 1-5 transactions, got ${transactions.length}`
      );
    }

    const serialized = transactions.map((tx) => bs58.encode(tx.serialize()));

    const res = await fetch(`${this.endpoint}/api/v1/bundles`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "sendBundle",
        params: [serialized],
      }),
    });

    const json = await res.json() as { result?: string; error?: { code: number; message: string } };
    if (json.error) {
      throw new Error(`Jito sendBundle failed: ${json.error.message}`);
    }

    const bundleId = json.result!;
    this.logger.info(
      { bundleId, txCount: transactions.length },
      "Bundle sent to Jito"
    );

    return { bundleId };
  }

  /** Check the status of a previously submitted bundle */
  async getBundleStatus(bundleId: string): Promise<JitoBundleStatus> {
    const res = await fetch(`${this.endpoint}/api/v1/bundles`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getBundleStatuses",
        params: [[bundleId]],
      }),
    });

    const json = await res.json() as {
      result?: { value: Array<{ bundle_id: string; status: string; slot?: number; err?: unknown }> };
      error?: { code: number; message: string };
    };

    if (json.error) {
      throw new Error(
        `Jito getBundleStatuses failed: ${json.error.message}`
      );
    }

    const statuses = json.result?.value ?? [];
    if (statuses.length === 0) {
      return { bundleId, status: "Pending" };
    }

    const s = statuses[0];
    return {
      bundleId: s.bundle_id,
      status: s.status as JitoBundleStatus["status"],
      landedSlot: s.slot,
      err: s.err,
    };
  }
}
