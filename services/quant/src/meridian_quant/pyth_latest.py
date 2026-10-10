"""Pyth Pro (Lazer) latest prices for all MAG7 tickers in ONE request (M3-08b).

The same upstream as the app's `/api/pyth-quotes` route (app/src/app/api/pyth-quotes/route.ts):
`POST https://pyth-lazer.dourolabs.app/v1/latest_price` with bearer `PYTH_API_TOKEN` and the
numeric Pyth Pro feed ids. A feed's price is `price * 10^exponent` (Decimal, exact); its time is
`feedUpdateTimestamp` in microseconds: when the price last changed (the last close after hours),
so a quiet feed reads as old and the caller's staleness rules apply.

The token travels in the Authorization header only and never reaches a log line or error text.
Every response is validated with pydantic; a feed that fails validation is left out (the caller
falls back per ticker), and a request that fails outright raises `PriceError`.
"""

import re
from collections.abc import Iterable
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import httpx
from pydantic import BaseModel, ValidationError

from .prices import PriceError, Spot

LATEST_PRICE_URL = "https://pyth-lazer.dourolabs.app/v1/latest_price"
TIMEOUT = httpx.Timeout(3.0)
CHANNEL = "fixed_rate@200ms"
MAX_ABS_EXPONENT = 30  # Pyth equity feeds use -5..-8; anything wild is malformed data

# Pyth Pro numeric feed ids (https://history.pyth-lazer.dourolabs.app/history/v1/symbols); the
# same table as PYTH_PRO_FEED_IDS in the app route.
PYTH_PRO_FEED_IDS: dict[str, int] = {
    "AAPL": 922,
    "AMZN": 954,
    "GOOGL": 1163,
    "META": 1272,
    "MSFT": 1292,
    "NVDA": 1314,
    "TSLA": 1435,
}

_INTEGER = re.compile(r"-?\d{1,40}")


class _Feed(BaseModel):
    priceFeedId: int  # upstream field names are camelCase
    price: str | None = None
    exponent: int | None = None
    feedUpdateTimestamp: int | str | None = None


class _Parsed(BaseModel):
    timestampUs: str
    priceFeeds: list[_Feed]


class _LatestPriceResponse(BaseModel):
    parsed: _Parsed


def pyth_price_to_decimal(price: str, exponent: int) -> Decimal:
    """Exact `price * 10^exponent`; raises `PriceError` for a non-integer mantissa, a wild
    exponent or a non-positive result (a price is never invented or clamped)."""
    if _INTEGER.fullmatch(price) is None:
        raise PriceError("price is not an integer mantissa")
    if abs(exponent) > MAX_ABS_EXPONENT:
        raise PriceError("exponent out of range")
    value = Decimal(int(price)).scaleb(exponent)
    if value <= 0:
        raise PriceError("no price")
    return value


def micros_to_datetime(micros: int) -> datetime:
    """Unix microseconds to an aware UTC datetime, without float rounding."""
    seconds, rest = divmod(micros, 1_000_000)
    return datetime.fromtimestamp(seconds, tz=UTC) + timedelta(microseconds=rest)


def _spot(ticker: str, feed: _Feed) -> Spot:
    if feed.price is None or feed.exponent is None or feed.feedUpdateTimestamp is None:
        raise PriceError("feed has no price, exponent or update time")
    try:
        micros = int(feed.feedUpdateTimestamp)
    except ValueError:
        raise PriceError("feed update time is not an integer") from None
    if micros <= 0:
        raise PriceError("feed update time is not positive")
    return Spot(
        ticker=ticker,
        price=pyth_price_to_decimal(feed.price, feed.exponent),
        as_of=micros_to_datetime(micros),
    )


def fetch_pyth_latest_spots(
    client: httpx.Client, pyth_token: str, tickers: Iterable[str] = tuple(PYTH_PRO_FEED_IDS)
) -> dict[str, Spot]:
    """Latest spots for `tickers` (default: all MAG7) in one request.

    Returns only the tickers with a valid price; raises `PriceError` when the request fails or
    the body is malformed. Unknown tickers are ignored (the caller falls back for them).
    """
    ids = {PYTH_PRO_FEED_IDS[t]: t for t in tickers if t in PYTH_PRO_FEED_IDS}
    if not ids:
        return {}
    try:
        response = client.post(
            LATEST_PRICE_URL,
            headers={
                "Authorization": f"Bearer {pyth_token}",
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
            json={
                "priceFeedIds": sorted(ids),
                "properties": ["price", "exponent", "feedUpdateTimestamp"],
                "formats": [],
                "channel": CHANNEL,
                "jsonBinaryEncoding": "hex",
                "parsed": True,
            },
            timeout=TIMEOUT,
        )
        response.raise_for_status()
    except httpx.HTTPStatusError as error:
        raise PriceError(f"pyth status {error.response.status_code}") from None
    except httpx.HTTPError as error:
        raise PriceError(f"pyth request failed: {type(error).__name__}") from None
    try:
        body = _LatestPriceResponse.model_validate_json(response.content)
    except ValidationError:
        raise PriceError("pyth: malformed latest_price response") from None
    spots: dict[str, Spot] = {}
    for feed in body.parsed.priceFeeds:
        ticker = ids.get(feed.priceFeedId)
        if ticker is None:
            continue
        try:
            spots[ticker] = _spot(ticker, feed)
        except PriceError:
            continue  # this ticker falls back to Finnhub; the others are still good
    return spots
