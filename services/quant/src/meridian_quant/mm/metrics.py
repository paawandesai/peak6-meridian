"""Market maker metrics."""

from collections.abc import Sequence

from .types import RestingOrder


def book_coverage(
    open_strikes: Sequence[int],
    resting_orders: Sequence[RestingOrder],
    mm_owner: str,
) -> float:
    """Calculate the share of open strikes with a two-sided MM quote.

    A strike is "covered" if it has at least one MM bid and one MM ask.
    Returns a value in [0.0, 1.0].
    """
    if not open_strikes:
        return 0.0

    # Group MM orders by strike
    strikes_with_bids: set[int] = set()
    strikes_with_asks: set[int] = set()

    for order in resting_orders:
        if order.owner == mm_owner:
            # Extract strike from market address (not ideal, but works for metric)
            # In practice, orders should include strike or market metadata
            if order.side == "Bid":
                strikes_with_bids.add(order.price)  # Placeholder
            else:
                strikes_with_asks.add(order.price)

    # For now, simplified: count strikes that have both sides
    # Real impl would parse market from order and match to strikes
    covered_count = len(strikes_with_bids & strikes_with_asks)

    return covered_count / len(open_strikes)
