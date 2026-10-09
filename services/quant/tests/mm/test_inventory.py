"""Tests for inventory tracking (updated for Finding #5: MarketKey)."""

from meridian_quant.mm.inventory import InventoryTracker
from meridian_quant.mm.types import MarketKey


def test_inventory_starts_at_zero() -> None:
    """Initial inventory is zero for any market."""
    tracker = InventoryTracker()
    key = MarketKey(ticker="AAPL", trading_date=20261008, strike_cents=68000)
    inv = tracker.get(key)
    assert inv.market_key == key
    assert inv.position == 0


def test_inventory_update() -> None:
    """Can update inventory with deltas."""
    tracker = InventoryTracker()
    key = MarketKey(ticker="AAPL", trading_date=20261008, strike_cents=68000)
    tracker.update(key, 50)
    assert tracker.get(key).position == 50

    tracker.update(key, -20)
    assert tracker.get(key).position == 30


def test_inventory_set() -> None:
    """Can set absolute position."""
    tracker = InventoryTracker()
    key = MarketKey(ticker="AAPL", trading_date=20261008, strike_cents=68000)
    tracker.set(key, 100)
    assert tracker.get(key).position == 100


def test_within_limits() -> None:
    """Check if inventory is within limits."""
    tracker = InventoryTracker()
    key = MarketKey(ticker="AAPL", trading_date=20261008, strike_cents=68000)
    tracker.set(key, 150)
    assert tracker.within_limits(key, max_inventory=200)
    assert not tracker.within_limits(key, max_inventory=100)

    tracker.set(key, -150)
    assert tracker.within_limits(key, max_inventory=200)
    assert not tracker.within_limits(key, max_inventory=100)


def test_can_add() -> None:
    """Check if can add delta without exceeding limits."""
    tracker = InventoryTracker()
    key = MarketKey(ticker="AAPL", trading_date=20261008, strike_cents=68000)
    tracker.set(key, 180)

    assert tracker.can_add(key, 10, max_inventory=200)
    assert not tracker.can_add(key, 30, max_inventory=200)

    tracker.set(key, -180)
    assert tracker.can_add(key, -10, max_inventory=200)
    assert not tracker.can_add(key, -30, max_inventory=200)


def test_skew_calculation() -> None:
    """Test skew calculation per domain.md (1¢ per 50 contracts)."""
    tracker = InventoryTracker()
    key = MarketKey(ticker="AAPL", trading_date=20261008, strike_cents=68000)

    # No position → no skew
    assert tracker.get(key).skew_cents(skew_per_50=1) == 0

    # +50 contracts → +1¢ skew
    tracker.set(key, 50)
    assert tracker.get(key).skew_cents(skew_per_50=1) == 1

    # -50 contracts → -1¢ skew
    tracker.set(key, -50)
    assert tracker.get(key).skew_cents(skew_per_50=1) == -1

    # +100 contracts → +2¢ skew
    tracker.set(key, 100)
    assert tracker.get(key).skew_cents(skew_per_50=1) == 2

    # +25 contracts → rounds to 0¢ skew
    tracker.set(key, 25)
    assert tracker.get(key).skew_cents(skew_per_50=1) == 0

    # +75 contracts → rounds to +2¢ skew
    tracker.set(key, 75)
    assert tracker.get(key).skew_cents(skew_per_50=1) == 2


def test_different_tickers_independent_inventory() -> None:
    """Test Finding #5: AAPL $230 and MSFT $230 have independent inventory."""
    tracker = InventoryTracker()

    aapl_key = MarketKey(ticker="AAPL", trading_date=20261008, strike_cents=23000)
    msft_key = MarketKey(ticker="MSFT", trading_date=20261008, strike_cents=23000)

    # Set AAPL inventory
    tracker.set(aapl_key, 150)

    # MSFT should start at zero
    assert tracker.get(msft_key).position == 0

    # Set MSFT inventory
    tracker.set(msft_key, -100)

    # They should be independent
    assert tracker.get(aapl_key).position == 150
    assert tracker.get(msft_key).position == -100
