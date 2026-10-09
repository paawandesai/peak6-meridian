"""Market maker configuration."""

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class MMConfig(BaseSettings):
    """Market maker configuration from environment."""

    model_config = SettingsConfigDict(case_sensitive=False, populate_by_name=True)

    # Solana connection (Finding #6: no MM_ prefix per environment.md)
    rpc_url: str = Field(default="http://localhost:8899", alias="SOLANA_RPC_URL")
    ws_url: str = Field(default="ws://localhost:8900", alias="SOLANA_WS_URL")

    # Market maker keypair (JSON array per environment.md, Finding #6)
    market_maker_keypair: str = Field(..., alias="MARKET_MAKER_KEYPAIR")

    # Program and config
    program_id: str = Field(..., alias="MERIDIAN_PROGRAM_ID")
    usdc_mint: str = Field(..., alias="USDC_MINT")

    # Trading parameters (domain.md § Market maker defaults)
    spread_cents: int = Field(default=2, description="Quote fair ± spread")
    size_per_side: int = Field(default=10, description="Contracts per side")
    max_inventory: int = Field(default=200, description="Max |inventory| per strike")
    skew_per_50: int = Field(default=1, description="1¢ skew per 50 contracts")

    # Pull conditions
    max_spot_age_secs: int = Field(default=10, description="Pull if spot > 10s old")
    min_time_to_close_secs: int = Field(default=120, description="Pull if < 2 min to close")

    # Service endpoints (base URL, no path - onchain.py appends /fair-values)
    # environment.md: QUANT_URL at http://127.0.0.1:4100
    fair_values_url: str = Field(default="http://127.0.0.1:4100", alias="QUANT_URL")
    service_token: str = Field(..., alias="SERVICE_TOKEN")

    # Operation
    loop_interval_secs: float = Field(default=5.0, description="Main loop interval")
    max_orders_per_owner: int = Field(default=8, description="Per-owner resting order cap")


# Constants from domain.md
MIN_PRICE_CENTS = 1
MAX_PRICE_CENTS = 99
