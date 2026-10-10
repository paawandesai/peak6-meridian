"""Production entry point for market maker and quant service.

Usage:
    python -m meridian_quant.mm.main

This process serves:
- GET /fair-values (M3-01): fair value pricing for all open strikes
- GET /health: service status with book_coverage metric (M3-02)
- MM loop (M3-02): two-sided quotes on every open strike

M3-08b: spots come from a shared cache (spot_cache.py: Pyth Pro for all tickers in one call,
Finnhub per-ticker fallback, at most one upstream fetch per ticker per 5 s). Fair values are
computed by a background refresher into a cache (fair_value_cache.py); GET /fair-values and the
MM loop both read that cache in-process, so no request prices anything and the MM makes no HTTP
self-call.

Environment variables (see docs/environment.md):
    MARKET_MAKER_KEYPAIR: JSON array of 64 bytes (required)
    MERIDIAN_PROGRAM_ID: Meridian program ID (required)
    SERVICE_TOKEN: Bearer token for /fair-values (required)
    FINNHUB_API_KEY: Finnhub API key, per-ticker spot fallback (required)
    TIINGO_API_KEY: Tiingo API key for daily closes (required)
    PYTH_API_TOKEN: Pyth Pro token, primary spot source and closes fallback (recommended)
    SOLANA_RPC_URL: RPC endpoint (default: http://localhost:8899)
    USDC_MINT: USDC mint address (required)
    QUANT_HOST: HTTP server host (default: 0.0.0.0)
    QUANT_PORT: HTTP server port (default: 4100)
"""

import asyncio
import contextlib
import json
import logging
import os
import sys
import threading
import time
from collections.abc import Awaitable, Callable, Sequence
from datetime import UTC, date, datetime
from decimal import Decimal

import httpx
from solana.rpc.async_api import AsyncClient
from solders.keypair import Keypair
from solders.pubkey import Pubkey

from meridian_quant.fair_value_cache import CachedFairValueSource, FairValueCache, run_refresher
from meridian_quant.prices import (
    PriceError,
    Spot,
    fetch_daily_closes,
    fetch_daily_closes_pyth,
    fetch_spot,
)
from meridian_quant.pyth_latest import fetch_pyth_latest_spots
from meridian_quant.server import MarketInfo, Service, make_server
from meridian_quant.spot_cache import SpotCache

from .chain import ChainMarketSource, ChainOrderClient
from .config import MMConfig
from .loop import MarketMakerLoop
from .session import session_trading_date
from .types import MarketState

# stdout, not stderr: Railway tags every stderr line as an error.
logging.basicConfig(
    stream=sys.stdout,
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
# httpx/httpcore log every request URL at INFO; a dedicated RPC URL carries its API key in the
# query string, so keep them at WARNING (CLAUDE.md: never log keys).
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)
logger = logging.getLogger(__name__)

# A ticker whose daily closes failed is not retried for this long (Tiingo's free tier is
# ~50 calls/hour and the fair-value refresher ticks every 1.5 s).
CLOSES_RETRY_SECS = 60.0
SPOT_TTL_SECS = 5.0  # at most one upstream spot fetch per ticker per 5 s (spot_cache.py)


class MarketCache:
    """Thread-safe cache of open markets updated by MM loop."""

    def __init__(self) -> None:
        self._markets: list[MarketState] = []
        self._lock = threading.Lock()

    def update(self, markets: list[MarketState]) -> None:
        """Update cached markets (called from MM loop)."""
        with self._lock:
            self._markets = markets

    def get(self) -> list[MarketState]:
        """Get cached markets (called from HTTP handler thread)."""
        with self._lock:
            return self._markets.copy()


