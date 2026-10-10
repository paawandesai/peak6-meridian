"""Tests for quant service configuration (M4-08)."""

from datetime import date

import pytest

from meridian_quant.config import QuantConfig, load_config


def test_live_mode_config_valid() -> None:
    """Live mode requires TIINGO_API_KEY, FINNHUB_API_KEY, SERVICE_TOKEN."""
    config = QuantConfig(
        demo_mode="live",
        demo_replay_date=None,
        tiingo_api_key="tiingo-key",
        finnhub_api_key="finnhub-key",
        service_token="token",
    )
    assert config.demo_mode == "live"
    assert config.demo_replay_date is None


def test_replay_mode_config_valid() -> None:
    """Replay mode requires DEMO_REPLAY_DATE and TIINGO_API_KEY."""
    config = QuantConfig(
        demo_mode="replay",
        demo_replay_date=date(2024, 10, 8),
        tiingo_api_key="tiingo-key",
        finnhub_api_key="",  # Not required in replay mode
        service_token="token",
    )
    assert config.demo_mode == "replay"
    assert config.demo_replay_date == date(2024, 10, 8)


def test_replay_mode_requires_replay_date() -> None:
    """Replay mode without DEMO_REPLAY_DATE fails validation."""
    with pytest.raises(ValueError, match="DEMO_REPLAY_DATE required"):
        QuantConfig(
            demo_mode="replay",
            demo_replay_date=None,
            tiingo_api_key="k",
            finnhub_api_key="k",
            service_token="t",
        )


def test_live_mode_requires_finnhub_key() -> None:
    """Live mode without FINNHUB_API_KEY fails validation."""
    with pytest.raises(ValueError, match="FINNHUB_API_KEY required"):
        QuantConfig(
            demo_mode="live",
            demo_replay_date=None,
            tiingo_api_key="k",
            finnhub_api_key="",
            service_token="t",
        )


def test_invalid_demo_mode_rejected() -> None:
    """DEMO_MODE must be 'live' or 'replay'."""
    with pytest.raises(ValueError, match="must be 'live' or 'replay'"):
        QuantConfig(
            demo_mode="invalid",
            demo_replay_date=None,
            tiingo_api_key="k",
            finnhub_api_key="k",
            service_token="t",
        )


def test_requires_service_token() -> None:
    """SERVICE_TOKEN must be set."""
    with pytest.raises(ValueError, match="SERVICE_TOKEN must be set"):
        QuantConfig(
            demo_mode="live",
            demo_replay_date=None,
            tiingo_api_key="k",
            finnhub_api_key="k",
            service_token="",
        )


def test_load_config_from_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """load_config reads environment variables."""
    monkeypatch.setenv("DEMO_MODE", "replay")
    monkeypatch.setenv("DEMO_REPLAY_DATE", "2024-10-08")
    monkeypatch.setenv("TIINGO_API_KEY", "tiingo-key")
    monkeypatch.setenv("FINNHUB_API_KEY", "finnhub-key")
    monkeypatch.setenv("SERVICE_TOKEN", "token")

    config = load_config()
    assert config.demo_mode == "replay"
    assert config.demo_replay_date == date(2024, 10, 8)
    assert config.tiingo_api_key == "tiingo-key"
    assert config.service_token == "token"


def test_load_config_defaults_to_live_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    """When DEMO_MODE unset, defaults to 'live'."""
    monkeypatch.delenv("DEMO_MODE", raising=False)
    monkeypatch.setenv("TIINGO_API_KEY", "tiingo-key")
    monkeypatch.setenv("FINNHUB_API_KEY", "finnhub-key")
    monkeypatch.setenv("SERVICE_TOKEN", "token")

    config = load_config()
    assert config.demo_mode == "live"
    assert config.demo_replay_date is None


def test_load_config_invalid_replay_date_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    """Invalid DEMO_REPLAY_DATE format raises ValueError."""
    monkeypatch.setenv("DEMO_MODE", "replay")
    monkeypatch.setenv("DEMO_REPLAY_DATE", "not-a-date")
    monkeypatch.setenv("TIINGO_API_KEY", "k")
    monkeypatch.setenv("FINNHUB_API_KEY", "k")
    monkeypatch.setenv("SERVICE_TOKEN", "t")

    with pytest.raises(ValueError, match="DEMO_REPLAY_DATE must be YYYY-MM-DD"):
        load_config()
