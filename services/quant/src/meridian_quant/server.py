"""`GET /fair-values` (architecture.md § Service HTTP contracts), bearer `SERVICE_TOKEN`.

Standard-library HTTP server: the request logic is `handle_request`, a pure function over
injected sources and a clock, so tests never open a socket or call a provider. A market whose
spot or closes are unavailable is left out of the answer (and logged by ticker and reason), never
priced with a made-up sigma or price.
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

from meridian_quant.fair_value import fair_cents, remaining_session_seconds
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

    def __post_init__(self) -> None:
        if not self.token:
            raise ValueError("SERVICE_TOKEN must be set")


def compute_fair_values(service: Service) -> list[FairValue]:
    now = service.now()
    spots: dict[str, tuple[Spot, float] | None] = {}
    out: list[FairValue] = []
    for info in service.sources.markets():
        if info.ticker not in spots:
            try:
                spot = service.sources.spot(info.ticker)
                spots[info.ticker] = (spot, realized_vol(service.sources.closes(info.ticker)))
            except (PriceError, VolError) as error:
                log.warning("skipping %s: %s", info.ticker, error)
                spots[info.ticker] = None
        entry = spots[info.ticker]
        if entry is None:
            continue
        spot, sigma = entry
        remaining = remaining_session_seconds(now, info.close_ts)
        out.append(
            FairValue(
                market=info.market,
                ticker=info.ticker,
                strike_cents=info.strike_cents,
                fair_cents=fair_cents(spot.price, info.strike_cents, sigma, remaining),
                sigma=sigma,
                spot=spot.price,
                as_of=spot.as_of,
                stale=(now - spot.as_of).total_seconds() > STALE_AFTER_SECS,
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
    if path != "/fair-values":
        return 404, b'{"error":"not found"}'
    if method != "GET":
        return 405, b'{"error":"method not allowed"}'
    if not _authorized(authorization, service.token):
        return 401, b'{"error":"unauthorized"}'
    body = [value.model_dump(mode="json") for value in compute_fair_values(service)]
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
