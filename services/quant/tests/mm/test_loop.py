"""Tests for the main MM loop (AC2: fake clock and fake fair values)."""

import json
from datetime import UTC, datetime, timedelta

import pytest
from solders.keypair import Keypair

from meridian_quant.mm.config import MMConfig
from meridian_quant.mm.fakes import FakeFairValueSource, FakeMarketSource, FakeOrderClient
from meridian_quant.mm.loop import MarketMakerLoop
from meridian_quant.mm.quoter import generate_quote
from meridian_quant.mm.types import FairValue, Inventory, MarketKey, MarketState


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
async def test_pull_on_stale_spot_data(mm_config: MMConfig) -> None:
    """MM pulls all quotes when spot data is > 10s old (AC2)."""
    # Inject a fake clock
    now = datetime.now(UTC)

    def fake_clock() -> datetime:
        return now

    mm = MarketMakerLoop(
        mm_config,
        market_source=FakeMarketSource(),
        fair_value_source=FakeFairValueSource(),
        order_client=FakeOrderClient(),
        clock=fake_clock,
    )

    # Create fair value with stale timestamp
    stale_time = now - timedelta(seconds=15)

    fair_values = [
        FairValue(
            market="test_market",
            ticker="AAPL",
            strike_cents=68000,
            fair_cents=50,
            sigma=0.2,
            spot=230.0,
            as_of=stale_time,  # 15 seconds old
        )
    ]

    # Check pull condition (no markets needed for stale check)
    should_pull = mm._should_pull_all_quotes(fair_values, [])
    assert should_pull is True


@pytest.mark.asyncio
async def test_no_pull_on_fresh_spot_data(mm_config: MMConfig) -> None:
    """MM does not pull quotes when spot data is fresh (AC2)."""
    now = datetime.now(UTC)

    def fake_clock() -> datetime:
        return now

    mm = MarketMakerLoop(
        mm_config,
        market_source=FakeMarketSource(),
        fair_value_source=FakeFairValueSource(),
        order_client=FakeOrderClient(),
        clock=fake_clock,
    )

    fair_values = [
        FairValue(
            market="test_market",
            ticker="AAPL",
            strike_cents=68000,
            fair_cents=50,
            sigma=0.2,
            spot=230.0,
            as_of=now,  # Fresh
        )
    ]

    # No markets, fresh spot → no pull
    should_pull = mm._should_pull_all_quotes(fair_values, [])
    assert should_pull is False


@pytest.mark.asyncio
async def test_pull_on_stale_flag(mm_config: MMConfig) -> None:
    """MM pulls all quotes when fair value has stale=True flag (AC2)."""
    now = datetime.now(UTC)

    def fake_clock() -> datetime:
        return now

    mm = MarketMakerLoop(
        mm_config,
        market_source=FakeMarketSource(),
        fair_value_source=FakeFairValueSource(),
        order_client=FakeOrderClient(),
        clock=fake_clock,
    )

    fair_values = [
        FairValue(
            market="test_market",
            ticker="AAPL",
            strike_cents=68000,
            fair_cents=50,
            sigma=0.2,
            spot=230.0,
            as_of=now,
            stale=True,  # Marked as stale
        )
    ]

    should_pull = mm._should_pull_all_quotes(fair_values, [])
    assert should_pull is True


@pytest.mark.asyncio
async def test_pull_within_2_min_of_close(mm_config: MMConfig) -> None:
    """MM pulls quotes when < 2 min to close (AC2, Finding #2)."""
    # Set fake clock at 15:58:30 (90 seconds before close at 16:00)
    now = datetime(2026, 10, 8, 15, 58, 30, tzinfo=UTC)

    def fake_clock() -> datetime:
        return now

    mm = MarketMakerLoop(
        mm_config,
        market_source=FakeMarketSource(),
        fair_value_source=FakeFairValueSource(),
        order_client=FakeOrderClient(),
        clock=fake_clock,
    )

    # Market closes at 16:00 (90 seconds away)
    close_ts = int(datetime(2026, 10, 8, 16, 0, 0, tzinfo=UTC).timestamp())

    markets = [
        MarketState(
            market="test_market",
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
            market="test_market",
            ticker="AAPL",
            strike_cents=68000,
            fair_cents=50,
            sigma=0.2,
            spot=230.0,
            as_of=now,
        )
    ]

    # 90 seconds < 120 seconds (min_time_to_close_secs) → should pull
    should_pull = mm._should_pull_all_quotes(fair_values, markets)
    assert should_pull is True


