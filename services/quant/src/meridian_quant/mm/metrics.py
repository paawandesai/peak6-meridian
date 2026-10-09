"""Market maker metrics (Finding #4: key by market, not price)."""

from collections.abc import Sequence

from .types import RestingOrder


def book_coverage(
    open_markets: Sequence[str],  # Finding #4: list of market addresses
    resting_orders: Sequence[RestingOrder],
    mm_owner: str,
) -> float:
    """Calculate the share of open markets with a two-sided MM quote.
    
    Finding #4: Key by market, not order.price. A market is "covered" if the
    MM owner has at least one bid and one ask on that market.
    
    Returns a value in [0.0, 1.0].
    """
    if not open_markets:
        return 0.0
    
    # Group MM orders by market
    markets_with_bids: set[str] = set()
    markets_with_asks: set[str] = set()
    
    for order in resting_orders:
        if order.owner == mm_owner:
            if order.side == "Bid":
                markets_with_bids.add(order.market)
            else:
                markets_with_asks.add(order.market)
    
    # Count markets that have both a bid and an ask
    covered_markets = markets_with_bids & markets_with_asks
    
    return len(covered_markets) / len(open_markets)
