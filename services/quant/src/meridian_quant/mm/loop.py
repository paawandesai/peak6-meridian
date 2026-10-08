"""Main market maker loop."""

import asyncio
import logging
from datetime import UTC, datetime
from typing import Any

import httpx
from solana.rpc.async_api import AsyncClient
from solders.keypair import Keypair  # type: ignore[import-untyped]
from solders.pubkey import Pubkey  # type: ignore[import-untyped]

from .config import MMConfig
from .inventory import InventoryTracker
from .quoter import generate_quote
from .types import FairValue, MarketState

logger = logging.getLogger(__name__)


class MarketMakerLoop:
    """Main market maker loop (M3-02)."""

    def __init__(self, config: MMConfig) -> None:
        self.config = config
        self.keypair = Keypair.from_base58_string(config.market_maker_keypair)
        self.program_id = Pubkey.from_string(config.program_id)
        self.inventory = InventoryTracker()
        self.rpc_client: AsyncClient | None = None
        self._running = False
        self._coverage = 0.0

    async def start(self) -> None:
        """Start the market maker loop."""
        # Never log config (contains keypair and service_token)
        logger.info(
            "Starting market maker loop",
            extra={
                "rpc_url": self.config.rpc_url,
                "program_id": str(self.program_id),
            },
        )
        self.rpc_client = AsyncClient(self.config.rpc_url)
        self._running = True

        try:
            while self._running:
                await self._run_once()
                await asyncio.sleep(self.config.loop_interval_secs)
        finally:
            if self.rpc_client:
                await self.rpc_client.close()
                self.rpc_client = None

    async def stop(self) -> None:
        """Stop the market maker loop."""
        logger.info("Stopping market maker loop")
        self._running = False

    @property
    def book_coverage(self) -> float:
        """Current book coverage metric (share of open strikes with two-sided quotes)."""
        return self._coverage

    async def _run_once(self) -> None:
        """Run one iteration of the MM loop."""
        try:
            # Fetch fair values from the quant service
            fair_values = await self._fetch_fair_values()
            if not fair_values:
                logger.warning("No fair values available, skipping iteration")
                return

            # Check pull conditions (stale spot data or near close)
            if self._should_pull_all_quotes(fair_values):
                logger.info("Pull condition met, canceling all quotes")
                await self._cancel_all_quotes()
                return

            # Get open markets
            open_markets = await self._fetch_open_markets()
            if not open_markets:
                logger.debug("No open markets")
                self._coverage = 0.0
                return

            # Update inventory from on-chain state
            await self._sync_inventory(open_markets)

            # Settle funds to recycle proceeds
            await self._settle_funds()

            # Generate and place quotes for each open strike
            await self._quote_all_strikes(fair_values, open_markets)

            # Update coverage metric
            await self._update_coverage(open_markets)

        except Exception:
            logger.exception("Error in MM loop iteration")

    async def _fetch_fair_values(self) -> list[FairValue]:
        """Fetch fair values from the quant service."""
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                resp = await client.get(
                    self.config.fair_values_url,
                    headers={"Authorization": f"Bearer {self.config.service_token}"},
                )
                resp.raise_for_status()
                data = resp.json()
                return [FairValue.model_validate(fv) for fv in data]
        except Exception:
            logger.exception("Failed to fetch fair values")
            return []

    def _should_pull_all_quotes(self, fair_values: list[FairValue]) -> bool:
        """Check if we should pull all quotes (stale spot or near close)."""
        now = datetime.now(UTC)

        # Check for stale spot data (> 10s old)
        for fv in fair_values:
            age_secs = (now - fv.as_of).total_seconds()
            if age_secs > self.config.max_spot_age_secs or fv.stale:
                logger.warning(f"Stale spot data for {fv.ticker}: {age_secs:.1f}s old")
                return True

        # Check for time to close (< 2 min)
        # Note: This requires market close_ts, implemented in _fetch_open_markets
        # For now, placeholder

        return False

    async def _fetch_open_markets(self) -> list[MarketState]:
        """Fetch open markets from on-chain state."""
        # Placeholder: would scan for markets in Open state
        # Real impl uses getProgramAccounts with market discriminator + state filter
        return []

    async def _sync_inventory(self, markets: list[MarketState]) -> None:
        """Sync inventory from on-chain positions."""
        # Placeholder: would read YES token accounts for MM keypair
        # and update inventory tracker
        pass

    async def _settle_funds(self) -> None:
        """Settle funds to recycle proceeds from fills."""
        # Placeholder: would call settle_funds for each market with free balance
        pass

    async def _quote_all_strikes(
        self,
        fair_values: list[FairValue],
        markets: list[MarketState],
    ) -> None:
        """Generate and place quotes for all open strikes."""
        for fv in fair_values:
            market = next(
                (m for m in markets if m.strike_cents == fv.strike_cents and m.ticker == fv.ticker),
                None,
            )
            if not market or not market.is_open:
                continue

            # Get current inventory
            inv = self.inventory.get(fv.strike_cents)

            # Check inventory limits
            if not self.inventory.within_limits(fv.strike_cents, self.config.max_inventory):
                logger.warning(
                    f"Inventory limit exceeded for {fv.ticker} ${fv.strike_cents/100:.0f}, "
                    f"position={inv.position}"
                )
                continue

            # Generate quote with skew
            quote = generate_quote(
                fair_value=fv,
                inventory=inv,
                spread_cents=self.config.spread_cents,
                size=self.config.size_per_side,
                skew_per_50=self.config.skew_per_50,
            )

            # Place orders (would check existing orders and update/replace as needed)
            await self._place_quote(market, quote)

    async def _place_quote(self, market: MarketState, quote: Any) -> None:
        """Place or update a two-sided quote."""
        # Placeholder: would place_order for bid and ask
        # Respecting max_orders_per_owner cap (8)
        # And potentially minting pairs for inventory
        pass

    async def _cancel_all_quotes(self) -> None:
        """Cancel all resting MM orders."""
        # Placeholder: would cancel all orders owned by MM keypair
        pass

    async def _update_coverage(self, markets: list[MarketState]) -> None:
        """Update the book coverage metric."""
        # Placeholder: would fetch resting orders and compute coverage
        self._coverage = 0.0
