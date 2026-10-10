"""Quote generation with skew."""

from .config import MAX_PRICE_CENTS, MIN_PRICE_CENTS
from .types import FairValue, Inventory, Quote


def generate_quote(
    fair_value: FairValue,
    inventory: Inventory,
    spread_cents: int,
    size: int,
    skew_per_50: int,
) -> Quote:
    """Generate a two-sided quote around fair value with inventory skew.

    Per domain.md § Market maker defaults:
    - Quote fair ± spread
    - Skew 1¢ per 50 contracts of inventory
    - Prices clamped to [1, 99]

    Positive inventory (long YES) → widen bid (lower), tighten ask (lower)
    Negative inventory (short YES) → tighten bid (higher), widen ask (higher)
    """
    fair_cents = fair_value.fair_cents
    skew_cents = inventory.skew_cents(skew_per_50)

    # Apply skew: positive inventory pushes both quotes down, negative pushes up
    bid_price = fair_cents - spread_cents - skew_cents
    ask_price = fair_cents + spread_cents - skew_cents

    # Clamp to valid range [1, 99]
    bid_price = max(MIN_PRICE_CENTS, min(MAX_PRICE_CENTS, bid_price))
    ask_price = max(MIN_PRICE_CENTS, min(MAX_PRICE_CENTS, ask_price))

    # Ensure bid < ask (if they cross after skew, use mid)
    if bid_price >= ask_price:
        mid = (bid_price + ask_price) // 2
        bid_price = max(MIN_PRICE_CENTS, mid - 1)
        ask_price = min(MAX_PRICE_CENTS, mid + 1)

    return Quote(
        market=fair_value.market,
        ticker=fair_value.ticker,
        strike_cents=fair_value.strike_cents,
        bid_price=bid_price,
        ask_price=ask_price,
        size=size,
    )
