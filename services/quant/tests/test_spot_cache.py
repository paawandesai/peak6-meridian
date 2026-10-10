"""Shared spot cache (M3-08b): TTL, Pyth-primary/Finnhub-fallback, no caching of failures,
retry throttling and single-flight under concurrency. Providers are fakes; no HTTP."""

import threading
import time
from collections.abc import Mapping
from datetime import UTC, datetime
from decimal import Decimal

import pytest
from hypothesis import given
from hypothesis import strategies as st

from meridian_quant.prices import PriceError, Spot
from meridian_quant.spot_cache import SpotCache

AS_OF = datetime(2026, 10, 8, 18, 0, tzinfo=UTC)
TICKERS = ("AAPL", "AMZN", "GOOGL", "META", "MSFT", "NVDA", "TSLA")


def spot(ticker: str, price: str = "100") -> Spot:
    return Spot(ticker=ticker, price=Decimal(price), as_of=AS_OF)


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


class Primary:
    def __init__(self, tickers: tuple[str, ...] = TICKERS, fail: bool = False) -> None:
        self.tickers = tickers
        self.fail = fail
        self.calls = 0

    def __call__(self) -> Mapping[str, Spot]:
        self.calls += 1
        if self.fail:
            raise PriceError("pyth status 503")
        return {t: spot(t, "200") for t in self.tickers}


class Fallback:
    def __init__(self, fail: bool = False) -> None:
        self.fail = fail
        self.calls: list[str] = []

    def __call__(self, ticker: str) -> Spot:
        self.calls.append(ticker)
        if self.fail:
            raise PriceError("provider status 429")
        return spot(ticker, "100")


def test_one_primary_call_serves_all_tickers_within_the_ttl() -> None:
    clock, primary, fallback = Clock(), Primary(), Fallback()
    cache = SpotCache(primary=primary, fallback=fallback, ttl_secs=5, clock=clock)
    for ticker in TICKERS:
        assert cache.get(ticker).price == Decimal(200)
        assert cache.source(ticker) == "primary"
    clock.now += 4.9
    for ticker in TICKERS:
        cache.get(ticker)
    assert primary.calls == 1
    assert fallback.calls == []


def test_expired_entries_are_refetched_once() -> None:
    clock, primary = Clock(), Primary()
    cache = SpotCache(primary=primary, fallback=Fallback(), ttl_secs=5, clock=clock)
    cache.get("NVDA")
    clock.now += 5
    cache.get("NVDA")
    cache.get("AAPL")
    assert primary.calls == 2


def test_pyth_down_falls_back_to_finnhub_per_ticker() -> None:
    clock, primary, fallback = Clock(), Primary(fail=True), Fallback()
    cache = SpotCache(primary=primary, fallback=fallback, ttl_secs=5, clock=clock)
    assert cache.get("NVDA").price == Decimal(100)
    assert cache.get("AAPL").price == Decimal(100)
    assert cache.source("NVDA") == "fallback"
    assert primary.calls == 1  # the failed primary is not retried within the window
    assert fallback.calls == ["NVDA", "AAPL"]
    cache.get("NVDA")
    assert fallback.calls == ["NVDA", "AAPL"]  # cached for the TTL


def test_ticker_missing_from_pyth_uses_finnhub() -> None:
    primary, fallback = Primary(tickers=("AAPL",)), Fallback()
    cache = SpotCache(primary=primary, fallback=fallback, ttl_secs=5, clock=Clock())
    assert cache.get("AAPL").price == Decimal(200)
    assert cache.get("NVDA").price == Decimal(100)
    assert fallback.calls == ["NVDA"]


def test_without_a_primary_only_the_fallback_is_used() -> None:
    fallback = Fallback()
    cache = SpotCache(primary=None, fallback=fallback, ttl_secs=5, clock=Clock())
    cache.get("NVDA")
    cache.get("NVDA")
    assert fallback.calls == ["NVDA"]


def test_all_down_raises_and_caches_nothing_then_retries_after_the_window() -> None:
    clock, primary, fallback = Clock(), Primary(fail=True), Fallback(fail=True)
    cache = SpotCache(primary=primary, fallback=fallback, ttl_secs=5, clock=clock)
    with pytest.raises(PriceError, match="NVDA: spot unavailable"):
        cache.get("NVDA")
    # Within the window: no upstream call at all (the provider is not hammered).
    with pytest.raises(PriceError, match="retry throttled"):
        cache.get("NVDA")
    assert primary.calls == 1
    assert fallback.calls == ["NVDA"]
    assert cache.source("NVDA") is None  # the failure stored no value
    # After the window, both providers are tried again; a recovery is served at once.
    clock.now += 5
    fallback.fail = False
    assert cache.get("NVDA").price == Decimal(100)
    assert primary.calls == 2
    assert fallback.calls == ["NVDA", "NVDA"]


def test_ttl_must_be_positive() -> None:
    with pytest.raises(ValueError, match="ttl"):
        SpotCache(primary=None, fallback=Fallback(), ttl_secs=0)


def test_concurrent_gets_share_one_in_flight_fetch() -> None:
    """Single-flight: 16 threads asking at once cause one upstream call, not 16."""
    gate = threading.Event()
    calls = 0
    calls_lock = threading.Lock()

    def slow_primary() -> Mapping[str, Spot]:
        nonlocal calls
        with calls_lock:
            calls += 1
        gate.wait(timeout=5)
        return {t: spot(t) for t in TICKERS}

    cache = SpotCache(primary=slow_primary, fallback=Fallback(fail=True), ttl_secs=5)
    results: list[Spot] = []
    errors: list[BaseException] = []

    def worker(ticker: str) -> None:
        try:
            results.append(cache.get(ticker))
        except BaseException as error:  # collected and asserted below
            errors.append(error)

    threads = [threading.Thread(target=worker, args=(TICKERS[i % 7],)) for i in range(16)]
    for thread in threads:
        thread.start()
    time.sleep(0.05)  # let every thread reach the cache while the fetch is in flight
    gate.set()
    for thread in threads:
        thread.join(timeout=5)
    assert errors == []
    assert len(results) == 16
    assert calls == 1


@given(st.lists(st.floats(min_value=0, max_value=3, allow_nan=False), min_size=1, max_size=60))
def test_at_most_one_upstream_fetch_per_ticker_per_ttl(gaps: list[float]) -> None:
    """Property: whatever the request timing, primary calls are >= TTL apart."""
    clock = Clock()
    call_times: list[float] = []

    def primary() -> Mapping[str, Spot]:
        call_times.append(clock.now)
        return {t: spot(t) for t in TICKERS}

    cache = SpotCache(primary=primary, fallback=Fallback(fail=True), ttl_secs=5, clock=clock)
    for gap in gaps:
        clock.now += gap
        cache.get("NVDA")
        cache.get("AAPL")
    assert all(b - a >= 5 for a, b in zip(call_times, call_times[1:], strict=False))
