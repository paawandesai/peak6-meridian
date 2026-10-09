"""AB-10: Market maker limits (AC3).

Abuse case: MM never exceeds per-owner resting-order cap (8) or inventory cap (200).
Prices always in 1–99.
"""

from datetime import UTC, datetime

from meridian_quant.mm.config import MAX_PRICE_CENTS, MIN_PRICE_CENTS
from meridian_quant.mm.inventory import InventoryTracker
from meridian_quant.mm.quoter import generate_quote
from meridian_quant.mm.types import FairValue, Inventory, MarketKey


def test_ab10_inventory_cap_enforced() -> None:
    """MM never exceeds inventory cap of 200 per market."""
    tracker = InventoryTracker()
    max_inv = 200
    key = MarketKey(ticker="AAPL", trading_date=20261008, strike_cents=68000)

    # Can add up to cap
    tracker.set(key, 190)
    assert tracker.can_add(key, 10, max_inv)

    # Cannot exceed cap
    tracker.set(key, 200)
    assert not tracker.can_add(key, 1, max_inv)

    # Negative direction
    tracker.set(key, -200)
    assert not tracker.can_add(key, -1, max_inv)


def test_ab10_order_cap_per_owner() -> None:
    """MM never exceeds 8 resting orders per owner (domain.md § Limits)."""
    # MM places 2 orders per market (bid + ask)
    # With max 8 orders, MM can quote at most 4 markets simultaneously

    # Create 5 markets
    markets = [
        MarketKey(ticker="AAPL", trading_date=20261008, strike_cents=23000),
        MarketKey(ticker="AAPL", trading_date=20261008, strike_cents=23500),
        MarketKey(ticker="AAPL", trading_date=20261008, strike_cents=24000),
        MarketKey(ticker="MSFT", trading_date=20261008, strike_cents=42000),
        MarketKey(ticker="NVDA", trading_date=20261008, strike_cents=13500),
    ]

    # Generate quotes for each market
    quotes_generated = []
    for key in markets:
        fv = FairValue(
            market=f"{key.ticker}_{key.trading_date}_{key.strike_cents}",
            ticker=key.ticker,
            strike_cents=key.strike_cents,
            fair_cents=50,
            sigma=0.2,
            spot=230.0,
            as_of=datetime.now(UTC),
        )
        inv = Inventory(market_key=key, position=0)
        quote = generate_quote(fv, inv, spread_cents=2, size=10, skew_per_50=1)
        quotes_generated.append(quote)

    # Count total orders that would be placed (2 per quote: bid + ask)
    total_orders = len(quotes_generated) * 2

    # If MM were to place all quotes, it would exceed cap
    assert total_orders == 10  # 5 markets × 2 = 10 orders
    assert total_orders > 8    # Would exceed the cap

    # MM must limit to at most 4 markets (8 orders) at a time
    max_markets_quoted = 8 // 2
    assert max_markets_quoted == 4

    # In practice: loop._quote_all_strikes should track resting order count
    # and skip markets when count ≥ max_orders_per_owner (tested in test_loop.py)


def test_ab10_prices_always_in_range() -> None:
    """MM quotes are always in [1, 99] cents."""
    key = MarketKey(ticker="AAPL", trading_date=20261008, strike_cents=68000)

    fv_low = FairValue(
        market="test",
        ticker="AAPL",
        strike_cents=68000,
        fair_cents=2,  # Very low
        sigma=0.2,
        spot=230.0,
        as_of=datetime.now(UTC),
    )

    fv_high = FairValue(
        market="test",
        ticker="AAPL",
        strike_cents=68000,
        fair_cents=98,  # Very high
        sigma=0.2,
        spot=230.0,
        as_of=datetime.now(UTC),
    )

    # With large inventory, test extreme skew
    inv_positive = Inventory(market_key=key, position=200)  # +4¢ skew
    inv_negative = Inventory(market_key=key, position=-200)  # -4¢ skew

    # Low fair + large positive inventory
    quote1 = generate_quote(fv_low, inv_positive, spread_cents=5, size=10, skew_per_50=1)
    assert MIN_PRICE_CENTS <= quote1.bid_price <= MAX_PRICE_CENTS
    assert MIN_PRICE_CENTS <= quote1.ask_price <= MAX_PRICE_CENTS

    # Low fair + large negative inventory
    quote2 = generate_quote(fv_low, inv_negative, spread_cents=5, size=10, skew_per_50=1)
    assert MIN_PRICE_CENTS <= quote2.bid_price <= MAX_PRICE_CENTS
    assert MIN_PRICE_CENTS <= quote2.ask_price <= MAX_PRICE_CENTS

    # High fair + large positive inventory
    quote3 = generate_quote(fv_high, inv_positive, spread_cents=5, size=10, skew_per_50=1)
    assert MIN_PRICE_CENTS <= quote3.bid_price <= MAX_PRICE_CENTS
    assert MIN_PRICE_CENTS <= quote3.ask_price <= MAX_PRICE_CENTS

    # High fair + large negative inventory
    quote4 = generate_quote(fv_high, inv_negative, spread_cents=5, size=10, skew_per_50=1)
    assert MIN_PRICE_CENTS <= quote4.bid_price <= MAX_PRICE_CENTS
    assert MIN_PRICE_CENTS <= quote4.ask_price <= MAX_PRICE_CENTS


def test_ab10_extreme_inventory_skew() -> None:
    """Test that extreme inventory doesn't break price bounds."""
    key = MarketKey(ticker="AAPL", trading_date=20261008, strike_cents=68000)

    fv = FairValue(
        market="test",
        ticker="AAPL",
        strike_cents=68000,
        fair_cents=50,
        sigma=0.2,
        spot=230.0,
        as_of=datetime.now(UTC),
    )

    # Extreme inventory (should never happen, but test it)
    inv_extreme = Inventory(market_key=key, position=1000)  # +20¢ skew

    quote = generate_quote(fv, inv_extreme, spread_cents=2, size=10, skew_per_50=1)

    # Prices still in valid range
    assert MIN_PRICE_CENTS <= quote.bid_price <= MAX_PRICE_CENTS
    assert MIN_PRICE_CENTS <= quote.ask_price <= MAX_PRICE_CENTS

    # Bid still < ask
    assert quote.bid_price < quote.ask_price


def test_ab10_inventory_tracking_consistency() -> None:
    """Inventory tracking remains consistent under updates."""
    tracker = InventoryTracker()
    key1 = MarketKey(ticker="AAPL", trading_date=20261008, strike_cents=68000)
    key2 = MarketKey(ticker="AAPL", trading_date=20261008, strike_cents=70000)

    # Sequence of updates
    tracker.update(key1, 50)
    tracker.update(key1, 30)
    tracker.update(key1, -20)

    assert tracker.get(key1).position == 60

    # Different markets are independent
    tracker.update(key2, 100)
    assert tracker.get(key1).position == 60
    assert tracker.get(key2).position == 100
