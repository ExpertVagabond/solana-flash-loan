export const WELL_KNOWN_MINTS: Record<string, string> = {
  // Major
  SOL: "So11111111111111111111111111111111111111112",
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  // DeFi blue chips
  JUP: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
  RAY: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",
  ORCA: "orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE",
  PYTH: "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3",
  RENDER: "rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof",
  HNT: "hntyVP6YFm1Hg25TN9WGLqM12b8TQmcknKrdu1oxWux",
  W: "85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ",
  TNSR: "TNSRxcUxoT9xBG3de7PiJyTDYu7kskLqcpddxnEJAS6",
  JTO: "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL",
  // LSTs
  MSOL: "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",
  JITOSOL: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn",
  BSOL: "bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1",
  INF: "5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm",
  // Meme / high volume
  BONK: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
  WIF: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm",
  POPCAT: "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr",
  MEW: "MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5",
  TRUMP: "6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN",
  FARTCOIN: "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump",
  // Mid/low liquidity — wider spreads, more arb potential
  SAMO: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
  MNDE: "MNDEFzGvMt87ueuHvVU9VcTqsAP5b3fTGPsHuuPA5ey",
  STEP: "StepAscQoEioFxxWGnh2sLBDFp9d8rvKz2Yp39iDpyT",
  SHDW: "SHDWyBxihqiCj6YekG2GUr7wqKLeLAMK1gHZck9pL6y",
  DUST: "DUSTawucrTsGU8hcqRdHDCbuYhCPADMLM2VcCb8VnFnQ",
  HONEY: "4vMsoUT2BWatFweudnQM1xedRLfJgJ7hsWhs4xExJoXn",
  BLZE: "BLZEEuZUBVqFhj8adcCFPJvPVCiCyVmh3hkJMrU8KuJA",
  KMNO: "KMNo3nJsBXfcpJTVhZcXLW7RmTwTt4GVFE7suUBo9sS",
  DRIFT: "DriFtupJYLTosbwoN8koMbEYSx54aFAVLddWsbksjwg7",
  TENSOR: "TNSRxcUxoT9xBG3de7PiJyTDYu7kskLqcpddxnEJAS6",
  ZEUS: "ZEUS1aR7aX8DFFJf5QjWj2ftDDdNTroMNGo8YoQm3Gq",
  PARCL: "PARCLdS3mxo7E4mkLfUBqNb4hPMYEMkgEKpAtHm4wdv",
  WEN: "WENWENvqqNya429ubCdR81ZmD69brwQaaBYY6p3LCpk",
  BOME: "ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82",
  SLERF: "7BgBvyjrZX1YKz4oh9mjb8ZScatkkwb8DzFx7LoiVkM3",
  SILLY: "7EYnhQoR9YM3N7UoaKRoA44Uy8JeaZV3qyouov87awMs",
  AI16Z: "HeLp6NuQkmYB4pYWo2zYs22mESHXPQYzXbB8n4V98jwC",
  GRIFFAIN: "2nnGAqbWMqavCnjgAMwXnoMfuuJtRjJSqNdnYJkXkfR3",
};

export const TOKEN_DECIMALS: Record<string, number> = {
  SOL: 9,
  USDC: 6,
  USDT: 6,
  JUP: 6,
  RAY: 6,
  ORCA: 6,
  PYTH: 6,
  RENDER: 8,
  HNT: 8,
  W: 6,
  TNSR: 9,
  JTO: 9,
  MSOL: 9,
  JITOSOL: 9,
  BSOL: 9,
  INF: 9,
  BONK: 5,
  WIF: 6,
  POPCAT: 9,
  MEW: 5,
  TRUMP: 6,
  FARTCOIN: 6,
  SAMO: 9,
  MNDE: 9,
  STEP: 9,
  SHDW: 9,
  DUST: 9,
  HONEY: 9,
  BLZE: 9,
  KMNO: 6,
  DRIFT: 6,
  TENSOR: 9,
  ZEUS: 6,
  PARCL: 6,
  WEN: 5,
  BOME: 6,
  SLERF: 9,
  SILLY: 6,
  AI16Z: 9,
  GRIFFAIN: 6,
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
