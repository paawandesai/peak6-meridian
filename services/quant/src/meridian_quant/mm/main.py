"""Production entry point for market maker loop.

Usage:
    python -m meridian_quant.mm.main

Environment variables (see docs/environment.md):
    MARKET_MAKER_KEYPAIR: JSON array of 64 bytes (required)
    PROGRAM_ID: Meridian program ID (required)
    SERVICE_TOKEN: Bearer token for M3-01 /fair-values (required)
    SOLANA_RPC_URL: RPC endpoint (default: http://localhost:8899)
    FAIR_VALUES_URL: M3-01 service URL (default: http://localhost:8080/fair-values)
"""

import asyncio
import json
import logging

from solana.rpc.async_api import AsyncClient
from solders.keypair import Keypair
from solders.pubkey import Pubkey

from .chain import ChainMarketSource, ChainOrderClient
from .config import MMConfig
from .loop import MarketMakerLoop
from .onchain import HttpFairValueSource

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)


async def main() -> None:
    """Start the market maker loop."""
    # Load config from environment (BaseSettings automatically reads env vars)
    config = MMConfig()  # type: ignore[call-arg]
    logger.info("Market maker starting with config: program_id=%s", config.program_id)

    # Initialize Solana connection
    rpc_client = AsyncClient(config.rpc_url)
    program_id = Pubkey.from_string(config.program_id)
    # Parse MARKET_MAKER_KEYPAIR as JSON array (environment.md format)
    keypair_bytes = json.loads(config.market_maker_keypair)
    keypair = Keypair.from_bytes(bytes(keypair_bytes))

    # Initialize on-chain clients (use chain.py implementations, not onchain.py stubs)
    market_source = ChainMarketSource(rpc_client, program_id)
    fair_value_source = HttpFairValueSource(
        base_url=config.fair_values_url, service_token=config.service_token
    )
    # USDC mint from environment (environment.md)
    usdc_mint = Pubkey.from_string(config.usdc_mint)
    order_client = ChainOrderClient(rpc_client, program_id, keypair, usdc_mint)

    # Create and start MM loop
    mm_loop = MarketMakerLoop(
        config=config,
        market_source=market_source,
        fair_value_source=fair_value_source,
        order_client=order_client,
    )

    logger.info("Starting market maker loop (interval: %.1fs)", config.loop_interval_secs)
    await mm_loop.start()


if __name__ == "__main__":
    asyncio.run(main())
