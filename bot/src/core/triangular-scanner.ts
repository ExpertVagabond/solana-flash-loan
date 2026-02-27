import type pino from "pino";
import { JupiterClient, JupiterQuote } from "../providers/jupiter-client";
import { resolveMint } from "../utils/tokens";
import { estimateSolCostsInToken } from "./profit-calculator";

/**
 * A triangular route: borrow tokenA, swap through tokenB and tokenC, repay tokenA.
 * Flow: borrow A → swap A→B → swap B→C → swap C→A → repay A
 */
export interface TriangularRoute {
  name: string;       // e.g. "USDC→SOL→JUP→USDC"
  tokenA: string;     // mint — flash loan token (start + end)
  tokenB: string;     // mint — first intermediate
  tokenC: string;     // mint — second intermediate
  borrowAmount: bigint;
}

export interface TriangularOpportunity {
  route: TriangularRoute;
  leg1Out: bigint;    // A → B output
  leg2Out: bigint;    // B → C output
  leg3Out: bigint;    // C → A output
  flashLoanFee: bigint;
  solCostsInToken: bigint;
  expectedProfit: bigint;
  profitBps: number;
  timestamp: number;
  // Cached quotes for fast execution
  quoteLeg1: JupiterQuote;
  quoteLeg2: JupiterQuote;
  quoteLeg3: JupiterQuote;
}

// --- Route definitions ---
// Each route borrows USDC, swaps through 2 intermediate tokens, returns to USDC.
// Organized by category for clarity.

function route(name: string, a: string, b: string, c: string, borrow: bigint): TriangularRoute {
  return {
    name,
    tokenA: resolveMint(a),
    tokenB: resolveMint(b),
    tokenC: resolveMint(c),
    borrowAmount: borrow,
  };
}

// Borrow amounts tuned to liquidity depth
const FULL = 200_000_000n;   // $200 — deep liquidity paths
const MED  = 100_000_000n;   // $100 — moderate liquidity
const SMALL = 50_000_000n;   // $50  — thinner liquidity
const TINY  = 20_000_000n;   // $20  — meme/low-liq

const TRIANGULAR_ROUTES: TriangularRoute[] = [
  // === SOL hub — DeFi blue chips ===
  route("USDC→SOL→JUP→USDC",       "USDC", "SOL", "JUP",     FULL),
  route("USDC→SOL→RAY→USDC",       "USDC", "SOL", "RAY",     FULL),
  route("USDC→SOL→ORCA→USDC",      "USDC", "SOL", "ORCA",    MED),
  route("USDC→SOL→PYTH→USDC",      "USDC", "SOL", "PYTH",    MED),
  route("USDC→SOL→JTO→USDC",       "USDC", "SOL", "JTO",     MED),
  route("USDC→SOL→W→USDC",         "USDC", "SOL", "W",       MED),
  route("USDC→SOL→RENDER→USDC",    "USDC", "SOL", "RENDER",  MED),

  // === SOL hub — LST depeg arb (high opportunity) ===
  route("USDC→SOL→MSOL→USDC",      "USDC", "SOL", "MSOL",    FULL),
  route("USDC→SOL→JITOSOL→USDC",   "USDC", "SOL", "JITOSOL", FULL),
  route("USDC→SOL→BSOL→USDC",      "USDC", "SOL", "BSOL",    MED),
  route("USDC→SOL→INF→USDC",       "USDC", "SOL", "INF",     SMALL),

  // === SOL hub — meme coins (volatile, wider spreads) ===
  route("USDC→SOL→BONK→USDC",      "USDC", "SOL", "BONK",    TINY),
  route("USDC→SOL→WIF→USDC",       "USDC", "SOL", "WIF",     TINY),
  route("USDC→SOL→TRUMP→USDC",     "USDC", "SOL", "TRUMP",   TINY),
  route("USDC→SOL→FARTCOIN→USDC",  "USDC", "SOL", "FARTCOIN",TINY),
  route("USDC→SOL→POPCAT→USDC",    "USDC", "SOL", "POPCAT",  TINY),

  // === Reverse direction (catches asymmetric pricing) ===
  route("USDC→JUP→SOL→USDC",       "USDC", "JUP", "SOL",     FULL),
  route("USDC→RAY→SOL→USDC",       "USDC", "RAY", "SOL",     FULL),
  route("USDC→ORCA→SOL→USDC",      "USDC", "ORCA","SOL",     MED),
  route("USDC→MSOL→SOL→USDC",      "USDC", "MSOL","SOL",     FULL),
  route("USDC→JITOSOL→SOL→USDC",   "USDC", "JITOSOL","SOL",  FULL),

  // === Stablecoin triangles ===
  route("USDC→USDT→SOL→USDC",      "USDC", "USDT","SOL",     FULL),
  route("USDC→SOL→USDT→USDC",      "USDC", "SOL", "USDT",    FULL),

  // === Cross-token triangles (no SOL hub) ===
  route("USDC→JUP→RAY→USDC",       "USDC", "JUP", "RAY",     MED),
  route("USDC→JUP→BONK→USDC",      "USDC", "JUP", "BONK",    TINY),
  route("USDC→RAY→ORCA→USDC",      "USDC", "RAY", "ORCA",    MED),
  route("USDC→DRIFT→SOL→USDC",     "USDC", "DRIFT","SOL",    SMALL),
  route("USDC→KMNO→SOL→USDC",      "USDC", "KMNO","SOL",     SMALL),

  // === LST cross-arb (mSOL ↔ jitoSOL via SOL) ===
  route("USDC→MSOL→JITOSOL→USDC",  "USDC", "MSOL","JITOSOL", MED),
  route("USDC→JITOSOL→MSOL→USDC",  "USDC", "JITOSOL","MSOL", MED),
  route("USDC→BSOL→MSOL→USDC",     "USDC", "BSOL","MSOL",    SMALL),
];

