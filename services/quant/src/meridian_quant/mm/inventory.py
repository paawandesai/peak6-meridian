"""Inventory tracking for the market maker."""

from collections import defaultdict

from .types import Inventory, MarketKey


class InventoryTracker:
    """Track inventory per market (ticker + trading_date + strike)."""

    def __init__(self) -> None:
        self._positions: dict[MarketKey, int] = defaultdict(int)

    def get(self, market_key: MarketKey) -> Inventory:
        """Get inventory for a market."""
        return Inventory(market_key=market_key, position=self._positions[market_key])

    def update(self, market_key: MarketKey, delta: int) -> None:
        """Update inventory for a market (delta = signed change in YES contracts)."""
        self._positions[market_key] += delta

    def set(self, market_key: MarketKey, position: int) -> None:
        """Set absolute position for a market."""
        self._positions[market_key] = position

    def within_limits(self, market_key: MarketKey, max_inventory: int) -> bool:
        """Check if current inventory is within limits."""
        return abs(self._positions[market_key]) <= max_inventory

    def can_add(self, market_key: MarketKey, delta: int, max_inventory: int) -> bool:
        """Check if adding delta to inventory would stay within limits."""
        new_position = self._positions[market_key] + delta
        return abs(new_position) <= max_inventory
