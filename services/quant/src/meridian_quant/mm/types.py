"""Type definitions for the market maker."""

from dataclasses import dataclass
from datetime import datetime
from typing import Literal

from pydantic import BaseModel


class FairValue(BaseModel):
    """Fair value response from the quant service."""

    market: str
    ticker: str
    strike_cents: int
    fair_cents: int
    sigma: float
    spot: float
    as_of: datetime
    stale: bool = False


class Quote(BaseModel):
    """A two-sided quote for a market."""

    market: str
    ticker: str
    strike_cents: int
    bid_price: int  # cents, 1-99
    ask_price: int  # cents, 1-99
    size: int  # contracts per side


@dataclass(frozen=True)
class MarketKey:
    """Unique market identifier (ticker + trading_date + strike)."""

    ticker: str
    trading_date: int  # YYYYMMDD
    strike_cents: int


@dataclass
class Inventory:
    """Per-market inventory tracking (Finding #5: key by market, not just strike)."""

    market_key: MarketKey
    position: int  # signed: positive = long YES, negative = short YES

    def skew_cents(self, skew_per_50: int) -> int:
        """Calculate skew in cents based on inventory (domain.md § Market maker defaults).

        Skew 1¢ per 50 contracts: positive inventory → widen bid, tighten ask.
        """
        return int(round(self.position / 50.0)) * skew_per_50


@dataclass
class MarketState:
    """Current state of a market for MM decisions."""

    market: str
    ticker: str
    strike_cents: int
    trading_date: int
    close_ts: int
    is_open: bool
    pairs_outstanding: int


Side = Literal["Bid", "Ask"]


@dataclass
class RestingOrder:
    """A resting order on the book."""

    order_id: int
    market: str
    side: Side
    price: int
    qty: int
    owner: str
