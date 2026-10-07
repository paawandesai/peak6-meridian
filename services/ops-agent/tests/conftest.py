"""Shared fixtures for the ops-agent unit tests. Nothing here touches the network."""

from datetime import UTC, date, datetime

import pytest
from meridian_ops_agent.models import Evidence, Incident, SourceClose, SourceReport

AS_OF = datetime(2026, 10, 6, 20, 5, tzinfo=UTC)
TRADING_DATE = date(2026, 10, 6)
MARKETS = ["AAPL-20261006-250", "AAPL-20261006-260"]


def make_close(name: str, cents: int) -> SourceClose:
    return SourceClose(name=name, close_cents=cents, as_of=AS_OF)


def make_report(name: str, cents: int | None, raw: str = "") -> SourceReport:
    close = make_close(name, cents) if cents is not None else None
    return SourceReport(name=name, close=close, raw=raw)


@pytest.fixture
def incident() -> Incident:
    return Incident(
        incident_id="inc-1",
        ticker="AAPL",
        trading_date=TRADING_DATE,
        markets=MARKETS,
        failure="settle_market retried 30 times; feed stale",
    )


@pytest.fixture
def closes() -> list[SourceClose]:
    return [make_close("tiingo", 25012), make_close("twelvedata", 25010)]


@pytest.fixture
def evidence(closes: list[SourceClose]) -> Evidence:
    return Evidence(ticker="AAPL", trading_date=TRADING_DATE, closes=closes)


@pytest.fixture
def reports() -> list[SourceReport]:
    return [
        make_report("tiingo", 25012, '{"close":250.12}'),
        make_report("twelvedata", 25010, '{"close":"250.10"}'),
    ]
