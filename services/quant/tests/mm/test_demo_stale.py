"""Devnet demo flag: waives the spot-age rule only, never the quant service's `stale` flag.

Railway 2026-10-10 (M3-08b): the fair-value cache serves the last value with stale=True when a
refresh fails or the value is too old. Under MERIDIAN_DEMO_ALLOW_STALE_SPOT the MM used to skip
the whole stale check and would have quoted from such a value.
"""

import json
from datetime import UTC, datetime, timedelta

import pytest
from hypothesis import given
from hypothesis import strategies as st
from solders.keypair import Keypair

from meridian_quant.mm.config import MMConfig
from meridian_quant.mm.fakes import FakeFairValueSource, FakeMarketSource, FakeOrderClient
from meridian_quant.mm.loop import MarketMakerLoop
from meridian_quant.mm.types import FairValue

NOW = datetime(2026, 10, 10, 20, 0, tzinfo=UTC)
DEMO_ENV = {
    "MERIDIAN_DEMO_ALLOW_STALE_SPOT": "1",
    "SOLANA_CLUSTER": "devnet",
    "SOLANA_RPC_URL": "https://api.devnet.solana.com",
}


def _config() -> MMConfig:
    return MMConfig.model_validate(
        {
            "market_maker_keypair": json.dumps(list(bytes(Keypair()))),
            "program_id": "11111111111111111111111111111112",
            "usdc_mint": "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
            "service_token": "test_token",
        }
    )


def _mm() -> MarketMakerLoop:
    return MarketMakerLoop(
        _config(),
        market_source=FakeMarketSource(),
        fair_value_source=FakeFairValueSource(),
        order_client=FakeOrderClient(),
        clock=lambda: NOW,
    )


def _fv(*, age_secs: float, stale: bool) -> FairValue:
    return FairValue(
        market="m",
        ticker="NVDA",
        strike_cents=23000,
        fair_cents=50,
        sigma=0.25,
        spot=229.31,
        as_of=NOW - timedelta(seconds=age_secs),
        stale=stale,
    )


@pytest.fixture
def demo(monkeypatch: pytest.MonkeyPatch) -> None:
    for key, value in DEMO_ENV.items():
        monkeypatch.setenv(key, value)


def test_demo_quotes_from_an_old_spot_that_is_not_flagged_stale(demo: None) -> None:
    # Weekend: Friday's last Pyth print is a day old, the refresh itself is fresh.
    assert _mm()._should_pull_all_quotes([_fv(age_secs=86_400, stale=False)], []) is False


def test_demo_still_pulls_on_a_value_flagged_stale(demo: None) -> None:
    assert _mm()._should_pull_all_quotes([_fv(age_secs=1, stale=True)], []) is True


def test_without_demo_an_old_spot_still_pulls(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("MERIDIAN_DEMO_ALLOW_STALE_SPOT", raising=False)
    assert _mm()._should_pull_all_quotes([_fv(age_secs=15, stale=False)], []) is True


@given(ages=st.lists(st.floats(0, 200_000), min_size=1, max_size=8), stale_at=st.integers(0, 7))
def test_demo_pulls_iff_any_value_is_flagged_stale(ages: list[float], stale_at: int) -> None:
    with pytest.MonkeyPatch.context() as mp:
        for key, value in DEMO_ENV.items():
            mp.setenv(key, value)
        values = [_fv(age_secs=a, stale=(i == stale_at)) for i, a in enumerate(ages)]
        expected = stale_at < len(ages)
        assert _mm()._should_pull_all_quotes(values, []) is expected
