"""Tests for the main MM loop (AC2: fake clock and fake fair values)."""

from datetime import UTC, datetime, timedelta

import base58
import pytest
from solders.keypair import Keypair  # type: ignore[import-untyped]

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
    # Use a valid keypair's bytes
    keypair_bytes = bytes(test_keypair)
    # Encode as base58 for the config (note: this is the full 64-byte seed+pubkey)
    return MMConfig(
        market_maker_keypair=base58.b58encode(keypair_bytes).decode('ascii'),
        program_id="11111111111111111111111111111112",
        service_token="test_token",
    )


@pytest.mark.asyncio
async def test_pull_on_stale_spot_data(mm_config: MMConfig) -> None:
    """MM pulls all quotes when spot data is > 10s old (AC2)."""
    # Inject a fake clock
    now = datetime.now(UTC)
    fake_clock = lambda: now
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
    fake_clock = lambda: now
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
    fake_clock = lambda: now
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
    fake_clock = lambda: now
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
    fake_clock = lambda: now
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
