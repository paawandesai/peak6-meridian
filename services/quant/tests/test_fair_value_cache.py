"""Background fair-value cache (M3-08b): computed once per tick, read by /fair-values and the MM;
last value kept with stale=true when a refresh fails; never-valued markets omitted."""

import asyncio
import json
import logging
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest

from meridian_quant.fair_value_cache import (
    MAX_INPUT_AGE_SECS,
    CachedFairValueSource,
    FairValueCache,
    run_refresher,
)
from meridian_quant.prices import PriceError, Spot
from meridian_quant.ratelog import RateLimitedLog
from meridian_quant.server import MarketInfo, Service, handle_request

T0 = datetime(2026, 10, 8, 18, 0, tzinfo=UTC)  # 14:00 EDT
CLOSE = int(datetime(2026, 10, 8, 20, 0, tzinfo=UTC).timestamp())
TOKEN = "local-dev-token"
NVDA = MarketInfo(market="NVDA_180", ticker="NVDA", strike_cents=18_000, close_ts=CLOSE)
AAPL = MarketInfo(market="AAPL_230", ticker="AAPL", strike_cents=23_000, close_ts=CLOSE)


class Now:
    def __init__(self) -> None:
        self.at = T0

    def __call__(self) -> datetime:
        return self.at


class Sources:
    def __init__(self, now: Now) -> None:
        self.now = now
        self.market_list = [NVDA, AAPL]
        self.down: set[str] = set()
        self.markets_fail = False
        self.spot_calls = 0

    def markets(self) -> list[MarketInfo]:
        if self.markets_fail:
            raise RuntimeError("market cache unavailable")
        return list(self.market_list)

    def spot(self, ticker: str) -> Spot:
        self.spot_calls += 1
        if ticker in self.down:
            raise PriceError(f"{ticker}: spot unavailable")
        price = Decimal("181.42") if ticker == "NVDA" else Decimal("231.10")
        return Spot(ticker=ticker, price=price, as_of=self.now.at - timedelta(seconds=1))

    def closes(self, ticker: str) -> list[Decimal]:
        return [Decimal(100) + (i % 3) for i in range(30)]


def setup() -> tuple[Now, Sources, FairValueCache]:
    now = Now()
    sources = Sources(now)
    return now, sources, FairValueCache(sources, now=now)


def by_market(cache: FairValueCache) -> dict[str, bool]:
    return {fv.market: fv.stale for fv in cache.snapshot()}


def test_empty_before_the_first_refresh() -> None:
    _, _, cache = setup()
    assert cache.snapshot() == []


def test_refresh_prices_every_open_market() -> None:
    _, sources, cache = setup()
    cache.refresh()
    values = cache.snapshot()
    assert [fv.market for fv in values] == ["NVDA_180", "AAPL_230"]
    assert all(1 <= fv.fair_cents <= 99 and not fv.stale for fv in values)
    assert sources.spot_calls == 2


def test_failed_refresh_keeps_the_last_value_marked_stale() -> None:
    now, sources, cache = setup()
    cache.refresh()
    before = {fv.market: fv for fv in cache.snapshot()}
    now.at += timedelta(seconds=2)
    sources.down = {"NVDA"}
    cache.refresh()
    after = {fv.market: fv for fv in cache.snapshot()}
    assert after["NVDA_180"].stale is True
    assert after["NVDA_180"].fair_cents == before["NVDA_180"].fair_cents  # the LAST value
    assert after["NVDA_180"].as_of == before["NVDA_180"].as_of
    assert after["AAPL_230"].stale is False
    # Recovery clears the flag on the next refresh.
    sources.down = set()
    cache.refresh()
    assert by_market(cache) == {"NVDA_180": False, "AAPL_230": False}


def test_all_providers_down_serves_last_values_stale() -> None:
    now, sources, cache = setup()
    cache.refresh()
    sources.down = {"NVDA", "AAPL"}
    now.at += timedelta(seconds=2)
    cache.refresh()
    assert by_market(cache) == {"NVDA_180": True, "AAPL_230": True}


def test_market_never_valued_is_omitted() -> None:
    _, sources, cache = setup()
    sources.down = {"AAPL"}
    cache.refresh()
    assert by_market(cache) == {"NVDA_180": False}


