"""Background fair-value cache shared by `GET /fair-values` and the market maker (M3-08b).

A refresher prices every open market once per tick (`DEFAULT_REFRESH_SECS`) with the existing
digital N(d2) model (`server.price_markets`, fair_value.py) and stores the result. Readers (the
HTTP handler threads and the MM loop) only read the cache, so viewer traffic never reaches a
price provider.

Staleness of a served value (`FairValue.stale`, the contract the app already consumes) is true
when ANY of these holds:

1. its spot is older than `server.STALE_AFTER_SECS` (10 s) at compute time (unchanged rule;
   off under the devnet demo flag, see meridian_quant.demo);
2. the latest refresh could not reprice the market (spot or closes unavailable, or a pricing
   error): the LAST computed value is served instead of dropping the market;
3. the value was computed more than `MAX_INPUT_AGE_SECS` (30 s) ago (the refresher stalled).

A market that has never had a value is omitted; a market that leaves the open-market list
(closed, or not in the current session) is dropped. The MM keeps its pull-on-stale rule, so it
never quotes from a stale value.
"""

import asyncio
import logging
import threading
from collections.abc import Callable
from dataclasses import dataclass, replace
from datetime import UTC, datetime

from .mm.types import FairValue as MMFairValue
from .ratelog import RateLimitedLog
from .server import FairValue, Sources, price_markets

MAX_INPUT_AGE_SECS = 30
DEFAULT_REFRESH_SECS = 1.5
log = logging.getLogger("meridian_quant.fair_value_cache")


def _utc_now() -> datetime:
    return datetime.now(UTC)


@dataclass(frozen=True)
class _Entry:
    value: FairValue
    computed_at: datetime
    failed: bool  # the latest refresh could not reprice this market


class FairValueCache:
    def __init__(
        self,
        sources: Sources,
        now: Callable[[], datetime] = _utc_now,
        max_input_age_secs: float = MAX_INPUT_AGE_SECS,
        warn_log: RateLimitedLog | None = None,
    ) -> None:
        self._sources = sources
        self._now = now
        self._max_age = max_input_age_secs
        self._warn = warn_log or RateLimitedLog(log)
        self._entries: dict[str, _Entry] = {}
        self._lock = threading.Lock()
        self._refresh_lock = threading.Lock()

    def refresh(self) -> None:
        """Reprices every open market once; keeps the last value of any it cannot reprice."""
        with self._refresh_lock:
            now = self._now()
            try:
                markets = self._sources.markets()
            except Exception as error:
                self._warn.warning("markets", f"fair-value refresh: no market list: {error}")
                self._mark_all_failed()
                return
            fresh = {
                fv.market: fv
                for fv in price_markets(self._sources, markets, now, self._warn.warning)
            }
            with self._lock:
                previous = self._entries
                entries: dict[str, _Entry] = {}
                for info in markets:
                    if info.market in fresh:
                        entries[info.market] = _Entry(fresh[info.market], now, failed=False)
                    elif info.market in previous:
                        entries[info.market] = replace(previous[info.market], failed=True)
                self._entries = entries

    def snapshot(self) -> list[FairValue]:
        """Every market with a value, `stale` set per the module rules."""
        now = self._now()
        with self._lock:
            entries = list(self._entries.values())
        return [self._served(entry, now) for entry in entries]

    def _served(self, entry: _Entry, now: datetime) -> FairValue:
        too_old = (now - entry.computed_at).total_seconds() > self._max_age
        stale = entry.value.stale or entry.failed or too_old
        return (
            entry.value
            if stale == entry.value.stale
            else entry.value.model_copy(update={"stale": stale})
        )

    def _mark_all_failed(self) -> None:
        with self._lock:
            self._entries = {k: replace(e, failed=True) for k, e in self._entries.items()}


class CachedFairValueSource:
    """The MM loop's `FairValueSource`, read in-process from the cache (no HTTP self-call)."""

    def __init__(self, cache: FairValueCache) -> None:
        self._cache = cache

    async def fetch_fair_values(self) -> list[MMFairValue]:
        return [
            MMFairValue(
                market=fv.market,
                ticker=fv.ticker,
                strike_cents=fv.strike_cents,
                fair_cents=fv.fair_cents,
                sigma=fv.sigma,
                spot=float(fv.spot),  # the MM's display-only field; quoting uses fair_cents
                as_of=fv.as_of,
                stale=fv.stale,
            )
            for fv in self._cache.snapshot()
        ]


async def run_refresher(
    cache: FairValueCache,
    interval_secs: float = DEFAULT_REFRESH_SECS,
    iterations: int | None = None,
) -> None:
    """Background task: `cache.refresh()` in a worker thread (providers are blocking httpx)
    every `interval_secs`. A failed refresh is logged and retried on the next tick; the cache
    keeps serving its last values, flagged stale. `iterations` bounds the loop for tests."""
    done = 0
    while iterations is None or done < iterations:
        try:
            await asyncio.to_thread(cache.refresh)
        except Exception:
            log.exception("fair-value refresh failed")
        done += 1
        await asyncio.sleep(interval_secs)
