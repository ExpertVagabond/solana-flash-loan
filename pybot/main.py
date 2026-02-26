#!/usr/bin/env python3
"""Solana Flash Loan Arbitrage Bot — Python edition.

Full-stack Python: scanning, transaction building, and execution.
Uses curl_cffi for Raydium, httpx+Jupiter API key for quotes and swap instructions.
Executes via Jito block engine or standard RPC.
"""

import asyncio
import signal
import sys
import time
from pathlib import Path

from loguru import logger
from solders.pubkey import Pubkey
from solana.rpc.async_api import AsyncClient
from solana.rpc.commitment import Confirmed

from config import load_config, BotConfig
from wallet import load_keypair
from quote_provider import QuoteProvider
from scanner import PairScanner
from flash_loan_client import FlashLoanClient, TOKEN_PROGRAM_ID
from jito_client import JitoClient
from tx_builder import build_arb_transaction, simulate_transaction

# ── Constants ──

ASSOCIATED_TOKEN_PROGRAM_ID = Pubkey.from_string(
    "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
)

# ── Logging setup ──

logger.remove()  # Remove default handler
logger.add(
    sys.stderr,
    format="<green>{time:HH:mm:ss}</green> | <level>{level:7s}</level> | {message}",
    level="DEBUG" if "--verbose" in sys.argv else "INFO",
    colorize=True,
)


def get_associated_token_address(wallet: Pubkey, mint: Pubkey) -> Pubkey:
    """Derive the associated token address (ATA) for a wallet + mint."""
    ata, _ = Pubkey.find_program_address(
        [bytes(wallet), bytes(TOKEN_PROGRAM_ID), bytes(mint)],
        ASSOCIATED_TOKEN_PROGRAM_ID,
    )
    return ata


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
            f"sim_fail={self.simulation_failures} exec_fail={self.execution_failures} "
            f"ray_quotes={self.raydium_quotes} jup_quotes={self.jupiter_quotes}"
        )


# ── Engine ──

