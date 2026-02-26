export const WELL_KNOWN_MINTS: Record<string, string> = {
  SOL: "So11111111111111111111111111111111111111112",
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  BONK: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
  JUP: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
  RAY: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",
  ORCA: "orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE",
  MSOL: "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",
  JITOSOL: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn",
  WIF: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm",
  PYTH: "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3",
};

export const TOKEN_DECIMALS: Record<string, number> = {
  SOL: 9,
  USDC: 6,
  USDT: 6,
  BONK: 5,
  JUP: 6,
  RAY: 6,
  ORCA: 6,
  MSOL: 9,
  JITOSOL: 9,
  WIF: 6,
  PYTH: 6,
};

export function resolveMint(symbolOrMint: string): string {
  return WELL_KNOWN_MINTS[symbolOrMint.toUpperCase()] ?? symbolOrMint;
}

export function resolveDecimals(symbolOrMint: string): number {
  const upper = symbolOrMint.toUpperCase();
  if (TOKEN_DECIMALS[upper]) return TOKEN_DECIMALS[upper];
  // Default to 6 for unknown tokens
  return 6;
}

export function parsePair(pair: string): [string, string] {
  const [a, b] = pair.split("/");
  if (!a || !b) throw new Error(`Invalid pair format: ${pair}. Expected "TOKEN_A/TOKEN_B"`);
  return [resolveMint(a), resolveMint(b)];
}

export function formatTokenAmount(amount: bigint, decimals: number): string {
  const whole = amount / BigInt(10 ** decimals);
  const frac = amount % BigInt(10 ** decimals);
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return fracStr ? `${whole}.${fracStr}` : whole.toString();
}
