"""Live spot and daily closes for the quant service (server-side keys, same providers as M2-05).

Spot: Finnhub quote. Daily closes: Tiingo end-of-day prices. Keys travel in headers only and are
never logged or put in error text. Every response is validated with pydantic; any failure raises
`PriceError`, so a price is never invented.
"""

import json
import re
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from urllib.parse import quote

import httpx
from pydantic import BaseModel, ConfigDict, ValidationError

TIMEOUT = httpx.Timeout(3.0)
CLOSE_LOOKBACK_DAYS = 45  # calendar days; comfortably holds 21 trading closes


TICKER_PATTERN = re.compile(r"[A-Z]{1,8}")


class PriceError(RuntimeError):
    """A provider failed or returned unusable data."""


class Spot(BaseModel):
    model_config = ConfigDict(frozen=True)

    ticker: str
    price: Decimal
    as_of: datetime


class _FinnhubQuote(BaseModel):
    c: Decimal
    t: int


class _TiingoBar(BaseModel):
    date: datetime
    close: Decimal


def _check_ticker(ticker: str) -> str:
    """A ticker is 1-8 capital letters; anything else could change the request URL."""
    if TICKER_PATTERN.fullmatch(ticker) is None:
        raise PriceError("invalid ticker symbol")
    return ticker


def _get(client: httpx.Client, url: str, headers: dict[str, str], params: dict[str, str]) -> bytes:
    try:
        response = client.get(url, headers=headers, params=params, timeout=TIMEOUT)
        response.raise_for_status()
    except httpx.HTTPStatusError as error:
        raise PriceError(f"provider status {error.response.status_code}") from None
    except httpx.HTTPError as error:
        raise PriceError(f"provider request failed: {type(error).__name__}") from None
    return response.content


def fetch_spot(client: httpx.Client, ticker: str, finnhub_key: str) -> Spot:
    """Latest price from Finnhub; `c == 0` / `t == 0` (unknown symbol) is an error."""
    ticker = _check_ticker(ticker)
    body = _get(
        client,
        "https://finnhub.io/api/v1/quote",
        {"X-Finnhub-Token": finnhub_key},
        {"symbol": ticker},
    )
    try:
        quote = _FinnhubQuote.model_validate_json(body)
    except ValidationError:
        raise PriceError(f"{ticker}: malformed quote") from None
    if quote.c <= 0 or quote.t <= 0:
        raise PriceError(f"{ticker}: no price")
    return Spot(ticker=ticker, price=quote.c, as_of=datetime.fromtimestamp(quote.t, tz=UTC))


def fetch_daily_closes(
    client: httpx.Client, ticker: str, tiingo_key: str, today: date
) -> list[Decimal]:
    """Daily closes, oldest first, ending at or before `today`."""
    symbol = quote(_check_ticker(ticker).lower(), safe="")
    body = _get(
        client,
        f"https://api.tiingo.com/tiingo/daily/{symbol}/prices",
        {"Authorization": f"Token {tiingo_key}"},
        {
            "startDate": (today - timedelta(days=CLOSE_LOOKBACK_DAYS)).isoformat(),
            "endDate": today.isoformat(),
        },
    )
    try:
        bars = [_TiingoBar.model_validate(item) for item in _json_list(body)]
    except (ValidationError, ValueError):
        raise PriceError(f"{ticker}: malformed daily closes") from None
    return [bar.close for bar in sorted(bars, key=lambda bar: bar.date)]


def _json_list(body: bytes) -> list[object]:
    data = json.loads(body)
    if not isinstance(data, list):
        raise ValueError("expected a list")
    return data


def fetch_daily_closes_pyth(
    client: httpx.Client, ticker: str, pyth_token: str, today: date
) -> list[Decimal]:
    """Daily closes, oldest first, from Pyth Pro's history API (fallback when Tiingo is limited)."""
    ticker = _check_ticker(ticker)
    end = datetime.combine(today, datetime.max.time(), tzinfo=UTC)
    body = _get(
        client,
        "https://pyth.dourolabs.app/v1/fixed_rate@200ms/history",
        {"Authorization": f"Bearer {pyth_token}"},
        {
            "symbol": f"Equity.US.{ticker}/USD",
            "resolution": "D",
            "from": str(int((end - timedelta(days=CLOSE_LOOKBACK_DAYS)).timestamp())),
            "to": str(int(end.timestamp())),
        },
    )
    try:
        data = json.loads(body)
        if data.get("s") != "ok":
            raise ValueError("status not ok")
        pairs = sorted(zip(data["t"], data["c"], strict=True))
        return [Decimal(str(close)) for _, close in pairs]
    except (ValueError, KeyError, TypeError, AttributeError):
        raise PriceError(f"{ticker}: malformed Pyth daily closes") from None
