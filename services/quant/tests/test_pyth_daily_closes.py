"""Pyth daily-closes fallback parsing."""

from datetime import date
from decimal import Decimal

import httpx
import pytest

from meridian_quant.prices import PriceError, fetch_daily_closes_pyth


def _client(payload: object, status: int = 200) -> httpx.Client:
    return httpx.Client(
        transport=httpx.MockTransport(lambda req: httpx.Response(status, json=payload))
    )


def test_parses_closes_oldest_first() -> None:
    client = _client({"s": "ok", "t": [2, 1], "c": [11.5, 10.25]})
    assert fetch_daily_closes_pyth(client, "AAPL", "tok", date(2026, 10, 9)) == [
        Decimal("10.25"),
        Decimal("11.5"),
    ]


def test_errors_raise_price_error() -> None:
    with pytest.raises(PriceError):
        fetch_daily_closes_pyth(_client({"s": "no_data"}), "AAPL", "tok", date(2026, 10, 9))
    with pytest.raises(PriceError):
        fetch_daily_closes_pyth(_client({}, 429), "AAPL", "tok", date(2026, 10, 9))
