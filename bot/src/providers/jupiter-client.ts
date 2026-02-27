import {
  PublicKey,
  TransactionInstruction,
  AddressLookupTableAccount,
  Connection,
} from "@solana/web3.js";
import type pino from "pino";
import { RateLimiter } from "../utils/rate-limiter";

// Jupiter API — requires API key (Basic tier: 1 RPS free, Pro: 10+ RPS)
const JUPITER_API_BASE = "https://api.jup.ag/swap/v1";
// Raydium API for quotes (generous limits, used for scanning)
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
  private raydiumCooldownMs = 120_000; // 2min cooldown after rate limit
  // Jupiter API key (Basic tier: 600 req/min)
  private jupiterApiKey: string | null;
  // Global rate limiter shared across all Jupiter calls
  // With API key: 600/min = 10/sec. Use 8/sec with burst of 10 for safety.
  public rateLimiter: RateLimiter;
  // Quote cache — avoid duplicate API calls for same pair within TTL
  private quoteCache: Map<string, { quote: JupiterQuote; ts: number }> = new Map();
  private quoteCacheTtlMs = 5_000; // 5 second TTL

  constructor(logger: pino.Logger, useRaydiumForQuotes = true, jupiterApiKey?: string) {
    this.logger = logger;
    this.useRaydiumForQuotes = useRaydiumForQuotes;
    this.jupiterApiKey = jupiterApiKey ?? null;
    // Jupiter API key Basic tier: ~2 RPS sustained. Without key: ~1 RPS.
    const rps = this.jupiterApiKey ? 2 : 0.8;
    this.rateLimiter = new RateLimiter(3, rps);
    if (this.jupiterApiKey) {
      this.logger.info("Jupiter API key configured");
    } else {
      this.logger.warn("No Jupiter API key — swap instructions will fail. Get one at jup.ag/api");
    }
  }

  /**
   * Get a quote — tries Raydium first (no rate limit), falls back to Jupiter.
   * Raydium does NOT use the rate limiter (it's a separate API with generous limits).
   * Jupiter fallback uses rate limiter to stay under 1 req/sec free tier.
   * Raydium auto-pauses for 60s after a rate limit hit.
   */
  async getQuote(
    inputMint: string,
    outputMint: string,
    amount: string,
    slippageBps: number,
    onlyDirectRoutes = false
  ): Promise<JupiterQuote> {
    // Check cache first — same pair+amount within TTL reuses quote
    const cacheKey = `${inputMint}:${outputMint}:${amount}`;
    const cached = this.quoteCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < this.quoteCacheTtlMs) {
      return cached.quote;
    }

    // Evict stale entries periodically
    if (this.quoteCache.size > 200) {
      const now = Date.now();
      for (const [k, v] of this.quoteCache) {
        if (now - v.ts > this.quoteCacheTtlMs) this.quoteCache.delete(k);
      }
    }

    // Try Raydium first (skip if cooling down from rate limit)
    if (this.useRaydiumForQuotes && Date.now() > this.raydiumCooldownUntil) {
      try {
        const quote = await this.getRaydiumQuote(inputMint, outputMint, amount, slippageBps);
        this.quoteCache.set(cacheKey, { quote, ts: Date.now() });
        return quote;
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

    const quote = await this.getJupiterQuote(inputMint, outputMint, amount, slippageBps, onlyDirectRoutes);
    this.quoteCache.set(cacheKey, { quote, ts: Date.now() });
    return quote;
  }

  /** Raydium quote — generous rate limit, returns data mapped to JupiterQuote shape */
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
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    let res: Response;
    try {
      res = await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
          "Accept": "application/json",
        },
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      this.logger.debug(
        { status: res.status, body: text.slice(0, 200), url: url.slice(0, 80) },
        "Raydium HTTP error"
      );
      throw new Error(`Raydium ${res.status}: ${text.slice(0, 200)}`);
    }

    const json: any = await res.json();
    if (!json.success || !json.data) {
      throw new Error(`Raydium quote failed: ${JSON.stringify(json).slice(0, 200)}`);
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
      maxAccounts: onlyDirectRoutes ? "20" : "40",
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
    userPublicKey: PublicKey,
    wrapAndUnwrapSol = true
  ): Promise<DeserializedSwapInstructions> {
    const url = `${JUPITER_API_BASE}/swap-instructions`;
    const body = {
      quoteResponse: quote,
      userPublicKey: userPublicKey.toBase58(),
      wrapAndUnwrapSol,
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

      // Inject Jupiter API key if available
      const headers = { ...(init.headers as Record<string, string> || {}) };
      if (this.jupiterApiKey) {
        headers["x-api-key"] = this.jupiterApiKey;
      }

      try {
        const res = await fetch(url, {
          ...init,
          headers,
          signal: controller.signal,
        });

        if (res.status === 429) {
          const delay = this.retryDelayMs * 2 ** attempt;
          // Drain rate limiter tokens to force slowdown across all callers
          this.rateLimiter.drain();
          this.logger.warn(
            { attempt, delayMs: delay },
            "Rate limited, backing off"
          );
          clearTimeout(timeout);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }

        if (!res.ok) {
          const text = await res.text();
          clearTimeout(timeout);
          // 4xx errors (except 429) are not retriable — fail immediately
          if (res.status >= 400 && res.status < 500) {
            throw new Error(`API ${res.status}: ${text}`);
          }
          // 5xx errors are retriable
          lastError = new Error(`API ${res.status}: ${text}`);
          if (attempt < this.maxRetries) {
            const delay = this.retryDelayMs * 2 ** attempt;
            this.logger.warn({ attempt, delayMs: delay }, "Server error, retrying");
            await new Promise((r) => setTimeout(r, delay));
          }
          continue;
        }

        clearTimeout(timeout);
        return await res.json();
      } catch (err) {
        clearTimeout(timeout);
        lastError = err as Error;
        if (lastError.name === "AbortError") {
          lastError = new Error(`Request timed out after ${timeoutMs}ms`);
        }
        // 4xx errors thrown above should propagate immediately
        if (lastError.message.startsWith("API 4")) {
          throw lastError;
        }
        if (attempt < this.maxRetries) {
          const delay = this.retryDelayMs * 2 ** attempt;
          this.logger.warn(
            { attempt, error: lastError.message, delayMs: delay },
            "Request failed, retrying"
          );
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }

    throw lastError ?? new Error("Request failed after retries");
  }
}
