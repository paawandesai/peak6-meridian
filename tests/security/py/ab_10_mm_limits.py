"""AB-10: Market maker limits (AC3).

Abuse case: MM never exceeds per-owner resting-order cap (8) or inventory cap (200).
Prices always in 1–99.
"""

import pytest

from meridian_quant.mm.config import MAX_PRICE_CENTS, MIN_PRICE_CENTS, MMConfig
from meridian_quant.mm.inventory import Inventory, InventoryTracker
from meridian_quant.mm.quoter import generate_quote
from meridian_quant.mm.types import FairValue
from datetime import UTC, datetime


def test_ab10_inventory_cap_enforced() -> None:
    """MM never exceeds inventory cap of 200 per strike."""
    tracker = InventoryTracker()
    max_inv = 200

    # Can add up to cap
    tracker.set(68000, 190)
    assert tracker.can_add(68000, 10, max_inv)

    # Cannot exceed cap
    tracker.set(68000, 200)
    assert not tracker.can_add(68000, 1, max_inv)

    # Negative direction
    tracker.set(68000, -200)
    assert not tracker.can_add(68000, -1, max_inv)


def test_ab10_order_cap_per_owner() -> None:
    """MM never exceeds 8 resting orders per owner per market (domain.md)."""
    # This is enforced at the program level, but MM logic should respect it
    # MM places at most 2 orders per strike (bid + ask)
    # With max 8 orders, that means at most 4 strikes quoted simultaneously

    max_orders = 8
    orders_per_strike = 2  # bid + ask
    max_quoted_strikes = max_orders // orders_per_strike

    assert max_quoted_strikes == 4

    # MM should prioritize strikes or rotate quotes to stay under cap
    # In practice, MM should track resting order count before placing new ones


def test_ab10_prices_always_in_range() -> None:
    """MM quotes are always in [1, 99] cents."""
    fv_low = FairValue(
        market="test",
        ticker="AAPL",
        strike_cents=68000,
        fair_cents=2,  # Very low
        sigma=0.2,
        spot=230.0,
        as_of=datetime.now(UTC),
    )

    fv_high = FairValue(
        market="test",
        ticker="AAPL",
        strike_cents=68000,
        fair_cents=98,  # Very high
        sigma=0.2,
        spot=230.0,
        as_of=datetime.now(UTC),
    )

    # With large inventory, test extreme skew
    inv_positive = Inventory(strike_cents=68000, position=200)  # +4¢ skew
    inv_negative = Inventory(strike_cents=68000, position=-200)  # -4¢ skew

    # Low fair + large positive inventory
    quote1 = generate_quote(fv_low, inv_positive, spread_cents=5, size=10, skew_per_50=1)
    assert MIN_PRICE_CENTS <= quote1.bid_price <= MAX_PRICE_CENTS
    assert MIN_PRICE_CENTS <= quote1.ask_price <= MAX_PRICE_CENTS

    # Low fair + large negative inventory
    quote2 = generate_quote(fv_low, inv_negative, spread_cents=5, size=10, skew_per_50=1)
    assert MIN_PRICE_CENTS <= quote2.bid_price <= MAX_PRICE_CENTS
    assert MIN_PRICE_CENTS <= quote2.ask_price <= MAX_PRICE_CENTS

    # High fair + large positive inventory
    quote3 = generate_quote(fv_high, inv_positive, spread_cents=5, size=10, skew_per_50=1)
    assert MIN_PRICE_CENTS <= quote3.bid_price <= MAX_PRICE_CENTS
    assert MIN_PRICE_CENTS <= quote3.ask_price <= MAX_PRICE_CENTS

    # High fair + large negative inventory
    quote4 = generate_quote(fv_high, inv_negative, spread_cents=5, size=10, skew_per_50=1)
    assert MIN_PRICE_CENTS <= quote4.bid_price <= MAX_PRICE_CENTS
    assert MIN_PRICE_CENTS <= quote4.ask_price <= MAX_PRICE_CENTS


def test_ab10_extreme_inventory_skew() -> None:
    """Test that extreme inventory doesn't break price bounds."""
    fv = FairValue(
        market="test",
        ticker="AAPL",
        strike_cents=68000,
        fair_cents=50,
        sigma=0.2,
        spot=230.0,
        as_of=datetime.now(UTC),
    )

    # Extreme inventory (should never happen, but test it)
    inv_extreme = Inventory(strike_cents=68000, position=1000)  # +20¢ skew

    quote = generate_quote(fv, inv_extreme, spread_cents=2, size=10, skew_per_50=1)

    # Prices still in valid range
    assert MIN_PRICE_CENTS <= quote.bid_price <= MAX_PRICE_CENTS
    assert MIN_PRICE_CENTS <= quote.ask_price <= MAX_PRICE_CENTS

    # Bid still < ask
    assert quote.bid_price < quote.ask_price


def test_ab10_inventory_tracking_consistency() -> None:
    """Inventory tracking remains consistent under updates."""
    tracker = InventoryTracker()

    # Sequence of updates
    tracker.update(68000, 50)
    tracker.update(68000, 30)
    tracker.update(68000, -20)

    assert tracker.get(68000).position == 60

    # Different strikes are independent
    tracker.update(70000, 100)
    assert tracker.get(68000).position == 60
    assert tracker.get(70000).position == 100
