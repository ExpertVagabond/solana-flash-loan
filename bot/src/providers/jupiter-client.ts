import {
  PublicKey,
  TransactionInstruction,
  AddressLookupTableAccount,
  Connection,
} from "@solana/web3.js";
import type pino from "pino";

const JUPITER_API_BASE = "https://lite-api.jup.ag/swap/v1";

// --- Types ---

export interface JupiterQuote {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: Array<{
    swapInfo: {
      ammKey: string;
      label: string;
      inputMint: string;
      outputMint: string;
      inAmount: string;
      outAmount: string;
      feeAmount: string;
      feeMint: string;
    };
    percent: number;
  }>;
}

interface RawInstruction {
  programId: string;
  accounts: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
  data: string; // base64
}

export interface SwapInstructionsResponse {
  tokenLedgerInstruction?: RawInstruction;
  computeBudgetInstructions: RawInstruction[];
  setupInstructions: RawInstruction[];
  swapInstruction: RawInstruction;
  cleanupInstruction?: RawInstruction;
  addressLookupTableAddresses: string[];
}

export interface DeserializedSwapInstructions {
  setupInstructions: TransactionInstruction[];
  swapInstruction: TransactionInstruction;
  cleanupInstruction: TransactionInstruction | null;
  addressLookupTableAddresses: string[];
}

// --- Helpers ---

function deserializeInstruction(raw: RawInstruction): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(raw.programId),
    keys: raw.accounts.map((a) => ({
      pubkey: new PublicKey(a.pubkey),
      isSigner: a.isSigner,
      isWritable: a.isWritable,
    })),
    data: Buffer.from(raw.data, "base64"),
  });
}

// --- Client ---

export class JupiterClient {
  private logger: pino.Logger;
  private retryDelayMs = 1000;
  private maxRetries = 3;

  constructor(logger: pino.Logger) {
    this.logger = logger;
  }

  async getQuote(
    inputMint: string,
    outputMint: string,
    amount: string,
    slippageBps: number,
    onlyDirectRoutes = false
  ): Promise<JupiterQuote> {
    const params = new URLSearchParams({
      inputMint,
      outputMint,
      amount,
      slippageBps: slippageBps.toString(),
      ...(onlyDirectRoutes ? { onlyDirectRoutes: "true" } : {}),
      maxAccounts: "40", // keep transaction size manageable
    });

    const url = `${JUPITER_API_BASE}/quote?${params}`;
    const data = await this.fetchWithRetry(url, { method: "GET" });

    if (!data.outAmount) {
      throw new Error(`Jupiter quote failed: ${JSON.stringify(data)}`);
    }

    this.logger.debug(
      {
        inputMint: inputMint.slice(0, 8),
        outputMint: outputMint.slice(0, 8),
        inAmount: amount,
        outAmount: data.outAmount,
        priceImpact: data.priceImpactPct,
        routes: data.routePlan?.length ?? 0,
      },
      "Jupiter quote"
    );

    return data as JupiterQuote;
  }

  async getSwapInstructions(
    quote: JupiterQuote,
    userPublicKey: PublicKey
  ): Promise<DeserializedSwapInstructions> {
    const url = `${JUPITER_API_BASE}/swap-instructions`;
    const body = {
      quoteResponse: quote,
      userPublicKey: userPublicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 0, // we set our own compute budget
    };

    const data: SwapInstructionsResponse = await this.fetchWithRetry(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!data.swapInstruction) {
      throw new Error(
        `Jupiter swap-instructions failed: ${JSON.stringify(data)}`
      );
    }

    return {
      setupInstructions: (data.setupInstructions || []).map(
        deserializeInstruction
      ),
      swapInstruction: deserializeInstruction(data.swapInstruction),
      cleanupInstruction: data.cleanupInstruction
        ? deserializeInstruction(data.cleanupInstruction)
        : null,
      addressLookupTableAddresses: data.addressLookupTableAddresses || [],
    };
  }

  async loadAddressLookupTables(
    connection: Connection,
    addresses: string[]
  ): Promise<AddressLookupTableAccount[]> {
    const unique = [...new Set(addresses)];
    if (unique.length === 0) return [];

    const tables: AddressLookupTableAccount[] = [];
    // Batch in groups of 10 to avoid RPC limits
    for (let i = 0; i < unique.length; i += 10) {
      const batch = unique.slice(i, i + 10);
      const results = await Promise.all(
        batch.map(async (addr) => {
          const result = await connection.getAddressLookupTable(
            new PublicKey(addr)
          );
          return result.value;
        })
      );
      for (const table of results) {
        if (table) tables.push(table);
      }
    }

    this.logger.debug(
      { requested: unique.length, loaded: tables.length },
      "Loaded ALTs"
    );
    return tables;
  }

  private async fetchWithRetry(
    url: string,
    init: RequestInit
  ): Promise<any> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const res = await fetch(url, init);

        if (res.status === 429) {
          const delay = this.retryDelayMs * 2 ** attempt;
          this.logger.warn(
            { attempt, delayMs: delay },
            "Jupiter rate limited, backing off"
          );
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }

        if (!res.ok) {
          const text = await res.text();
          throw new Error(`Jupiter API ${res.status}: ${text}`);
        }

        return await res.json();
      } catch (err) {
        lastError = err as Error;
        if (attempt < this.maxRetries) {
          const delay = this.retryDelayMs * 2 ** attempt;
          this.logger.warn(
            { attempt, error: lastError.message, delayMs: delay },
            "Jupiter request failed, retrying"
          );
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }

    throw lastError ?? new Error("Jupiter request failed after retries");
  }
}
