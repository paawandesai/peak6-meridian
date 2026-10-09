"""Annualized 20-day realized volatility of daily closes, floored at 15% (domain.md)."""

import math
from collections.abc import Sequence
from decimal import Decimal
from itertools import pairwise

WINDOW_DAYS = 20
TRADING_DAYS_PER_YEAR = 252
SIGMA_FLOOR = 0.15


class VolError(ValueError):
    """Not enough or invalid close data. There is no default sigma: callers must handle this."""


def realized_vol(closes: Sequence[Decimal]) -> float:
    """Sample stdev of the last 20 daily log returns (21 closes, oldest first) x sqrt(252).

    The result is floored at `SIGMA_FLOOR`. Fewer than 21 closes or any non-positive close
    raises `VolError`; older closes beyond the window are ignored.
    """
    if len(closes) < WINDOW_DAYS + 1:
        raise VolError(f"need {WINDOW_DAYS + 1} daily closes, got {len(closes)}")
    window = closes[-(WINDOW_DAYS + 1) :]
    if any(close <= 0 for close in window):
        raise VolError("daily closes must be positive")
    returns = [float((later / earlier).ln()) for earlier, later in pairwise(window)]
    mean = sum(returns) / len(returns)
    variance = sum((r - mean) ** 2 for r in returns) / (len(returns) - 1)
    return max(SIGMA_FLOOR, math.sqrt(variance) * math.sqrt(TRADING_DAYS_PER_YEAR))
