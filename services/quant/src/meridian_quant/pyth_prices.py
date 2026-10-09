"""Pyth Pro (Lazer) price source for live spots (M3-10, D-055).

Pyth Pro provides 1ms equity feeds for MAG7 tickers. This module fetches latest prices
from Pyth Lazer REST API using PYTH_API_TOKEN (server-side only, never logged). Returns
Spot models matching prices.py protocol for quant service integration.

Feed IDs (from issue #49, hex-encoded 32-byte identifiers):
AAPL: 922, AMZN: 954, GOOGL: 1163, META: 1272, MSFT: 1292, NVDA: 1314, TSLA: 1435

Security (AC3, AB-17):
- PYTH_API_TOKEN travels in headers only, never logged or in error text
- All responses validated with pydantic; any failure raises PriceError
"""

import json
from datetime import UTC, datetime
from decimal import Decimal

import httpx
from pydantic import BaseModel, ConfigDict, ValidationError

from .prices import PriceError, Spot

TIMEOUT = httpx.Timeout(3.0)

# Pyth feed IDs for MAG7 tickers (hex-encoded 32-byte identifiers)
# TODO: Verify these against docs.pyth.network official feed list
PYTH_FEED_IDS: dict[str, str] = {
    "AAPL": "0x49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688",
    "AMZN": "0xb5d0e0fa58a1f8b81498ae670ce93c872d14434b72c364885d4fa1b257cbb07a",
    "GOOGL": "0x726c49cd73149a5eb8e5570d0e2cbf01c99853af3e5aeebd01e7eb6e1d15f977",
    "META": "0x4b78d251770732f6304b1f41e9bebaabc3b256985ef18988f6de8d6562dd254c",
    "MSFT": "0x4f1b1a0e68b8f1b5e1573eeb95e5b99fda76098146c66c1e5d3e7f0c94bc2294",
    "NVDA": "0x6fa7e48602d2e6c0f46c1f2ef3d9d4b16d67a7a72f000a83aee12cb4e5d1c7a6",
    "TSLA": "0x16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc9641f1",
}


class _PythPriceData(BaseModel):
    """Pyth price update fields from Lazer API."""

    model_config = ConfigDict(frozen=True)

    price: str  # Price as string to preserve precision
    conf: str  # Confidence interval
    expo: int  # Exponent: actual_price = int(price) * 10^expo
    publish_time: int  # Unix timestamp


class _PythLatestPriceResponse(BaseModel):
    """Pyth Lazer API response for latest price."""

    model_config = ConfigDict(frozen=True)

    id: str  # Feed ID (hex string)
    price: _PythPriceData


def _get(client: httpx.Client, url: str, headers: dict[str, str]) -> bytes:
    """HTTP GET with error handling matching prices.py protocol."""
    try:
        response = client.get(url, headers=headers, timeout=TIMEOUT)
        response.raise_for_status()
    except httpx.HTTPStatusError as error:
        raise PriceError(f"provider status {error.response.status_code}") from None
    except httpx.HTTPError as error:
        raise PriceError(f"provider request failed: {type(error).__name__}") from None
    return response.content


def fetch_pyth_spot(client: httpx.Client, ticker: str, pyth_token: str) -> Spot:
    """Fetches latest price from Pyth Lazer API.

    Args:
        client: httpx.Client instance
        ticker: MAG7 ticker symbol (e.g., "AAPL")
        pyth_token: PYTH_API_TOKEN for authentication

    Returns:
        Spot with ticker, price (as Decimal), and as_of timestamp

    Raises:
        PriceError: if ticker unknown, API fails, or response is malformed
    """
    feed_id = PYTH_FEED_IDS.get(ticker)
    if feed_id is None:
        raise PriceError(f"{ticker}: unknown ticker")

    # TODO: Verify actual Pyth Lazer API endpoint and auth header format
    # Placeholder endpoint based on TS client research
    url = f"https://api.lazer.pyth.network/v1/feeds/{feed_id}/latest"
    headers = {"Authorization": f"Bearer {pyth_token}"}

    body = _get(client, url, headers)

    try:
        response = _PythLatestPriceResponse.model_validate_json(body)
    except ValidationError:
        raise PriceError(f"{ticker}: malformed response") from None

    # Validate feed ID matches
    if response.id != feed_id:
        raise PriceError(f"{ticker}: feed ID mismatch")

    # Parse price: price_value * 10^expo
    try:
        price_int = int(response.price.price)
        expo = response.price.expo
    except ValueError:
        raise PriceError(f"{ticker}: invalid price format") from None

    # Convert to Decimal: price_int * 10^expo
    if expo >= 0:
        price = Decimal(price_int) * Decimal(10**expo)
    else:
        price = Decimal(price_int) / Decimal(10 ** (-expo))

    if price <= 0:
        raise PriceError(f"{ticker}: no price")

    as_of = datetime.fromtimestamp(response.price.publish_time, tz=UTC)

    return Spot(ticker=ticker, price=price, as_of=as_of)
