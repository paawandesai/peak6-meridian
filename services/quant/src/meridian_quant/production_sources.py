"""Production Sources implementation for the quant service.

M4-08: Connects markets(), spot(), and closes() to real price providers with demo mode support.
This file will be wired into server.py after !58 merges.
"""

from datetime import UTC, date, datetime
from decimal import Decimal

import httpx

from meridian_quant.config import QuantConfig
from meridian_quant.prices import Spot, fetch_daily_closes, fetch_spot
from meridian_quant.server import MarketInfo


class ProductionSources:
    """Real price sources with demo mode support."""

    def __init__(
        self,
        config: QuantConfig,
        http_client: httpx.Client,
        market_list: list[MarketInfo],
        today: date | None = None,
    ) -> None:
        """Initialize production sources.

        Args:
            config: Quant service configuration
            http_client: HTTP client for price requests
            market_list: List of markets to price (from chain or config)
            today: Current date (for daily closes lookback); defaults to UTC today
        """
        self._config = config
        self._http = http_client
        self._market_list = market_list
        self._today = today or datetime.now(UTC).date()

    def markets(self) -> list[MarketInfo]:
        """List of markets to price."""
        return self._market_list

    def spot(self, ticker: str) -> Spot:
        """Current spot price (or historical EOD in replay mode)."""
        return fetch_spot(
            self._http,
            ticker,
            self._config.finnhub_api_key,
            demo_mode=self._config.demo_mode,
            demo_replay_date=self._config.demo_replay_date,
            tiingo_key=self._config.tiingo_api_key,
        )

    def closes(self, ticker: str) -> list[Decimal]:
        """Daily closes for volatility (historical in replay mode)."""
        return fetch_daily_closes(
            self._http,
            ticker,
            self._config.tiingo_api_key,
            self._today,
            demo_mode=self._config.demo_mode,
            demo_replay_date=self._config.demo_replay_date,
        )
