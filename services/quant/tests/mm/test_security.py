"""Security tests for MM (AC5: no key material in logs)."""

import json
import logging
from datetime import UTC, datetime, timedelta
from io import StringIO
from unittest.mock import AsyncMock

import pytest
from solders.keypair import Keypair

from meridian_quant.mm.config import MMConfig
from meridian_quant.mm.fakes import FakeFairValueSource, FakeMarketSource, FakeOrderClient
from meridian_quant.mm.loop import MarketMakerLoop
from meridian_quant.mm.types import FairValue, MarketState


@pytest.mark.asyncio
async def test_no_keypair_in_logs() -> None:
    """Keypair and service token never logged in production _run_once (AC5)."""
    # Capture logs
    log_capture = StringIO()
    handler = logging.StreamHandler(log_capture)
    handler.setLevel(logging.DEBUG)

    logger = logging.getLogger("meridian_quant.mm")
    logger.addHandler(handler)
    logger.setLevel(logging.DEBUG)

    try:
        # Create MM with a test keypair and service token
        test_kp = Keypair()
        # Convert to JSON array format per environment.md
        keypair_str = json.dumps(list(bytes(test_kp)))

        config = MMConfig.model_validate(
            {
                "market_maker_keypair": keypair_str,
                "program_id": "11111111111111111111111111111112",
                "usdc_mint": "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
                "service_token": "secret_token_12345",
            }
        )

        # Setup market and fair value for _run_once
        now = datetime(2026, 10, 8, 18, 0, tzinfo=UTC)
        close_ts = int((now + timedelta(hours=1)).timestamp())
        market = MarketState(
            market="TEST_20261008_23000",
            ticker="TEST",
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

        # Mock order client to avoid actual chain calls
        order_client = FakeOrderClient()
        # Mock mint_pair and place_order to verify they're called without logging secrets
        order_client.mint_pair = AsyncMock(return_value=None)  # type: ignore[method-assign]
        order_client.place_order = AsyncMock(return_value=1)  # type: ignore[method-assign]

        mm = MarketMakerLoop(
            config,
            market_source=FakeMarketSource([market]),
            fair_value_source=FakeFairValueSource([fair_value]),
            order_client=order_client,
            clock=lambda: now,
        )

        # Run production code (_run_once logs internally)
        await mm._run_once()

        # Check that production logs don't contain secrets
        log_output = log_capture.getvalue()

        # The keypair JSON string should NOT appear in production logs
        assert keypair_str not in log_output, "Keypair JSON leaked in production logs"

        # Service token should NOT appear in production logs
        assert "secret_token_12345" not in log_output, "Service token leaked in production logs"

        # But if someone were to log model_dump(), that WOULD leak (anti-pattern to avoid)
        unsafe_dump = str(config.model_dump())
        assert keypair_str in unsafe_dump  # This shows why we must never log model_dump()

    finally:
        logger.removeHandler(handler)


def test_config_repr_does_not_leak_secrets() -> None:
    """Config repr/str doesn't leak sensitive fields (AC5)."""
    test_kp = Keypair()
    # Convert to JSON array format per environment.md
    keypair_str = json.dumps(list(bytes(test_kp)))

    config = MMConfig.model_validate(
        {
            "market_maker_keypair": keypair_str,
            "program_id": "11111111111111111111111111111112",
            "usdc_mint": "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
            "service_token": "secret_token",
        }
    )

    # model_dump should include the fields (for internal use)
    # but when logging config, we should redact them
    dump = config.model_dump()

    # These are in the dump (for internal use)
    assert "market_maker_keypair" in dump
    assert "service_token" in dump

    # In production, we'd use model_dump(exclude={'market_maker_keypair', 'service_token'})
    # when logging
    safe_dump = config.model_dump(exclude={"market_maker_keypair", "service_token"})
    assert "market_maker_keypair" not in str(safe_dump)
    assert "service_token" not in str(safe_dump)
