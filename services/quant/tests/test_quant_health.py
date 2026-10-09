import base58
from solders.keypair import Keypair  # type: ignore[import-untyped]

from meridian_quant import health
from meridian_quant.mm.config import MMConfig
from meridian_quant.mm.fakes import FakeFairValueSource, FakeMarketSource, FakeOrderClient
from meridian_quant.mm.loop import MarketMakerLoop


def test_health_reports_quant_ok() -> None:
    assert health() == {"service": "quant", "status": "ok"}


def test_health_includes_book_coverage_when_mm_running() -> None:
    """Health endpoint includes book_coverage when MM loop is provided."""
    # Create a test MM loop
    keypair = Keypair()
    config = MMConfig(
        market_maker_keypair=base58.b58encode(bytes(keypair)).decode("ascii"),
        program_id="11111111111111111111111111111112",
        service_token="test_token",
    )
    mm_loop = MarketMakerLoop(
        config,
        market_source=FakeMarketSource(),
        fair_value_source=FakeFairValueSource(),
        order_client=FakeOrderClient(),
    )

    # Coverage starts at 0.0
    result = health(mm_loop)
    assert result == {"service": "quant", "status": "ok", "book_coverage": 0.0}

    # If coverage changes, health reflects it
    mm_loop._coverage = 0.75
    result = health(mm_loop)
    assert result["book_coverage"] == 0.75