class OnChainSources:
    """Sources implementation using cached markets and live price providers.

    Markets are cached from the MM loop to avoid async-in-sync event loop issues. Spots come
    from the shared `SpotCache`. Called by the fair-value refresher (one thread at a time).
    """

    def __init__(
        self,
        market_cache: MarketCache,
        http_client: httpx.Client,
        spot_cache: SpotCache,
        tiingo_key: str,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._market_cache = market_cache
        self._http_client = http_client
        self._spot_cache = spot_cache
        self._tiingo_key = tiingo_key
        self._clock = clock
        self._closes_cache: dict[str, tuple[date, list[Decimal]]] = {}
        self._closes_failed_at: dict[str, float] = {}

    def markets(self) -> list[MarketInfo]:
        """Get open markets from cache (populated by MM loop).

        Filters to the current session's trading_date (meridian_quant.mm.session). Prior-day
        markets stay Open for settlement (AB-11) but should not appear on /fair-values for M3-03.
        """
        # The current session's trading date, the same rule the MM loop quotes by
        cached_markets = self._market_cache.get()
        today_trading_date = session_trading_date(cached_markets, datetime.now(UTC))
        return [
            MarketInfo(
                market=m.market,
                ticker=m.ticker,
                strike_cents=m.strike_cents,
                close_ts=m.close_ts,
            )
            for m in cached_markets
            if m.is_open and m.trading_date == today_trading_date
        ]

    def spot(self, ticker: str) -> Spot:
        """Spot from the shared cache (Pyth Pro primary, Finnhub fallback)."""
        return self._spot_cache.get(ticker)

    def closes(self, ticker: str) -> list[Decimal]:
        """Daily closes, cached per ticker per day (they don't change intraday, and /fair-values
        is polled every few seconds). Tiingo first; Pyth Pro history when PYTH_API_TOKEN is set
        and Tiingo fails (e.g. rate-limited)."""
        today = datetime.now(UTC).date()
        cached = self._closes_cache.get(ticker)
        if cached is not None and cached[0] == today:
            return cached[1]
        failed_at = self._closes_failed_at.get(ticker)
        if failed_at is not None and self._clock() - failed_at < CLOSES_RETRY_SECS:
            raise PriceError(f"{ticker}: closes unavailable (last fetch failed; retry throttled)")
        try:
            closes = self._fetch_closes(ticker, today)
        except PriceError:
            self._closes_failed_at[ticker] = self._clock()
            raise
        self._closes_failed_at.pop(ticker, None)
        self._closes_cache[ticker] = (today, closes)
        return closes

    def _fetch_closes(self, ticker: str, today: date) -> list[Decimal]:
        try:
            return fetch_daily_closes(self._http_client, ticker, self._tiingo_key, today)
        except Exception as e:
            pyth_token = os.getenv("PYTH_API_TOKEN", "")
            if not pyth_token:
                raise PriceError(f"Failed to fetch closes for {ticker}: {e}") from e
            try:
                return fetch_daily_closes_pyth(self._http_client, ticker, pyth_token, today)
            except Exception as e2:
                raise PriceError(f"Failed to fetch closes for {ticker}: {e}; pyth: {e2}") from e2


def make_spot_cache(
    http_client: httpx.Client, finnhub_key: str, pyth_token: str, ttl_secs: float
) -> SpotCache:
    """Pyth Pro (all tickers, one request) when a token is set; Finnhub per ticker otherwise
    and as the fallback. Keys stay in request headers; errors carry no key."""

    def finnhub(ticker: str) -> Spot:
        try:
            return fetch_spot(http_client, ticker, finnhub_key)
        except PriceError:
            raise
        except Exception as e:
            raise PriceError(f"finnhub fetch failed: {type(e).__name__}") from e

    def pyth() -> dict[str, Spot]:
        return fetch_pyth_latest_spots(http_client, pyth_token)

    return SpotCache(primary=pyth if pyth_token else None, fallback=finnhub, ttl_secs=ttl_secs)


async def update_market_cache(
    market_source: ChainMarketSource, cache: MarketCache, interval_secs: float
) -> None:
    """Background task: periodically fetch markets and update cache for HTTP handler."""
    while True:
        try:
            markets = await market_source.fetch_open_markets()
            cache.update(markets)
            logger.debug(f"Updated market cache: {len(markets)} markets")
        except Exception:
            logger.exception("Failed to update market cache")
        await asyncio.sleep(interval_secs)


FIRST_FAIR_VALUES_TIMEOUT_SECS = 60.0


async def wait_for_first_fair_values(
    snapshot: Callable[[], Sequence[object]],
    timeout_secs: float = FIRST_FAIR_VALUES_TIMEOUT_SECS,
    poll_secs: float = 0.5,
    clock: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
) -> int:
    """Waits until the fair-value cache holds at least one value, so the MM's first tick does
    not pull every quote for want of a value that is a refresh away. Returns how many values
    were ready; 0 after `timeout_secs` (the MM then starts anyway and pulls as usual)."""
    deadline = clock() + timeout_secs
    while True:
        ready = len(snapshot())
        if ready > 0:
            logger.info("First fair values ready: %d markets", ready)
            return ready
        if clock() >= deadline:
            logger.warning("No fair values after %.0fs; starting the MM anyway", timeout_secs)
            return 0
        await sleep(poll_secs)


async def main() -> None:
    """Start the quant service with MM loop and HTTP endpoints."""
    # Load config from environment
    config = MMConfig()  # type: ignore[call-arg]
    service_token = os.environ["SERVICE_TOKEN"]
    finnhub_key = os.environ["FINNHUB_API_KEY"]
    tiingo_key = os.environ["TIINGO_API_KEY"]
    pyth_token = os.getenv("PYTH_API_TOKEN", "")
    host = os.getenv("QUANT_HOST", "0.0.0.0")
    port = int(os.getenv("QUANT_PORT", "4100"))

    logger.info(
        "Starting quant service with MM loop: program_id=%s, http=%s:%d",
        config.program_id,
        host,
        port,
    )

    # Initialize Solana connection
    rpc_client = AsyncClient(config.rpc_url)
    program_id = Pubkey.from_string(config.program_id)
    keypair_bytes = json.loads(config.market_maker_keypair)
    keypair = Keypair.from_bytes(bytes(keypair_bytes))

    # Initialize on-chain market source
    market_source = ChainMarketSource(rpc_client, program_id)

    # Initialize order client
    usdc_mint = Pubkey.from_string(config.usdc_mint)
    order_client = ChainOrderClient(rpc_client, program_id, keypair, usdc_mint)

    # Create market cache for HTTP handler (updated by background task)
    market_cache = MarketCache()

    # HTTP client for price providers (synchronous, used by the fair-value refresher thread)
    http_client = httpx.Client(timeout=httpx.Timeout(3.0))
    if not pyth_token:
        logger.warning("PYTH_API_TOKEN not set: spots come from Finnhub only (rate-limited)")
    spot_cache = make_spot_cache(http_client, finnhub_key, pyth_token, SPOT_TTL_SECS)

    # Sources (market cache + spot cache + closes) feed the background fair-value cache
    sources = OnChainSources(market_cache, http_client, spot_cache, tiingo_key)
    fair_value_cache = FairValueCache(sources)

    # The MM reads fair values from the same cache in-process (no HTTP self-call)
    mm_loop = MarketMakerLoop(
        config=config,
        market_source=market_source,
        fair_value_source=CachedFairValueSource(fair_value_cache),
        order_client=order_client,
    )

    # /fair-values serves the cache; mm_loop enables book_coverage in /health
    service = Service(
        sources=sources,
        token=service_token,
        mm_loop=mm_loop,
        fair_values=fair_value_cache.snapshot,
    )

    # Start HTTP server in a thread (ThreadingHTTPServer handles requests synchronously)
    server = make_server(service, host, port)
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    logger.info("HTTP server started on %s:%d (GET /fair-values, GET /health)", host, port)

    # Background tasks: the open-market list, then the fair values priced from it
    cache_update_task = asyncio.create_task(
        update_market_cache(market_source, market_cache, interval_secs=30.0)
    )
    refresher_task = asyncio.create_task(run_refresher(fair_value_cache))
    await wait_for_first_fair_values(fair_value_cache.snapshot)

    # Start MM loop (blocks until stopped)
    logger.info("Starting market maker loop (interval: %.1fs)", config.loop_interval_secs)
    try:
        await mm_loop.start()
    finally:
        for task in (cache_update_task, refresher_task):
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        server.shutdown()
        http_client.close()
        await rpc_client.close()


if __name__ == "__main__":
    asyncio.run(main())