class ArbitrageEngine:
    def __init__(self, config: BotConfig):
        self.config = config
        self.running = False
        self.consecutive_failures = 0
        self.metrics = Metrics()

        # Core providers
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

        # Execution stack (initialized in start())
        self.rpc: AsyncClient | None = None
        self.borrower = None
        self.borrower_pk = None
        self.borrower_usdc_ata = None
        self.flash_loan: FlashLoanClient | None = None
        self.jito: JitoClient | None = None

    async def start(self):
        self.running = True
        logger.info("=== Solana Flash Loan Arbitrage Bot (Python) ===")
        logger.info(f"Pairs: {len(self.config.pairs)} | Borrow: {self.config.borrow_amount} | "
                     f"MinProfit: {self.config.min_profit_bps} bps | DryRun: {self.config.dry_run}")
        logger.info(f"Jito: {self.config.use_jito} | Raydium: {self.config.use_raydium} | "
                     f"Jupiter key: {'yes' if self.config.jupiter_api_key else 'NO'}")

        # 1. Load wallet
        self.borrower = load_keypair(self.config.wallet_path)
        self.borrower_pk = self.borrower.pubkey()
        logger.info(f"Wallet: {self.borrower_pk}")

        # 2. Connect to Solana RPC
        self.rpc = AsyncClient(self.config.rpc_url, commitment="confirmed")
        bal_resp = await self.rpc.get_balance(self.borrower_pk)
        sol_balance = bal_resp.value / 1e9
        logger.info(f"SOL balance: {sol_balance:.4f}")

        # 3. Derive borrower's USDC ATA
        usdc_mint = Pubkey.from_string(self.config.flash_loan_token_mint)
        self.borrower_usdc_ata = get_associated_token_address(self.borrower_pk, usdc_mint)
        logger.info(f"USDC ATA: {self.borrower_usdc_ata}")

        # 4. Initialize flash loan client
        self.flash_loan = FlashLoanClient(
            rpc=self.rpc,
            program_id=self.config.flash_loan_program_id,
            token_mint=self.config.flash_loan_token_mint,
        )

        # Fetch pool state to verify deployment and get fee
        try:
            pool_state = await self.flash_loan.get_pool_state()
            fee_bps = pool_state["fee_bps"]
            self.scanner.pool_fee_bps = fee_bps
            logger.info(
                f"Flash loan pool: {pool_state['total_deposits'] / 1e6:.2f} USDC, "
                f"fee={fee_bps} bps, active={pool_state['is_active']}"
            )
        except Exception as e:
            logger.warning(f"Could not fetch pool state: {e}")

        # 5. Initialize Jito client (optional)
        if self.config.use_jito:
            self.jito = JitoClient(region=self.config.jito_region)
            logger.info(f"Jito: {self.jito.endpoint}")

        # Test quote connectivity
        await self._test_raydium()

        # Metrics printer
        metrics_task = asyncio.create_task(self._metrics_loop())

        try:
            await self._scan_loop()
        finally:
            metrics_task.cancel()
            await self.quote_provider.close()
            if self.jito:
                await self.jito.close()
            if self.rpc:
                await self.rpc.close()
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
        """Build, simulate, and send an arbitrage transaction."""
        # Use dynamic fees from the opportunity (scaled to profit margin)
        cu_price = opp.dynamic_cu_price or self.config.priority_fee_micro_lamports
        tip_lamports = opp.dynamic_tip_lamports or self.config.jito_tip_lamports

        logger.info(
            f"EXECUTING {opp.pair}: {opp.profit_bps:+d} bps, "
            f"borrow={opp.borrow_amount / 1e6:.0f} USDC, "
            f"expected_profit={opp.expected_profit / 1e6:.4f} USDC, "
            f"cu_price={cu_price}, tip={tip_lamports}"
        )

        try:
            # Build Jito tip instruction (only paid on tx success)
            jito_tip_ix = None
            if self.jito and self.config.use_jito:
                jito_tip_ix = self.jito.build_tip_instruction(
                    self.borrower_pk, tip_lamports
                )

            # Build atomic arb transaction
            tx, blockhash, last_valid = await build_arb_transaction(
                rpc=self.rpc,
                borrower=self.borrower,
                borrower_token_account_a=self.borrower_usdc_ata,
                flash_loan=self.flash_loan,
                quote_provider=self.quote_provider,
                opportunity=opp,
                slippage_bps=self.config.max_slippage_bps,
                compute_unit_price=cu_price,
                compute_unit_limit=self.config.compute_unit_limit,
                jito_tip_ix=jito_tip_ix,
            )

            # Simulate first
            success, logs, units = await simulate_transaction(self.rpc, tx)

            if not success:
                self.metrics.simulation_failures += 1
                logger.warning(f"Simulation FAILED for {opp.pair}, skipping")
                return

            logger.info(f"Simulation OK: {units} CU used")

            # Send transaction
            sig = ""
            if self.jito and self.config.use_jito:
                sig = await self.jito.send_transaction(tx)
            else:
                resp = await self.rpc.send_transaction(tx)
                sig = str(resp.value)

            logger.info(f"TX SENT: {sig} | {opp.pair} {opp.profit_bps:+d} bps")

            # Confirm transaction
            confirmed = await self._confirm_transaction(sig, last_valid)
            if confirmed:
                self.metrics.successful_arbs += 1
                self.metrics.total_profit += opp.expected_profit
                logger.info(
                    f"TX CONFIRMED: {sig} | profit ~{opp.expected_profit / 1e6:.4f} USDC"
                )
            else:
                self.metrics.execution_failures += 1
                logger.warning(f"TX EXPIRED/FAILED: {sig}")

        except Exception as e:
            self.metrics.execution_failures += 1
            logger.error(f"Execution failed for {opp.pair}: {e}")

    async def _confirm_transaction(self, sig: str, last_valid_block_height: int) -> bool:
        """Poll for transaction confirmation until confirmed or blockhash expires."""
        from solders.signature import Signature

        signature = Signature.from_string(sig)
        poll_interval = 2.0  # seconds
        max_polls = 30  # ~60 seconds max

        for _ in range(max_polls):
            try:
                resp = await self.rpc.get_signature_statuses([signature])
                statuses = resp.value
                if statuses and statuses[0]:
                    status = statuses[0]
                    if status.err:
                        logger.warning(f"TX failed on-chain: {status.err}")
                        return False
                    if status.confirmation_status and str(status.confirmation_status) in (
                        "confirmed", "finalized"
                    ):
                        return True

                # Check if blockhash has expired
                height_resp = await self.rpc.get_block_height()
                if height_resp.value > last_valid_block_height:
                    logger.warning("Blockhash expired before confirmation")
                    return False

            except Exception as e:
                logger.debug(f"Confirm poll error: {e}")

            await asyncio.sleep(poll_interval)

        logger.warning("Confirmation timed out")
        return False

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
