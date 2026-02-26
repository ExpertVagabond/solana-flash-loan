#!/usr/bin/env python3
"""Solana Flash Loan Arbitrage Bot — Python edition.

Uses curl_cffi to bypass Cloudflare on Raydium API (unlimited free quotes).
Falls back to Jupiter API with API key for quotes and swap instructions.
"""

import asyncio
import signal
import sys
import time
from pathlib import Path

from loguru import logger

from config import load_config, BotConfig
from quote_provider import QuoteProvider
from scanner import PairScanner

# ── Logging setup ──

logger.remove()  # Remove default handler
logger.add(
    sys.stderr,
    format="<green>{time:HH:mm:ss}</green> | <level>{level:7s}</level> | {message}",
    level="DEBUG" if "--verbose" in sys.argv else "INFO",
    colorize=True,
)


# ── Metrics ──

class Metrics:
    def __init__(self):
        self.start_time = time.time()
        self.scan_cycles = 0
        self.opportunities_found = 0
        self.successful_arbs = 0
        self.simulation_failures = 0
        self.execution_failures = 0
        self.total_profit = 0
        self.raydium_quotes = 0
        self.jupiter_quotes = 0

    def summary(self) -> str:
        uptime = (time.time() - self.start_time) / 60
        rate = (
            f"{self.opportunities_found / self.scan_cycles * 100:.1f}%"
            if self.scan_cycles > 0
            else "0%"
        )
        return (
            f"uptime={uptime:.1f}m cycles={self.scan_cycles} "
            f"opps={self.opportunities_found} hit_rate={rate} "
            f"arbs={self.successful_arbs} profit={self.total_profit} "
            f"ray_quotes={self.raydium_quotes} jup_quotes={self.jupiter_quotes}"
        )


# ── Engine ──

class ArbitrageEngine:
    def __init__(self, config: BotConfig):
        self.config = config
        self.running = False
        self.consecutive_failures = 0
        self.metrics = Metrics()

        self.quote_provider = QuoteProvider(
            jupiter_api_key=config.jupiter_api_key,
            use_raydium=config.use_raydium,
        )

        self.scanner = PairScanner(
            quote_provider=self.quote_provider,
            pool_fee_bps=9,  # Default, updated in preflight
            min_profit_bps=config.min_profit_bps,
            slippage_bps=config.max_slippage_bps,
            priority_fee_micro=config.priority_fee_micro_lamports,
            compute_units=config.compute_unit_limit,
            jito_tip=config.jito_tip_lamports,
            use_jito=config.use_jito,
        )

    async def start(self):
        self.running = True
        logger.info("=== Solana Flash Loan Arbitrage Bot (Python) ===")
        logger.info(f"Pairs: {len(self.config.pairs)} | Borrow: {self.config.borrow_amount} | "
                     f"MinProfit: {self.config.min_profit_bps} bps | DryRun: {self.config.dry_run}")
        logger.info(f"Jito: {self.config.use_jito} | Raydium: {self.config.use_raydium} | "
                     f"Jupiter key: {'yes' if self.config.jupiter_api_key else 'NO'}")

        # Test Raydium connectivity
        await self._test_raydium()

        # Metrics printer
        metrics_task = asyncio.create_task(self._metrics_loop())

        try:
            await self._scan_loop()
        finally:
            metrics_task.cancel()
            await self.quote_provider.close()
            logger.info(f"FINAL METRICS: {self.metrics.summary()}")
            logger.info("Bot stopped.")

    async def _test_raydium(self):
        """Quick connectivity test for Raydium via curl_cffi."""
        try:
            q = await self.quote_provider.get_quote(
                "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",  # USDC
                "So11111111111111111111111111111111111111112",       # SOL
                200_000_000,
                50,
            )
            logger.info(f"Quote test OK: 200 USDC -> {q.out_amount / 1e9:.4f} SOL via {q.source}")
        except Exception as e:
            logger.warning(f"Quote test failed: {e}")

    async def _metrics_loop(self):
        while True:
            await asyncio.sleep(60)
            logger.info(f"METRICS: {self.metrics.summary()}")

    async def _scan_loop(self):
        # Priority pairs: scan these more frequently (tightest historical spreads)
        priority_pairs = {"SOL/USDC", "MSOL/USDC", "JITOSOL/USDC", "BSOL/USDC",
                         "JUP/USDC", "TRUMP/USDC", "ORCA/USDC", "INF/USDC"}
        cycle_count = 0

        while self.running:
            cycle_start = time.monotonic()
            self.metrics.scan_cycles += 1
            cycle_count += 1

            # Every 3rd cycle: scan all pairs. Otherwise: priority pairs only.
            if cycle_count % 3 == 0:
                pairs_to_scan = self.config.pairs
                logger.debug(f"Full scan cycle ({len(pairs_to_scan)} pairs)")
            else:
                pairs_to_scan = [p for p in self.config.pairs if p in priority_pairs]
                logger.debug(f"Priority scan cycle ({len(pairs_to_scan)} pairs)")

            try:
                for i, pair in enumerate(pairs_to_scan):
                    if not self.running:
                        break

                    # Stagger between pairs: Raydium allows ~1 req/sec sustained
                    # Each pair = 2 requests (leg1 + leg2), so 1.5s gap keeps us under
                    if i > 0:
                        await asyncio.sleep(1.5)

                    opp = await self.scanner.scan_pair(
                        pair, self.config.borrow_amount
                    )

                    if opp:
                        self.metrics.opportunities_found += 1

                        if self.config.dry_run:
                            logger.info(
                                f"DRY RUN: would execute {pair} "
                                f"{opp.profit_bps:+d} bps, profit={opp.expected_profit}"
                            )
                        else:
                            await self._execute(opp)

                self.consecutive_failures = 0

            except Exception as e:
                self.consecutive_failures += 1
                logger.error(f"Scan cycle error: {e} (consecutive={self.consecutive_failures})")

                if self.consecutive_failures >= self.config.max_consecutive_failures:
                    logger.error("KILL SWITCH: too many consecutive failures")
                    self.stop()
                    break

            # Throttle — shorter wait for priority-only cycles
            elapsed = time.monotonic() - cycle_start
            target_s = self.config.poll_interval_ms / 1000
            if cycle_count % 3 != 0:
                target_s = min(target_s, 5.0)  # Priority cycles: 5s max gap
            sleep_s = max(0, target_s - elapsed)
            if sleep_s > 0 and self.running:
                await asyncio.sleep(sleep_s)

    async def _execute(self, opp):
        """Execute an arbitrage opportunity (placeholder — needs tx building)."""
        logger.warning(
            f"EXECUTE {opp.pair}: {opp.profit_bps:+d} bps — "
            f"TX building not yet implemented in Python bot"
        )
        # TODO: Build and send transaction via solders/solana-py
        # For now, the TypeScript bot handles execution
        # This bot is optimized for fast scanning

    def stop(self):
        self.running = False


# ── Entry point ──

async def main():
    config = load_config()

    engine = ArbitrageEngine(config)

    # Graceful shutdown
    loop = asyncio.get_event_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, engine.stop)

    await engine.start()


if __name__ == "__main__":
    asyncio.run(main())
