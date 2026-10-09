"""AB-10: Market maker limits (AC3).

Abuse case: MM never exceeds per-owner resting-order cap (8) or inventory cap (200).
Prices always in 1-99.
"""

from datetime import UTC, datetime, timedelta

import base58
import pytest
from meridian_quant.mm.config import MAX_PRICE_CENTS, MIN_PRICE_CENTS, MMConfig
from meridian_quant.mm.fakes import FakeFairValueSource, FakeMarketSource, FakeOrderClient
from meridian_quant.mm.inventory import InventoryTracker
from meridian_quant.mm.loop import MarketMakerLoop
from meridian_quant.mm.quoter import generate_quote
from meridian_quant.mm.types import FairValue, Inventory, MarketKey, MarketState
from solders.keypair import Keypair  # type: ignore[import-untyped]


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


@pytest.mark.asyncio
async def test_ab10_order_cap_per_owner() -> None:
    """MM never exceeds 8 resting orders per owner (domain.md § Limits).

    Drive the actual MM loop with 5 open markets and verify it never places
    more than 8 resting orders (4 two-sided quotes).
    """
    now = datetime.now(UTC)
    close_ts = int((now + timedelta(hours=1)).timestamp())

    # 5 open markets - MM should only quote 4 (8 orders max)
    markets = [
        MarketState(
            market="AAPL_20261008_23000",
            ticker="AAPL",
            strike_cents=23000,
            trading_date=20261008,
            close_ts=close_ts,
            is_open=True,
            pairs_outstanding=100,
        ),
        MarketState(
            market="AAPL_20261008_23500",
            ticker="AAPL",
            strike_cents=23500,
            trading_date=20261008,
            close_ts=close_ts,
            is_open=True,
            pairs_outstanding=100,
        ),
        MarketState(
            market="AAPL_20261008_24000",
            ticker="AAPL",
            strike_cents=24000,
            trading_date=20261008,
            close_ts=close_ts,
            is_open=True,
            pairs_outstanding=100,
        ),
        MarketState(
            market="MSFT_20261008_42000",
            ticker="MSFT",
            strike_cents=42000,
            trading_date=20261008,
            close_ts=close_ts,
            is_open=True,
            pairs_outstanding=100,
        ),
        MarketState(
            market="NVDA_20261008_13500",
            ticker="NVDA",
            strike_cents=13500,
            trading_date=20261008,
            close_ts=close_ts,
            is_open=True,
            pairs_outstanding=100,
        ),
    ]

    fair_values = [
        FairValue(
            market=m.market,
            ticker=m.ticker,
            strike_cents=m.strike_cents,
            fair_cents=50,
            sigma=0.2,
            spot=230.0,
            as_of=now,
        )
        for m in markets
    ]

    # Create MM loop with fakes
    keypair = Keypair()
    config = MMConfig(
        market_maker_keypair=base58.b58encode(bytes(keypair)).decode("ascii"),
        program_id="11111111111111111111111111111112",
        service_token="test_token",
    )

    market_source = FakeMarketSource(markets)
    fv_source = FakeFairValueSource(fair_values)
    order_client = FakeOrderClient()

    mm = MarketMakerLoop(
        config,
        market_source=market_source,
        fair_value_source=fv_source,
        order_client=order_client,
        clock=lambda: now,
    )

    # Run loop once
    await mm._run_once()

    # Count total orders placed across all markets
    mm_owner = str(mm.keypair.pubkey())
    total_orders = 0
    for market in markets:
        count = order_client.count_orders_by_owner(market.market, mm_owner)
        total_orders += count

    # AB-10: Never exceed 8 orders per owner per market
    # (domain.md § Limits)
    assert total_orders <= 8, f"MM placed {total_orders} orders, exceeding cap of 8"

    # With 5 markets and 8 order cap, should quote exactly 4 markets (8 orders)
    assert total_orders == 8, f"Expected 8 orders (4 markets), got {total_orders}"


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


def test_ab10_mm_stops_quoting_at_inventory_limit() -> None:
    """MM stops quoting when position + quote_size would exceed limit (Finding #3)."""
    tracker = InventoryTracker()
    key = MarketKey(ticker="AAPL", trading_date=20261008, strike_cents=68000)
    max_inv = 200
    quote_size = 10

    # Position at 195: can still quote (195 + 10 = 205 > 200, so should NOT quote)
    tracker.set(key, 195)
    assert tracker.within_limits(key, max_inv)  # Still within limits
    assert not tracker.can_add(key, quote_size, max_inv)  # But can't add more

    # Position at 190: can quote (190 + 10 = 200, exactly at limit)
    tracker.set(key, 190)
    assert tracker.within_limits(key, max_inv)
    assert tracker.can_add(key, quote_size, max_inv)

    # Position at 200: within limits but can't add more
    tracker.set(key, 200)
    assert tracker.within_limits(key, max_inv)  # At limit
    assert not tracker.can_add(key, 1, max_inv)  # Can't add any more

    # Negative direction: position at -195
    tracker.set(key, -195)
    assert tracker.within_limits(key, max_inv)
    assert not tracker.can_add(key, -quote_size, max_inv)  # Would go to -205
