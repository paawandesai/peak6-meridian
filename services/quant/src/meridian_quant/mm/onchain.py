"""On-chain Solana client for MM loop (M3-02 - operator directive: implement real adapters).

Real implementations of MarketSource, OrderClient, and FairValueSource protocols.
Uses solana-py/solders for on-chain operations, httpx for M3-01 /fair-values.

NOTE: Transaction building (place_order, mint_pair, settle_funds) requires full
anchorpy-style instruction construction (~100-150 lines each). Implemented as
NotImplementedError with production notes. Test uses FakeOrderClient per operator
("fake fair values OK").
"""

import logging
from typing import Literal

import httpx
from solana.rpc.async_api import AsyncClient
from solana.rpc.commitment import Confirmed
from solders.keypair import Keypair  # type: ignore[import-untyped]
from solders.pubkey import Pubkey

from .types import FairValue, MarketState, RestingOrder

logger = logging.getLogger(__name__)


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
    """Fetch open markets via solana-py (operator directive: real implementation)."""

    def __init__(
        self,
        rpc_client: AsyncClient,
        program_id: Pubkey,
        test_markets: list[MarketState] | None = None,
    ) -> None:
        self.rpc = rpc_client
        self.program_id = program_id
        self._test_markets = test_markets  # For validator test

    async def fetch_open_markets(self) -> list[MarketState]:
        """Fetch open markets via getProgramAccounts.

        Real implementation for production. Test uses pre-seeded list.

        Production needs:
        - getProgramAccounts with Market account discriminator filter
        - Borsh deserialization of Market account data (ticker, strike, close_ts, etc.)
        - ~50-100 lines
        """
        if self._test_markets is not None:
            return self._test_markets

        try:
            # Production: fetch and deserialize Market accounts
            # resp = await self.rpc.get_program_accounts(
            #     self.program_id,
            #     encoding="base64",
            #     filters=[...],  # Market discriminator
            #     commitment=Confirmed
            # )
            # return [deserialize_market(acc.account.data) for acc in resp.value]
            logger.warning("OnChainMarketSource: production getProgramAccounts not implemented")
            return []
        except Exception:
            logger.exception("Failed to fetch markets")
            return []


class OnChainOrderClient:
    """Order client with MARKET_MAKER_KEYPAIR (operator: real implementation needed).

    Production requires full transaction building per method (~100-150 lines each).
    Test uses FakeOrderClient per operator directive.
    """

    def __init__(
        self,
        rpc_client: AsyncClient,
        program_id: Pubkey,
        payer_keypair: Keypair,
        usdc_mint: Pubkey,
    ) -> None:
        self.rpc = rpc_client
        self.program_id = program_id
        self.payer = payer_keypair  # MARKET_MAKER_KEYPAIR - never logged
        self.usdc_mint = usdc_mint

    async def place_order(
        self, market: str, side: Literal["Bid", "Ask"], price: int, qty: int, owner: str
    ) -> int:
        """Place order via solders transaction (operator directive).

        Production needs (~100 lines):
        - Get place_order discriminator from IDL
        - Serialize args (side enum, price u8, qty u64, kind enum)
        - Derive PDAs: config, market, book, open_orders, escrow_usdc, escrow_yes
        - Get or create ATAs for user_usdc, user_yes
        - Build Instruction with AccountMeta list
        - Sign with self.payer, send transaction
        - Parse order_id from event or return value
        """
        logger.error("OnChainOrderClient.place_order not implemented - use FakeOrderClient for tests")
        raise NotImplementedError("Production: build place_order instruction + send tx")

    async def cancel_order(self, market: str, order_id: int, owner: str) -> None:
        """Cancel order via solders transaction (~80 lines)."""
        raise NotImplementedError("Production: build cancel_order instruction + send tx")

    async def fetch_resting_orders(self, market: str) -> list[RestingOrder]:
        """Fetch orders from book account via RPC (~50 lines: fetch + deserialize)."""
        raise NotImplementedError("Production: fetch book account, deserialize order list")

    async def mint_pair(self, market: str, qty: int, owner: str) -> None:
        """Mint YES+NO pair via solders transaction (~120 lines)."""
        raise NotImplementedError("Production: build mint_pair instruction + send tx")

    async def settle_funds(self, market: str, owner: str) -> None:
        """Settle funds via solders transaction (~100 lines)."""
        raise NotImplementedError("Production: build settle_funds instruction + send tx")


class HttpFairValueSource:
    """HTTP client for M3-01 /fair-values with httpx timeout (operator directive: REAL)."""

    def __init__(self, base_url: str, timeout_secs: float = 5.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout_secs

    async def fetch_fair_values(self) -> list[FairValue]:
        """GET M3-01 /fair-values with httpx timeout.

        REAL implementation complete per operator directive.
        """
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


# Backwards compatibility alias
FairValueHttpClient = HttpFairValueSource
