"""Configuration for the quant service.

M4-08: Demo mode support for historical price replay.
Environment variables (docs/environment.md):
- DEMO_MODE: "live" (default) or "replay"
- DEMO_REPLAY_DATE: YYYY-MM-DD (required when DEMO_MODE=replay)
- TIINGO_API_KEY: Tiingo API key (required for both modes; live uses daily closes, replay uses EOD)
- FINNHUB_API_KEY: Finnhub API key (live mode only)
- SERVICE_TOKEN: Bearer token for /fair-values endpoint
"""

import os
from dataclasses import dataclass
from datetime import date


@dataclass(frozen=True)
class QuantConfig:
    """Quant service configuration from environment."""

    demo_mode: str  # "live" or "replay"
    demo_replay_date: date | None  # Required when demo_mode="replay"
    tiingo_api_key: str
    finnhub_api_key: str
    service_token: str

    def __post_init__(self) -> None:
        if self.demo_mode not in ("live", "replay"):
            raise ValueError(f"DEMO_MODE must be 'live' or 'replay', got {self.demo_mode!r}")
        if self.demo_mode == "replay" and self.demo_replay_date is None:
            raise ValueError("DEMO_REPLAY_DATE required when DEMO_MODE=replay")
        if not self.tiingo_api_key:
            raise ValueError("TIINGO_API_KEY must be set")
        if self.demo_mode == "live" and not self.finnhub_api_key:
            raise ValueError("FINNHUB_API_KEY required for live mode")
        if not self.service_token:
            raise ValueError("SERVICE_TOKEN must be set")


def load_config() -> QuantConfig:
    """Load configuration from environment variables."""
    demo_mode = os.getenv("DEMO_MODE", "live")
    demo_replay_date_str = os.getenv("DEMO_REPLAY_DATE")
    demo_replay_date = None
    if demo_replay_date_str:
        try:
            demo_replay_date = date.fromisoformat(demo_replay_date_str)
        except ValueError as error:
            raise ValueError(f"DEMO_REPLAY_DATE must be YYYY-MM-DD: {error}") from None

    return QuantConfig(
        demo_mode=demo_mode,
        demo_replay_date=demo_replay_date,
        tiingo_api_key=os.getenv("TIINGO_API_KEY", ""),
        finnhub_api_key=os.getenv("FINNHUB_API_KEY", ""),
        service_token=os.getenv("SERVICE_TOKEN", ""),
    )
