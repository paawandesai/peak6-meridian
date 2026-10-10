"""Tests for Pyth Pro price source (M3-10)."""

from datetime import UTC, datetime
from decimal import Decimal

import httpx
import pytest

from meridian_quant.prices import PriceError
from meridian_quant.pyth_prices import fetch_pyth_spot


def client(handler: httpx.MockTransport | None = None, **kwargs: object) -> httpx.Client:
    """Creates httpx.Client with mock transport."""

    def respond(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, **kwargs)  # type: ignore[arg-type]

    return httpx.Client(transport=handler or httpx.MockTransport(respond))


def test_pyth_spot_parses_response_and_sends_token_in_header_only() -> None:
    """Token in Authorization header only, never in URL."""
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(
            200,
            json={
                "id": "0x49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688",
                "price": {
                    "price": "15000",
                    "conf": "5",
                    "expo": -2,
                    "publish_time": 1791316801,
                },
            },
        )

    spot = fetch_pyth_spot(client(httpx.MockTransport(handler)), "AAPL", "secret-pyth-token")
    assert spot.ticker == "AAPL"
    assert spot.price == Decimal("150.00")  # 15000 * 10^(-2)
    assert spot.as_of == datetime.fromtimestamp(1791316801, tz=UTC)
    assert seen[0].headers["Authorization"] == "Bearer secret-pyth-token"
    assert "secret-pyth-token" not in str(seen[0].url)


def test_pyth_spot_handles_negative_exponent() -> None:
    """Price scaling with negative exponent: price_int * 10^(-expo)."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "id": "0x6fa7e48602d2e6c0f46c1f2ef3d9d4b16d67a7a72f000a83aee12cb4e5d1c7a6",
                "price": {
                    "price": "68125",
                    "conf": "10",
                    "expo": -2,
                    "publish_time": 1791490000,
                },
            },
        )

    spot = fetch_pyth_spot(client(httpx.MockTransport(handler)), "NVDA", "token")
    assert spot.price == Decimal("681.25")  # 68125 * 10^(-2)


def test_pyth_spot_handles_positive_exponent() -> None:
    """Price scaling with positive exponent: price_int * 10^expo."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "id": "0x4f1b1a0e68b8f1b5e1573eeb95e5b99fda76098146c66c1e5d3e7f0c94bc2294",
                "price": {
                    "price": "420",
                    "conf": "1",
                    "expo": 2,
                    "publish_time": 1791490000,
                },
            },
        )

    spot = fetch_pyth_spot(client(httpx.MockTransport(handler)), "MSFT", "token")
    assert spot.price == Decimal("42000")  # 420 * 10^2


def test_pyth_spot_rejects_unknown_ticker() -> None:
    """Unknown ticker fails before any HTTP request."""

    def unreachable(request: httpx.Request) -> httpx.Response:
        raise AssertionError("no request may be sent")

    with pytest.raises(PriceError, match="unknown ticker"):
        fetch_pyth_spot(client(httpx.MockTransport(unreachable)), "INVALID", "token")


@pytest.mark.parametrize(
    "body",
    [
        {
            "id": "wrong-id",
            "price": {"price": "15000", "conf": "5", "expo": -2, "publish_time": 1791316801},
        },
        {
            "price": {"price": "15000", "conf": "5", "expo": -2, "publish_time": 1791316801}
        },  # missing id
        {"id": "0x49...", "price": {}},  # missing price fields
        {
            "id": "0x49...",
            "price": {
                "price": "not-a-number",
                "conf": "5",
                "expo": -2,
                "publish_time": 1791316801,
            },
        },
        [1, 2],  # not an object
        {"id": "0x49...", "price": None},
    ],
)
def test_pyth_spot_rejects_malformed_responses(body: object) -> None:
    """Malformed or invalid responses raise PriceError."""
    with pytest.raises(PriceError):
        fetch_pyth_spot(client(json=body), "AAPL", "token")


def test_pyth_spot_rejects_zero_or_negative_price() -> None:
    """Zero or negative prices are invalid."""

    def handler_zero(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "id": "0x49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688",
                "price": {"price": "0", "conf": "5", "expo": -2, "publish_time": 1791316801},
            },
        )

    with pytest.raises(PriceError, match="no price"):
        fetch_pyth_spot(client(httpx.MockTransport(handler_zero)), "AAPL", "token")

    def handler_negative(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "id": "0x49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688",
                "price": {"price": "-100", "conf": "5", "expo": -2, "publish_time": 1791316801},
            },
        )

    with pytest.raises(PriceError, match="no price"):
        fetch_pyth_spot(client(httpx.MockTransport(handler_negative)), "AAPL", "token")


def test_pyth_provider_errors_are_price_errors_without_token() -> None:
    """HTTP errors raise PriceError without leaking token."""

    def timeout_handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectTimeout("timed out", request=request)

    with pytest.raises(PriceError, match="ConnectTimeout") as timeout:
        fetch_pyth_spot(client(httpx.MockTransport(timeout_handler)), "AAPL", "secret-pyth-token")
    assert "secret-pyth-token" not in str(timeout.value)

    def status_503(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503)

    with pytest.raises(PriceError, match="status 503"):
        fetch_pyth_spot(client(httpx.MockTransport(status_503)), "AAPL", "secret-pyth-token")


def test_pyth_request_url_includes_feed_id() -> None:
    """Verify request URL contains the correct feed ID for the ticker."""
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(
            200,
            json={
                "id": "0x6fa7e48602d2e6c0f46c1f2ef3d9d4b16d67a7a72f000a83aee12cb4e5d1c7a6",
                "price": {"price": "68000", "conf": "10", "expo": -2, "publish_time": 1791490000},
            },
        )

    fetch_pyth_spot(client(httpx.MockTransport(handler)), "NVDA", "token")
    assert "0x6fa7e48602d2e6c0f46c1f2ef3d9d4b16d67a7a72f000a83aee12cb4e5d1c7a6" in str(seen[0].url)