@pytest.mark.asyncio
async def test_no_pull_when_far_from_close(mm_config: MMConfig) -> None:
    """MM does not pull when > 2 min to close (AC2, Finding #2)."""
    # Set fake clock at 15:00 (1 hour before close)
    now = datetime(2026, 10, 8, 15, 0, 0, tzinfo=UTC)

    def fake_clock() -> datetime:
        return now

    mm = MarketMakerLoop(
        mm_config,
        market_source=FakeMarketSource(),
        fair_value_source=FakeFairValueSource(),
        order_client=FakeOrderClient(),
        clock=fake_clock,
    )

    # Market closes at 16:00 (3600 seconds away)
    close_ts = int(datetime(2026, 10, 8, 16, 0, 0, tzinfo=UTC).timestamp())

    markets = [
        MarketState(
            market="test_market",
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
            market="test_market",
            ticker="AAPL",
            strike_cents=68000,
            fair_cents=50,
            sigma=0.2,
            spot=230.0,
            as_of=now,
        )
    ]

    # 3600 seconds > 120 seconds → should not pull
    should_pull = mm._should_pull_all_quotes(fair_values, markets)
    assert should_pull is False


@pytest.mark.asyncio
async def test_pull_after_close(mm_config: MMConfig) -> None:
    """MM pulls quotes after close (negative ttc, AB-11 thread fix)."""
    # Set fake clock AFTER close (16:05, 5 min after 16:00 close)
    now = datetime(2026, 10, 8, 16, 5, 0, tzinfo=UTC)

    def fake_clock() -> datetime:
        return now

    mm = MarketMakerLoop(
        mm_config,
        market_source=FakeMarketSource(),
        fair_value_source=FakeFairValueSource(),
        order_client=FakeOrderClient(),
        clock=fake_clock,
    )

    # Market closed at 16:00 (300 seconds ago, ttc = -300)
    close_ts = int(datetime(2026, 10, 8, 16, 0, 0, tzinfo=UTC).timestamp())

    markets = [
        MarketState(
            market="test_market",
            ticker="AAPL",
            strike_cents=68000,
            trading_date=20261008,
            close_ts=close_ts,
            is_open=True,  # Still Open status (not settled yet)
            pairs_outstanding=100,
        )
    ]

    fair_values = [
        FairValue(
            market="test_market",
            ticker="AAPL",
            strike_cents=68000,
            fair_cents=50,
            sigma=0.2,
            spot=230.0,
            as_of=now,
        )
    ]

    # ttc = -300 < 120 → should pull (cancel orders even after close per AB-11)
    should_pull = mm._should_pull_all_quotes(fair_values, markets)
    assert should_pull is True


@pytest.mark.asyncio
async def test_inventory_cap_respected(mm_config: MMConfig) -> None:
    """MM respects inventory cap of 200 per strike (AC2)."""
    mm = MarketMakerLoop(
        mm_config,
        market_source=FakeMarketSource(),
        fair_value_source=FakeFairValueSource(),
        order_client=FakeOrderClient(),
    )

    # Set inventory to limit
    key = MarketKey(ticker="AAPL", trading_date=20261008, strike_cents=68000)
    mm.inventory.set(key, 200)

    # Check limits
    assert mm.inventory.within_limits(key, mm_config.max_inventory)
    assert not mm.inventory.can_add(key, 10, mm_config.max_inventory)

    # Set inventory beyond limit
    mm.inventory.set(key, 250)
    assert not mm.inventory.within_limits(key, mm_config.max_inventory)


@pytest.mark.asyncio
async def test_skew_applied_correctly(mm_config: MMConfig) -> None:  # noqa: ARG001
    """MM applies 1¢ skew per 50 contracts of inventory (AC2)."""
    key = MarketKey(ticker="AAPL", trading_date=20261008, strike_cents=68000)
    fv = FairValue(
        market="test_market",
        ticker="AAPL",
        strike_cents=68000,
        fair_cents=50,
        sigma=0.2,
        spot=230.0,
        as_of=datetime.now(UTC),
    )

    # +100 inventory → +2¢ skew → prices down 2¢
    inv = Inventory(market_key=key, position=100)
    quote = generate_quote(fv, inv, spread_cents=2, size=10, skew_per_50=1)

    # fair=50, spread=2, skew=+2 → bid=50-2-2=46, ask=50+2-2=50
    assert quote.bid_price == 46
    assert quote.ask_price == 50


