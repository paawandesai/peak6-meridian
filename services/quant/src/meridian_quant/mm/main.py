"""Production entry point for market maker and quant service.

Usage:
    python -m meridian_quant.mm.main

This process serves:
- GET /fair-values (M3-01): fair value pricing for all open strikes
- GET /health: service status with book_coverage metric (M3-02)
- MM loop (M3-02): two-sided quotes on every open strike

Environment variables (see docs/environment.md):
    MARKET_MAKER_KEYPAIR: JSON array of 64 bytes (required)
    MERIDIAN_PROGRAM_ID: Meridian program ID (required)
    SERVICE_TOKEN: Bearer token for /fair-values (required)
    FINNHUB_API_KEY: Finnhub API key for spot prices (required)
    TIINGO_API_KEY: Tiingo API key for daily closes (required)
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
import threading
from datetime import UTC, datetime
from decimal import Decimal

import httpx
from solana.rpc.async_api import AsyncClient
from solders.keypair import Keypair
from solders.pubkey import Pubkey

from meridian_quant.prices import PriceError, Spot, fetch_daily_closes, fetch_spot
from meridian_quant.server import MarketInfo, Service, make_server

from .chain import ChainMarketSource, ChainOrderClient
from .config import MMConfig
from .loop import MarketMakerLoop
from .onchain import HttpFairValueSource
from .types import MarketState

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)


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

    Markets are cached from the MM loop to avoid async-in-sync event loop issues.
    The HTTP handler thread reads from the cache; the MM loop updates it.
    """

    def __init__(
        self,
        market_cache: MarketCache,
        http_client: httpx.Client,
        finnhub_key: str,
        tiingo_key: str,
    ) -> None:
        self._market_cache = market_cache
        self._http_client = http_client
        self._finnhub_key = finnhub_key
        self._tiingo_key = tiingo_key

    def markets(self) -> list[MarketInfo]:
        """Get open markets from cache (populated by MM loop)."""
        cached_markets = self._market_cache.get()
        return [
            MarketInfo(
                market=m.market,
                ticker=m.ticker,
                strike_cents=m.strike_cents,
                close_ts=m.close_ts,
            )
            for m in cached_markets
            if m.is_open
        ]

    def spot(self, ticker: str) -> Spot:
        """Fetch live spot price from Finnhub."""
        try:
            return fetch_spot(self._http_client, ticker, self._finnhub_key)
        except Exception as e:
            raise PriceError(f"Failed to fetch spot for {ticker}: {e}") from e

    def closes(self, ticker: str) -> list[Decimal]:
        """Fetch daily closes from Tiingo."""
        try:
            today = datetime.now(UTC).date()
            return fetch_daily_closes(self._http_client, ticker, self._tiingo_key, today)
        except Exception as e:
            raise PriceError(f"Failed to fetch closes for {ticker}: {e}") from e


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


async def main() -> None:
    """Start the quant service with MM loop and HTTP endpoints."""
    # Load config from environment
    config = MMConfig()  # type: ignore[call-arg]
    service_token = os.environ["SERVICE_TOKEN"]
    finnhub_key = os.environ["FINNHUB_API_KEY"]
    tiingo_key = os.environ["TIINGO_API_KEY"]
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

    # Create MM loop (for quoting; also fetches fair values internally)
    # Note: MM loop will call this same service's /fair-values endpoint at QUANT_URL
    # Placeholder fair_value_source (will be set after HTTP server starts)
    mm_loop = MarketMakerLoop(
        config=config,
        market_source=market_source,
        fair_value_source=None,  # type: ignore[arg-type]
        order_client=order_client,
    )

    # Create HTTP client for price providers (synchronous, used by HTTP handler thread)
    http_client = httpx.Client(timeout=httpx.Timeout(3.0))

    # Create Sources for /fair-values endpoint (uses market cache, not async calls)
    sources = OnChainSources(market_cache, http_client, finnhub_key, tiingo_key)

    # Create Service with mm_loop injected (enables book_coverage in /health)
    service = Service(sources=sources, token=service_token, mm_loop=mm_loop)

    # Start HTTP server in a thread (ThreadingHTTPServer handles requests synchronously)
    server = make_server(service, host, port)
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    logger.info("HTTP server started on %s:%d (GET /fair-values, GET /health)", host, port)

    # Update MM loop's fair_value_source to point to our own /fair-values endpoint
    fair_value_source = HttpFairValueSource(
        base_url=f"http://127.0.0.1:{port}", service_token=service_token
    )
    mm_loop._fair_value_source = fair_value_source

    # Start background task to update market cache (for /fair-values endpoint)
    cache_update_task = asyncio.create_task(
        update_market_cache(market_source, market_cache, interval_secs=30.0)
    )

    # Start MM loop (blocks until stopped)
    logger.info("Starting market maker loop (interval: %.1fs)", config.loop_interval_secs)
    try:
        await mm_loop.start()
    finally:
        cache_update_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await cache_update_task
        server.shutdown()
        http_client.close()
        await rpc_client.close()


if __name__ == "__main__":
    asyncio.run(main())
