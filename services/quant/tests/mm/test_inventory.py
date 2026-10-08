"""Tests for inventory tracking."""


from meridian_quant.mm.inventory import InventoryTracker


def test_inventory_starts_at_zero() -> None:
    """Initial inventory is zero for any strike."""
    tracker = InventoryTracker()
    inv = tracker.get(68000)
    assert inv.strike_cents == 68000
    assert inv.position == 0


def test_inventory_update() -> None:
    """Can update inventory with deltas."""
    tracker = InventoryTracker()
    tracker.update(68000, 50)
    assert tracker.get(68000).position == 50

    tracker.update(68000, -20)
    assert tracker.get(68000).position == 30


def test_inventory_set() -> None:
    """Can set absolute position."""
    tracker = InventoryTracker()
    tracker.set(68000, 100)
    assert tracker.get(68000).position == 100


def test_within_limits() -> None:
    """Check if inventory is within limits."""
    tracker = InventoryTracker()
    tracker.set(68000, 150)
    assert tracker.within_limits(68000, max_inventory=200)
    assert not tracker.within_limits(68000, max_inventory=100)

    tracker.set(68000, -150)
    assert tracker.within_limits(68000, max_inventory=200)
    assert not tracker.within_limits(68000, max_inventory=100)


def test_can_add() -> None:
    """Check if can add delta without exceeding limits."""
    tracker = InventoryTracker()
    tracker.set(68000, 180)

    assert tracker.can_add(68000, 10, max_inventory=200)
    assert not tracker.can_add(68000, 30, max_inventory=200)

    tracker.set(68000, -180)
    assert tracker.can_add(68000, -10, max_inventory=200)
    assert not tracker.can_add(68000, -30, max_inventory=200)


def test_skew_calculation() -> None:
    """Test skew calculation per domain.md (1¢ per 50 contracts)."""
    tracker = InventoryTracker()

    # No position → no skew
    assert tracker.get(68000).skew_cents(skew_per_50=1) == 0

    # +50 contracts → +1¢ skew
    tracker.set(68000, 50)
    assert tracker.get(68000).skew_cents(skew_per_50=1) == 1

    # -50 contracts → -1¢ skew
    tracker.set(68000, -50)
    assert tracker.get(68000).skew_cents(skew_per_50=1) == -1

    # +100 contracts → +2¢ skew
    tracker.set(68000, 100)
    assert tracker.get(68000).skew_cents(skew_per_50=1) == 2

    # +25 contracts → rounds to 0¢ skew
    tracker.set(68000, 25)
    assert tracker.get(68000).skew_cents(skew_per_50=1) == 0

    # +75 contracts → rounds to +2¢ skew
    tracker.set(68000, 75)
    assert tracker.get(68000).skew_cents(skew_per_50=1) == 2