@pytest.mark.asyncio
async def test_inventory_cap_enforced_in_run_once(mm_config: MMConfig) -> None:
    """AC2: MM stops quoting when signed position at ±200 cap (Finding #3).

    Drive _run_once with FakeOrderClient balances set to cap. Verify loop
    doesn't place quotes when |YES - NO| >= 200.
    """
    # Use a fixed date to ensure market is "today" (Finding #3: prior-day markets skipped)
    now = datetime(2026, 10, 8, 18, 0, tzinfo=UTC)  # 2026-10-08 14:00 ET
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

    fv = FairValue(
        market=market.market,
        ticker=market.ticker,
        strike_cents=market.strike_cents,
        fair_cents=50,
        sigma=0.2,
        spot=230.0,
        as_of=now,
    )

    order_client = FakeOrderClient()
    mm = MarketMakerLoop(
        mm_config,
        market_source=FakeMarketSource([market]),
        fair_value_source=FakeFairValueSource([fv]),
        order_client=order_client,
        clock=lambda: now,
    )

    mm_owner = str(mm.keypair.pubkey())

    # Set signed position at cap: YES=250, NO=50 → position=+200
    order_client.set_yes_balance(market.market, mm_owner, 250)
    order_client.set_no_balance(market.market, mm_owner, 50)

    await mm._run_once()

    # Cap enforced: no quotes placed (would exceed limit)
    orders = await order_client.fetch_resting_orders(market.market)
    mm_orders = [o for o in orders if o.owner == mm_owner]
    assert len(mm_orders) == 0, f"Expected 0 orders at cap, got {len(mm_orders)}"

    # Now set position below cap: YES=190, NO=0 → position=+190
    order_client.set_yes_balance(market.market, mm_owner, 190)
    order_client.set_no_balance(market.market, mm_owner, 0)

    await mm._run_once()

    # Below cap: quotes placed
    orders = await order_client.fetch_resting_orders(market.market)
    mm_orders = [o for o in orders if o.owner == mm_owner]
    assert len(mm_orders) == 2, f"Expected 2 orders below cap, got {len(mm_orders)}"


@pytest.mark.asyncio
async def test_prior_day_markets_dont_block_today_quoting(mm_config: MMConfig) -> None:
    """Prior-day markets past close don't prevent quoting today (Finding #3, AB-11).

    ChainMarketSource keeps post-close Open markets for settlement. Verify one
    unsettled market from yesterday doesn't disable quoting on today's strikes.
    """
    # Clock at 2026-10-09 14:00 ET (18:00 UTC)
    now = datetime(2026, 10, 9, 18, 0, tzinfo=UTC)

    def fake_clock() -> datetime:
        return now

    # Yesterday's market: trading_date=20261008, already past close
    yesterday_close_ts = int((now - timedelta(hours=20)).timestamp())  # Closed 20h ago
    yesterday_market = MarketState(
        market="AAPL_20261008_23000",
        ticker="AAPL",
        strike_cents=23000,
        trading_date=20261008,  # Yesterday
        close_ts=yesterday_close_ts,
        is_open=True,  # Still Open for settlement (AB-11)
        pairs_outstanding=100,
    )

    # Today's market: trading_date=20261009, closes in 2 hours
    today_close_ts = int((now + timedelta(hours=2)).timestamp())
    today_market = MarketState(
        market="AAPL_20261009_23000",
        ticker="AAPL",
        strike_cents=23000,
        trading_date=20261009,  # Today
        close_ts=today_close_ts,
        is_open=True,
        pairs_outstanding=100,
    )

    markets = [yesterday_market, today_market]
    market_source = FakeMarketSource(markets)

    # Fair value only for today's market (M3-01 doesn't quote prior days)
    fair_values = [
        FairValue(
            market=today_market.market,
            ticker="AAPL",
            strike_cents=23000,
            fair_cents=50,
            sigma=0.2,
            spot=230.0,
            as_of=now,
        )
    ]
    fv_source = FakeFairValueSource(fair_values)
    order_client = FakeOrderClient()

    mm = MarketMakerLoop(
        mm_config,
        market_source=market_source,
        fair_value_source=fv_source,
        order_client=order_client,
        clock=fake_clock,
    )

    # Seed inventory for both markets (MM has positions from yesterday)
    order_client.set_yes_balance(yesterday_market.market, str(mm.keypair.pubkey()), 50)
    order_client.set_no_balance(yesterday_market.market, str(mm.keypair.pubkey()), 50)
    order_client.set_yes_balance(today_market.market, str(mm.keypair.pubkey()), 50)
    order_client.set_no_balance(today_market.market, str(mm.keypair.pubkey()), 50)

    await mm._run_once()

    # Verify: today's market gets quotes, yesterday's doesn't
    mm_owner = str(mm.keypair.pubkey())
    today_orders = await order_client.fetch_resting_orders(today_market.market)
    today_mm_orders = [o for o in today_orders if o.owner == mm_owner]
    assert len(today_mm_orders) == 2, (
        f"Expected 2 quotes on today's market, got {len(today_mm_orders)}"
    )

    yesterday_orders = await order_client.fetch_resting_orders(yesterday_market.market)
    yesterday_mm_orders = [o for o in yesterday_orders if o.owner == mm_owner]
    # Yesterday's market has no new quotes (no fair value provided anyway)
    assert len(yesterday_mm_orders) == 0, (
        f"Expected 0 quotes on yesterday's market, got {len(yesterday_mm_orders)}"
    )
