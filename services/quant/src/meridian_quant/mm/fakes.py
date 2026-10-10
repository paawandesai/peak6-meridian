"""Fake implementations for MM loop testing (AC1/AC2)."""

import logging
from collections import defaultdict

from .types import FairValue, MarketState, RestingOrder

logger = logging.getLogger(__name__)


class FakeMarketSource:
    """Fake market source for tests."""

    def __init__(self, markets: list[MarketState] | None = None) -> None:
        self._markets = markets or []

    async def fetch_open_markets(self) -> list[MarketState]:
        return self._markets.copy()


class FakeFairValueSource:
    """Fake fair value source for tests."""

    def __init__(self, fair_values: list[FairValue] | None = None) -> None:
        self._fair_values = fair_values or []

    async def fetch_fair_values(self) -> list[FairValue]:
        return self._fair_values.copy()


class FakeOrderClient:
    """Fake order client for tests - tracks orders in memory."""

    def __init__(self) -> None:
        # market -> list of orders
        self._orders: dict[str, list[RestingOrder]] = defaultdict(list)
        self._next_order_id = 1
        # (market, owner) -> YES/NO token balances
        self._yes_balances: dict[tuple[str, str], int] = defaultdict(int)
        self._no_balances: dict[tuple[str, str], int] = defaultdict(int)
        self.cycles_started = 0
        # (operation, market) for every transaction-sending call, in call order (test helper:
        # lets tests check the per-market cancel -> settle -> mint -> place sequence)
        self.call_log: list[tuple[str, str]] = []

    def begin_cycle(self) -> None:
        """Count loop cycles (test helper; the chain client resets its blockhash cache)."""
        self.cycles_started += 1

    async def place_order(  # noqa: PLR0913, PLR0917 - OrderClient signature
        self,
        market: str,
        side: str,
        price: int,
        qty: int,
        owner: str,
        resting_orders: list[RestingOrder] | None = None,  # noqa: ARG002 - unused in fake
    ) -> int:
        """Place an order and return its ID."""
        self.call_log.append(("place", market))
        order_id = self._next_order_id
        self._next_order_id += 1

        # Type narrowing: side must be "Bid" or "Ask" per RestingOrder
        if side not in ("Bid", "Ask"):
            raise ValueError(f"Invalid side: {side}")

        order = RestingOrder(
            order_id=order_id,
            market=market,
            side=side,  # type: ignore[arg-type]
            price=price,
            qty=qty,
            owner=owner,
        )
        self._orders[market].append(order)
        return order_id

    async def cancel_order(self, market: str, order_id: int, owner: str) -> None:
        """Cancel an order."""
        self.call_log.append(("cancel", market))
        self._orders[market] = [
            o for o in self._orders[market] if not (o.order_id == order_id and o.owner == owner)
        ]

    async def fetch_resting_orders(self, market: str) -> list[RestingOrder]:
        """Fetch all resting orders for a market."""
        return self._orders[market].copy()

    async def fetch_resting_orders_batch(self, markets: list[str]) -> dict[str, list[RestingOrder]]:
        """Batch fetch built on fetch_resting_orders so per-market fault injection works.

        A market whose fetch raises is left out of the result (the loop fails closed on it).
        """
        books: dict[str, list[RestingOrder]] = {}
        for market in markets:
            try:
                books[market] = await self.fetch_resting_orders(market)
            except Exception:
                logger.exception(f"Fake fetch failed for {market}")
        return books

    async def mint_pair(self, market: str, qty: int, owner: str) -> None:
        """Mint a YES+NO pair - increases both YES and NO balances."""
        self.call_log.append(("mint", market))
        key = (market, owner)
        self._yes_balances[key] = self._yes_balances[key] + qty
        self._no_balances[key] = self._no_balances[key] + qty

    async def settle_funds(self, market: str, owner: str) -> None:
        """Settle funds to withdraw fill proceeds (no-op in fake)."""
        self.call_log.append(("settle", market))

    async def get_yes_token_balance(self, market: str, owner: str) -> int:
        """Get YES token balance for owner in market."""
        return self._yes_balances[(market, owner)]

    async def get_no_token_balance(self, market: str, owner: str) -> int:
        """Get NO token balance for owner in market."""
        return self._no_balances[(market, owner)]

    async def get_multiple_token_balances(
        self, markets: list[str], owner: str
    ) -> dict[str, tuple[int, int]]:
        """Batch-fetch YES and NO token balances for multiple markets (P1-7)."""
        return {
            market: (
                self._yes_balances[(market, owner)],
                self._no_balances[(market, owner)],
            )
            for market in markets
        }

    def set_yes_balance(self, market: str, owner: str, balance: int) -> None:
        """Set YES balance (test helper)."""
        self._yes_balances[(market, owner)] = balance

    def set_no_balance(self, market: str, owner: str, balance: int) -> None:
        """Set NO balance (test helper)."""
        self._no_balances[(market, owner)] = balance

    def count_orders_by_owner(self, market: str, owner: str) -> int:
        """Count orders by owner for a market (test helper)."""
        return sum(1 for o in self._orders[market] if o.owner == owner)

    def get_all_orders(self) -> dict[str, list[RestingOrder]]:
        """Get all orders (test helper)."""
        return dict(self._orders)
