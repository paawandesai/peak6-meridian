import json
from datetime import UTC, date, datetime
from decimal import Decimal

import httpx
import pytest
from meridian_quant.prices import PriceError, fetch_daily_closes, fetch_spot


def client(handler: httpx.MockTransport | None = None, **kwargs: object) -> httpx.Client:
    def respond(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, **kwargs)  # type: ignore[arg-type]

    return httpx.Client(transport=handler or httpx.MockTransport(respond))


def test_spot_parses_finnhub_quote_and_sends_key_in_header_only() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"c": 181.42, "t": 1_791_490_000})

    spot = fetch_spot(client(httpx.MockTransport(handler)), "NVDA", "secret-key")
    assert spot.price == Decimal("181.42")
    assert spot.as_of == datetime.fromtimestamp(1_791_490_000, tz=UTC)
    assert seen[0].headers["X-Finnhub-Token"] == "secret-key"
    assert "secret-key" not in str(seen[0].url)


@pytest.mark.parametrize(
    "body", [{"c": 0, "t": 0}, {"c": 5, "t": 0}, {"c": "x"}, [1], {"c": None, "t": 1}]
)
def test_spot_rejects_missing_or_malformed(body: object) -> None:
    with pytest.raises(PriceError):
        fetch_spot(client(json=body), "NVDA", "k")


def test_provider_errors_are_price_errors_without_the_key() -> None:
    def boom(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectTimeout("timed out", request=request)

    with pytest.raises(PriceError, match="ConnectTimeout") as timeout:
        fetch_spot(client(httpx.MockTransport(boom)), "NVDA", "secret-key")
    assert "secret-key" not in str(timeout.value)
    with pytest.raises(PriceError, match="status 503"):
        fetch_spot(client(httpx.MockTransport(lambda r: httpx.Response(503))), "NVDA", "secret-key")


def test_daily_closes_sorted_oldest_first() -> None:
    bars = [
        {"date": "2026-10-07T00:00:00.000Z", "close": 102.5},
        {"date": "2026-10-05T00:00:00.000Z", "close": 100.0},
        {"date": "2026-10-06T00:00:00.000Z", "close": 101.25},
    ]
    closes = fetch_daily_closes(client(json=bars), "NVDA", "k", date(2026, 10, 8))
    assert closes == [Decimal("100.0"), Decimal("101.25"), Decimal("102.5")]


@pytest.mark.parametrize("content", [b"not json", json.dumps({"a": 1}).encode(), b'[{"x":1}]'])
def test_daily_closes_reject_malformed(content: bytes) -> None:
    with pytest.raises(PriceError, match="malformed"):
        fetch_daily_closes(client(content=content), "NVDA", "k", date(2026, 10, 8))


@pytest.mark.parametrize(
    "ticker", ["", "nvda", "NV/DA", "NVDA?x=1", "../x", "TOOLONGSYM", "NVDA\n"]
)
def test_bad_ticker_is_rejected_before_any_request(ticker: str) -> None:
    def unreachable(request: httpx.Request) -> httpx.Response:
        raise AssertionError("no request may be sent")

    http = client(httpx.MockTransport(unreachable))
    with pytest.raises(PriceError, match="invalid ticker"):
        fetch_spot(http, ticker, "k")
    with pytest.raises(PriceError, match="invalid ticker"):
        fetch_daily_closes(http, ticker, "k", date(2026, 10, 8))


def test_tiingo_path_uses_the_quoted_lowercase_symbol() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=[])

    fetch_daily_closes(client(httpx.MockTransport(handler)), "NVDA", "k", date(2026, 10, 8))
    assert seen[0].url.path == "/tiingo/daily/nvda/prices"
