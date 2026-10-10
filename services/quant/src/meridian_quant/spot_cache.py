"""Shared server-side spot cache (M3-08b): at most one upstream fetch per ticker per TTL.

One process serves `GET /fair-values` (polled by every browser viewer) and runs the market maker,
so spots must not be fetched per request: Finnhub's free tier allows ~60 calls a minute.

- **Primary:** one batched call for ALL tickers (Pyth Pro latest price) per TTL window.
- **Fallback:** per ticker (Finnhub quote) for tickers the primary did not return.
- **TTL:** a fetched spot is reused for `ttl_secs` (default 5 s), measured on an injectable
  monotonic clock. Upstream ATTEMPTS are throttled the same way, success or not, so a failing
  provider is not hammered.
- **Failures are never cached:** a failed fetch stores no value. Until the retry window passes,
  `get` raises `PriceError` for that ticker (the fair-value cache then serves its last value
  flagged stale); after it, the next `get` fetches again.
- **Thread-safe, single-flight:** reads take a short data lock; fetches run under one fetch lock
  and re-check the cache after acquiring it, so concurrent callers wait for the one in-flight
  fetch instead of each calling upstream.
"""

import logging
import threading
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass

from .prices import PriceError, Spot

DEFAULT_TTL_SECS = 5.0
log = logging.getLogger("meridian_quant.spot_cache")

PrimaryFetch = Callable[[], Mapping[str, Spot]]
FallbackFetch = Callable[[str], Spot]


@dataclass(frozen=True)
class _Entry:
    spot: Spot
    fetched_at: float
    source: str


class SpotCache:
    def __init__(
        self,
        *,
        primary: PrimaryFetch | None,
        fallback: FallbackFetch,
        ttl_secs: float = DEFAULT_TTL_SECS,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if ttl_secs <= 0:
            raise ValueError("ttl_secs must be positive")
        self._primary = primary
        self._fallback = fallback
        self._ttl = ttl_secs
        self._clock = clock
        self._entries: dict[str, _Entry] = {}
        self._primary_attempt: float | None = None
        self._fallback_attempts: dict[str, float] = {}
        self._data_lock = threading.Lock()
        self._fetch_lock = threading.Lock()

    def get(self, ticker: str) -> Spot:
        """A spot fetched within the TTL; fetches (single-flight) when there is none."""
        hit = self._fresh(ticker)
        if hit is not None:
            return hit
        with self._fetch_lock:
            hit = self._fresh(ticker)  # another caller may have fetched while we waited
            if hit is not None:
                return hit
            self._refresh_primary()
            hit = self._fresh(ticker)
            if hit is not None:
                return hit
            return self._fetch_fallback(ticker)

    def source(self, ticker: str) -> str | None:
        """Which provider the cached spot came from ("primary"/"fallback"), if any."""
        with self._data_lock:
            entry = self._entries.get(ticker)
        return None if entry is None else entry.source

    def _fresh(self, ticker: str) -> Spot | None:
        with self._data_lock:
            entry = self._entries.get(ticker)
        if entry is None or self._clock() - entry.fetched_at >= self._ttl:
            return None
        return entry.spot

    def _store(self, spot: Spot, fetched_at: float, source: str) -> None:
        with self._data_lock:
            self._entries[spot.ticker] = _Entry(spot=spot, fetched_at=fetched_at, source=source)

    def _within_window(self, attempt: float | None) -> bool:
        return attempt is not None and self._clock() - attempt < self._ttl

    def _refresh_primary(self) -> None:
        """One batched primary call per TTL window, whatever the outcome (caller holds the
        fetch lock). A failure is logged (no secrets: `PriceError` text never holds the token)."""
        if self._primary is None or self._within_window(self._primary_attempt):
            return
        started = self._clock()
        self._primary_attempt = started
        try:
            spots = self._primary()
        except PriceError as error:
            log.warning("primary spot source failed, falling back per ticker: %s", error)
            return
        for spot in spots.values():
            self._store(spot, started, "primary")

    def _fetch_fallback(self, ticker: str) -> Spot:
        """Per-ticker fallback, throttled per TTL window (caller holds the fetch lock)."""
        if self._within_window(self._fallback_attempts.get(ticker)):
            raise PriceError(f"{ticker}: spot unavailable (last fetch failed; retry throttled)")
        started = self._clock()
        self._fallback_attempts[ticker] = started
        try:
            spot = self._fallback(ticker)
        except PriceError as error:
            raise PriceError(f"{ticker}: spot unavailable: {error}") from error
        self._store(spot, started, "fallback")
        return spot
