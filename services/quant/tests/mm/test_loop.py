"""Tests for the main MM loop (AC2: fake clock and fake fair values)."""

import json
from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock, MagicMock
from zoneinfo import ZoneInfo

import pytest
from solders.keypair import Keypair
from solders.pubkey import Pubkey

from meridian_quant.mm.chain import ChainOrderClient
from meridian_quant.mm.config import MMConfig
from meridian_quant.mm.fakes import FakeFairValueSource, FakeMarketSource, FakeOrderClient
from meridian_quant.mm.loop import MarketMakerLoop
from meridian_quant.mm.quoter import generate_quote
from meridian_quant.mm.types import (
    FairValue,
    Inventory,
    MarketKey,
    MarketState,
    RestingOrder,
)

# Test market: AAPL 2026-10-08 strike $230.00
# Derived from program 5dJoSJfkx23ZkTGxMtnWxD7fabmM6WiezubXHWqKUffi
# PDA seeds: b"market" + b"AAPL" + 20261008.to_bytes(4, 'little') + 23000.to_bytes(8, 'little')
TEST_MARKET_PUBKEY = "DyAQwhVQNpAhWMUhd83YShjS244PoU2QotChDStexM7Z"


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
        market=TEST_MARKET_PUBKEY,
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
        market=TEST_MARKET_PUBKEY,
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

    # Fair values for BOTH markets (yesterday intrinsic, today normal)
    # Yesterday's FV should NOT match today's market despite same ticker+strike (0DTE reuses)
    fair_values = [
        FairValue(
            market=yesterday_market.market,  # AAPL_20261007_23000
            ticker="AAPL",
            strike_cents=23000,
            fair_cents=1,  # Intrinsic at TTE=0
            sigma=0.2,
            spot=230.0,
            as_of=now,
        ),
        FairValue(
            market=today_market.market,  # AAPL_20261008_23000
            ticker="AAPL",
            strike_cents=23000,  # Same strike, different day
            fair_cents=50,
            sigma=0.2,
            spot=230.0,
            as_of=now,
        ),
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

    # Verify: today's market gets quotes from today's FV (50c), yesterday's market gets none
    mm_owner = str(mm.keypair.pubkey())
    today_orders = await order_client.fetch_resting_orders(today_market.market)
    today_mm_orders = [o for o in today_orders if o.owner == mm_owner]
    assert len(today_mm_orders) == 2, (
        f"Expected 2 quotes on today's market, got {len(today_mm_orders)}"
    )

    # Verify today's quotes are based on today's FV (50c), not yesterday's (1c)
    # With 50c fair value and 2c spread, expect bid ~48-49c and ask ~51-52c
    bids = [o for o in today_mm_orders if o.side == "Bid"]
    asks = [o for o in today_mm_orders if o.side == "Ask"]
    assert len(bids) == 1 and len(asks) == 1
    # If yesterday's FV (1c) was used, bid would be 0c and ask would be 3c
    assert bids[0].price >= 40, f"Bid {bids[0].price}c too low (expected ~48c from 50c FV)"
    assert asks[0].price <= 60, f"Ask {asks[0].price}c too high (expected ~52c from 50c FV)"

    yesterday_orders = await order_client.fetch_resting_orders(yesterday_market.market)
    yesterday_mm_orders = [o for o in yesterday_orders if o.owner == mm_owner]
    # Yesterday's market has no new quotes (prior-day FV must not match today's strike)
    assert len(yesterday_mm_orders) == 0, (
        f"Expected 0 quotes on yesterday's market, got {len(yesterday_mm_orders)}"
    )


@pytest.mark.asyncio
async def test_pull_condition_zeros_coverage(mm_config: MMConfig) -> None:
    """Pull condition (stale spot or near close) zeros book_coverage metric.

    After a pull, /health should report 0% coverage since all quotes are cancelled.
    """
    # Fixed time: 2026-10-08 14:00 ET (18:00 UTC)
    now = datetime(2026, 10, 8, 18, 0, tzinfo=UTC)

    # Market closing in 1 hour (not near close)
    close_ts = int((now + timedelta(hours=1)).timestamp())

    markets = [
        MarketState(
            market=TEST_MARKET_PUBKEY,
            ticker="AAPL",
            strike_cents=23000,
            trading_date=20261008,
            close_ts=close_ts,
            is_open=True,
            pairs_outstanding=100,
        )
    ]

    # Fair value with STALE spot (>10s old) to trigger pull
    stale_time = now - timedelta(seconds=15)
    fair_values = [
        FairValue(
            market=TEST_MARKET_PUBKEY,
            ticker="AAPL",
            strike_cents=23000,
            fair_cents=50,
            sigma=0.2,
            spot=230.0,
            as_of=stale_time,  # Stale - triggers pull
            stale=False,
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

    # Seed some inventory
    mm_owner = str(mm.keypair.pubkey())
    order_client.set_yes_balance(markets[0].market, mm_owner, 50)
    order_client.set_no_balance(markets[0].market, mm_owner, 50)

    # Initially coverage is 0
    assert mm.book_coverage == 0.0

    # Run once - pull condition should cancel all quotes and zero coverage
    await mm._run_once()

    # Verify: no quotes placed (pulled due to stale spot)
    orders = await order_client.fetch_resting_orders(markets[0].market)
    mm_orders = [o for o in orders if o.owner == mm_owner]
    assert len(mm_orders) == 0, f"Expected 0 orders after pull, got {len(mm_orders)}"

    # Verify: coverage metric is 0.0 (not stale from before pull)
    assert mm.book_coverage == 0.0, f"Expected book_coverage=0.0 after pull, got {mm.book_coverage}"


@pytest.mark.asyncio
async def test_empty_fair_values_pulls_all_quotes(mm_config: MMConfig) -> None:
    """Empty/failed fair values pull all quotes (AC2).

    When _fetch_fair_values returns [] (HTTP error or all tickers skipped),
    MM must cancel all resting quotes per domain.md § Market maker and US-16.
    """
    # Fixed time: 2026-10-08 14:00 ET (18:00 UTC)
    now = datetime(2026, 10, 8, 18, 0, tzinfo=UTC)

    # Market closing in 1 hour (not near close)
    close_ts = int((now + timedelta(hours=1)).timestamp())

    markets = [
        MarketState(
            market=TEST_MARKET_PUBKEY,
            ticker="AAPL",
            strike_cents=23000,
            trading_date=20261008,
            close_ts=close_ts,
            is_open=True,
            pairs_outstanding=100,
        )
    ]

    # Start with valid fair values
    fair_values = [
        FairValue(
            market=TEST_MARKET_PUBKEY,
            ticker="AAPL",
            strike_cents=23000,
            fair_cents=50,
            sigma=0.2,
            spot=230.0,
            as_of=now,
            stale=False,
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

    # Seed inventory
    mm_owner = str(mm.keypair.pubkey())
    order_client.set_yes_balance(markets[0].market, mm_owner, 50)
    order_client.set_no_balance(markets[0].market, mm_owner, 50)

    # Run once with valid fair values - quotes should be placed
    await mm._run_once()

    # Verify quotes are placed (bid + ask)
    orders = await order_client.fetch_resting_orders(markets[0].market)
    mm_orders = [o for o in orders if o.owner == mm_owner]
    assert len(mm_orders) == 2, f"Expected 2 orders after first run, got {len(mm_orders)}"

    # Now simulate empty fair values (HTTP error or all tickers skipped)
    fv_source._fair_values = []

    # Run again - should cancel all quotes
    await mm._run_once()

    # Verify: all MM quotes are cancelled
    orders = await order_client.fetch_resting_orders(markets[0].market)
    mm_orders = [o for o in orders if o.owner == mm_owner]
    assert len(mm_orders) == 0, f"Expected 0 orders after empty FVs, got {len(mm_orders)}"

    # Verify: coverage is zeroed
    assert mm.book_coverage == 0.0, (
        f"Expected book_coverage=0.0 after empty FVs, got {mm.book_coverage}"
    )


@pytest.mark.asyncio
async def test_missing_ata_vs_rpc_timeout(mm_config: MMConfig) -> None:
    """Missing ATA (balance=0) still mints/quotes; RPC timeout does not (AC1).

    Tests full _run_once behavior with mocked RPC:
    - Missing ATA (get_account_info.value=None): balance=0, mints, places quotes
    - RPC timeout (exception): does not mint, does not place quotes
    """
    # Part 1: Test ChainOrderClient's low-level behavior
    mock_rpc = AsyncMock()
    program_id = Pubkey.from_string("5dJoSJfkx23ZkTGxMtnWxD7fabmM6WiezubXHWqKUffi")
    usdc_mint = Pubkey.from_string("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")

    payer = Keypair()
    client = ChainOrderClient(mock_rpc, program_id, payer, usdc_mint)

    # Test 1a: Missing ATA (account doesn't exist)
    account_info_response = MagicMock()
    account_info_response.value = None
    mock_rpc.get_account_info.return_value = account_info_response

    balance = await client.get_yes_token_balance(TEST_MARKET_PUBKEY, str(payer.pubkey()))
    assert balance == 0, "Missing ATA should return 0"

    # Test 1b: RPC timeout (exception raised)
    mock_rpc.get_account_info.side_effect = Exception("RPC timeout")

    with pytest.raises(Exception, match="RPC timeout"):
        await client.get_yes_token_balance(TEST_MARKET_PUBKEY, str(payer.pubkey()))

    # Part 2: Test full MM loop behavior with missing ATA vs RPC error
    # Use FakeOrderClient that tracks mints and quotes, but inject balance errors

    class FakeOrderClientWithATAErrors(FakeOrderClient):
        """Fake client that can simulate missing ATA (balance=0) or RPC errors."""

        def __init__(self, *args: object, **kwargs: object) -> None:
            super().__init__(*args, **kwargs)
            self.simulate_missing_ata_initial = False  # Only for first read
            self.simulate_rpc_timeout = False
            self.mint_called = False
            self.place_called = False
            self._first_balance_read = True

        async def get_yes_token_balance(self, market: str, owner: str) -> int:
            if self.simulate_rpc_timeout:
                raise Exception("RPC timeout")
            # Simulate missing ATA only on first read (before mint)
            if self.simulate_missing_ata_initial and self._first_balance_read:
                return 0  # ATA doesn't exist initially
            return await super().get_yes_token_balance(market, owner)

        async def get_no_token_balance(self, market: str, owner: str) -> int:
            if self.simulate_rpc_timeout:
                raise Exception("RPC timeout")
            if self.simulate_missing_ata_initial and self._first_balance_read:
                self._first_balance_read = False  # Next reads will use actual balance
                return 0
            return await super().get_no_token_balance(market, owner)

        async def get_multiple_token_balances(
            self, markets: list[str], owner: str
        ) -> dict[str, tuple[int, int]]:
            """Batch-fetch balances, but inject errors for tests (P1-7)."""
            if self.simulate_rpc_timeout:
                raise Exception("RPC timeout")
            # Simulate missing ATA only on first read (before mint)
            if self.simulate_missing_ata_initial and self._first_balance_read:
                self._first_balance_read = False
                return {market: (0, 0) for market in markets}
            return await super().get_multiple_token_balances(markets, owner)

        async def mint_pair(self, market: str, qty: int, owner: str) -> None:
            self.mint_called = True
            if self.simulate_rpc_timeout:
                raise Exception("RPC timeout")
            await super().mint_pair(market, qty, owner)

        async def place_order(  # noqa: PLR0913, PLR0917 - OrderClient signature
            self,
            market: str,
            side: str,
            price: int,
            qty: int,
            owner: str,
            resting_orders: list[RestingOrder] | None = None,
        ) -> int:
            self.place_called = True
            return await super().place_order(market, side, price, qty, owner, resting_orders)

    # Test 2a: Missing ATA (balance=0) should still mint and place
    # Use today's trading date (ET timezone)
    now = datetime.now(UTC)
    et_now = now.astimezone(ZoneInfo("America/New_York"))
    today_trading_date = int(et_now.strftime("%Y%m%d"))

    market_id = f"AAPL_{today_trading_date}_23000"
    market_source = FakeMarketSource()
    market = MarketState(
        market=market_id,
        ticker="AAPL",
        strike_cents=23000,
        trading_date=today_trading_date,
        close_ts=int((now + timedelta(hours=1)).timestamp()),
        is_open=True,
        pairs_outstanding=0,
    )
    market_source._markets = [market]

    order_client_ata = FakeOrderClientWithATAErrors()
    order_client_ata.simulate_missing_ata_initial = True

    fv_source = FakeFairValueSource()
    fv_source._fair_values = [
        FairValue(
            market=market_id,
            ticker="AAPL",
            strike_cents=23000,
            fair_cents=5000,
            sigma=0.3,
            spot=230.0,
            as_of=now,
        )
    ]

    mm_ata = MarketMakerLoop(mm_config, market_source, fv_source, order_client_ata)

    # Run loop - should mint and place despite missing ATA (balance=0)
    order_client_ata.mint_called = False
    order_client_ata.place_called = False
    await mm_ata._run_once()

    assert order_client_ata.mint_called, "Missing ATA (balance=0) should still mint"
    assert order_client_ata.place_called, "Missing ATA (balance=0) should still place quotes"

    # Test 2b: RPC timeout should NOT mint and NOT place
    order_client_timeout = FakeOrderClientWithATAErrors()
    order_client_timeout.simulate_rpc_timeout = True

    mm_timeout = MarketMakerLoop(mm_config, market_source, fv_source, order_client_timeout)

    # Run loop - should NOT mint or place due to RPC timeout during balance check
    order_client_timeout.mint_called = False
    order_client_timeout.place_called = False
    await mm_timeout._run_once()

    assert not order_client_timeout.mint_called, "RPC timeout should skip mint"
    assert not order_client_timeout.place_called, "RPC timeout should skip quote placement"


@pytest.mark.asyncio
async def test_fetch_resting_orders_failure_skips_quoting(
    mm_config: MMConfig, test_keypair: Keypair
) -> None:
    """AB-10/AC3: fetch_resting_orders failure skips quoting that market.

    Scenario: Market A has 7 leftovers, fetch fails. Market B has 0 orders, fetch succeeds.
    Expected: Market A not quoted (fail closed), market B quoted (not stacked).
    """
    # Inject clock for 2026-10-08 ET (so markets aren't dropped as prior-day)
    trading_date = 20261008
    # 2026-10-08 14:00 ET = 18:00 UTC
    fake_time = datetime(2026, 10, 8, 18, 0, 0, tzinfo=UTC)

    def fake_clock() -> datetime:
        return fake_time

    # Setup two markets
    market_a = MarketState(
        market=TEST_MARKET_PUBKEY,
        ticker="AAPL",
        trading_date=trading_date,
        strike_cents=23_000,
        close_ts=int(fake_time.timestamp()) + 7200,  # 2h from now
        is_open=True,
        pairs_outstanding=100,
    )
    market_b = MarketState(
        market="AAPL_20261008_24000",
        ticker="AAPL",
        trading_date=trading_date,
        strike_cents=24_000,
        close_ts=int(fake_time.timestamp()) + 7200,
        is_open=True,
        pairs_outstanding=100,
    )

    market_source = FakeMarketSource([market_a, market_b])

    fv_a = FairValue(
        market=TEST_MARKET_PUBKEY,
        ticker="AAPL",
        strike_cents=23_000,
        fair_cents=50,
        sigma=0.2,
        spot=230.0,
        as_of=fake_time,
    )
    fv_b = FairValue(
        market="AAPL_20261008_24000",
        ticker="AAPL",
        strike_cents=24_000,
        fair_cents=40,
        sigma=0.2,
        spot=230.0,
        as_of=fake_time,
    )
    fv_source = FakeFairValueSource([fv_a, fv_b])

    # Create order client that fails fetch on market A (7 leftovers), succeeds on B
    class PartialFailWithLeftoversClient(FakeOrderClient):
        def __init__(self) -> None:
            super().__init__()
            self.fetch_calls: dict[str, int] = {}
            self.place_calls: list[str] = []
            # Seed 7 leftovers on market A (invisible due to fetch failure)
            for i in range(7):
                self._orders[TEST_MARKET_PUBKEY].append(
                    RestingOrder(
                        order_id=i + 1,
                        market=TEST_MARKET_PUBKEY,
                        owner=str(test_keypair.pubkey()),
                        side="Bid",
                        price=45,
                        qty=10,
                    )
                )

        async def fetch_resting_orders(self, market: str) -> list[RestingOrder]:
            self.fetch_calls[market] = self.fetch_calls.get(market, 0) + 1
            if market == TEST_MARKET_PUBKEY:
                # Simulate RPC error - 7 leftovers exist but are invisible
                raise Exception("Simulated RPC error on market A")
            return await super().fetch_resting_orders(market)

        async def place_order(  # noqa: PLR0913, PLR0917 - OrderClient signature
            self,
            market: str,
            side: str,
            price: int,
            qty: int,
            owner: str,
            resting_orders: list[RestingOrder] | None = None,
        ) -> int:
            self.place_calls.append(market)
            return await super().place_order(market, side, price, qty, owner, resting_orders)

    order_client = PartialFailWithLeftoversClient()
    mm = MarketMakerLoop(mm_config, market_source, fv_source, order_client, clock=fake_clock)

    # Run loop
    await mm._run_once()

    # Assert: both markets fetched
    assert TEST_MARKET_PUBKEY in order_client.fetch_calls
    assert "AAPL_20261008_24000" in order_client.fetch_calls

    # Assert: market A NOT quoted (fail closed - 7 leftovers + 2 new would exceed cap)
    # market B WAS quoted (fetch succeeded, no stacking on A's invisible leftovers)
    a_quoted = TEST_MARKET_PUBKEY in order_client.place_calls
    b_quoted = "AAPL_20261008_24000" in order_client.place_calls

    assert not a_quoted, "Should NOT quote market A (fetch failed, 7 leftovers invisible)"
    assert b_quoted, "Should quote market B (fetch succeeded, no leftovers)"


@pytest.mark.asyncio
async def test_cancel_fetch_failure_per_market_isolation(
    mm_config: MMConfig, test_keypair: Keypair
) -> None:
    """AB-10/AC1: cancel fetch failure on market A doesn't abort cancel of B/C.

    Scenario: Market A fetch fails (skipped). Market B has 7 leftovers, fetch
    succeeds, cancel runs, then requotes 2 orders. Market C has 0, quotes 2.
    Verifies per-market isolation: A's failure doesn't block B/C cancel+quote.
    """
    # Pin clock to trading date so markets aren't filtered as prior-day
    trading_date = 20261008
    fake_time = datetime(2026, 10, 8, 18, 0, 0, tzinfo=UTC)  # 14:00 ET

    def fake_clock() -> datetime:
        return fake_time

    # Setup three markets
    market_a = MarketState(
        market=TEST_MARKET_PUBKEY,
        ticker="AAPL",
        trading_date=trading_date,
        strike_cents=23_000,
        close_ts=int(fake_time.timestamp()) + 7200,
        is_open=True,
        pairs_outstanding=100,
    )
    market_b = MarketState(
        market="AAPL_20261008_24000",
        ticker="AAPL",
        trading_date=trading_date,
        strike_cents=24_000,
        close_ts=int(fake_time.timestamp()) + 7200,
        is_open=True,
        pairs_outstanding=100,
    )
    market_c = MarketState(
        market="AAPL_20261008_25000",
        ticker="AAPL",
        trading_date=trading_date,
        strike_cents=25_000,
        close_ts=int(fake_time.timestamp()) + 7200,
        is_open=True,
        pairs_outstanding=100,
    )

    market_source = FakeMarketSource([market_a, market_b, market_c])

    fv_a = FairValue(
        market=TEST_MARKET_PUBKEY,
        ticker="AAPL",
        strike_cents=23_000,
        fair_cents=50,
        sigma=0.2,
        spot=230.0,
        as_of=fake_time,
    )
    fv_b = FairValue(
        market="AAPL_20261008_24000",
        ticker="AAPL",
        strike_cents=24_000,
        fair_cents=40,
        sigma=0.2,
        spot=230.0,
        as_of=fake_time,
    )
    fv_c = FairValue(
        market="AAPL_20261008_25000",
        ticker="AAPL",
        strike_cents=25_000,
        fair_cents=30,
        sigma=0.2,
        spot=230.0,
        as_of=fake_time,
    )
    fv_source = FakeFairValueSource([fv_a, fv_b, fv_c])

    # Create order client that fails fetch on market A, seeds 7 leftovers on B
    class PartialFailWithLeftoversClient(FakeOrderClient):
        def __init__(self) -> None:
            super().__init__()
            self.fetch_calls: list[str] = []
            self.cancel_calls: list[str] = []
            self.place_calls: list[str] = []
            # Seed 7 MM leftovers on market B
            for i in range(7):
                self._orders["AAPL_20261008_24000"].append(
                    RestingOrder(
                        order_id=i + 1,
                        market="AAPL_20261008_24000",
                        owner=str(test_keypair.pubkey()),
                        side="Bid" if i % 2 == 0 else "Ask",
                        price=40 + i,
                        qty=10,
                    )
                )

        async def fetch_resting_orders(self, market: str) -> list[RestingOrder]:
            self.fetch_calls.append(market)
            if market == TEST_MARKET_PUBKEY:
                raise Exception("Simulated RPC error on market A")
            return await super().fetch_resting_orders(market)

        async def cancel_order(self, market: str, order_id: int, owner: str) -> None:
            self.cancel_calls.append(market)
            await super().cancel_order(market, order_id, owner)

        async def place_order(  # noqa: PLR0913, PLR0917 - OrderClient signature
            self,
            market: str,
            side: str,
            price: int,
            qty: int,
            owner: str,
            resting_orders: list[RestingOrder] | None = None,
        ) -> int:
            self.place_calls.append(market)
            return await super().place_order(market, side, price, qty, owner, resting_orders)

    order_client = PartialFailWithLeftoversClient()
    mm = MarketMakerLoop(mm_config, market_source, fv_source, order_client, clock=fake_clock)

    # Run loop
    await mm._run_once()

    # Assert: fetch was attempted for all three markets
    assert len(order_client.fetch_calls) >= 3, "Should attempt fetch for all markets"
    assert TEST_MARKET_PUBKEY in order_client.fetch_calls
    assert "AAPL_20261008_24000" in order_client.fetch_calls
    assert "AAPL_20261008_25000" in order_client.fetch_calls

    # Assert: cancel WAS called for B's 7 leftovers (per-market isolation)
    b_cancel_count = order_client.cancel_calls.count("AAPL_20261008_24000")
    assert b_cancel_count == 7, f"Should cancel 7 leftovers on B, got {b_cancel_count}"

    # Assert: cancel was NOT called for A (fetch failed) or C (no leftovers)
    assert TEST_MARKET_PUBKEY not in order_client.cancel_calls
    # C might appear 0 times (no leftovers to cancel)

    # Assert: quote was NOT placed for A (cancel listing failed)
    # but WAS placed for B (7 cancelled, 2 new) and C (0 + 2 new)
    a_quoted = TEST_MARKET_PUBKEY in order_client.place_calls
    b_quote_count = order_client.place_calls.count("AAPL_20261008_24000")
    c_quote_count = order_client.place_calls.count("AAPL_20261008_25000")

    assert not a_quoted, "Should NOT quote market A (cancel listing failed)"
    assert b_quote_count == 2, f"Should quote 2 orders on B after cancel, got {b_quote_count}"
    assert c_quote_count == 2, f"Should quote 2 orders on C, got {c_quote_count}"


def test_invalid_keypair_not_json() -> None:
    """MarketMakerLoop raises ValueError for invalid keypair JSON."""
    bad_config = MMConfig.model_validate(
        {
            "market_maker_keypair": "not-valid-json",
            "program_id": "11111111111111111111111111111112",
            "usdc_mint": "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
            "service_token": "test_token",
        }
    )
    with pytest.raises(ValueError, match="must be a JSON array of 64 bytes"):
        MarketMakerLoop(
            bad_config,
            market_source=FakeMarketSource(),
            fair_value_source=FakeFairValueSource(),
            order_client=FakeOrderClient(),
        )


def test_invalid_keypair_wrong_length() -> None:
    """MarketMakerLoop raises ValueError for keypair with wrong length."""
    bad_config = MMConfig.model_validate(
        {
            "market_maker_keypair": json.dumps([0] * 32),  # Only 32 bytes, need 64
            "program_id": "11111111111111111111111111111112",
            "usdc_mint": "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
            "service_token": "test_token",
        }
    )
    with pytest.raises(ValueError, match="must be JSON array of 64 bytes"):
        MarketMakerLoop(
            bad_config,
            market_source=FakeMarketSource(),
            fair_value_source=FakeFairValueSource(),
            order_client=FakeOrderClient(),
        )


@pytest.mark.asyncio
async def test_weekend_demo_session_is_quoted_when_today_has_closed(mm_config: MMConfig) -> None:
    """Saturday: today's markets are past close, Sunday demo markets are live (session.py).

    The MM must not pull everything because of today's closed markets, must quote the demo
    session, and must still leave today's closed market alone (place_order would fail).
    """
    now = datetime(2026, 10, 10, 16, 0, tzinfo=UTC)  # Sat 12:00 ET

    def fake_clock() -> datetime:
        return now

    closed_today = MarketState(
        market=TEST_MARKET_PUBKEY,
        ticker="AAPL",
        strike_cents=34000,
        trading_date=20261010,
        close_ts=int((now - timedelta(hours=6)).timestamp()),
        is_open=True,
        pairs_outstanding=0,
    )
    demo = MarketState(
        market="AAPL_20261011_34000",
        ticker="AAPL",
        strike_cents=34000,
        trading_date=20261011,
        close_ts=int((now + timedelta(hours=32)).timestamp()),
        is_open=True,
        pairs_outstanding=0,
    )
    fair_values = [
        FairValue(
            market=demo.market,
            ticker="AAPL",
            strike_cents=34000,
            fair_cents=45,
            sigma=0.2,
            spot=336.06,
            as_of=now,
        )
    ]
    order_client = FakeOrderClient()
    mm = MarketMakerLoop(
        mm_config,
        market_source=FakeMarketSource([closed_today, demo]),
        fair_value_source=FakeFairValueSource(fair_values),
        order_client=order_client,
        clock=fake_clock,
    )
    mm_owner = str(mm.keypair.pubkey())
    order_client.set_yes_balance(demo.market, mm_owner, 50)
    order_client.set_no_balance(demo.market, mm_owner, 50)

    await mm._run_once()

    demo_orders = [
        o for o in await order_client.fetch_resting_orders(demo.market) if o.owner == mm_owner
    ]
    assert sorted(o.side for o in demo_orders) == ["Ask", "Bid"]
    closed_orders = await order_client.fetch_resting_orders(closed_today.market)
    assert [o for o in closed_orders if o.owner == mm_owner] == []
    assert mm.book_coverage == 1.0


@pytest.mark.asyncio
async def test_demo_session_near_close_still_pulls(mm_config: MMConfig) -> None:
    """The 2-minute pull applies to the demo session exactly as to a real one."""
    now = datetime(2026, 10, 10, 16, 0, tzinfo=UTC)
    demo = MarketState(
        market="AAPL_20261011_34000",
        ticker="AAPL",
        strike_cents=34000,
        trading_date=20261011,
        close_ts=int((now + timedelta(seconds=60)).timestamp()),
        is_open=True,
        pairs_outstanding=0,
    )
    fv = FairValue(
        market=demo.market,
        ticker="AAPL",
        strike_cents=34000,
        fair_cents=45,
        sigma=0.2,
        spot=336.06,
        as_of=now,
    )
    order_client = FakeOrderClient()
    mm = MarketMakerLoop(
        mm_config,
        market_source=FakeMarketSource([demo]),
        fair_value_source=FakeFairValueSource([fv]),
        order_client=order_client,
        clock=lambda: now,
    )
    assert mm._should_pull_all_quotes([fv], [demo]) is True
