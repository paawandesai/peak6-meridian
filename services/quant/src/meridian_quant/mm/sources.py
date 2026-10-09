"""Dependency injection protocols for MM loop testability (AC1/AC2)."""

from typing import Protocol

from .types import FairValue, MarketState, RestingOrder


class MarketSource(Protocol):
    """Source of open markets (injectable for tests)."""

    async def fetch_open_markets(self) -> list[MarketState]:
        """Fetch all open markets."""
        ...


class FairValueSource(Protocol):
    """Source of fair values (injectable for tests)."""

    async def fetch_fair_values(self) -> list[FairValue]:
        """Fetch fair values for all markets."""
        ...


class OrderClient(Protocol):
    """Client for placing/canceling orders (injectable for tests)."""

    async def place_order(
        self, market: str, side: str, price: int, qty: int, owner: str
    ) -> int:
        """Place an order. Returns order_id."""
        ...

    async def cancel_order(self, market: str, order_id: int, owner: str) -> None:
        """Cancel an order."""
        ...

    async def fetch_resting_orders(self, market: str) -> list[RestingOrder]:
        """Fetch all resting orders for a market."""
        ...

    async def mint_pair(self, market: str, qty: int, owner: str) -> None:
        """Mint a YES+NO pair for inventory."""
        ...
