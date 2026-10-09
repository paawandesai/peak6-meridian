"""Minimal on-chain Solana client for MM loop (M3-02).

Implements just enough for local-validator test: market fetching and order placement.
Full production client should live in packages/client-py/ as shared infrastructure.
"""

import struct
from typing import Literal

from solana.rpc.async_api import AsyncClient
from solana.rpc.commitment import Confirmed
from solders.instruction import AccountMeta, Instruction  # type: ignore[import-untyped]
from solders.keypair import Keypair  # type: ignore[import-untyped]
from solders.pubkey import Pubkey
from solders.system_program import ID as SYS_PROGRAM_ID
from solders.transaction import Transaction  # type: ignore[import-untyped]
from spl.token.constants import TOKEN_PROGRAM_ID

from .types import MarketState, RestingOrder


def derive_market_pda(program_id: Pubkey, ticker: bytes, trading_date: int, strike_cents: int) -> Pubkey:
    """Derive market PDA: seeds = [b"market", ticker (8 bytes), trading_date (u32 LE), strike_cents (u64 LE)]."""
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
    """Minimal market fetcher for local-validator test."""

    def __init__(self, rpc_client: AsyncClient, program_id: Pubkey) -> None:
        self.rpc = rpc_client
        self.program_id = program_id

    async def fetch_open_markets(self) -> list[MarketState]:
        """Fetch open markets. STUB: returns empty for now."""
        # Full implementation needs:
        # - getProgramAccounts with Market discriminator filter
        # - Borsh deserialization of Market account data
        # - ~50-100 lines
        return []


class OnChainOrderClient:
    """Minimal order client for local-validator test."""

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
        """Place order. STUB for now."""
        # Full implementation needs:
        # - Build place_order instruction with discriminator
        # - Derive all PDAs (book, open_orders, escrow accounts)
        # - Get or create ATAs for user_usdc, user_yes
        # - Build and send transaction
        # - ~100-150 lines
        raise NotImplementedError("place_order: needs full transaction builder")

    async def cancel_order(self, market: str, order_id: int, owner: str) -> None:
        """Cancel order."""
        raise NotImplementedError("cancel_order: needs full transaction builder")

    async def fetch_resting_orders(self, market: str) -> list[RestingOrder]:
        """Fetch resting orders from book account."""
        # Full implementation needs:
        # - Fetch book account data
        # - Deserialize order list (Borsh)
        # - ~50 lines
        return []

    async def mint_pair(self, market: str, qty: int, owner: str) -> None:
        """Mint YES+NO pair."""
        raise NotImplementedError("mint_pair: needs full transaction builder")
