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

    async def place_order(  # noqa: PLR0913, PLR0917
        self,
        market: str,
        side: str,
        price: int,
        qty: int,
        owner: str,
        resting_orders: list[RestingOrder] | None = None,
    ) -> int:
        """Place an order. Returns order_id.

        resting_orders: the market's resting orders if the caller just read them (P1-7);
        the client fetches them itself when None.
        """
        ...

    async def cancel_order(self, market: str, order_id: int, owner: str) -> None:
        """Cancel an order."""
        ...

    async def fetch_resting_orders(self, market: str) -> list[RestingOrder]:
        """Fetch all resting orders for a market."""
        ...

    async def fetch_resting_orders_batch(self, markets: list[str]) -> dict[str, list[RestingOrder]]:
        """Fetch resting orders for many markets in batched reads (P1-7).

        Raises if the read fails. A market missing from the result could not be read and
        must be treated as unknown (fail closed, AB-10).
        """
        ...

    async def mint_pair(self, market: str, qty: int, owner: str) -> None:
        """Mint a YES+NO pair for inventory."""
        ...

    async def settle_funds(self, market: str, owner: str) -> None:
        """Settle funds to withdraw fill proceeds."""
        ...

    async def get_yes_token_balance(self, market: str, owner: str) -> int:
        """Get YES token balance for owner in market."""
        ...

    async def get_no_token_balance(self, market: str, owner: str) -> int:
        """Get NO token balance for owner in market."""
        ...

    async def get_multiple_token_balances(
        self, markets: list[str], owner: str
    ) -> dict[str, tuple[int, int]]:
        """Batch-fetch (YES, NO) token balances for many markets (P1-7).

        Raises if the read fails. A market missing from the result must not be quoted.
        """
        ...

    def begin_cycle(self) -> None:
        """Mark the start of a loop cycle (lets the client reuse per-cycle RPC state)."""
        ...
