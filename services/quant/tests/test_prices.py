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


def test_spot_replay_mode_uses_tiingo_eod_for_replay_date() -> None:
    """In replay mode, fetch_spot uses Tiingo EOD close for the replay date as the spot price."""
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=[{"date": "2024-10-08T00:00:00.000Z", "close": 175.50}])

    spot = fetch_spot(
        client(httpx.MockTransport(handler)),
        "AAPL",
        "finnhub-key",
        demo_mode="replay",
        demo_replay_date=date(2024, 10, 8),
        tiingo_key="tiingo-key",
    )
    assert spot.ticker == "AAPL"
    assert spot.price == Decimal("175.50")
    assert spot.as_of == datetime(2024, 10, 8, 0, 0, 0, tzinfo=UTC)
    # Should use Tiingo, not Finnhub
    assert len(seen) == 1
    assert seen[0].url.path == "/tiingo/daily/aapl/prices"
    assert "tiingo-key" in seen[0].headers.get("Authorization", "")


def test_spot_replay_mode_requires_tiingo_key() -> None:
    with pytest.raises(PriceError, match="tiingo_key required"):
        fetch_spot(
            client(),
            "AAPL",
            "finnhub-key",
            demo_mode="replay",
            demo_replay_date=date(2024, 10, 8),
            tiingo_key=None,
        )


def test_spot_replay_mode_requires_replay_date() -> None:
    with pytest.raises(PriceError, match="demo_replay_date required"):
        fetch_spot(
            client(),
            "AAPL",
            "finnhub-key",
            demo_mode="replay",
            demo_replay_date=None,
            tiingo_key="k",
        )


def test_spot_replay_mode_rejects_no_data() -> None:
    with pytest.raises(PriceError, match="no replay price"):
        fetch_spot(
            client(json=[]),
            "AAPL",
            "finnhub-key",
            demo_mode="replay",
            demo_replay_date=date(2024, 10, 8),
            tiingo_key="k",
        )


def test_daily_closes_replay_mode_fetches_before_replay_date() -> None:
    """In replay mode, fetch_daily_closes ends one day before the replay date."""
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(
            200,
            json=[
                {"date": "2024-10-05T00:00:00.000Z", "close": 173.0},
                {"date": "2024-10-07T00:00:00.000Z", "close": 174.5},
            ],
        )

    closes = fetch_daily_closes(
        client(httpx.MockTransport(handler)),
        "AAPL",
        "tiingo-key",
        date(2024, 10, 8),
        demo_mode="replay",
        demo_replay_date=date(2024, 10, 8),
    )
    assert closes == [Decimal("173.0"), Decimal("174.5")]
    # Should fetch data ending Oct 7 (one day before Oct 8 replay date)
    params = dict(seen[0].url.params)
    assert params["endDate"] == "2024-10-07"


def test_daily_closes_replay_mode_requires_replay_date() -> None:
    with pytest.raises(PriceError, match="demo_replay_date required"):
        fetch_daily_closes(
            client(),
            "AAPL",
            "k",
            date(2024, 10, 8),
            demo_mode="replay",
            demo_replay_date=None,
        )
