"""MM pull-on-stale stays, logged loudly once then rate-limited (M3-08b)."""

import json
import logging
from datetime import UTC, datetime, timedelta

import pytest
from solders.keypair import Keypair

from meridian_quant.mm.config import MMConfig
from meridian_quant.mm.fakes import FakeFairValueSource, FakeMarketSource, FakeOrderClient
from meridian_quant.mm.loop import PULL_LOG_INTERVAL_SECS, MarketMakerLoop
from meridian_quant.mm.types import FairValue, MarketState

NOW = datetime(2026, 10, 8, 18, 0, tzinfo=UTC)  # 14:00 EDT
CLOSE = int(datetime(2026, 10, 8, 20, 0, tzinfo=UTC).timestamp())
MARKET = MarketState(
    market="NVDA_20261008_18000",
    ticker="NVDA",
    strike_cents=18_000,
    trading_date=20261008,
    close_ts=CLOSE,
    is_open=True,
    pairs_outstanding=0,
)


def config() -> MMConfig:
    return MMConfig.model_validate(
        {
            "market_maker_keypair": json.dumps(list(bytes(Keypair()))),
            "program_id": "11111111111111111111111111111112",
            "usdc_mint": "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
            "service_token": "test_token",
        }
    )


def fair_value(as_of: datetime, stale: bool) -> FairValue:
    return FairValue(
        market=MARKET.market,
        ticker="NVDA",
        strike_cents=18_000,
        fair_cents=55,
        sigma=0.3,
        spot=181.0,
        as_of=as_of,
        stale=stale,
    )


class Clock:
    def __init__(self) -> None:
        self.at = NOW

    def __call__(self) -> datetime:
        return self.at


def loud(caplog: pytest.LogCaptureFixture, text: str) -> int:
    return sum(1 for r in caplog.records if r.levelno >= logging.INFO and text in r.getMessage())


@pytest.mark.asyncio
async def test_stale_value_pulls_quotes_and_logs_once_per_interval(
    caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("MERIDIAN_DEMO_ALLOW_STALE_SPOT", raising=False)
    clock = Clock()
    fv_source = FakeFairValueSource([fair_value(NOW, stale=True)])
    orders = FakeOrderClient()
    mm = MarketMakerLoop(config(), FakeMarketSource([MARKET]), fv_source, orders, clock=clock)
    with caplog.at_level(logging.DEBUG, logger="meridian_quant.mm.loop"):
        for _ in range(6):  # 30 s of 5 s iterations
            await mm._run_once()
            clock.at += timedelta(seconds=5)
    assert orders.get_all_orders().get(MARKET.market, []) == []  # never quoted a stale value
    assert loud(caplog, "Pulling all quotes: stale fair value for NVDA") == 1
    assert any(
        r.levelno == logging.DEBUG and "stale fair value" in r.getMessage() for r in caplog.records
    )
    clock.at += timedelta(seconds=PULL_LOG_INTERVAL_SECS)
    with caplog.at_level(logging.DEBUG, logger="meridian_quant.mm.loop"):
        await mm._run_once()
    assert loud(caplog, "Pulling all quotes: stale fair value for NVDA") == 2


@pytest.mark.asyncio
async def test_quoting_resumes_once_values_are_fresh(
    caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("MERIDIAN_DEMO_ALLOW_STALE_SPOT", raising=False)
    clock = Clock()
    fv_source = FakeFairValueSource([])
    orders = FakeOrderClient()
    mm = MarketMakerLoop(config(), FakeMarketSource([MARKET]), fv_source, orders, clock=clock)
    with caplog.at_level(logging.DEBUG, logger="meridian_quant.mm.loop"):
        await mm._run_once()
        await mm._run_once()
        assert loud(caplog, "Pulling all quotes: no fair values available") == 1
        fv_source._fair_values = [fair_value(clock.at - timedelta(seconds=1), stale=False)]
        await mm._run_once()
        await mm._run_once()
    assert loud(caplog, "Resuming quotes") == 1
    assert orders.count_orders_by_owner(MARKET.market, str(mm.keypair.pubkey())) == 2


@pytest.mark.asyncio
async def test_near_close_pull_is_logged_at_info_rate_limited(
    caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("MERIDIAN_DEMO_ALLOW_STALE_SPOT", raising=False)
    clock = Clock()
    clock.at = datetime.fromtimestamp(CLOSE - 60, tz=UTC)
    fv_source = FakeFairValueSource([fair_value(clock.at, stale=False)])
    mm = MarketMakerLoop(
        config(), FakeMarketSource([MARKET]), fv_source, FakeOrderClient(), clock=clock
    )
    with caplog.at_level(logging.DEBUG, logger="meridian_quant.mm.loop"):
        await mm._run_once()
        await mm._run_once()
    infos = [r for r in caplog.records if "to close for NVDA" in r.getMessage()]
    assert [r.levelno for r in infos] == [logging.INFO, logging.DEBUG]
