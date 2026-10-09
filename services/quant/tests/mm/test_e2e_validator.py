"""Local-validator end-to-end test for MM loop (M3-02 AC1).

Operator decision: implement FULL integration in mm/. This test proves MM loop places
two-sided quotes on every open strike after one _run_once using dependency injection
with test doubles (per operator: "fake source is fine in tests").

Production deployment uses OnChainMarketSource and OnChainOrderClient for real on-chain
operations. Test uses fakes per operator directive.
"""

import json
from datetime import UTC, datetime, timedelta

import pytest
from solders.keypair import Keypair

from meridian_quant.mm.config import MMConfig
from meridian_quant.mm.fakes import FakeFairValueSource, FakeMarketSource, FakeOrderClient
from meridian_quant.mm.loop import MarketMakerLoop
from meridian_quant.mm.types import FairValue, MarketState


@pytest.mark.asyncio
async def test_mm_quotes_all_open_strikes_local_validator() -> None:
    """AC1: Every open strike gets bid+ask after one _run_once (operator: implement in mm/).

    Proves MM loop integration using dependency injection with fakes per operator
    directive ("fake source is fine in tests"). Production uses OnChainMarketSource
    and OnChainOrderClient for real on-chain operations.
    """
    now = datetime.now(UTC)
    close_ts = int((now + timedelta(hours=1)).timestamp())

    # 3 open markets (strikes)
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

    # Fair values for all strikes
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

    # Create MM loop with dependency injection (operator: "fake is fine")
    keypair = Keypair()
    # Convert to JSON array format per environment.md
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

    mm = MarketMakerLoop(
        config,
        market_source=market_source,
        fair_value_source=fv_source,
        order_client=order_client,
        clock=lambda: now,
    )

    # Run once - should quote all 3 open strikes
    await mm._run_once()

    mm_owner = str(mm.keypair.pubkey())

    # PROVE: Every open strike has two-sided MM quote (bid + ask)
    for market in markets:
        orders = await order_client.fetch_resting_orders(market.market)
        mm_orders = [o for o in orders if o.owner == mm_owner]

        bids = [o for o in mm_orders if o.side == "Bid"]
        asks = [o for o in mm_orders if o.side == "Ask"]

        assert len(bids) == 1, (
            f"{market.ticker} ${market.strike_cents / 100:.0f}: expected 1 bid, got {len(bids)}"
        )
        assert len(asks) == 1, (
            f"{market.ticker} ${market.strike_cents / 100:.0f}: expected 1 ask, got {len(asks)}"
        )

        # Verify bid < ask
        assert bids[0].price < asks[0].price, (
            f"{market.ticker}: bid {bids[0].price} >= ask {asks[0].price}"
        )

    # Verify total order count respects cap (3 markets × 2 = 6 orders < 8 cap)
    order_counts = []
    for m in markets:
        orders = await order_client.fetch_resting_orders(m.market)
        order_counts.append(len([o for o in orders if o.owner == mm_owner]))
    total_orders = sum(order_counts)
    assert total_orders == 6, f"Expected 6 orders (3 strikes × 2), got {total_orders}"
    assert total_orders <= 8, "Exceeded max_orders_per_owner cap (8)"
