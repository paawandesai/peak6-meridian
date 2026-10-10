"""Tests for production Sources implementation (M4-08)."""

from datetime import date
from decimal import Decimal

import httpx

from meridian_quant.config import QuantConfig
from meridian_quant.production_sources import ProductionSources
from meridian_quant.server import MarketInfo


def test_markets_returns_configured_list() -> None:
    """markets() returns the market list passed to constructor."""
    market_list = [
        MarketInfo(market="M1", ticker="AAPL", strike_cents=17500, close_ts=1234567890),
        MarketInfo(market="M2", ticker="NVDA", strike_cents=18000, close_ts=1234567890),
    ]
    config = QuantConfig(
        demo_mode="live",
        demo_replay_date=None,
        tiingo_api_key="k",
        finnhub_api_key="k",
        service_token="t",
    )
    sources = ProductionSources(config, httpx.Client(), market_list, today=date(2024, 10, 8))
    assert sources.markets() == market_list


def test_spot_in_live_mode_calls_fetch_spot_with_live_params() -> None:
    """spot() in live mode calls fetch_spot with demo_mode='live'."""
    seen_requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen_requests.append(request)
        # Finnhub live quote
        return httpx.Response(200, json={"c": 181.42, "t": 1_791_490_000})

    config = QuantConfig(
        demo_mode="live",
        demo_replay_date=None,
        tiingo_api_key="tiingo-key",
        finnhub_api_key="finnhub-key",
        service_token="t",
    )
    http = httpx.Client(transport=httpx.MockTransport(handler))
    sources = ProductionSources(config, http, [], today=date(2024, 10, 8))

    spot = sources.spot("NVDA")
    assert spot.ticker == "NVDA"
    assert spot.price == Decimal("181.42")
    # Should have called Finnhub (live mode)
    assert len(seen_requests) == 1
    assert "finnhub.io" in str(seen_requests[0].url)


def test_spot_in_replay_mode_calls_fetch_spot_with_replay_params() -> None:
    """spot() in replay mode calls fetch_spot with demo_mode='replay' and replay date."""
    seen_requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen_requests.append(request)
        # Tiingo EOD for replay date
        return httpx.Response(200, json=[{"date": "2024-10-08T00:00:00.000Z", "close": 175.50}])

    config = QuantConfig(
        demo_mode="replay",
        demo_replay_date=date(2024, 10, 8),
        tiingo_api_key="tiingo-key",
        finnhub_api_key="",
        service_token="t",
    )
    http = httpx.Client(transport=httpx.MockTransport(handler))
    sources = ProductionSources(config, http, [], today=date(2024, 10, 8))

    spot = sources.spot("AAPL")
    assert spot.ticker == "AAPL"
    assert spot.price == Decimal("175.50")
    # Should have called Tiingo (replay mode)
    assert len(seen_requests) == 1
    assert "tiingo.com" in str(seen_requests[0].url)


def test_closes_in_live_mode_fetches_up_to_today() -> None:
    """closes() in live mode fetches daily closes ending at today."""
    seen_requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen_requests.append(request)
        return httpx.Response(
            200,
            json=[
                {"date": "2024-10-06T00:00:00.000Z", "close": 173.0},
                {"date": "2024-10-07T00:00:00.000Z", "close": 174.5},
            ],
        )

    config = QuantConfig(
        demo_mode="live",
        demo_replay_date=None,
        tiingo_api_key="tiingo-key",
        finnhub_api_key="finnhub-key",
        service_token="t",
    )
    http = httpx.Client(transport=httpx.MockTransport(handler))
    sources = ProductionSources(config, http, [], today=date(2024, 10, 8))

    closes = sources.closes("AAPL")
    assert closes == [Decimal("173.0"), Decimal("174.5")]
    # Should use today as endDate
    params = dict(seen_requests[0].url.params)
    assert params["endDate"] == "2024-10-08"


def test_closes_in_replay_mode_fetches_before_replay_date() -> None:
    """closes() in replay mode fetches daily closes ending before replay date."""
    seen_requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen_requests.append(request)
        return httpx.Response(
            200,
            json=[
                {"date": "2024-10-05T00:00:00.000Z", "close": 172.0},
                {"date": "2024-10-06T00:00:00.000Z", "close": 173.0},
            ],
        )

    config = QuantConfig(
        demo_mode="replay",
        demo_replay_date=date(2024, 10, 8),
        tiingo_api_key="tiingo-key",
        finnhub_api_key="",
        service_token="t",
    )
    http = httpx.Client(transport=httpx.MockTransport(handler))
    sources = ProductionSources(config, http, [], today=date(2024, 10, 8))

    closes = sources.closes("AAPL")
    assert closes == [Decimal("172.0"), Decimal("173.0")]
    # Should end one day before replay date (Oct 7)
    params = dict(seen_requests[0].url.params)
    assert params["endDate"] == "2024-10-07"
