"""Tests for quote generation (updated for MarketKey)."""

from datetime import UTC, datetime

from meridian_quant.mm.quoter import generate_quote
from meridian_quant.mm.types import FairValue, Inventory, MarketKey


def test_basic_quote_no_inventory() -> None:
    """Generate basic quote with no inventory (no skew)."""
    key = MarketKey(ticker="AAPL", trading_date=20261008, strike_cents=68000)
    fv = FairValue(
        market="test_market",
        ticker="AAPL",
        strike_cents=68000,
        fair_cents=50,
        sigma=0.2,
        spot=230.0,
        as_of=datetime.now(UTC),
    )
    inv = Inventory(market_key=key, position=0)
    quote = generate_quote(fv, inv, spread_cents=2, size=10, skew_per_50=1)
    assert quote.bid_price == 48
    assert quote.ask_price == 52
