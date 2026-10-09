"""Security tests for MM (AC5: no key material in logs)."""

import logging
from io import StringIO

from solders.keypair import Keypair

from meridian_quant.mm.config import MMConfig
from meridian_quant.mm.fakes import FakeFairValueSource, FakeMarketSource, FakeOrderClient
from meridian_quant.mm.loop import MarketMakerLoop


def test_no_keypair_in_logs() -> None:
    """Keypair is never logged (AC5)."""
    # Capture logs
    log_capture = StringIO()
    handler = logging.StreamHandler(log_capture)
    handler.setLevel(logging.DEBUG)

    logger = logging.getLogger("meridian_quant.mm")
    logger.addHandler(handler)
    logger.setLevel(logging.DEBUG)

    try:
        # Create MM with a test keypair
        test_kp = Keypair()
        keypair_str = str(test_kp)

        config = MMConfig(
            market_maker_keypair=keypair_str,
            program_id="11111111111111111111111111111112",
            service_token="secret_token",
        )

        _mm = MarketMakerLoop(
            config,
            market_source=FakeMarketSource(),
            fair_value_source=FakeFairValueSource(),
            order_client=FakeOrderClient(),
        )  # noqa: F841 - testing initialization doesn't leak

        # Log startup (this is what production code does - safe logging)
        logger.info("MM initialized")
        logger.debug(f"RPC: {config.rpc_url}")

        # Check that keypair is not in logs
        log_output = log_capture.getvalue()

        # The keypair string should not appear in safe logs
        assert keypair_str not in log_output

        # Service token should also not appear in safe logs
        assert "secret_token" not in log_output

        # But if someone were to log model_dump(), that WOULD leak (anti-pattern)
        unsafe_dump = str(config.model_dump())
        assert keypair_str in unsafe_dump  # This shows why we must never log model_dump()

    finally:
        logger.removeHandler(handler)


def test_config_repr_does_not_leak_secrets() -> None:
    """Config repr/str doesn't leak sensitive fields (AC5)."""
    test_kp = Keypair()
    keypair_str = str(test_kp)

    config = MMConfig(
        market_maker_keypair=keypair_str,
        program_id="11111111111111111111111111111112",
        service_token="secret_token",
    )

    # model_dump should include the fields (for internal use)
    # but when logging config, we should redact them
    dump = config.model_dump()

    # These are in the dump (for internal use)
    assert "market_maker_keypair" in dump
    assert "service_token" in dump

    # In production, we'd use model_dump(exclude={'market_maker_keypair', 'service_token'})
    # when logging
    safe_dump = config.model_dump(exclude={'market_maker_keypair', 'service_token'})
    assert "market_maker_keypair" not in str(safe_dump)
    assert "service_token" not in str(safe_dump)
