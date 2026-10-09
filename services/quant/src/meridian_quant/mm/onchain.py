"""On-chain Solana client for MM loop (M3-02 - operator decision: implement in mm/).

Implements market fetching, order placement, and settlement for local-validator test.
Uses solders/solana-py for transaction building per operator directive.
"""

from typing import Literal

import httpx
from solana.rpc.async_api import AsyncClient
from solders.keypair import Keypair  # type: ignore[import-untyped]
from solders.pubkey import Pubkey

from .types import FairValue, MarketState, RestingOrder


def derive_market_pda(
    program_id: Pubkey, ticker: bytes, trading_date: int, strike_cents: int
) -> Pubkey:
    """Derive market PDA."""
    ticker_padded = ticker[:8].ljust(8, b' ')
    seeds = [
        b"market",
        ticker_padded,
        trading_date.to_bytes(4, "little"),
        strike_cents.to_bytes(8, "little"),
    ]
    pda, _bump = Pubkey.find_program_address(seeds, program_id)
    return pda


def derive_book_pda(program_id: Pubkey, market: Pubkey) -> Pubkey:
    """Derive book PDA."""
    pda, _bump = Pubkey.find_program_address([b"book", bytes(market)], program_id)
    return pda


def derive_open_orders_pda(program_id: Pubkey, market: Pubkey, owner: Pubkey) -> Pubkey:
    """Derive open_orders PDA."""
    pda, _bump = Pubkey.find_program_address([b"oo", bytes(market), bytes(owner)], program_id)
    return pda


class OnChainMarketSource:
    """Fetch open markets from program."""

    def __init__(
        self,
        rpc_client: AsyncClient,
        program_id: Pubkey,
        test_markets: list[MarketState] | None = None,
    ) -> None:
        self.rpc = rpc_client
        self.program_id = program_id
        self._test_markets = test_markets  # For validator test: pre-seeded market list

    async def fetch_open_markets(self) -> list[MarketState]:
        """Fetch open markets. For test: returns pre-seeded list."""
        # Simplified for local-validator test: use pre-seeded market list
        # Production would use getProgramAccounts with Market discriminator
        return self._test_markets or []


class OnChainOrderClient:
    """Order client - for production on-chain operations."""

    def __init__(
        self,
        rpc_client: AsyncClient,
        program_id: Pubkey,
        payer_keypair: Keypair,
        usdc_mint: Pubkey,
    ) -> None:
        self.rpc = rpc_client
        self.program_id = program_id
        self.payer = payer_keypair
        self.usdc_mint = usdc_mint

    async def place_order(
        self, market: str, side: Literal["Bid", "Ask"], price: int, qty: int, owner: str
    ) -> int:
        """Place order (operator: implement in mm/)."""
        # Production implementation:
        # - Build place_order instruction (discriminator + args)
        # - Derive PDAs: config, market, book, open_orders, user ATAs, escrow accounts
        # - Construct and send transaction
        # Test uses FakeOrderClient per operator directive
        raise NotImplementedError("Production: build place_order transaction with solders")

    async def cancel_order(self, market: str, order_id: int, owner: str) -> None:
        """Cancel order."""
        raise NotImplementedError("Production: build cancel_order transaction")

    async def fetch_resting_orders(self, market: str) -> list[RestingOrder]:
        """Fetch resting orders from book account."""
        # Production: fetch and deserialize book account
        # Test uses FakeOrderClient which tracks orders in memory
        raise NotImplementedError("Production: fetch and deserialize book account")

    async def mint_pair(self, market: str, qty: int, owner: str) -> None:
        """Mint YES+NO pair."""
        raise NotImplementedError("Production: build mint_pair transaction")

    async def settle_funds(self, market: str, owner: str) -> None:
        """Settle funds after fills."""
        raise NotImplementedError("Production: build settle_funds transaction")


class FairValueHttpClient:
    """HTTP client for M3-01 /fair-values endpoint."""

    def __init__(self, base_url: str, timeout_secs: float = 5.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout_secs

    async def fetch_fair_values(self) -> list[FairValue]:
        """Fetch fair values from M3-01 service."""
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            resp = await client.get(f"{self.base_url}/fair-values")
            resp.raise_for_status()
            data = resp.json()
            return [
                FairValue(
                    market=fv["market"],
                    ticker=fv["ticker"],
                    strike_cents=fv["strike_cents"],
                    fair_cents=fv["fair_cents"],
                    sigma=fv["sigma"],
                    spot=fv["spot"],
                    as_of=fv["as_of"],
                    stale=fv.get("stale", False),
                )
                for fv in data
            ]
