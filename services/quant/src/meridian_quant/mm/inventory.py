"""Inventory tracking for the market maker."""

from collections import defaultdict

from .types import Inventory


class InventoryTracker:
    """Track inventory per strike."""

    def __init__(self) -> None:
        self._positions: dict[int, int] = defaultdict(int)

    def get(self, strike_cents: int) -> Inventory:
        """Get inventory for a strike."""
        return Inventory(strike_cents=strike_cents, position=self._positions[strike_cents])

    def update(self, strike_cents: int, delta: int) -> None:
        """Update inventory for a strike (delta = signed change in YES contracts)."""
        self._positions[strike_cents] += delta

    def set(self, strike_cents: int, position: int) -> None:
        """Set absolute position for a strike."""
        self._positions[strike_cents] = position

    def within_limits(self, strike_cents: int, max_inventory: int) -> bool:
        """Check if current inventory is within limits."""
        return abs(self._positions[strike_cents]) <= max_inventory

    def can_add(self, strike_cents: int, delta: int, max_inventory: int) -> bool:
        """Check if adding delta to inventory would stay within limits."""
        new_position = self._positions[strike_cents] + delta
        return abs(new_position) <= max_inventory
