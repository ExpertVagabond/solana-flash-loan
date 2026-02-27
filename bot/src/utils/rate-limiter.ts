/**
 * Token bucket rate limiter.
 * Enforces a maximum request rate across all callers.
 * Waits (non-blocking) when the bucket is empty.
 */
export class RateLimiter {
  private tokens: number;
  private maxTokens: number;
  private refillRate: number; // tokens per second
  private lastRefill: number;
  private waitQueue: Array<() => void> = [];

  /**
   * @param maxTokens Max burst capacity
   * @param refillRate Tokens added per second (e.g., 1 = 1 req/sec)
   */
  constructor(maxTokens: number, refillRate: number) {
    this.maxTokens = maxTokens;
    this.tokens = maxTokens;
    this.refillRate = refillRate;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(
      this.maxTokens,
      this.tokens + elapsed * this.refillRate
    );
    this.lastRefill = now;
  }

  /**
   * Acquire a token. Returns immediately if available,
   * otherwise waits until one becomes available.
   */
  async acquire(): Promise<void> {
    this.refill();

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }

    // Wait for next token
    const waitMs = ((1 - this.tokens) / this.refillRate) * 1000;
    return new Promise((resolve) => {
      setTimeout(() => {
        this.refill();
        this.tokens = Math.max(0, this.tokens - 1);
        resolve();
      }, Math.ceil(waitMs));
    });
  }

  /** Check how many tokens are available without consuming. */
  available(): number {
    this.refill();
    return Math.floor(this.tokens);
  }

  /** Drain all tokens — forces subsequent callers to wait for refill. */
  drain(): void {
    this.tokens = 0;
    this.lastRefill = Date.now();
  }
}
