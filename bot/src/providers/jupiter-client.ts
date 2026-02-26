import {
  PublicKey,
  TransactionInstruction,
  AddressLookupTableAccount,
  Connection,
} from "@solana/web3.js";
import type pino from "pino";
import { RateLimiter } from "../utils/rate-limiter";

// Jupiter lite API for swap instructions (used only during execution)
const JUPITER_API_BASE = "https://lite-api.jup.ag/swap/v1";
// Raydium API for quotes (no rate limit, used during scanning)
const RAYDIUM_API_BASE = "https://transaction-v1.raydium.io";

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
  private retryDelayMs = 2000;
  private maxRetries = 1;
  private useRaydiumForQuotes: boolean;
  private jupiterFailCount = 0;
  // Raydium cooldown: pause after rate limit, resume after cooldown expires
  private raydiumCooldownUntil = 0;
  private raydiumCooldownMs = 60_000; // 60s cooldown after rate limit
  // Global rate limiter shared across all Jupiter calls
  // Jupiter free tier: 60 req/60s = 1 req/sec. Use 0.8/sec for safety margin.
  public rateLimiter: RateLimiter;

  constructor(logger: pino.Logger, useRaydiumForQuotes = true) {
    this.logger = logger;
    this.useRaydiumForQuotes = useRaydiumForQuotes;
    this.rateLimiter = new RateLimiter(5, 0.8); // burst of 5, sustained 0.8/sec
  }

  /**
   * Get a quote — tries Raydium first (rate-limit-free), falls back to Jupiter.
   * Raydium quotes are used for scanning; Jupiter is reserved for swap instructions.
   * Raydium auto-pauses for 60s after a rate limit hit to avoid ban escalation.
   */
  async getQuote(
    inputMint: string,
    outputMint: string,
    amount: string,
    slippageBps: number,
    onlyDirectRoutes = false
  ): Promise<JupiterQuote> {
    // Try Raydium first (skip if cooling down from rate limit)
    if (this.useRaydiumForQuotes && Date.now() > this.raydiumCooldownUntil) {
      try {
        return await this.getRaydiumQuote(inputMint, outputMint, amount, slippageBps);
      } catch (err) {
        const msg = (err as Error).message;
        // If rate-limited, activate cooldown
        if (msg.includes("429") || msg.includes("1015")) {
          this.raydiumCooldownUntil = Date.now() + this.raydiumCooldownMs;
          this.logger.warn(
            { cooldownMs: this.raydiumCooldownMs },
            "Raydium rate-limited — cooling down, using Jupiter only"
          );
        } else {
          this.logger.debug({ error: msg }, "Raydium quote failed, falling back to Jupiter");
        }
      }
    }

    return this.getJupiterQuote(inputMint, outputMint, amount, slippageBps, onlyDirectRoutes);
  }

  /** Raydium quote — no rate limit, returns data mapped to JupiterQuote shape */
  private async getRaydiumQuote(
    inputMint: string,
    outputMint: string,
    amount: string,
    slippageBps: number
  ): Promise<JupiterQuote> {
    const params = new URLSearchParams({
      inputMint,
      outputMint,
      amount,
      slippageBps: slippageBps.toString(),
      txVersion: "V0",
    });

    const url = `${RAYDIUM_API_BASE}/compute/swap-base-in?${params}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Raydium ${res.status}: ${await res.text()}`);

    const json: any = await res.json();
    if (!json.success || !json.data) {
      throw new Error(`Raydium quote failed: ${JSON.stringify(json)}`);
    }

    const d = json.data;

    this.logger.debug(
      {
        inputMint: inputMint.slice(0, 8),
        outputMint: outputMint.slice(0, 8),
        inAmount: d.inputAmount,
        outAmount: d.outputAmount,
        priceImpact: d.priceImpactPct?.toString() ?? "0",
        routes: d.routePlan?.length ?? 0,
        via: "raydium",
      },
      "Quote"
    );

    // Map to JupiterQuote shape for compatibility
    return {
      inputMint: d.inputMint,
      inAmount: d.inputAmount,
      outputMint: d.outputMint,
      outAmount: d.outputAmount,
      otherAmountThreshold: d.otherAmountThreshold,
      swapMode: "ExactIn",
      slippageBps,
      priceImpactPct: d.priceImpactPct?.toString() ?? "0",
      routePlan: (d.routePlan || []).map((r: any) => ({
        swapInfo: {
          ammKey: r.poolId || "",
          label: "raydium",
          inputMint: r.inputMint || inputMint,
          outputMint: r.outputMint || outputMint,
          inAmount: amount,
          outAmount: d.outputAmount,
          feeAmount: "0",
          feeMint: inputMint,
        },
        percent: 100,
      })),
    };
  }

  /** Original Jupiter quote */
  private async getJupiterQuote(
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
      maxAccounts: "40",
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
        via: "jupiter",
      },
      "Quote"
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

  /** Fetch with timeout (W-07), rate limiter, retry on 429, and exponential backoff. */
  private async fetchWithRetry(
    url: string,
    init: RequestInit,
    timeoutMs: number = 8000
  ): Promise<any> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      // Wait for rate limiter token before making request
      await this.rateLimiter.acquire();

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const res = await fetch(url, {
          ...init,
          signal: controller.signal,
        });

        if (res.status === 429) {
          const delay = this.retryDelayMs * 2 ** attempt;
          this.logger.warn(
            { attempt, delayMs: delay },
            "Rate limited, backing off"
          );
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }

        if (!res.ok) {
          const text = await res.text();
          throw new Error(`API ${res.status}: ${text}`);
        }

        return await res.json();
      } catch (err) {
        lastError = err as Error;
        if (lastError.name === "AbortError") {
          lastError = new Error(`Request timed out after ${timeoutMs}ms`);
        }
        if (attempt < this.maxRetries) {
          const delay = this.retryDelayMs * 2 ** attempt;
          this.logger.warn(
            { attempt, error: lastError.message, delayMs: delay },
            "Request failed, retrying"
          );
          await new Promise((r) => setTimeout(r, delay));
        }
      } finally {
        clearTimeout(timeout);
      }
    }

    throw lastError ?? new Error("Request failed after retries");
  }
}
