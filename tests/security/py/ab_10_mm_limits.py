"""AB-10: Market maker limits (AC3).

Abuse case: MM never exceeds per-owner resting-order cap (8) or inventory cap (200).
Prices always in 1-99.
"""

import json
from datetime import UTC, datetime, timedelta

import pytest
from meridian_quant.mm.config import MAX_PRICE_CENTS, MIN_PRICE_CENTS, MMConfig
from meridian_quant.mm.fakes import FakeFairValueSource, FakeMarketSource, FakeOrderClient
from meridian_quant.mm.inventory import InventoryTracker
from meridian_quant.mm.loop import MarketMakerLoop
from meridian_quant.mm.quoter import generate_quote
from meridian_quant.mm.types import FairValue, Inventory, MarketKey, MarketState
from solders.keypair import Keypair


@pytest.mark.asyncio
async def test_ab10_inventory_cap_enforced() -> None:
    """MM never exceeds inventory cap of 200 per market.

    Drives _run_once with FakeOrderClient balances at ±200 (including
    ask-fill YES=0, NO=200 path) and asserts no quotes are placed.
    """
    now = datetime(2026, 10, 8, 18, 0, tzinfo=UTC)  # 14:00 ET
    close_ts = int((now + timedelta(hours=1)).timestamp())

    market = MarketState(
        market="AAPL_20261008_23000",
        ticker="AAPL",
        strike_cents=23000,
        trading_date=20261008,
        close_ts=close_ts,
        is_open=True,
        pairs_outstanding=100,
    )

    fair_value = FairValue(
        market=market.market,
        ticker=market.ticker,
        strike_cents=market.strike_cents,
        fair_cents=50,
        sigma=0.2,
        spot=230.0,
        as_of=now,
    )

    keypair = Keypair()
    keypair_json = json.dumps(list(bytes(keypair)))
    config = MMConfig.model_validate(
        {
            "market_maker_keypair": keypair_json,
            "program_id": "11111111111111111111111111111112",
            "usdc_mint": "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
            "service_token": "test_token",
        }
    )

    mm_owner = str(keypair.pubkey())

    # Test +200 position (YES=200, NO=0): bid-fill path at cap
    order_client_pos = FakeOrderClient()
    order_client_pos.set_yes_balance(market.market, mm_owner, 200)
    order_client_pos.set_no_balance(market.market, mm_owner, 0)

    mm_pos = MarketMakerLoop(
        config,
        market_source=FakeMarketSource([market]),
        fair_value_source=FakeFairValueSource([fair_value]),
        order_client=order_client_pos,
        clock=lambda: now,
    )

    await mm_pos._run_once()

    # At +200, MM should NOT place any quotes (would exceed cap)
    pos_orders = order_client_pos.count_orders_by_owner(market.market, mm_owner)
    assert pos_orders == 0, f"At +200 position, MM should place 0 orders, got {pos_orders}"

    # Test -200 position (YES=0, NO=200): ask-fill path at cap
    order_client_neg = FakeOrderClient()
    order_client_neg.set_yes_balance(market.market, mm_owner, 0)
    order_client_neg.set_no_balance(market.market, mm_owner, 200)

    mm_neg = MarketMakerLoop(
        config,
        market_source=FakeMarketSource([market]),
        fair_value_source=FakeFairValueSource([fair_value]),
        order_client=order_client_neg,
        clock=lambda: now,
    )

    await mm_neg._run_once()

    # At -200, MM should NOT place any quotes (would exceed cap)
    neg_orders = order_client_neg.count_orders_by_owner(market.market, mm_owner)
    assert neg_orders == 0, f"At -200 position, MM should place 0 orders, got {neg_orders}"

    # Test within limits (position = 0): should place quotes
    order_client_ok = FakeOrderClient()
    order_client_ok.set_yes_balance(market.market, mm_owner, 0)
    order_client_ok.set_no_balance(market.market, mm_owner, 0)

    mm_ok = MarketMakerLoop(
        config,
        market_source=FakeMarketSource([market]),
        fair_value_source=FakeFairValueSource([fair_value]),
        order_client=order_client_ok,
        clock=lambda: now,
    )

    await mm_ok._run_once()

    # At position 0, MM should place 2 quotes (bid + ask)
    ok_orders = order_client_ok.count_orders_by_owner(market.market, mm_owner)
    assert ok_orders == 2, f"At position 0, MM should place 2 orders, got {ok_orders}"


@pytest.mark.asyncio
async def test_ab10_order_cap_per_owner() -> None:
    """MM never exceeds 8 resting orders per owner per market (domain.md § Limits).

    Seed 7 existing MM orders in one market, then run loop. MM should skip that
    market (placing 2 more would exceed 8) but still quote other markets.
    """
    # Fixed date to match market trading_date (Finding #3)
    now = datetime(2026, 10, 8, 18, 0, tzinfo=UTC)  # 2026-10-08 14:00 ET
    close_ts = int((now + timedelta(hours=1)).timestamp())

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
            market="AAPL_20261008_24000",
            ticker="AAPL",
            strike_cents=24000,
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

    keypair = Keypair()
    keypair_json = json.dumps(list(bytes(keypair)))
    config = MMConfig.model_validate(
        {
            "market_maker_keypair": keypair_json,
            "program_id": "11111111111111111111111111111112",
            "usdc_mint": "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
            "service_token": "test_token",
        }
    )

    market_source = FakeMarketSource(markets)
    fv_source = FakeFairValueSource(fair_values)
    order_client = FakeOrderClient()

    # Make cancel_order a no-op for this test to simulate orders that survive
    # (e.g., from other systems or failed cancel attempts)
    async def cancel_noop(market: str, order_id: int, owner: str) -> None:
        """No-op cancel for this test."""
        pass

    order_client.cancel_order = cancel_noop  # type: ignore[method-assign]

    mm = MarketMakerLoop(
        config,
        market_source=market_source,
        fair_value_source=fv_source,
        order_client=order_client,
        clock=lambda: now,
    )

    mm_owner = str(mm.keypair.pubkey())

    # Seed 7 existing orders in first market
    # With cancel as no-op, these will persist
    for i in range(7):
        await order_client.place_order(
            market=markets[0].market,
            side="Bid" if i % 2 == 0 else "Ask",
            price=45 + i,
            qty=10,
            owner=mm_owner,
        )

    # Run loop - should skip first market (7 + 2 > 8), quote second market
    await mm._run_once()

    # First market: still 7 orders (MM skipped it due to cap)
    market_0_orders = order_client.count_orders_by_owner(markets[0].market, mm_owner)
    assert market_0_orders == 7, (
        f"Market 0 should still have 7 orders (cap prevents new quotes), got {market_0_orders}"
    )

    # Second market: 2 orders (bid + ask placed)
    market_1_orders = order_client.count_orders_by_owner(markets[1].market, mm_owner)
    assert market_1_orders == 2, f"Market 1 should have 2 orders, got {market_1_orders}"

    # AB-10: Each market respects 8-order cap
    for market in markets:
        count = order_client.count_orders_by_owner(market.market, mm_owner)
        assert count <= 8, f"Market {market.market} has {count} orders, exceeds cap of 8"


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
