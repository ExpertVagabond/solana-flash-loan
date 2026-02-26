"""WebSocket pool streamer — real-time monitoring of AMM pool account changes.

Subscribes to on-chain account updates via Solana WebSocket RPC.
When a pool account changes (trade happened), immediately decodes the new state
and checks for cross-DEX arbitrage opportunities.

This is 100-1000x faster than polling — we react within the same slot.
"""

import asyncio
import json
from typing import Callable, Optional

import websockets
from solders.pubkey import Pubkey
from loguru import logger

from pool_decoder import decode_pool, PoolState
from pool_registry import PoolRegistry, PoolInfo, KNOWN_PROGRAMS


class PoolStreamer:
    """Streams pool account changes via WebSocket and triggers callbacks."""

    def __init__(
        self,
        ws_url: str,
        registry: PoolRegistry,
        on_pool_update: Callable[[PoolState, PoolInfo], None],
    ):
        self.ws_url = ws_url
        self.registry = registry
        self.on_pool_update = on_pool_update
        self._ws = None
        self._subscriptions: dict[int, str] = {}  # sub_id -> pool_address
        self._pool_to_info: dict[str, PoolInfo] = {}
        self._running = False
        self._request_id = 0

    async def start(self):
        """Connect to WebSocket and subscribe to all registered pools."""
        self._running = True
        pool_count = 0

        # Collect all pool addresses to subscribe to
        for pair_pools in self.registry._pairs.values():
            for pool_info in pair_pools.pools:
                self._pool_to_info[pool_info.address] = pool_info
                pool_count += 1

        if pool_count == 0:
            logger.warning("No pools to stream — discover pools first")
            return

        logger.info(f"Starting pool streamer: {pool_count} pools on {self.ws_url}")

        while self._running:
            try:
                async with websockets.connect(
                    self.ws_url,
                    ping_interval=20,
                    ping_timeout=30,
                    max_size=10 * 1024 * 1024,  # 10MB max message
                ) as ws:
                    self._ws = ws
                    logger.info("WebSocket connected")

                    # Subscribe to all pool accounts
                    await self._subscribe_all()

                    # Process incoming messages
                    async for msg in ws:
                        if not self._running:
                            break
                        await self._handle_message(msg)

            except websockets.exceptions.ConnectionClosed as e:
                if self._running:
                    logger.warning(f"WebSocket disconnected: {e}, reconnecting in 2s...")
                    await asyncio.sleep(2)
            except Exception as e:
                if self._running:
                    logger.error(f"WebSocket error: {e}, reconnecting in 5s...")
                    await asyncio.sleep(5)

    async def stop(self):
        self._running = False
        if self._ws:
            await self._ws.close()

    async def _subscribe_all(self):
        """Subscribe to accountChange for each pool address."""
        for address, pool_info in self._pool_to_info.items():
            self._request_id += 1
            req = {
                "jsonrpc": "2.0",
                "id": self._request_id,
                "method": "accountSubscribe",
                "params": [
                    address,
                    {
                        "encoding": "base64",
                        "commitment": "confirmed",
                    },
                ],
            }
            await self._ws.send(json.dumps(req))

        logger.info(f"Subscribed to {len(self._pool_to_info)} pool accounts")

    async def _handle_message(self, raw: str):
        """Handle incoming WebSocket message."""
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            return

        # Subscription confirmation
        if "id" in msg and "result" in msg:
            sub_id = msg["result"]
            req_id = msg["id"]
            # Map subscription ID to pool address
            # We subscribed in order, so req_id maps to the address list
            addresses = list(self._pool_to_info.keys())
            idx = req_id - 1  # request IDs start at 1
            if 0 <= idx < len(addresses):
                self._subscriptions[sub_id] = addresses[idx]
            return

        # Account change notification
        if msg.get("method") == "accountNotification":
            params = msg.get("params", {})
            sub_id = params.get("subscription")
            result = params.get("result", {})
            value = result.get("value", {})
            account_data = value.get("data", [])

            pool_address = self._subscriptions.get(sub_id)
            if not pool_address:
                return

            pool_info = self._pool_to_info.get(pool_address)
            if not pool_info:
                return

            # Decode account data (base64 encoded)
            if isinstance(account_data, list) and len(account_data) >= 1:
                import base64
                try:
                    data = base64.b64decode(account_data[0])
                except Exception:
                    return

                state = decode_pool(data, pool_address, pool_info.program_id)
                if state:
                    # Fire callback
                    try:
                        self.on_pool_update(state, pool_info)
                    except Exception as e:
                        logger.error(f"Pool update callback error: {e}")
