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


def fetch_spot(
    client: httpx.Client,
    ticker: str,
    finnhub_key: str,
    *,
    demo_mode: str = "live",
    demo_replay_date: date | None = None,
    tiingo_key: str | None = None,
) -> Spot:
    """Latest price from Finnhub (live mode) or historical Tiingo EOD (replay mode).

    In replay mode, uses Tiingo EOD close for demo_replay_date as the spot price.
    Requires tiingo_key when demo_mode="replay".
    """
    ticker = _check_ticker(ticker)

    # Demo replay: use Tiingo EOD close for the replay date as "spot"
    if demo_mode == "replay":
        if demo_replay_date is None:
            raise PriceError("demo_replay_date required when demo_mode=replay")
        if tiingo_key is None:
            raise PriceError("tiingo_key required for replay mode")

        symbol = quote(ticker.lower(), safe="")
        body = _get(
            client,
            f"https://api.tiingo.com/tiingo/daily/{symbol}/prices",
            {"Authorization": f"Token {tiingo_key}"},
            {
                "startDate": demo_replay_date.isoformat(),
                "endDate": demo_replay_date.isoformat(),
            },
        )
        try:
            bars = [_TiingoBar.model_validate(item) for item in _json_list(body)]
        except (ValidationError, ValueError):
            raise PriceError(f"{ticker}: malformed replay EOD") from None
        if not bars or bars[0].close <= 0:
            raise PriceError(f"{ticker}: no replay price for {demo_replay_date}")
        # Use the replay date's close as the "spot" with the date's midnight timestamp
        return Spot(
            ticker=ticker,
            price=bars[0].close,
            as_of=datetime.combine(demo_replay_date, datetime.min.time(), tzinfo=UTC),
        )

    # Live mode: Finnhub quote
    body = _get(
        client,
        "https://finnhub.io/api/v1/quote",
        {"X-Finnhub-Token": finnhub_key},
        {"symbol": ticker},
    )
    try:
        finnhub_quote = _FinnhubQuote.model_validate_json(body)
    except ValidationError:
        raise PriceError(f"{ticker}: malformed quote") from None
    if finnhub_quote.c <= 0 or finnhub_quote.t <= 0:
        raise PriceError(f"{ticker}: no price")
    return Spot(
        ticker=ticker,
        price=finnhub_quote.c,
        as_of=datetime.fromtimestamp(finnhub_quote.t, tz=UTC),
    )


def fetch_daily_closes(
    client: httpx.Client,
    ticker: str,
    tiingo_key: str,
    today: date,
    *,
    demo_mode: str = "live",
    demo_replay_date: date | None = None,
) -> list[Decimal]:
    """Daily closes, oldest first, ending at or before `today`.

    In replay mode, fetches closes before demo_replay_date (for historical volatility).
    """
    symbol = quote(_check_ticker(ticker).lower(), safe="")

    # Demo replay: fetch closes before the replay date for volatility calculation
    end_date = today
    if demo_mode == "replay":
        if demo_replay_date is None:
            raise PriceError("demo_replay_date required when demo_mode=replay")
        # End one day before the replay date to avoid using "future" data
        end_date = demo_replay_date - timedelta(days=1)

    body = _get(
        client,
        f"https://api.tiingo.com/tiingo/daily/{symbol}/prices",
        {"Authorization": f"Token {tiingo_key}"},
        {
            "startDate": (end_date - timedelta(days=CLOSE_LOOKBACK_DAYS)).isoformat(),
            "endDate": end_date.isoformat(),
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