export class TriangularScanner {
  private jupiter: JupiterClient;
  private poolFeeBps: number;
  private minProfitBps: number;
  private slippageBps: number;
  private logger: pino.Logger;
  private priorityFeeMicroLamports: number;
  private computeUnitLimit: number;
  private jitoTipLamports: number;
  private useJito: boolean;

  // Rotate which routes to scan each cycle (avoid scanning all 30+ every time)
  private routeOffset = 0;
  private routesPerCycle = 10;

  constructor(
    jupiter: JupiterClient,
    poolFeeBps: number,
    minProfitBps: number,
    slippageBps: number,
    logger: pino.Logger,
    priorityFeeMicroLamports: number,
    computeUnitLimit: number,
    jitoTipLamports: number,
    useJito: boolean
  ) {
    this.jupiter = jupiter;
    this.poolFeeBps = poolFeeBps;
    this.minProfitBps = minProfitBps;
    this.slippageBps = slippageBps;
    this.logger = logger;
    this.priorityFeeMicroLamports = priorityFeeMicroLamports;
    this.computeUnitLimit = computeUnitLimit;
    this.jitoTipLamports = jitoTipLamports;
    this.useJito = useJito;
  }

  /** Scan a rotating batch of triangular routes. Returns first profitable opportunity. */
  async scan(): Promise<TriangularOpportunity | null> {
    const routes = TRIANGULAR_ROUTES;
    const batch = this.getNextBatch(routes);

    this.logger.debug(
      { batchSize: batch.length, offset: this.routeOffset, totalRoutes: routes.length },
      "Triangular scan batch"
    );

    for (const route of batch) {
      try {
        const opp = await this.scanRoute(route);
        if (opp) return opp; // Return first profitable opportunity
      } catch (err) {
        this.logger.debug(
          { route: route.name, error: (err as Error).message },
          "Triangular route scan failed"
        );
      }
    }

    return null;
  }

  private getNextBatch(routes: TriangularRoute[]): TriangularRoute[] {
    const start = this.routeOffset % routes.length;
    const end = Math.min(start + this.routesPerCycle, routes.length);
    const batch = routes.slice(start, end);
    // Wrap around if needed
    if (batch.length < this.routesPerCycle && start > 0) {
      batch.push(...routes.slice(0, this.routesPerCycle - batch.length));
    }
    this.routeOffset = (start + this.routesPerCycle) % routes.length;
    return batch;
  }

  private async scanRoute(route: TriangularRoute): Promise<TriangularOpportunity | null> {
    const { tokenA, tokenB, tokenC, borrowAmount } = route;

    // Use direct routes + low maxAccounts for triangular (3 swaps must fit in 1232 bytes)
    const directOnly = true;

    // Leg 1: A → B
    const quoteLeg1 = await this.jupiter.getQuote(
      tokenA, tokenB, borrowAmount.toString(), this.slippageBps, directOnly
    );
    const leg1Out = BigInt(quoteLeg1.outAmount);
    if (leg1Out === 0n) return null;

    // Leg 2: B → C
    const quoteLeg2 = await this.jupiter.getQuote(
      tokenB, tokenC, leg1Out.toString(), this.slippageBps, directOnly
    );
    const leg2Out = BigInt(quoteLeg2.outAmount);
    if (leg2Out === 0n) return null;

    // Leg 3: C → A
    const quoteLeg3 = await this.jupiter.getQuote(
      tokenC, tokenA, leg2Out.toString(), this.slippageBps, directOnly
    );
    const leg3Out = BigInt(quoteLeg3.outAmount);

    // Calculate profit
    const flashLoanFee = (borrowAmount * BigInt(this.poolFeeBps) + 9999n) / 10000n;

    const solCostsInToken = estimateSolCostsInToken(
      borrowAmount, leg1Out, tokenA, tokenB,
      this.priorityFeeMicroLamports, this.computeUnitLimit,
      this.jitoTipLamports, this.useJito
    );

    const expectedProfit = leg3Out - borrowAmount - flashLoanFee - solCostsInToken;
    const profitBps = borrowAmount > 0n
      ? Number((expectedProfit * 10000n) / borrowAmount)
      : 0;

    if (profitBps >= this.minProfitBps) {
      this.logger.info(
        {
          route: route.name,
          profitBps,
          expectedProfit: expectedProfit.toString(),
          flashLoanFee: flashLoanFee.toString(),
          solCosts: solCostsInToken.toString(),
          leg1Out: leg1Out.toString(),
          leg2Out: leg2Out.toString(),
          leg3Out: leg3Out.toString(),
          borrow: borrowAmount.toString(),
        },
        "TRIANGULAR OPPORTUNITY FOUND"
      );

      return {
        route,
        leg1Out, leg2Out, leg3Out,
        flashLoanFee, solCostsInToken,
        expectedProfit, profitBps,
        timestamp: Date.now(),
        quoteLeg1, quoteLeg2, quoteLeg3,
      };
    }

    this.logger.debug(
      { route: route.name, profitBps, threshold: this.minProfitBps },
      "Triangular below threshold"
    );
    return null;
  }

  /** Get all defined routes (for logging/debugging) */
  getRoutes(): TriangularRoute[] {
    return [...TRIANGULAR_ROUTES];
  }
}
