import type pino from "pino";

export interface BotMetrics {
  startTime: number;
  scanCycles: number;
  opportunitiesFound: number;
  simulationFailures: number;
  executionFailures: number;
  successfulArbs: number;
  totalProfitLamports: bigint;
  totalGasSpentLamports: bigint;
}

export function createMetrics(): BotMetrics {
  return {
    startTime: Date.now(),
    scanCycles: 0,
    opportunitiesFound: 0,
    simulationFailures: 0,
    executionFailures: 0,
    successfulArbs: 0,
    totalProfitLamports: 0n,
    totalGasSpentLamports: 0n,
  };
}

export function printMetricsSummary(metrics: BotMetrics, logger: pino.Logger): void {
  const uptimeMs = Date.now() - metrics.startTime;
  const uptimeMin = (uptimeMs / 60_000).toFixed(1);
  const hitRate =
    metrics.scanCycles > 0
      ? ((metrics.opportunitiesFound / metrics.scanCycles) * 100).toFixed(2)
      : "0.00";

  logger.info(
    {
      uptimeMinutes: uptimeMin,
      scanCycles: metrics.scanCycles,
      opportunitiesFound: metrics.opportunitiesFound,
      hitRate: `${hitRate}%`,
      successfulArbs: metrics.successfulArbs,
      simulationFailures: metrics.simulationFailures,
      executionFailures: metrics.executionFailures,
      totalProfit: metrics.totalProfitLamports.toString(),
      totalGasSpent: metrics.totalGasSpentLamports.toString(),
    },
    "METRICS SUMMARY"
  );
}
