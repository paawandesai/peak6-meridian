"""AB-17 for the quant service's price path (M3-08b).

Abuse case: a provider error (Pyth Pro or Finnhub) that echoes the caller's credentials ends up
in the quant service's logs, error text or /fair-values body. The token and key travel in
request headers only; every error carries status or exception type, never the credential.
All HTTP is mocked.
"""

import logging
from datetime import UTC, datetime

import httpx
import pytest
from meridian_quant.fair_value_cache import FairValueCache
from meridian_quant.mm.main import MarketCache, OnChainSources, make_spot_cache
from meridian_quant.mm.session import et_trading_date
from meridian_quant.mm.types import MarketState
from meridian_quant.server import Service, handle_request

PYTH_FIXTURE = "ab17-fixture-pyth"
FINNHUB_FIXTURE = "ab17-fixture-finnhub"
TIINGO_FIXTURE = "ab17-fixture-tiingo"
SERVICE_TOKEN = "ab17-service-token"


def leaky(request: httpx.Request) -> httpx.Response:
    """Every provider fails and echoes whatever credentials it was sent."""
    echoed = " ".join(f"{k}={v}" for k, v in request.headers.items())
    if "pyth" in str(request.url):
        raise httpx.ConnectError(f"refused {echoed}", request=request)
    return httpx.Response(401, text=f"bad credentials: {echoed} {request.url}")


def test_ab17_provider_failures_never_leak_credentials(
    caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("PYTH_API_TOKEN", PYTH_FIXTURE)  # the closes fallback reads it too
    http = httpx.Client(transport=httpx.MockTransport(leaky))
    market_cache = MarketCache()
    now = datetime.now(UTC)
    market_cache.update(
        [
            MarketState(
                market="NVDA_X",
                ticker="NVDA",
                strike_cents=18_000,
                trading_date=et_trading_date(now),
                close_ts=int(now.timestamp()) + 3600,
                is_open=True,
                pairs_outstanding=0,
            )
        ]
    )
    spot_cache = make_spot_cache(http, FINNHUB_FIXTURE, PYTH_FIXTURE, ttl_secs=5)
    sources = OnChainSources(market_cache, http, spot_cache, TIINGO_FIXTURE)
    cache = FairValueCache(sources)
    service = Service(sources=sources, token=SERVICE_TOKEN, fair_values=cache.snapshot)
    with caplog.at_level(logging.DEBUG):
        cache.refresh()
        cache.refresh()
        _, body = handle_request(service, "GET", "/fair-values", f"Bearer {SERVICE_TOKEN}")
    text = caplog.text + body.decode()
    for secret in (PYTH_FIXTURE, FINNHUB_FIXTURE, TIINGO_FIXTURE):
        assert secret not in text
    assert "spot unavailable" in caplog.text  # the failure itself is still visible
