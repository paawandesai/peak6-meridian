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

# P1-MM-REQUOTE: a tick requotes market by market and each market costs ~5 transactions, so the
# last market of a tick is quoted minutes after the tick read its fair values. Past this age the
# fair values are re-read from the (in-process, cached) source before quoting a market, and that
# market's value is re-checked for staleness with the same rule as the tick-start pull check.
FAIR_VALUE_REFRESH_SECS = 30.0


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
        # The tick's fair values and when they were read (re-read when older than
        # FAIR_VALUE_REFRESH_SECS before a market is quoted)
        self._fair_values: list[FairValue] = []
        self._fair_values_read_at = datetime.min.replace(tzinfo=UTC)

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
            self._fair_values = fair_values
            self._fair_values_read_at = self._clock()

            # P1-MM-REQUOTE: requote market by market (cancel -> settle -> sync -> place, then
            # the next market) so a market's book is empty only for its own few transactions,
            # not for most of the tick. One batched Book read up front is the cancel listing
            # (P1-7); an RPC error on it aborts the tick before any transaction (fail closed).
            cancel_listings = await self._fetch_books([m.market for m in open_markets])
            session_date = session_trading_date(open_markets, self._clock())
            for market in open_markets:
                try:
                    await self._requote_market(
                        market, cancel_listings.get(market.market), session_date
                    )
                except Exception:
                    # One market's failure never aborts the rest of the tick
                    logger.exception(f"Requote failed for {market.ticker} {market.market}")

            # Coverage at the end of the tick (denominator = the session's open markets, AC4)
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

        # Check for stale spot data (> 10s old) or a value the quant service flags stale
        for fv in fair_values:
            if self._is_stale(fv, now):
                age_secs = (now - fv.as_of).total_seconds()
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

    def _is_stale(self, fv: FairValue, now: datetime) -> bool:
        """Spot older than max_spot_age_secs, or a value the quant service flags stale.

        `stale` means its last refresh failed or it is too old (fair_value_cache.py). The devnet
        demo flag waives only the spot-age rule (quote from the last close; see
        meridian_quant.demo), never `stale`.
        """
        age_secs = (now - fv.as_of).total_seconds()
        spot_too_old = age_secs > self.config.max_spot_age_secs and not demo_allow_stale_spot()
        return spot_too_old or fv.stale

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

    async def _requote_market(
        self,
        market: MarketState,
        cancel_listing: list[RestingOrder] | None,
        session_date: int,
    ) -> None:
        """Cancel, settle, sync and re-quote one market before moving to the next.

        Args:
            market: An open market from this tick's market fetch.
            cancel_listing: The market's resting orders from the tick's batched Book read,
                or None if its Book could not be read (AB-10: then it is not quoted).
            session_date: The session's trading date (meridian_quant.mm.session).
        """
        if cancel_listing is None:
            logger.error(f"Book unreadable for cancel in {market.market}, not quoting it")
        else:
            # Frees escrowed YES/USDC into OpenOrders
            await self._cancel_market_quotes(market, cancel_listing)
        # Moves cancel refunds and fill proceeds to the wallet (AB-11: works after close too)
        await self._settle_market(market)
        if cancel_listing is None or not self._is_quotable(market, session_date):
            return
        # Skip markets without a usable fair value before spending a mint on them
        if await self._fair_value_for(market) is None:
            return
        if not await self._sync_market(market):
            return
        # Placing may come long after the tick read its fair values: re-check just before
        fair_value = await self._fair_value_for(market)
        if fair_value is None:
            return
        await self._quote_market(market, fair_value)

    def _is_quotable(self, market: MarketState, session_date: int) -> bool:
        """Open, in the current session, and not within min_time_to_close_secs of close.

        Prior-day markets stay Open for settlement (AB-11) but never get quotes or mints;
        mint_pair and place_order fail at or after close_ts (MarketClosed). The clock is read
        per market because a tick spans minutes.
        """
        if not market.is_open or market.trading_date != session_date:
            return False
        time_to_close_secs = market.close_ts - int(self._clock().timestamp())
        if time_to_close_secs < self.config.min_time_to_close_secs:
            logger.info(
                f"Not quoting {market.ticker} {market.market}: {time_to_close_secs}s to close "
                f"(< {self.config.min_time_to_close_secs}s threshold)"
            )
            return False
        return True

    async def _fair_value_for(self, market: MarketState) -> FairValue | None:
        """The market's fair value, re-read first if the tick's values are too old.

        Values older than FAIR_VALUE_REFRESH_SECS are re-read from the source (the in-memory
        cache in production) and the market's refreshed value re-checked for staleness. A
        failed re-read, a missing value or a stale one means the market is not quoted.
        Within the window the tick's values are used as read, exactly as before (the
        spot-age rule is not re-applied to them against a later clock).
        """
        now = self._clock()
        refreshed = False
        if (now - self._fair_values_read_at).total_seconds() > FAIR_VALUE_REFRESH_SECS:
            self._fair_values = await self._fetch_fair_values()
            self._fair_values_read_at = now
            refreshed = True
        # Exact market ID match: prior-day values must not match today's market (0DTE reuses
        # ticker+strike across days; the ID carries the trading date)
        fair_value = next((fv for fv in self._fair_values if fv.market == market.market), None)
        if fair_value is None:
            if refreshed:
                logger.warning(f"Not quoting {market.ticker}: no fair value after re-read")
            return None
        # Judged as of when it was read, with the pull check's rule: the tick-start values
        # already passed that check; a re-read value is checked once, here, for every market
        if self._is_stale(fair_value, self._fair_values_read_at):
            logger.warning(
                f"Not quoting {market.ticker} {market.market}: re-read fair value is stale "
                f"(as_of {fair_value.as_of.isoformat()}, stale={fair_value.stale})"
            )
            return None
        return fair_value

    async def _sync_market(self, market: MarketState) -> bool:
        """Sync one market's inventory from its on-chain YES/NO balances and mint if short.

        Runs after the market's cancel + settle, so all of its YES is in the wallet. Reads
        the balances fresh for this market (an RPC error propagates: never quote on unknown
        inventory). Returns False if the market must not be quoted: closed or too close to
        close, balances unreadable, YES short while at the inventory cap, or a failed mint.
        """
        now_ts = int(self._clock().timestamp())
        if not market.is_open or market.close_ts - now_ts < self.config.min_time_to_close_secs:
            return False

        balances = await self._order_client.get_multiple_token_balances(
            [market.market], self._mm_owner
        )
        if market.market not in balances:
            logger.error(f"Token balances unreadable for {market.market}, not quoting it")
            return False

        yes_balance, no_balance = balances[market.market]
        # Signed position = YES - NO (can be negative)
        signed_position = yes_balance - no_balance
        market_key = MarketKey(
            ticker=market.ticker,
            trading_date=market.trading_date,
            strike_cents=market.strike_cents,
        )
        self.inventory.set(market_key, signed_position)

        # Mint only if we need YES for asks AND position isn't at cap
        # Don't replenish sold inventory - let position move with fills
        if yes_balance >= self.config.size_per_side:
            return True
        if abs(signed_position) >= self.config.max_inventory:
            logger.debug(
                f"At inventory cap for {market.market}, position={signed_position}, skipping mint"
            )
            return False

        # Mint only what we need (minting pairs doesn't change position)
        mint_qty = self.config.size_per_side - yes_balance
        try:
            await self._order_client.mint_pair(
                market=market.market, qty=mint_qty, owner=self._mm_owner
            )
        except Exception:
            logger.exception(f"Failed to mint pairs for {market.market}")
            return False  # can't quote without YES tokens (AC1)
        logger.debug(
            f"Minted {mint_qty} pairs for {market.market} "
            f"(YES: {yes_balance}, NO: {no_balance}, position: {signed_position})"
        )
        return True

    async def _settle_market(self, market: MarketState) -> None:
        """settle_funds for one market; a failure is logged and does not stop the tick."""
        try:
            await self._order_client.settle_funds(market=market.market, owner=self._mm_owner)
        except Exception:
            logger.exception(f"Failed to settle funds for {market.market}")

    async def _settle_funds(self, markets: list[MarketState] | None = None) -> None:
        """Settle funds for every market (pull paths) to recycle fill proceeds and refunds.

        Args:
            markets: Already-fetched open markets. If None, fetches them.
                Passing the already-fetched list avoids refetching.
        """
        try:
            if markets is None:
                markets = await self._fetch_open_markets()
            for market in markets:
                await self._settle_market(market)
        except Exception:
            logger.exception("Failed to settle funds")

    async def _quote_market(self, market: MarketState, fv: FairValue) -> None:
        """Generate and place one market's two-sided quote, within inventory and order caps.

        The Book is read fresh just before placing (both orders reuse it, P1-7): it counts
        the MM's orders still resting after the cancel (AB-10 per-market cap) and names the
        other owners whose OpenOrders the place instruction needs. An RPC error on that read
        propagates; a market missing from it is not quoted (AB-10: never place on top of
        orders we cannot see). A failed place propagates to the caller.
        """
        market_key = MarketKey(
            ticker=market.ticker,
            trading_date=market.trading_date,
            strike_cents=market.strike_cents,
        )
        inv = self.inventory.get(market_key)
        max_inv = self.config.max_inventory
        quote_size = self.config.size_per_side
        label = f"{market.ticker} ${market.strike_cents / 100:.0f}"

        # Must be within limits AND able to absorb a fill of the quote size on either side
        if not self.inventory.within_limits(market_key, max_inv):
            logger.warning(f"Inventory limit exceeded for {label}, position={inv.position}")
            return
        if not (
            self.inventory.can_add(market_key, quote_size, max_inv)
            and self.inventory.can_add(market_key, -quote_size, max_inv)
        ):
            logger.warning(
                f"Cannot quote {label}: position={inv.position}, "
                f"size={quote_size} would exceed limits"
            )
            return

        books = await self._fetch_books([market.market])
        if market.market not in books:
            logger.error(f"Book unreadable for {market.ticker} {market.market}, not quoting")
            return
        resting_orders = books[market.market]
        # domain.md: max 8 resting orders per owner per market; a two-sided quote adds 2
        current = sum(1 for o in resting_orders if o.owner == self._mm_owner)
        if current + 2 > self.config.max_orders_per_owner:
            logger.warning(
                f"Skipping {label}: would exceed max_orders_per_owner per market "
                f"({self.config.max_orders_per_owner}), current in {market.market}={current}"
            )
            return

        quote = generate_quote(
            fair_value=fv,
            inventory=inv,
            spread_cents=self.config.spread_cents,
            size=quote_size,
            skew_per_50=self.config.skew_per_50,
        )
        await self._place_quote(market, quote, resting_orders)

    async def _place_quote(
        self, market: MarketState, quote: Quote, resting_orders: list[RestingOrder]
    ) -> None:
        """Place a two-sided quote.

        The market's old quotes are already cancelled in _requote_market, so this just
        places the new bid and ask. `resting_orders` is the Book snapshot read just before
        quoting; both orders reuse it (P1-7: no per-order Book read).

        Atomicity: if Ask placement fails after Bid succeeds, cancel the Bid
        to avoid leaving a one-sided quote.

        Raises:
            Exception: If either Bid or Ask placement fails.
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

    async def _cancel_market_quotes(self, market: MarketState, listing: list[RestingOrder]) -> None:
        """Cancel the MM's orders in `listing`; each failure is logged and the rest continue.

        A leftover from a failed cancel stays visible to the per-market order cap check.
        """
        for order in listing:
            if order.owner != self._mm_owner:
                continue
            try:
                await self._order_client.cancel_order(
                    market=market.market, order_id=order.order_id, owner=self._mm_owner
                )
            except Exception:
                logger.exception(f"Failed to cancel order {order.order_id} in {market.market}")

    async def _cancel_all_quotes(self, markets: list[MarketState] | None = None) -> None:
        """Cancel all resting MM orders in every market (pull paths; AC2).

        Catches per-order and per-market to avoid one failure skipping remaining
        markets/orders (which would leave leftovers and hit the per-market order cap).
        P1-7: Books for all markets are read in one batched call; if that read fails
        the error propagates (fail loudly: nothing can be cancelled).

        Args:
            markets: Already-fetched open markets. If None, fetches them.
                Passing the already-fetched list avoids refetching, which can
                return [] on RPC error and leave stale orders undetected.

        Raises:
            Exception: If fetching markets (when markets is None) or the batched Book
                read fails. Caller must handle this explicitly rather than silently
                leaving stale orders.
        """
        try:
            if markets is None:
                markets = await self._fetch_open_markets()
        except Exception:
            logger.exception("Failed to fetch open markets for cancel")
            # Re-raise to fail loudly: returning silently would leave stale orders
            raise

        books = await self._fetch_books([m.market for m in markets])
        for market in markets:
            if market.market not in books:
                logger.error(f"Book unreadable for cancel in {market.market}")
                continue
            await self._cancel_market_quotes(market, books[market.market])

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

        Counts only today's quotable markets (same session filter as _is_quotable).
        Prior-day markets remain Open for settlement but don't get quotes, so they
        shouldn't count toward coverage.
        """
        try:
            # Get today's trading date (YYYYMMDD in ET) - same session filter as _is_quotable
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
