import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

export interface BotConfig {
  rpcUrl: string;
  wsUrl?: string;
  walletPath: string;
  flashLoanProgramId: string;
  flashLoanTokenMint: string;
  borrowAmount: bigint;
  pairs: string[];
  minProfitBps: number;
  maxSlippageBps: number;
  pollIntervalMs: number;
  dryRun: boolean;
  priorityFeeMicroLamports: number;
  computeUnitLimit: number;
  maxConsecutiveFailures: number;
  verbose: boolean;
  // Jito bundle support
  useJito: boolean;
  jitoRegion: string;
  jitoTipLamports: number;
}

export function loadConfig(cliOpts: Record<string, any>): BotConfig {
  const env = process.env;

  const rpcUrl = cliOpts.rpc || env.RPC_URL;
  if (!rpcUrl) {
    throw new Error("RPC_URL is required. Set via --rpc or RPC_URL env var.");
  }

  const pairsRaw = cliOpts.pairs || env.PAIRS?.split(",") || ["SOL/USDC"];
  const pairs = Array.isArray(pairsRaw) ? pairsRaw : [pairsRaw];

  return {
    rpcUrl,
    wsUrl: env.WS_URL,
    walletPath: cliOpts.wallet || env.WALLET_PATH || "~/.config/solana/id.json",
    flashLoanProgramId:
      cliOpts.programId ||
      env.FLASH_LOAN_PROGRAM_ID ||
      "2chVPk6DV21qWuyUA2eHAzATdFSHM7ykv1fVX7Gv6nor",
    flashLoanTokenMint:
      cliOpts.tokenMint ||
      env.FLASH_LOAN_TOKEN_MINT ||
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    borrowAmount: BigInt(
      cliOpts.borrowAmount || env.BORROW_AMOUNT || "1000000000"
    ),
    pairs,
    minProfitBps: Number(cliOpts.minProfitBps || env.MIN_PROFIT_BPS || "5"),
    maxSlippageBps: Number(cliOpts.slippage || env.MAX_SLIPPAGE_BPS || "50"),
    pollIntervalMs: Number(
      cliOpts.pollInterval || env.POLL_INTERVAL_MS || "2000"
    ),
    dryRun: cliOpts.dryRun !== undefined ? cliOpts.dryRun : (env.DRY_RUN !== undefined ? env.DRY_RUN === "true" : true),
    priorityFeeMicroLamports: Number(
      cliOpts.priorityFee || env.PRIORITY_FEE || "50000"
    ),
    computeUnitLimit: Number(
      cliOpts.computeUnitLimit || env.COMPUTE_UNIT_LIMIT || "600000"
    ),
    maxConsecutiveFailures: Number(
      env.MAX_CONSECUTIVE_FAILURES || "10"
    ),
    verbose: cliOpts.verbose ?? false,
    // Jito
    useJito: cliOpts.jito !== undefined ? cliOpts.jito : (env.USE_JITO === "true"),
    jitoRegion: cliOpts.jitoRegion || env.JITO_REGION || "default",
    jitoTipLamports: Number(cliOpts.jitoTip || env.JITO_TIP_LAMPORTS || "10000"),
  };
}
