"""Fair value of a YES contract: the digital-option price N(d2) (domain.md § Fair value).

r = 0, T = remaining regular-session seconds / (252 x 6.5 x 3600). Pure and clock-free: callers
pass `now`. Money is `Decimal` dollars or integer cents; only the normal CDF uses floats.
"""

import math
from datetime import UTC, datetime, time
from decimal import Decimal
from zoneinfo import ZoneInfo

SESSION_SECONDS_PER_YEAR = 252 * 65 * 3600 // 10  # 252 days x 6.5 h x 3600 s
SESSION_OPEN_ET = time(9, 30)
MIN_CENTS = 1
MAX_CENTS = 99
_ET = ZoneInfo("America/New_York")


class FairValueError(ValueError):
    """Inputs that cannot be priced (non-positive spot, strike or sigma)."""


def remaining_session_seconds(now: datetime, close_ts: int) -> int:
    """Regular-session seconds left before `close_ts` (unix s); 0 at or after the close.

    The session opens 09:30 ET of the close's own ET date, so before the open the full session
    counts, and an early close (a `close_ts` before 16:00 ET) shortens it with no calendar.
    """
    if now.tzinfo is None:
        raise FairValueError("now must be timezone-aware")
    close = datetime.fromtimestamp(close_ts, tz=UTC)
    open_et = datetime.combine(close.astimezone(_ET).date(), SESSION_OPEN_ET, tzinfo=_ET)
    start = max(now, open_et)
    return max(0, int((close - start).total_seconds()))


def _ncdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def fair_probability(spot: Decimal, strike_cents: int, sigma: float, remaining_secs: int) -> float:
    """P(close >= strike) = N(d2); the step function when `remaining_secs <= 0`."""
    if spot <= 0 or strike_cents <= 0:
        raise FairValueError("spot and strike must be positive")
    strike = Decimal(strike_cents) / 100
    if remaining_secs <= 0:
        return 1.0 if spot >= strike else 0.0
    if not math.isfinite(sigma) or sigma <= 0:
        raise FairValueError("sigma must be positive and finite")
    t = remaining_secs / SESSION_SECONDS_PER_YEAR
    log_moneyness = float((spot / strike).ln())
    d2 = (log_moneyness - sigma * sigma * t / 2) / (sigma * math.sqrt(t))
    return _ncdf(d2)


def fair_cents(spot: Decimal, strike_cents: int, sigma: float, remaining_secs: int) -> int:
    """Integer cents, half-up, clamped to [1, 99]."""
    probability = fair_probability(spot, strike_cents, sigma, remaining_secs)
    cents = int(Decimal(repr(probability * 100)).quantize(Decimal(1), rounding="ROUND_HALF_UP"))
    return min(MAX_CENTS, max(MIN_CENTS, cents))
