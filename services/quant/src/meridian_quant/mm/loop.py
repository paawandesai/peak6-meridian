"""Main market maker loop."""

import asyncio
import json
import logging
from collections.abc import Callable
from datetime import UTC, datetime

from solana.rpc.async_api import AsyncClient
from solders.keypair import Keypair
from solders.pubkey import Pubkey

from meridian_quant.demo import demo_allow_stale_spot
from meridian_quant.ratelog import RateLimitedLog

from .config import MMConfig
from .inventory import InventoryTracker
from .metrics import book_coverage
from .quoter import generate_quote
from .session import session_trading_date
from .sources import FairValueSource, MarketSource, OrderClient
from .types import FairValue, MarketKey, MarketState, Quote, RestingOrder

logger = logging.getLogger(__name__)

# M3-08b: a pull condition (no fair values, a stale value, close near) that persists is logged
# loudly when it starts and then at most once a minute per reason; repeats go to DEBUG.
PULL_LOG_INTERVAL_SECS = 60.0
PULL_KEYS = ("pull:no-fair-values", "pull:stale", "pull:close")


# Clock protocol for testing (Finding #2)
Clock = Callable[[], datetime]


def _utc_now() -> datetime:
    """Default clock: current UTC time."""
    return datetime.now(UTC)


class MarketMakerLoop:
    """Main market maker loop (M3-02).

    AC1/AC2: Dependency injection for testability - markets, fair values, and order
    client are injectable so tests can use fakes without a live validator.
    """

    def __init__(
        self,
        config: MMConfig,
        market_source: MarketSource,
        fair_value_source: FairValueSource,
        order_client: OrderClient,
        clock: Clock | None = None,
    ) -> None:
        self.config = config
        # Parse MARKET_MAKER_KEYPAIR as JSON array (environment.md format)
        keypair_len = 64  # Ed25519 secret key length
        try:
            keypair_bytes = json.loads(config.market_maker_keypair)
            if not isinstance(keypair_bytes, list) or len(keypair_bytes) != keypair_len:
                raise ValueError("MARKET_MAKER_KEYPAIR must be JSON array of 64 bytes")
            self.keypair = Keypair.from_bytes(bytes(keypair_bytes))
        except (json.JSONDecodeError, ValueError, TypeError) as e:
            raise ValueError(f"MARKET_MAKER_KEYPAIR must be a JSON array of 64 bytes: {e}") from e
        self.program_id = Pubkey.from_string(config.program_id)
        self.inventory = InventoryTracker()
        self.rpc_client: AsyncClient | None = None
        self._running = False
        self._coverage = 0.0
        self._clock = clock or _utc_now  # Finding #2: injectable clock
        self._pull_log = RateLimitedLog(
            logger, PULL_LOG_INTERVAL_SECS, clock=lambda: self._clock().timestamp()
        )
        self._market_source = market_source
        self._fair_value_source = fair_value_source
        self._order_client = order_client
        self._mm_owner = str(self.keypair.pubkey())

    async def start(self) -> None:
        """Start the market maker loop."""
        # Never log config (contains keypair and service_token) or the RPC URL (a dedicated
        # provider URL such as MERIDIAN_DEVNET_RPC_URL embeds its API key).
        logger.info("Starting market maker loop", extra={"program_id": str(self.program_id)})
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
        self._order_client.begin_cycle()  # P1-7: per-cycle RPC state (blockhash reuse)
        try:
            # Fetch fair values from the quant service
            fair_values = await self._fetch_fair_values()
            if not fair_values:
                self._pull_log.warning(
                    "pull:no-fair-values", "Pulling all quotes: no fair values available"
                )
                try:
                    await self._cancel_all_quotes()  # Will fetch markets internally
                except Exception:
                    logger.exception("Failed to cancel quotes (no fair values)")
                try:
                    await self._settle_funds()  # Will fetch markets internally
                except Exception:
                    logger.exception("Failed to settle funds (no fair values)")
                self._coverage = 0.0
                return

            # Get open markets first (needed for close_ts check)
            try:
                open_markets = await self._fetch_open_markets()
            except Exception:
                logger.exception("Failed to fetch open markets, failing closed")
                # Can't cancel without market list - log and continue (stale orders risky but
                # better than crashing loop; next successful iteration will cancel them)
                self._coverage = 0.0
                return

            # Empty list means no markets to quote (success case, not failure)
            # The fetch succeeded, so we know this is legitimately empty, not an RPC error.
            # In this case, cancel any stale quotes but don't log as failure.
            if not open_markets:
                logger.info("No open markets today, canceling any stale quotes")
                await self._cancel_all_quotes(open_markets)  # Pass empty list (no refetch)
                await self._settle_funds(open_markets)  # Pass empty list (no refetch)
                self._coverage = 0.0
                return

            # Check pull conditions (stale spot data or near close)
            if self._should_pull_all_quotes(fair_values, open_markets):
                await self._cancel_all_quotes(open_markets)
                # Settle funds to recycle proceeds (AB-11: settle still works after close)
                await self._settle_funds(open_markets)
                self._coverage = 0.0
                return

            self._log_resume()

            # Cancel all old quotes first (frees escrowed YES to OpenOrders.free_yes)
            # Track markets where cancel listing failed (AB-10: don't quote those markets)
            cancel_failed_markets = await self._cancel_all_quotes(open_markets)

            # Settle funds to move free_yes to wallet
            await self._settle_funds(open_markets)

            # Sync inventory from wallet (now all YES is in wallet, not escrowed)
            # Returns only markets with successful balance reads (RPC errors skip quoting)
            synced_markets = await self._sync_inventory(open_markets)

            # Place new quotes (no cancel needed, already cancelled above)
            # Only quote markets that were successfully synced AND had successful cancel listing
            await self._quote_all_strikes(fair_values, synced_markets, cancel_failed_markets)

            # Update coverage metric (denominator = all open markets per AC4)
            # Coverage is share of OPEN strikes with quotes, not share of synced
            await self._update_coverage(open_markets)

        except Exception:
            logger.exception("Error in MM loop iteration")
            self._coverage = 0.0  # iteration aborted: coverage unknown, report none

    async def _fetch_fair_values(self) -> list[FairValue]:
        """Fetch fair values (AC1: uses injected source)."""
        try:
            return await self._fair_value_source.fetch_fair_values()
        except Exception:
            logger.exception("Failed to fetch fair values")
            return []

    def _should_pull_all_quotes(
        self, fair_values: list[FairValue], markets: list[MarketState]
    ) -> bool:
        """Check if we should pull all quotes (stale spot or near close).

        Finding #2: Now uses injected clock and checks close_ts.
        Finding #3: Only check close_ts for today's trading session to avoid
        prior-day unsettled markets blocking today's quotes (AB-11).
        """
        now = self._clock()

        # Check for stale spot data (> 10s old)
        for fv in fair_values:
            if demo_allow_stale_spot():
                break  # devnet demo only: quote from the last close (see meridian_quant.demo)
            age_secs = (now - fv.as_of).total_seconds()
            if age_secs > self.config.max_spot_age_secs or fv.stale:
                self._pull_log.warning(
                    "pull:stale",
                    f"Pulling all quotes: stale fair value for {fv.ticker} {fv.market} "
                    f"(spot {age_secs:.1f}s old, limit {self.config.max_spot_age_secs}s, "
                    f"stale={fv.stale})",
                )
                return True

        # The current session's trading date (today in ET, or the demo/next session when only
        # it still has markets before close; see meridian_quant.mm.session)
        today_trading_date = session_trading_date(markets, now)

        # Check for time to close: pull at close, within 2min, or after close
        # Only check markets from today's session; prior-day markets remain Open
        # for settlement (AB-11) but shouldn't block today's quoting
        for market in markets:
            if market.is_open and market.trading_date == today_trading_date:
                time_to_close_secs = market.close_ts - int(now.timestamp())
                # Pull if at/within close window OR after close (negative ttc)
                if time_to_close_secs < self.config.min_time_to_close_secs:
                    self._pull_log.log(
                        "pull:close",
                        f"Pulling all quotes: {time_to_close_secs}s to close "
                        f"for {market.ticker} (< {self.config.min_time_to_close_secs}s threshold)",
                        logging.INFO,
                    )
                    return True

        return False

    def _log_resume(self) -> None:
        """Once quoting resumes after a pull, say so (once) and re-arm the pull warnings."""
        if any(self._pull_log.active(key) for key in PULL_KEYS):
            logger.info("Resuming quotes: pull condition cleared")
            for key in PULL_KEYS:
                self._pull_log.clear(key)

    async def _fetch_open_markets(self) -> list[MarketState]:
        """Fetch open markets (AC1: uses injected source).

        Re-raises on error to fail closed (AC2): returning [] would make
        _run_once think the book is empty when it's actually an RPC failure,
        causing cancel to refetch and also get [], leaving stale orders.
        """
        try:
            return await self._market_source.fetch_open_markets()
        except Exception:
            logger.exception("Failed to fetch open markets")
            raise

    async def _sync_inventory(self, markets: list[MarketState]) -> list[MarketState]:
        """Sync inventory from on-chain YES token balances (AC1/AC2).

        Reads wallet YES/NO token balances, syncs to InventoryTracker, then mints
        pairs if inventory is low. This ensures skew reflects actual fills and the
        200-lot cap binds correctly.

        P1-7: one batched read for all markets (getMultipleAccounts, <= 100 keys per
        call) instead of per-market reads. An RPC error propagates and aborts the
        iteration (fail closed: never quote on unknown inventory).

        Returns markets that were successfully synced. Markets whose balances could not
        be read are excluded (not quoted).
        """
        # Only markets still tradable: mint_pair and place_order fail at or after close_ts
        # (MarketClosed), and unsettled prior-day markets stay Open for settlement (AB-11).
        now_ts = int(self._clock().timestamp())
        open_markets = [
            m
            for m in markets
            if m.is_open and m.close_ts - now_ts >= self.config.min_time_to_close_secs
        ]
        if not open_markets:
            return []

        # Batch-fetch all token balances (P1-7: <= 100 keys per RPC call); raises on RPC error
        market_addresses = [m.market for m in open_markets]
        balances = await self._order_client.get_multiple_token_balances(
            market_addresses, self._mm_owner
        )

        synced_markets = []
        for market in open_markets:
            market_key = MarketKey(
                ticker=market.ticker,
                trading_date=market.trading_date,
                strike_cents=market.strike_cents,
            )

            # Get balances from batched result
            if market.market not in balances:
                logger.error(f"Token balances unreadable for {market.market}, not quoting it")
                continue

            yes_balance, no_balance = balances[market.market]
            # Signed position = YES - NO (can be negative)
            signed_position = yes_balance - no_balance
            self.inventory.set(market_key, signed_position)

            # Mint only if we need YES for asks AND position isn't at cap
            # Don't replenish sold inventory - let position move with fills
            if yes_balance < self.config.size_per_side:
                # Check if we're at the inventory cap
                if abs(signed_position) >= self.config.max_inventory:
                    logger.debug(
                        f"At inventory cap for {market.market}, "
                        f"position={signed_position}, skipping mint"
                    )
                    continue

                # Mint only what we need (minting pairs doesn't change position)
                mint_qty = self.config.size_per_side - yes_balance
                try:
                    await self._order_client.mint_pair(
                        market=market.market, qty=mint_qty, owner=self._mm_owner
                    )
                    logger.debug(
                        f"Minted {mint_qty} pairs for {market.market} "
                        f"(YES: {yes_balance}, NO: {no_balance}, position: {signed_position})"
                    )
                except Exception:
                    logger.exception(f"Failed to mint pairs for {market.market}")
                    # Skip this market - can't quote without YES tokens (AC1)
                    continue

            # Successfully synced this market's inventory
            synced_markets.append(market)

        return synced_markets

    async def _settle_funds(self, markets: list[MarketState] | None = None) -> None:
        """Settle funds to recycle proceeds from fills.

        Calls settle_funds for each market to withdraw fill proceeds and cancel
        refunds from open orders balance back to wallet.

        Args:
            markets: Already-fetched open markets. If None, fetches them.
                Passing the already-fetched list avoids refetching.
        """
        try:
            if markets is None:
                markets = await self._fetch_open_markets()
            for market in markets:
                try:
                    await self._order_client.settle_funds(
                        market=market.market, owner=self._mm_owner
                    )
                except Exception:
                    logger.exception(f"Failed to settle funds for {market.market}")
        except Exception:
            logger.exception("Failed to settle funds")

    async def _quote_all_strikes(
        self,
        fair_values: list[FairValue],
        markets: list[MarketState],
        cancel_failed_markets: set[str] | None = None,
    ) -> None:
        """Generate and place quotes for all open strikes.

        Finding #3: Only quote today's markets; prior-day markets remain Open for
        settlement (AB-11) but don't get new quotes.

        Args:
            fair_values: Fair values from the quant service.
            markets: Open markets (typically from _sync_inventory).
            cancel_failed_markets: Market IDs where cancel listing failed.
                These markets are skipped (AB-10: fail closed on fetch errors).
        """
        if cancel_failed_markets is None:
            cancel_failed_markets = set()
        # The current session's trading date (see meridian_quant.mm.session)
        now = self._clock()
        today_trading_date = session_trading_date(markets, now)

        # Filter to today's markets only (Finding #3: prior-day markets stay Open for
        # settlement but don't get new quotes)
        today_markets = [m for m in markets if m.is_open and m.trading_date == today_trading_date]

        # Count current resting orders PER MARKET (domain.md: 8 per owner per market).
        # P1-7: one batched Book read for all of today's markets; an RPC error propagates and
        # aborts the iteration (AB-10: never place on top of orders we cannot see).
        books = await self._fetch_books([m.market for m in today_markets])
        orders_per_market: dict[str, int] = {}
        for market in today_markets:
            if market.market not in books:
                # Do NOT set to 0 (AB-10: would allow placing on top of invisible leftovers).
                # Skip this market entirely - it won't be in orders_per_market.
                logger.error(f"Book unreadable for {market.ticker} {market.market}, not quoting")
                continue
            mm_orders = [o for o in books[market.market] if o.owner == self._mm_owner]
            orders_per_market[market.market] = len(mm_orders)

        for fv in fair_values:
            # Match FV to market by exact market ID (both use TICKER_YYYYMMDD_STRIKE).
            # Prior-day FVs must not match today's markets (0DTE reuses ticker+strike across days).
            # Exact match ensures trading_date matches.
            fv_market: MarketState | None = next(
                (m for m in today_markets if m.market == fv.market),
                None,
            )
            if not fv_market:
                continue

            # Skip markets where cancel listing failed (AB-10: fail closed)
            if fv_market.market in cancel_failed_markets:
                logger.warning(f"Skipping {fv.ticker}: cancel listing failed for this market")
                continue

            # Get current inventory using MarketKey (Finding #5)
            market_key = MarketKey(
                ticker=fv.ticker, trading_date=fv_market.trading_date, strike_cents=fv.strike_cents
            )
            inv = self.inventory.get(market_key)

            # Check inventory limits: must be within limits AND able to add quote size
            # This prevents quoting when at the limit (e.g., position=200)
            if not self.inventory.within_limits(market_key, self.config.max_inventory):
                logger.warning(
                    f"Inventory limit exceeded for {fv.ticker} ${fv.strike_cents / 100:.0f}, "
                    f"position={inv.position}"
                )
                continue

            # Check if we can add the quote size without exceeding limits
            # Quote could get filled on either side, so check both
            max_inv = self.config.max_inventory
            quote_size = self.config.size_per_side
            if not (
                self.inventory.can_add(market_key, quote_size, max_inv)
                and self.inventory.can_add(market_key, -quote_size, max_inv)
            ):
                logger.warning(
                    f"Cannot quote {fv.ticker} ${fv.strike_cents / 100:.0f}: "
                    f"position={inv.position}, size={quote_size} would exceed limits"
                )
                continue

            # Check order cap PER MARKET: placing a two-sided quote adds 2 orders (AB-10)
            # domain.md: "max 8 resting orders per owner per market"
            # If market not in dict, fetch failed - skip (fail closed)
            if fv_market.market not in orders_per_market:
                logger.warning(
                    f"Skipping {fv.ticker} ${fv.strike_cents / 100:.0f}: "
                    f"fetch_resting_orders failed (cannot verify order cap)"
                )
                continue
            current_market_orders = orders_per_market[fv_market.market]
            if current_market_orders + 2 > self.config.max_orders_per_owner:
                logger.warning(
                    f"Skipping {fv.ticker} ${fv.strike_cents / 100:.0f}: would exceed "
                    f"max_orders_per_owner per market ({self.config.max_orders_per_owner}), "
                    f"current in {fv_market.market}={current_market_orders}"
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
            try:
                await self._place_quote(fv_market, quote, books[fv_market.market])
                # Update count only after both sides confirm (AC3 / AB-10 cap enforcement)
                orders_per_market[fv_market.market] = orders_per_market.get(fv_market.market, 0) + 2
            except Exception:
                # Place failed - don't increment count (may have 0 or 1 order if rollback failed)
                logger.exception(f"Failed to place quote for {fv.ticker}, skipping count update")
                continue

    async def _place_quote(
        self, market: MarketState, quote: Quote, resting_orders: list[RestingOrder]
    ) -> None:
        """Place a two-sided quote.

        Old quotes are already cancelled in _run_once before this is called,
        so this just places the new bid and ask. `resting_orders` is the Book snapshot
        read just before quoting; both orders reuse it (P1-7: no per-order Book read).

        Atomicity: if Ask placement fails after Bid succeeds, cancel the Bid
        to avoid leaving a one-sided quote.

        Raises:
            Exception: If either Bid or Ask placement fails. Caller must not
                increment order count on failure (AC3/AB-10 cap enforcement).
        """
        bid_placed = False
        try:
            # Place new bid
            await self._order_client.place_order(
                market=market.market,
                side="Bid",
                price=quote.bid_price,
                qty=quote.size,
                owner=self._mm_owner,
                resting_orders=resting_orders,
            )
            bid_placed = True

            # Place new ask
            await self._order_client.place_order(
                market=market.market,
                side="Ask",
                price=quote.ask_price,
                qty=quote.size,
                owner=self._mm_owner,
                resting_orders=resting_orders,
            )
        except Exception:
            logger.exception(f"Failed to place quote for {market.ticker}")
            # If Bid placed but Ask failed, cancel the Bid (avoid one-sided quote)
            if bid_placed:
                try:
                    logger.warning(f"Canceling Bid for {market.ticker} after Ask placement failed")
                    # Cancel listing for this market to remove the orphaned Bid
                    orders = await self._order_client.fetch_resting_orders(market.market)
                    mm_orders = [o for o in orders if o.owner == self._mm_owner]
                    for order in mm_orders:
                        try:
                            await self._order_client.cancel_order(
                                market.market, order.order_id, self._mm_owner
                            )
                        except Exception:
                            logger.exception(f"Failed to cancel orphaned Bid {order.order_id}")
                except Exception:
                    logger.exception(f"Failed to clean up orphaned Bid for {market.ticker}")
            # Re-raise to signal failure to caller (don't increment order count)
            raise

    async def _cancel_all_quotes(self, markets: list[MarketState] | None = None) -> set[str]:
        """Cancel all resting MM orders (AC2: actually cancels orders).

        Catches per-order and per-market to avoid one failure skipping remaining
        markets/orders (which would leave leftovers and hit the per-market order cap).
        P1-7: Books for all markets are read in one batched call; if that read fails
        the error propagates (fail loudly: nothing can be cancelled or safely quoted).

        Args:
            markets: Already-fetched open markets. If None, fetches them.
                Passing the already-fetched list avoids refetching, which can
                return [] on RPC error and leave stale orders undetected.

        Returns:
            Set of market IDs where fetch_resting_orders failed. These markets
            should not be quoted (AB-10: fail closed on fetch errors).

        Raises:
            Exception: If fetching markets (when markets is None) or the batched Book
                read fails. Caller must handle this explicitly rather than silently
                leaving stale orders.
        """
        failed_markets: set[str] = set()
        try:
            if markets is None:
                markets = await self._fetch_open_markets()
        except Exception:
            logger.exception("Failed to fetch open markets for cancel")
            # Re-raise to fail loudly: returning empty set would leave stale orders
            raise

        books = await self._fetch_books([m.market for m in markets])
        for market in markets:
            if market.market not in books:
                logger.error(f"Book unreadable for cancel in {market.market}, not quoting it")
                failed_markets.add(market.market)
                continue
            mm_orders = [o for o in books[market.market] if o.owner == self._mm_owner]
            for order in mm_orders:
                try:
                    await self._order_client.cancel_order(
                        market=market.market, order_id=order.order_id, owner=self._mm_owner
                    )
                except Exception:
                    logger.exception(f"Failed to cancel order {order.order_id} in {market.market}")

        return failed_markets

    async def _fetch_books(self, market_ids: list[str]) -> dict[str, list[RestingOrder]]:
        """Batched Book read (P1-7). Logs and re-raises RPC errors (fail closed)."""
        if not market_ids:
            return {}
        try:
            return await self._order_client.fetch_resting_orders_batch(market_ids)
        except Exception:
            logger.exception(f"Batched Book read failed for {len(market_ids)} markets")
            raise

    async def _update_coverage(self, markets: list[MarketState]) -> None:
        """Update the book coverage metric (AC4: actually fetches orders).

        Counts only today's quotable markets (same filter as _quote_all_strikes).
        Prior-day markets remain Open for settlement but don't get quotes, so they
        shouldn't count toward coverage.
        """
        try:
            # Get today's trading date (YYYYMMDD in ET) - same filter as _quote_all_strikes
            now = self._clock()
            today_trading_date = session_trading_date(markets, now)

            # Filter to today's quotable markets only
            today_markets = [
                m for m in markets if m.is_open and m.trading_date == today_trading_date
            ]
            today_market_ids = [m.market for m in today_markets]

            if not today_market_ids:
                self._coverage = 0.0
                return

            # Fetch all resting orders across today's quotable markets (one batched read)
            books = await self._fetch_books(today_market_ids)
            if len(books) != len(today_market_ids):
                raise RuntimeError("Book unreadable for some markets; coverage unknown")
            all_orders = [o for orders in books.values() for o in orders]

            self._coverage = book_coverage(today_market_ids, all_orders, self._mm_owner)
        except Exception:
            logger.exception("Failed to update coverage")
            self._coverage = 0.0
