"""Pyth Pro latest_price, all MAG7 tickers in one request (M3-08b). All HTTP is mocked."""

import json
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import httpx
import pytest
from hypothesis import given
from hypothesis import strategies as st

from meridian_quant.prices import PriceError
from meridian_quant.pyth_latest import (
    LATEST_PRICE_URL,
    PYTH_PRO_FEED_IDS,
    fetch_pyth_latest_spots,
    micros_to_datetime,
    pyth_price_to_decimal,
)

TOKEN = "secret-pyth-token-123"
UPDATE_US = 1_791_490_000_123_456


def feed(feed_id: int, price: str = "18142000000", exponent: int = -8) -> dict[str, object]:
    return {
        "priceFeedId": feed_id,
        "price": price,
        "exponent": exponent,
        "feedUpdateTimestamp": UPDATE_US,
    }


def body(feeds: list[dict[str, object]]) -> dict[str, object]:
    return {"parsed": {"timestampUs": str(UPDATE_US + 5), "priceFeeds": feeds}}


def client_for(handler: object) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler))  # type: ignore[arg-type]


def test_one_post_for_all_seven_tickers_with_token_in_header_only() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=body([feed(i) for i in PYTH_PRO_FEED_IDS.values()]))

    spots = fetch_pyth_latest_spots(client_for(handler), TOKEN)
    assert len(seen) == 1
    request = seen[0]
    assert request.method == "POST"
    assert str(request.url) == LATEST_PRICE_URL
    assert request.headers["Authorization"] == f"Bearer {TOKEN}"
    assert TOKEN not in str(request.url)
    sent = json.loads(request.content)
    assert sent["priceFeedIds"] == sorted(PYTH_PRO_FEED_IDS.values())
    assert sent["channel"] == "fixed_rate@200ms"
    assert sent["parsed"] is True
    assert "feedUpdateTimestamp" in sent["properties"]
    assert set(spots) == set(PYTH_PRO_FEED_IDS)
    nvda = spots["NVDA"]
    assert nvda.ticker == "NVDA"
    assert nvda.price == Decimal("181.42")
    assert nvda.as_of == datetime(2026, 10, 8, 20, 6, 40, 123_456, tzinfo=UTC)


def test_feed_ids_match_the_app_route() -> None:
    assert PYTH_PRO_FEED_IDS == {
        "AAPL": 922,
        "AMZN": 954,
        "GOOGL": 1163,
        "META": 1272,
        "MSFT": 1292,
        "NVDA": 1314,
        "TSLA": 1435,
    }


def test_invalid_feeds_are_left_out_and_the_rest_kept() -> None:
    feeds: list[dict[str, object]] = [
        feed(922),  # AAPL ok
        {"priceFeedId": 954},  # AMZN: no price
        feed(1163, price="0"),  # GOOGL: zero
        feed(1272, price="-5"),  # META: negative
        feed(1292, price="1.5"),  # MSFT: not an integer mantissa
        {**feed(1314), "feedUpdateTimestamp": "soon"},  # NVDA: bad timestamp
        {**feed(1435), "feedUpdateTimestamp": 0},  # TSLA: non-positive timestamp
        feed(99_999),  # unknown feed id: ignored
    ]
    spots = fetch_pyth_latest_spots(
        client_for(lambda _r: httpx.Response(200, json=body(feeds))), TOKEN
    )
    assert set(spots) == {"AAPL"}


def test_timestamp_may_arrive_as_a_string() -> None:
    feeds = [{**feed(922), "feedUpdateTimestamp": str(UPDATE_US)}]
    spots = fetch_pyth_latest_spots(
        client_for(lambda _r: httpx.Response(200, json=body(feeds))), TOKEN
    )
    assert spots["AAPL"].as_of == micros_to_datetime(UPDATE_US)


def test_only_requested_known_tickers_are_asked_for() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=body([feed(922)]))

    assert fetch_pyth_latest_spots(client_for(handler), TOKEN, ["XYZ"]) == {}
    assert seen == []  # nothing known to ask for: no request at all
    fetch_pyth_latest_spots(client_for(handler), TOKEN, ["AAPL", "XYZ"])
    assert json.loads(seen[0].content)["priceFeedIds"] == [922]


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(503),
        httpx.Response(401, json={"error": f"bad token {TOKEN}"}),
        httpx.Response(200, content=b"<html>"),
        httpx.Response(200, json={"parsed": {"priceFeeds": []}}),
        httpx.Response(200, json=[1, 2]),
    ],
)
def test_failures_raise_price_error_without_the_token(response: httpx.Response) -> None:
    with pytest.raises(PriceError) as caught:
        fetch_pyth_latest_spots(client_for(lambda _r: response), TOKEN)
    assert TOKEN not in str(caught.value)


def test_network_errors_raise_price_error_without_the_token() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectTimeout(f"timed out {TOKEN}", request=request)

    with pytest.raises(PriceError) as caught:
        fetch_pyth_latest_spots(client_for(handler), TOKEN)
    assert TOKEN not in str(caught.value)
    assert "ConnectTimeout" in str(caught.value)


@pytest.mark.parametrize(
    ("price", "exponent"), [("0", -2), ("-1", -2), ("abc", -2), ("", 0), ("5", 31), ("5", -31)]
)
def test_conversion_rejects_bad_inputs(price: str, exponent: int) -> None:
    with pytest.raises(PriceError):
        pyth_price_to_decimal(price, exponent)


@given(
    mantissa=st.integers(min_value=1, max_value=10**18),
    exponent=st.integers(min_value=-12, max_value=4),
)
def test_conversion_is_exact_price_times_ten_to_the_exponent(mantissa: int, exponent: int) -> None:
    value = pyth_price_to_decimal(str(mantissa), exponent)
    assert value > 0
    # Exact: scaling back by 10^-exponent recovers the integer mantissa with no rounding.
    assert value.scaleb(-exponent) == mantissa
    assert value == Decimal(mantissa) * Decimal(10) ** exponent


@given(st.integers(min_value=1, max_value=4_102_444_800 * 1_000_000))
def test_micros_to_datetime_round_trips(micros: int) -> None:
    moment = micros_to_datetime(micros)
    epoch = datetime(1970, 1, 1, tzinfo=UTC)
    assert (moment - epoch) // timedelta(microseconds=1) == micros
