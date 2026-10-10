"""Tests for market maker metrics (AC4: property test for book_coverage, Finding #4)."""

from hypothesis import given
from hypothesis import strategies as st

from meridian_quant.mm.metrics import book_coverage
from meridian_quant.mm.types import RestingOrder


def test_coverage_all_covered() -> None:
    """Coverage = 1.0 when all markets have both sides (Finding #4)."""
    orders = [
        RestingOrder(order_id=1, market="market_a", side="Bid", price=48, qty=10, owner="MM_OWNER"),
        RestingOrder(order_id=2, market="market_a", side="Ask", price=52, qty=10, owner="MM_OWNER"),
    ]
    cov = book_coverage(open_markets=["market_a"], resting_orders=orders, mm_owner="MM_OWNER")
    assert cov == 1.0


@given(
    num_markets=st.integers(min_value=1, max_value=20),
    num_covered=st.integers(min_value=0, max_value=20),
)
def test_coverage_property(num_markets: int, num_covered: int) -> None:
    """Property test: coverage equals covered/total (AC4, Finding #4)."""
    num_covered = min(num_covered, num_markets)
    markets = [f"market_{i}" for i in range(num_markets)]
    orders = []
    for i in range(num_covered):
        orders.extend(
            [
                RestingOrder(
                    order_id=i * 2,
                    market=markets[i],
                    side="Bid",
                    price=48,
                    qty=10,
                    owner="MM",
                ),
                RestingOrder(
                    order_id=i * 2 + 1,
                    market=markets[i],
                    side="Ask",
                    price=52,
                    qty=10,
                    owner="MM",
                ),
            ]
        )
    cov = book_coverage(open_markets=markets, resting_orders=orders, mm_owner="MM")
    assert cov == num_covered / num_markets
