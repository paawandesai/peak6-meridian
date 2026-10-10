"""Which trading date the market maker treats as the current session.

Normally that is today's ET date. When today has no Open market that is still before its
close_ts (a weekend, or a day whose markets have all closed) but another date does, the
earliest such date is the session instead. This lets the MM quote demo-session markets that
live on a non-trading day (scripts/demo-markets) and markets created ahead of their day,
while prior-day markets past close still never block or receive quotes (AB-11).
"""

from collections.abc import Iterable
from datetime import datetime
from typing import Protocol
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")


class _SessionMarket(Protocol):
    @property
    def is_open(self) -> bool: ...
    @property
    def trading_date(self) -> int: ...
    @property
    def close_ts(self) -> int: ...


def et_trading_date(now: datetime) -> int:
    """`YYYYMMDD` of `now` in America/New_York."""
    return int(now.astimezone(ET).strftime("%Y%m%d"))


def session_trading_date(markets: Iterable[_SessionMarket], now: datetime) -> int:
    """Today's ET date, unless only other dates still have Open markets before close."""
    today = et_trading_date(now)
    now_ts = int(now.timestamp())
    live_dates = {m.trading_date for m in markets if m.is_open and m.close_ts > now_ts}
    if today in live_dates or not live_dates:
        return today
    return min(live_dates)
