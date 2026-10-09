"""Integration tests for MM loop (AC1/AC2: fake sources, actual quote placing)."""

import json
from datetime import UTC, datetime, timedelta

import pytest
from solders.keypair import Keypair

from meridian_quant.mm.config import MMConfig
from meridian_quant.mm.fakes import FakeFairValueSource, FakeMarketSource, FakeOrderClient
from meridian_quant.mm.loop import MarketMakerLoop
from meridian_quant.mm.types import FairValue, MarketState


@pytest.fixture
def test_keypair() -> Keypair:
    """Generate a test keypair."""
    return Keypair()


@pytest.fixture
def mm_config(test_keypair: Keypair) -> MMConfig:
    """Test MM configuration."""
    # Convert to JSON array format per environment.md
    keypair_json = json.dumps(list(bytes(test_keypair)))
    return MMConfig.model_validate(
        {
            "market_maker_keypair": keypair_json,
            "program_id": "11111111111111111111111111111112",
            "usdc_mint": "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
            "service_token": "test_token",
        }
    )


@pytest.mark.asyncio
async def test_ac1_every_open_strike_has_two_sided_quotes(mm_config: MMConfig) -> None:
    """AC1: After _run_once, every open strike has bid + ask quotes."""
    # Fixed date to match market trading_date (Finding #3)
    now = datetime(2026, 10, 8, 18, 0, tzinfo=UTC)  # 2026-10-08 14:00 ET
    close_ts = int((now + timedelta(hours=1)).timestamp())

    # Three open markets
    markets = [
        MarketState(
            market="AAPL_20261008_68000",
            ticker="AAPL",
            strike_cents=68000,
            trading_date=20261008,
            close_ts=close_ts,
            is_open=True,
            pairs_outstanding=100,
        ),
        MarketState(
            market="AAPL_20261008_70000",
            ticker="AAPL",
            strike_cents=70000,
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
    ]

    # Fair values for all markets
    fair_values = [
        FairValue(
            market="AAPL_20261008_68000",
            ticker="AAPL",
            strike_cents=68000,
            fair_cents=50,
            sigma=0.2,
            spot=230.0,
            as_of=now,
        ),
        FairValue(
            market="AAPL_20261008_70000",
            ticker="AAPL",
            strike_cents=70000,
            fair_cents=45,
            sigma=0.2,
            spot=230.0,
            as_of=now,
        ),
        FairValue(
            market="MSFT_20261008_42000",
            ticker="MSFT",
            strike_cents=42000,
            fair_cents=55,
            sigma=0.25,
            spot=420.0,
            as_of=now,
        ),
    ]

    market_source = FakeMarketSource(markets)
    fv_source = FakeFairValueSource(fair_values)
    order_client = FakeOrderClient()

    mm = MarketMakerLoop(
        mm_config,
        market_source=market_source,
        fair_value_source=fv_source,
        order_client=order_client,
        clock=lambda: now,
    )

    # Run once
    await mm._run_once()

    # Verify every market has exactly 2 orders (bid + ask)
    mm_owner = str(mm.keypair.pubkey())
    for market in markets:
        orders = await order_client.fetch_resting_orders(market.market)
        mm_orders = [o for o in orders if o.owner == mm_owner]

        assert len(mm_orders) == 2, f"{market.ticker} should have 2 orders (bid+ask)"

        # Verify we have one bid and one ask
        sides = {o.side for o in mm_orders}
        assert sides == {"Bid", "Ask"}, f"{market.ticker} should have bid and ask"

    # Verify book coverage is 100%
    assert mm.book_coverage == 1.0


@pytest.mark.asyncio
async def test_ac2_quotes_cancelled_within_2_min_of_close(mm_config: MMConfig) -> None:
    """AC2: Quotes are cancelled when < 2 min to close."""
    # Set clock to 90 seconds before close
    now = datetime(2026, 10, 8, 15, 58, 30, tzinfo=UTC)
    close_ts = int(datetime(2026, 10, 8, 16, 0, 0, tzinfo=UTC).timestamp())

    markets = [
        MarketState(
            market="AAPL_20261008_68000",
            ticker="AAPL",
            strike_cents=68000,
            trading_date=20261008,
            close_ts=close_ts,
            is_open=True,
            pairs_outstanding=100,
        )
    ]

    fair_values = [
        FairValue(
            market="AAPL_20261008_68000",
            ticker="AAPL",
            strike_cents=68000,
            fair_cents=50,
            sigma=0.2,
            spot=230.0,
            as_of=now,
        )
    ]

    market_source = FakeMarketSource(markets)
    fv_source = FakeFairValueSource(fair_values)
    order_client = FakeOrderClient()

    # First, place some orders by running at 1 hour before close
    early_now = datetime(2026, 10, 8, 15, 0, 0, tzinfo=UTC)
    mm = MarketMakerLoop(
        mm_config,
        market_source=market_source,
        fair_value_source=fv_source,
        order_client=order_client,
        clock=lambda: early_now,
    )
    await mm._run_once()

    # Verify orders were placed
    mm_owner = str(mm.keypair.pubkey())
    orders_before = await order_client.fetch_resting_orders(markets[0].market)
    mm_orders_before = [o for o in orders_before if o.owner == mm_owner]
    assert len(mm_orders_before) == 2, "Should have 2 orders before pull time"

    # Now run at 90 seconds before close - should pull all quotes
    mm2 = MarketMakerLoop(
        mm_config,
        market_source=market_source,
        fair_value_source=fv_source,
        order_client=order_client,
        clock=lambda: now,  # 90 seconds before close
    )
    await mm2._run_once()

    # Verify all MM orders were cancelled
    orders_after = await order_client.fetch_resting_orders(markets[0].market)
    mm_orders_after = [o for o in orders_after if o.owner == mm_owner]
    assert len(mm_orders_after) == 0, "All MM orders should be cancelled <2min to close"


@pytest.mark.asyncio
async def test_ac3_respects_8_order_cap_per_owner_per_market(mm_config: MMConfig) -> None:
    """AC3: MM never exceeds 8 resting orders per owner per market."""
    # Fixed date to match market trading_date (Finding #3)
    now = datetime(2026, 10, 8, 18, 0, tzinfo=UTC)  # 2026-10-08 14:00 ET
    close_ts = int((now + timedelta(hours=1)).timestamp())

    # One market
    markets = [
        MarketState(
            market="AAPL_20261008_68000",
            ticker="AAPL",
            strike_cents=68000,
            trading_date=20261008,
            close_ts=close_ts,
            is_open=True,
            pairs_outstanding=100,
        )
    ]

    fair_values = [
        FairValue(
            market="AAPL_20261008_68000",
            ticker="AAPL",
            strike_cents=68000,
            fair_cents=50,
            sigma=0.2,
            spot=230.0,
            as_of=now,
        )
    ]

    market_source = FakeMarketSource(markets)
    fv_source = FakeFairValueSource(fair_values)
    order_client = FakeOrderClient()

    mm = MarketMakerLoop(
        mm_config,
        market_source=market_source,
        fair_value_source=fv_source,
        order_client=order_client,
        clock=lambda: now,
    )

    # Run once - should place 2 orders (bid + ask)
    await mm._run_once()

    mm_owner = str(mm.keypair.pubkey())
    order_count = order_client.count_orders_by_owner(markets[0].market, mm_owner)

    # Domain.md: max 8 resting orders per owner per market
    # MM places 2 per strike (bid + ask)
    assert order_count <= 8, f"MM has {order_count} orders, exceeds cap of 8"
    assert order_count == 2, "Should have exactly 2 orders for 1 strike"


@pytest.mark.asyncio
async def test_coverage_metric_computed_correctly(mm_config: MMConfig) -> None:
    """AC4: Coverage metric reflects actual two-sided quoting."""
    # Fixed date to match market trading_date (Finding #3)
    now = datetime(2026, 10, 8, 18, 0, tzinfo=UTC)  # 2026-10-08 14:00 ET
    close_ts = int((now + timedelta(hours=1)).timestamp())

    # Three markets
    markets = [
        MarketState(
            market="AAPL_20261008_68000",
            ticker="AAPL",
            strike_cents=68000,
            trading_date=20261008,
            close_ts=close_ts,
            is_open=True,
            pairs_outstanding=100,
        ),
        MarketState(
            market="AAPL_20261008_70000",
            ticker="AAPL",
            strike_cents=70000,
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
    ]

    # Only provide fair values for 2 out of 3 markets
    fair_values = [
        FairValue(
            market="AAPL_20261008_68000",
            ticker="AAPL",
            strike_cents=68000,
            fair_cents=50,
            sigma=0.2,
            spot=230.0,
            as_of=now,
        ),
        FairValue(
            market="AAPL_20261008_70000",
            ticker="AAPL",
            strike_cents=70000,
            fair_cents=45,
            sigma=0.2,
            spot=230.0,
            as_of=now,
        ),
        # MSFT market has no fair value - won't be quoted
    ]

    market_source = FakeMarketSource(markets)
    fv_source = FakeFairValueSource(fair_values)
    order_client = FakeOrderClient()

    mm = MarketMakerLoop(
        mm_config,
        market_source=market_source,
        fair_value_source=fv_source,
        order_client=order_client,
        clock=lambda: now,
    )

    await mm._run_once()

    # Coverage should be 2/3 = 0.666... (2 markets quoted out of 3 open)
    assert abs(mm.book_coverage - (2.0 / 3.0)) < 0.01
