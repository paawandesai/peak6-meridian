"""Tests for onchain.py HttpFairValueSource (M3-02 coverage)."""

from unittest.mock import AsyncMock, patch

import pytest

from meridian_quant.mm.onchain import HttpFairValueSource


@pytest.mark.asyncio
async def test_fetch_fair_values_success() -> None:
    """HttpFairValueSource deserializes /fair-values response."""
    source = HttpFairValueSource(
        base_url="http://localhost:4100",
        service_token="test-token",
        timeout_secs=5.0,
    )

    # Mock httpx response - json() must return plain data, not a coroutine
    response_data = [
        {
            "market": "22222222222222222222222222222222222222222222",
            "ticker": "AAPL",
            "strike_cents": 23000,
            "fair_cents": 5000,
            "sigma": 0.25,
            "spot": 230.5,
            "as_of": "2026-10-08T12:00:00Z",
            "stale": False,
        }
    ]

    mock_resp = AsyncMock()
    mock_resp.json = lambda: response_data  # Sync method, not async
    mock_resp.raise_for_status = AsyncMock()

    with patch("meridian_quant.mm.onchain.httpx.AsyncClient") as mock_client_cls:
        mock_client = AsyncMock()
        mock_client.__aenter__.return_value = mock_client
        mock_client.__aexit__.return_value = AsyncMock()
        mock_client.get = AsyncMock(return_value=mock_resp)
        mock_client_cls.return_value = mock_client

        fvs = await source.fetch_fair_values()

    assert len(fvs) == 1
    assert fvs[0].ticker == "AAPL"
    assert fvs[0].fair_cents == 5000
    assert fvs[0].sigma == 0.25
    assert fvs[0].stale is False
    # Check Authorization header
    mock_client.get.assert_called_once()
    call_args = mock_client.get.call_args
    assert call_args[1]["headers"]["Authorization"] == "Bearer test-token"


@pytest.mark.asyncio
async def test_fetch_fair_values_handles_missing_stale_field() -> None:
    """HttpFairValueSource defaults stale=False when field missing."""
    source = HttpFairValueSource(
        base_url="http://localhost:4100/",  # Test trailing slash removal
        service_token="test-token",
    )

    # Mock response without 'stale' field
    response_data = [
        {
            "market": "22222222222222222222222222222222222222222222",
            "ticker": "NVDA",
            "strike_cents": 50000,
            "fair_cents": 12000,
            "sigma": 0.30,
            "spot": 505.0,
            "as_of": "2026-10-08T14:00:00Z",
        }
    ]

    mock_resp = AsyncMock()
    mock_resp.json = lambda: response_data  # Sync method, not async
    mock_resp.raise_for_status = AsyncMock()

    with patch("meridian_quant.mm.onchain.httpx.AsyncClient") as mock_client_cls:
        mock_client = AsyncMock()
        mock_client.__aenter__.return_value = mock_client
        mock_client.__aexit__.return_value = AsyncMock()
        mock_client.get = AsyncMock(return_value=mock_resp)
        mock_client_cls.return_value = mock_client

        fvs = await source.fetch_fair_values()

    assert len(fvs) == 1
    assert fvs[0].stale is False  # Default value when field missing
