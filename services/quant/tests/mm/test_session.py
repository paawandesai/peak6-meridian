"""Session trading date: today in ET, or the earliest date that still has live markets."""

import logging
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from hypothesis import given
from hypothesis import strategies as st

import meridian_quant.mm.main  # noqa: F401  (import applies the logger levels under test)
from meridian_quant.mm.session import et_trading_date, session_trading_date

# Saturday 2026-10-10 12:00 ET (16:00 UTC)
SAT_NOON = datetime(2026, 10, 10, 16, 0, tzinfo=UTC)


@dataclass(frozen=True)
class M:
    trading_date: int
    close_ts: int
    is_open: bool = True


def ts(dt: datetime) -> int:
    return int(dt.timestamp())


def test_et_trading_date_uses_new_york_not_utc() -> None:
    # 2026-10-10 02:00 UTC is still 2026-10-09 in New York (EDT, UTC-4)
    assert et_trading_date(datetime(2026, 10, 10, 2, 0, tzinfo=UTC)) == 20261009
    # Winter: 2026-12-01 04:30 UTC is 2026-11-30 23:30 EST (UTC-5)
    assert et_trading_date(datetime(2026, 12, 1, 4, 30, tzinfo=UTC)) == 20261130


def test_no_markets_is_today() -> None:
    assert session_trading_date([], SAT_NOON) == 20261010


def test_today_live_wins_over_other_dates() -> None:
    markets = [
        M(20261010, ts(SAT_NOON + timedelta(hours=1))),
        M(20261011, ts(SAT_NOON + timedelta(days=1))),
    ]
    assert session_trading_date(markets, SAT_NOON) == 20261010


def test_today_all_closed_moves_to_demo_session() -> None:
    # Saturday's markets are past close; Sunday demo markets close tomorrow evening
    markets = [
        M(20261010, ts(SAT_NOON - timedelta(hours=6))),
        M(20261009, ts(SAT_NOON - timedelta(hours=20))),
        M(20261011, ts(SAT_NOON + timedelta(hours=32))),
    ]
    assert session_trading_date(markets, SAT_NOON) == 20261011


def test_only_prior_day_markets_past_close_is_today() -> None:
    # AB-11: unsettled prior-day markets never become the session
    markets = [M(20261009, ts(SAT_NOON - timedelta(hours=20)))]
    assert session_trading_date(markets, SAT_NOON) == 20261010


def test_settled_markets_are_ignored() -> None:
    markets = [M(20261011, ts(SAT_NOON + timedelta(hours=5)), is_open=False)]
    assert session_trading_date(markets, SAT_NOON) == 20261010


def test_earliest_live_date_is_chosen() -> None:
    markets = [
        M(20261013, ts(SAT_NOON + timedelta(days=3))),
        M(20261011, ts(SAT_NOON + timedelta(days=1))),
    ]
    assert session_trading_date(markets, SAT_NOON) == 20261011


def test_market_closing_exactly_now_is_not_live() -> None:
    markets = [M(20261011, ts(SAT_NOON))]
    assert session_trading_date(markets, SAT_NOON) == 20261010


market_st = st.builds(
    M,
    trading_date=st.sampled_from([20261008, 20261009, 20261010, 20261011, 20261012]),
    close_ts=st.integers(ts(SAT_NOON) - 3 * 86_400, ts(SAT_NOON) + 3 * 86_400),
    is_open=st.booleans(),
)


@given(st.lists(market_st, max_size=30))
def test_session_is_today_or_a_live_date(markets: list[M]) -> None:
    session = session_trading_date(markets, SAT_NOON)
    now = ts(SAT_NOON)
    live = {m.trading_date for m in markets if m.is_open and m.close_ts > now}
    if session != 20261010:
        # Never a date without a live market, and today had none
        assert session in live
        assert 20261010 not in live
        assert session == min(live)
    else:
        assert 20261010 in live or not live


def test_mm_main_keeps_httpx_quiet() -> None:
    """httpx logs full request URLs (RPC API keys) at INFO; main pins it to WARNING."""
    assert logging.getLogger("httpx").getEffectiveLevel() >= logging.WARNING
    assert logging.getLogger("httpcore").getEffectiveLevel() >= logging.WARNING
