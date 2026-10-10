"""mm/main.py wiring (M3-08b): spots through the shared cache (Pyth primary, Finnhub fallback),
closes retry throttle. All HTTP goes through httpx.MockTransport; no live provider."""

import json
from datetime import UTC, datetime
from decimal import Decimal

import httpx
import pytest

from meridian_quant.mm.main import (
    CLOSES_RETRY_SECS,
    MarketCache,
    OnChainSources,
    make_spot_cache,
)
from meridian_quant.prices import PriceError, Spot
from meridian_quant.pyth_latest import LATEST_PRICE_URL, PYTH_PRO_FEED_IDS
from meridian_quant.spot_cache import SpotCache

PYTH_TOKEN = "secret-pyth-token-xyz"
FINNHUB_KEY = "secret-finnhub-key-xyz"
UPDATE_US = 1_791_490_000_000_000


class Router:
    """Mock upstream: Pyth latest_price, Finnhub quote and Tiingo daily, each switchable."""

    def __init__(self) -> None:
        self.pyth_ok = True
        self.finnhub_ok = True
        self.tiingo_ok = True
        self.hits: list[str] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url == LATEST_PRICE_URL:
            return self._pyth()
        if url.startswith("https://finnhub.io/"):
            return self._finnhub(request.url.params["symbol"])
        if url.startswith("https://api.tiingo.com/"):
            return self._tiingo()
        return httpx.Response(404)

    def _pyth(self) -> httpx.Response:
        self.hits.append("pyth")
        if not self.pyth_ok:
            return httpx.Response(503)
        feeds = [
            {
                "priceFeedId": feed_id,
                "price": "18142000000",
                "exponent": -8,
                "feedUpdateTimestamp": UPDATE_US,
            }
            for feed_id in PYTH_PRO_FEED_IDS.values()
        ]
        return httpx.Response(200, json={"parsed": {"timestampUs": "1", "priceFeeds": feeds}})

    def _finnhub(self, symbol: str) -> httpx.Response:
        self.hits.append(f"finnhub:{symbol}")
        if not self.finnhub_ok:
            return httpx.Response(429)
        return httpx.Response(200, json={"c": 99.5, "t": 1_791_490_000})

    def _tiingo(self) -> httpx.Response:
        self.hits.append("tiingo")
        if not self.tiingo_ok:
            return httpx.Response(429)
        bars = [
            {"date": f"2026-09-{day:02d}T00:00:00Z", "close": 100 + day % 3} for day in range(1, 29)
        ]
        return httpx.Response(200, content=json.dumps(bars).encode())


def client(router: Router) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(router))


def test_pyth_is_primary_for_all_tickers_in_one_call() -> None:
    router = Router()
    cache = make_spot_cache(client(router), FINNHUB_KEY, PYTH_TOKEN, ttl_secs=5)
    for ticker in PYTH_PRO_FEED_IDS:
        assert cache.get(ticker).price == Decimal("181.42")
    assert router.hits == ["pyth"]


def test_pyth_down_falls_back_to_finnhub() -> None:
    router = Router()
    router.pyth_ok = False
    cache = make_spot_cache(client(router), FINNHUB_KEY, PYTH_TOKEN, ttl_secs=5)
    assert cache.get("NVDA").price == Decimal("99.5")
    assert router.hits == ["pyth", "finnhub:NVDA"]


def test_no_pyth_token_uses_finnhub_only() -> None:
    router = Router()
    cache = make_spot_cache(client(router), FINNHUB_KEY, "", ttl_secs=5)
    cache.get("NVDA")
    assert router.hits == ["finnhub:NVDA"]


def test_everything_down_raises_without_any_key_in_the_error() -> None:
    router = Router()
    router.pyth_ok = False
    router.finnhub_ok = False
    cache = make_spot_cache(client(router), FINNHUB_KEY, PYTH_TOKEN, ttl_secs=5)
    with pytest.raises(PriceError) as caught:
        cache.get("NVDA")
    assert PYTH_TOKEN not in str(caught.value)
    assert FINNHUB_KEY not in str(caught.value)


def test_unexpected_finnhub_errors_become_price_errors() -> None:
    def broken(request: httpx.Request) -> httpx.Response:
        raise ValueError(f"weird failure {FINNHUB_KEY}")

    cache = make_spot_cache(
        httpx.Client(transport=httpx.MockTransport(broken)), FINNHUB_KEY, "", ttl_secs=5
    )
    with pytest.raises(PriceError) as caught:
        cache.get("NVDA")
    assert FINNHUB_KEY not in str(caught.value)


class Ticks:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


def sources(router: Router, ticks: Ticks) -> OnChainSources:
    http = client(router)
    spot_cache = SpotCache(primary=None, fallback=_never, ttl_secs=5)
    return OnChainSources(MarketCache(), http, spot_cache, "tiingo-key", clock=ticks)


def _never(ticker: str) -> Spot:
    raise PriceError(f"{ticker}: not used")


def test_spot_reads_the_shared_cache() -> None:
    fixed = Spot(ticker="NVDA", price=Decimal(1), as_of=datetime(2026, 10, 8, tzinfo=UTC))
    spot_cache = SpotCache(primary=lambda: {"NVDA": fixed}, fallback=_never, ttl_secs=5)
    src = OnChainSources(MarketCache(), client(Router()), spot_cache, "k")
    assert src.spot("NVDA") == fixed


def test_closes_are_cached_per_day() -> None:
    router, ticks = Router(), Ticks()
    src = sources(router, ticks)
    assert len(src.closes("NVDA")) == 28
    src.closes("NVDA")
    assert router.hits == ["tiingo"]


def test_failed_closes_are_not_retried_inside_the_window(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("PYTH_API_TOKEN", raising=False)
    router, ticks = Router(), Ticks()
    router.tiingo_ok = False
    src = sources(router, ticks)
    with pytest.raises(PriceError, match="Failed to fetch closes"):
        src.closes("NVDA")
    with pytest.raises(PriceError, match="retry throttled"):
        src.closes("NVDA")
    assert router.hits == ["tiingo"]
    ticks.now += CLOSES_RETRY_SECS
    router.tiingo_ok = True
    assert len(src.closes("NVDA")) == 28
    assert router.hits == ["tiingo", "tiingo"]