def test_value_older_than_30s_is_stale_even_without_a_failed_refresh() -> None:
    now, _, cache = setup()
    cache.refresh()
    now.at += timedelta(seconds=MAX_INPUT_AGE_SECS)
    assert set(by_market(cache).values()) == {False}
    now.at += timedelta(seconds=1)
    assert set(by_market(cache).values()) == {True}


def test_spot_older_than_10s_is_stale_at_compute_time() -> None:
    now, sources, cache = setup()

    def old_spot(ticker: str) -> Spot:
        return Spot(ticker=ticker, price=Decimal("181.42"), as_of=now.at - timedelta(seconds=11))

    sources.spot = old_spot  # type: ignore[method-assign]
    cache.refresh()
    assert set(by_market(cache).values()) == {True}


def test_market_leaving_the_open_list_is_dropped() -> None:
    _, sources, cache = setup()
    cache.refresh()
    sources.market_list = [NVDA]
    cache.refresh()
    assert by_market(cache) == {"NVDA_180": False}


def test_market_list_failure_marks_every_value_stale() -> None:
    _, sources, cache = setup()
    cache.refresh()
    sources.markets_fail = True
    cache.refresh()
    assert by_market(cache) == {"NVDA_180": True, "AAPL_230": True}


def test_persistent_failures_are_logged_rate_limited(caplog: pytest.LogCaptureFixture) -> None:
    now, sources, _ = setup()
    ticks = [0.0]
    cache = FairValueCache(
        sources,
        now=now,
        warn_log=RateLimitedLog(logging.getLogger("t.fv"), 60, clock=lambda: ticks[0]),
    )
    sources.down = {"AAPL"}
    with caplog.at_level(logging.DEBUG, logger="t.fv"):
        for _ in range(10):
            cache.refresh()
            ticks[0] += 1.5
    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert len(warnings) == 1
    assert "AAPL" in warnings[0].getMessage()


def test_http_requests_read_the_cache_and_never_call_providers() -> None:
    _, sources, cache = setup()
    cache.refresh()
    calls = sources.spot_calls
    service = Service(sources=sources, token=TOKEN, fair_values=cache.snapshot)
    for _ in range(20):
        status, body = handle_request(service, "GET", "/fair-values", f"Bearer {TOKEN}")
        assert status == 200
    assert sources.spot_calls == calls
    rows = json.loads(body)
    assert [row["market"] for row in rows] == ["NVDA_180", "AAPL_230"]
    assert set(rows[0]) == {
        "market",
        "ticker",
        "strike_cents",
        "fair_cents",
        "sigma",
        "spot",
        "as_of",
        "stale",
    }
    # Auth is still enforced in front of the cache.
    assert handle_request(service, "GET", "/fair-values", None)[0] == 401


@pytest.mark.asyncio
async def test_mm_source_reads_the_cache_in_process() -> None:
    now, sources, cache = setup()
    source = CachedFairValueSource(cache)
    assert await source.fetch_fair_values() == []
    cache.refresh()
    values = await source.fetch_fair_values()
    assert [fv.market for fv in values] == ["NVDA_180", "AAPL_230"]
    assert values[0].spot == pytest.approx(181.42)
    assert values[0].stale is False
    sources.down = {"NVDA"}
    now.at += timedelta(seconds=2)
    cache.refresh()
    values = await source.fetch_fair_values()
    assert values[0].stale is True  # the MM's pull-on-stale rule sees it


@pytest.mark.asyncio
async def test_refresher_runs_and_survives_a_failing_refresh(
    caplog: pytest.LogCaptureFixture,
) -> None:
    class Flaky(FairValueCache):
        def __init__(self) -> None:
            self.calls = 0

        def refresh(self) -> None:
            self.calls += 1
            if self.calls == 1:
                raise RuntimeError("boom")

    flaky = Flaky()
    with caplog.at_level(logging.ERROR, logger="meridian_quant.fair_value_cache"):
        await asyncio.wait_for(run_refresher(flaky, interval_secs=0, iterations=3), timeout=5)
    assert flaky.calls == 3
    assert "fair-value refresh failed" in caplog.text
