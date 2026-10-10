"""`GET /fair-values` (architecture.md § Service HTTP contracts), bearer `SERVICE_TOKEN`.

Standard-library HTTP server: the request logic is `handle_request`, a pure function over
injected sources and a clock, so tests never open a socket or call a provider. A market whose
spot or closes are unavailable is left out of the answer (and logged by ticker and reason), never
priced with a made-up sigma or price.

In production (mm/main.py) the service is given `fair_values`, a read of the background
fair-value cache (fair_value_cache.py), so a request never calls a price provider (M3-08b).
"""

import hmac
import json
import logging
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Protocol

from pydantic import BaseModel, ConfigDict

from meridian_quant.demo import demo_allow_stale_spot
from meridian_quant.fair_value import FairValueError, fair_cents, remaining_session_seconds
from meridian_quant.prices import PriceError, Spot
from meridian_quant.vol import VolError, realized_vol

STALE_AFTER_SECS = 10
log = logging.getLogger("meridian_quant.server")


class MarketInfo(BaseModel):
    """An open market to price."""

    model_config = ConfigDict(frozen=True)

    market: str
    ticker: str
    strike_cents: int
    close_ts: int


class FairValue(BaseModel):
    model_config = ConfigDict(frozen=True)

    market: str
    ticker: str
    strike_cents: int
    fair_cents: int
    sigma: float
    spot: Decimal
    as_of: datetime
    stale: bool


class Sources(Protocol):
    def markets(self) -> list[MarketInfo]: ...
    def spot(self, ticker: str) -> Spot: ...
    def closes(self, ticker: str) -> list[Decimal]: ...


@dataclass(frozen=True)
class Service:
    sources: Sources
    token: str
    now: Callable[[], datetime] = lambda: datetime.now(UTC)
    mm_loop: object | None = None  # Optional MarketMakerLoop for M3-02 book_coverage
    # M3-08b: read precomputed fair values (the cache) instead of pricing per request
    fair_values: Callable[[], list[FairValue]] | None = None

    def __post_init__(self) -> None:
        if not self.token:
            raise ValueError("SERVICE_TOKEN must be set")


def compute_fair_values(service: Service) -> list[FairValue]:
    return price_markets(service.sources, service.sources.markets(), service.now())


# (key, message): a skipped ticker or market; the cache passes a rate-limited logger here.
Warn = Callable[[str, str], object]


def _log_warning(_key: str, message: str) -> None:
    log.warning(message)


def price_markets(
    sources: Sources, markets: list[MarketInfo], now: datetime, warn: Warn = _log_warning
) -> list[FairValue]:
    """Fair values for the priceable `markets`; each ticker's spot and closes fetched once."""
    spots: dict[str, tuple[Spot, float] | None] = {}
    out: list[FairValue] = []
    for info in markets:
        if info.ticker not in spots:
            try:
                spot = sources.spot(info.ticker)
                spots[info.ticker] = (spot, realized_vol(sources.closes(info.ticker)))
            except (PriceError, VolError) as error:
                warn(f"ticker:{info.ticker}", f"skipping ticker {info.ticker}: {error}")
                spots[info.ticker] = None
        entry = spots[info.ticker]
        if entry is None:
            continue
        spot, sigma = entry
        try:
            remaining = (
                max(0, info.close_ts - int(now.timestamp()))
                if demo_allow_stale_spot()
                else remaining_session_seconds(now, info.close_ts)
            )
            cents = fair_cents(spot.price, info.strike_cents, sigma, remaining)
        except FairValueError as error:
            # One unpriceable market (e.g. a non-positive strike) must not 500 every other market.
            warn(
                f"market:{info.market}",
                f"skipping market {info.market} ({info.ticker}): {error}",
            )
            continue
        out.append(
            FairValue(
                market=info.market,
                ticker=info.ticker,
                strike_cents=info.strike_cents,
                fair_cents=cents,
                sigma=sigma,
                spot=spot.price,
                as_of=spot.as_of,
                stale=(now - spot.as_of).total_seconds() > STALE_AFTER_SECS
                and not demo_allow_stale_spot(),
            )
        )
    return out


def _authorized(header: str | None, token: str) -> bool:
    prefix = "Bearer "
    if header is None or not header.startswith(prefix):
        return False
    return hmac.compare_digest(header[len(prefix) :].encode(), token.encode())


def handle_request(
    service: Service, method: str, path: str, authorization: str | None
) -> tuple[int, bytes]:
    """Returns (status, JSON body)."""
    # /health is unauthenticated (M3-02 AC4, M3-04/M3-09 monitoring)
    if path == "/health":
        if method != "GET":
            return 405, b'{"error":"method not allowed"}'
        health_data: dict[str, object] = {"service": "quant", "status": "ok"}
        # Include book_coverage if MM loop is running (M3-02)
        if service.mm_loop is not None and hasattr(service.mm_loop, "book_coverage"):
            health_data["book_coverage"] = service.mm_loop.book_coverage
        return 200, json.dumps(health_data).encode()

    if path != "/fair-values":
        return 404, b'{"error":"not found"}'
    if method != "GET":
        return 405, b'{"error":"method not allowed"}'
    if not _authorized(authorization, service.token):
        return 401, b'{"error":"unauthorized"}'
    values = (
        service.fair_values() if service.fair_values is not None else compute_fair_values(service)
    )
    body = [value.model_dump(mode="json") for value in values]
    return 200, json.dumps(body).encode()


def make_server(service: Service, host: str, port: int) -> ThreadingHTTPServer:
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            status, body = handle_request(
                service, "GET", self.path.split("?")[0], self.headers.get("Authorization")
            )
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format: str, *args: object) -> None:
            return  # no access log: request lines and headers can carry secrets

    return ThreadingHTTPServer((host, port), Handler)
