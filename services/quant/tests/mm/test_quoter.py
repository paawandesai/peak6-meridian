"""Tests for quote generation."""

from datetime import UTC, datetime

from meridian_quant.mm.inventory import Inventory
from meridian_quant.mm.quoter import generate_quote
from meridian_quant.mm.types import FairValue


def test_basic_quote_no_inventory() -> None:
    """Generate basic quote with no inventory (no skew)."""
    fv = FairValue(
        market="test_market",
        ticker="AAPL",
        strike_cents=68000,
        fair_cents=50,
        sigma=0.2,
        spot=230.0,
        as_of=datetime.now(UTC),
    )
    inv = Inventory(strike_cents=68000, position=0)

    quote = generate_quote(fv, inv, spread_cents=2, size=10, skew_per_50=1)

    assert quote.market == "test_market"
    assert quote.ticker == "AAPL"
    assert quote.strike_cents == 68000
    assert quote.bid_price == 48  # 50 - 2
    assert quote.ask_price == 52  # 50 + 2
    assert quote.size == 10


def test_quote_with_positive_inventory() -> None:
    """Positive inventory (long YES) widens bid, tightens ask."""
    fv = FairValue(
        market="test_market",
        ticker="AAPL",
        strike_cents=68000,
        fair_cents=50,
        sigma=0.2,
        spot=230.0,
        as_of=datetime.now(UTC),
    )
    # +50 contracts → +1¢ skew
    inv = Inventory(strike_cents=68000, position=50)

    quote = generate_quote(fv, inv, spread_cents=2, size=10, skew_per_50=1)

    # Skew = +1, so both prices shift down by 1
    assert quote.bid_price == 47  # 50 - 2 - 1
    assert quote.ask_price == 51  # 50 + 2 - 1


def test_quote_with_negative_inventory() -> None:
    """Negative inventory (short YES) tightens bid, widens ask."""
    fv = FairValue(
        market="test_market",
        ticker="AAPL",
        strike_cents=68000,
        fair_cents=50,
        sigma=0.2,
        spot=230.0,
        as_of=datetime.now(UTC),
    )
    # -50 contracts → -1¢ skew
    inv = Inventory(strike_cents=68000, position=-50)

    quote = generate_quote(fv, inv, spread_cents=2, size=10, skew_per_50=1)

    # Skew = -1, so both prices shift up by 1
    assert quote.bid_price == 49  # 50 - 2 - (-1)
    assert quote.ask_price == 53  # 50 + 2 - (-1)


def test_quote_clamped_to_min() -> None:
    """Quotes are clamped to min price of 1."""
    fv = FairValue(
        market="test_market",
        ticker="AAPL",
        strike_cents=68000,
        fair_cents=3,  # Very low fair value
        sigma=0.2,
        spot=230.0,
        as_of=datetime.now(UTC),
    )
    inv = Inventory(strike_cents=68000, position=0)

    quote = generate_quote(fv, inv, spread_cents=5, size=10, skew_per_50=1)

    assert quote.bid_price >= 1  # Clamped
    assert quote.ask_price >= 1


def test_quote_clamped_to_max() -> None:
    """Quotes are clamped to max price of 99."""
    fv = FairValue(
        market="test_market",
        ticker="AAPL",
        strike_cents=68000,
        fair_cents=97,  # Very high fair value
        sigma=0.2,
        spot=230.0,
        as_of=datetime.now(UTC),
    )
    inv = Inventory(strike_cents=68000, position=0)

    quote = generate_quote(fv, inv, spread_cents=5, size=10, skew_per_50=1)

    assert quote.bid_price <= 99
    assert quote.ask_price <= 99  # Clamped


def test_quote_prevents_bid_ask_cross() -> None:
    """If bid >= ask after skew, adjust to maintain spread."""
    fv = FairValue(
        market="test_market",
        ticker="AAPL",
        strike_cents=68000,
        fair_cents=50,
        sigma=0.2,
        spot=230.0,
        as_of=datetime.now(UTC),
    )
    # Large inventory → large skew
    inv = Inventory(strike_cents=68000, position=200)

    quote = generate_quote(fv, inv, spread_cents=2, size=10, skew_per_50=1)

    # Ensure bid < ask
    assert quote.bid_price < quote.ask_price


def test_quote_with_large_negative_inventory() -> None:
    """Large negative inventory pushes prices up."""
    fv = FairValue(
        market="test_market",
        ticker="AAPL",
        strike_cents=68000,
        fair_cents=50,
        sigma=0.2,
        spot=230.0,
        as_of=datetime.now(UTC),
    )
    # -200 contracts → -4¢ skew
    inv = Inventory(strike_cents=68000, position=-200)

    quote = generate_quote(fv, inv, spread_cents=2, size=10, skew_per_50=1)

    # Skew = -4, so prices shift up by 4
    assert quote.bid_price == 52  # 50 - 2 - (-4)
    assert quote.ask_price == 56  # 50 + 2 - (-4)
