"""Additional chain.py coverage tests with mocked RPC (M3-02 coverage blocker).

Tests fetch_open_markets and fetch_resting_orders deserialization with fixture data.
"""
import struct
from unittest.mock import AsyncMock, MagicMock

import pytest
from solana.rpc.async_api import AsyncClient
from solders.account import Account
from solders.pubkey import Pubkey
from solders.rpc.responses import GetAccountInfoResp, GetProgramAccountsResp, RpcResponseContext

from meridian_quant.mm.chain import ChainMarketSource, ChainOrderClient


@pytest.mark.asyncio
async def test_fetch_open_markets_with_mocked_rpc() -> None:
    """fetch_open_markets deserializes Market accounts from RPC response."""
    # Create mock RPC client
    rpc = AsyncMock(spec=AsyncClient)
    program_id = Pubkey.from_string("11111111111111111111111111111112")

    # Create fixture Market account data matching chain.py deserialization order:
    # discriminator(8) + ticker(8) + strike(8) + trading_date(4) + close_ts(8) +
    # 6 pubkeys(192) + pairs_outstanding(8) + status(1)
    market_disc = bytes([219, 190, 213, 55, 0, 227, 198, 154])
    ticker = b"AAPL\x00\x00\x00\x00"  # 8 bytes padded
    strike_cents = struct.pack("<Q", 23000)  # u64
    trading_date = struct.pack("<I", 20261008)  # u32
    close_ts = struct.pack("<q", 1234567890)  # i64
    pubkeys = b"\x00" * (32 * 6)  # 6 pubkeys (yes_mint, no_mint, vault, escrow_usdc, escrow_yes, book)
    pairs_outstanding = struct.pack("<Q", 100)  # u64
    status = b"\x00"  # MarketStatus::Open = 0
    padding = b"\x00" * 50  # Ensure > 250 bytes total

    market_data = market_disc + ticker + strike_cents + trading_date + close_ts + pubkeys + pairs_outstanding + status + padding

    # Create mock account
    mock_account = MagicMock()
    mock_account.pubkey = Pubkey.from_string("2" * 44)  # 44-char base58
    mock_account.account = MagicMock()
    mock_account.account.data = market_data

    # Mock get_program_accounts response
    mock_response = MagicMock()
    mock_response.value = [mock_account]
    rpc.get_program_accounts = AsyncMock(return_value=mock_response)

    source = ChainMarketSource(rpc, program_id)
    markets = await source.fetch_open_markets()

    # Should successfully deserialize one market
    assert len(markets) == 1
    assert markets[0].ticker == "AAPL"
    assert markets[0].strike_cents == 23000
    assert markets[0].trading_date == 20261008
    assert markets[0].is_open is True


@pytest.mark.asyncio
async def test_fetch_open_markets_filters_non_market_accounts() -> None:
    """fetch_open_markets filters accounts without Market discriminator."""
    rpc = AsyncMock(spec=AsyncClient)
    program_id = Pubkey.from_string("11111111111111111111111111111112")

    # Create account with wrong discriminator (Book, not Market)
    wrong_disc = bytes([197, 178, 136, 149, 17, 94, 76, 216])  # Book discriminator
    wrong_data = wrong_disc + b"\x00" * 300

    mock_account = MagicMock()
    mock_account.pubkey = Pubkey.from_string("2" * 44)  # 44-char base58
    mock_account.account = MagicMock()
    mock_account.account.data = wrong_data

    mock_response = MagicMock()
    mock_response.value = [mock_account]
    rpc.get_program_accounts = AsyncMock(return_value=mock_response)

    source = ChainMarketSource(rpc, program_id)
    markets = await source.fetch_open_markets()

    # Should filter out non-Market accounts
    assert len(markets) == 0


@pytest.mark.asyncio
async def test_fetch_resting_orders_with_mocked_rpc() -> None:
    """fetch_resting_orders deserializes Book data from RPC response."""
    rpc = AsyncMock(spec=AsyncClient)
    program_id = Pubkey.from_string("11111111111111111111111111111112")
    usdc_mint = Pubkey.from_string("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU")

    from solders.keypair import Keypair
    payer = Keypair()
    client = ChainOrderClient(rpc, program_id, payer, usdc_mint)

    # Create fixture Book account data
    # Discriminator + bids + asks (each BookOrder is 64 bytes)
    book_disc = bytes([197, 178, 136, 149, 17, 94, 76, 216])
    
    # One bid order: order_id(u64) + owner(32) + price(u8) + pad(7) + qty(u64) + seq(u64)
    order_id = struct.pack("<Q", 1)
    owner = bytes(Pubkey.from_string("3" * 44))  # 32 bytes, 44-char base58
    price = struct.pack("<B", 50)
    pad = b"\x00" * 7
    qty = struct.pack("<Q", 10)
    seq = struct.pack("<Q", 1)
    
    bid_order = order_id + owner + price + pad + qty + seq
    
    # 32 bid slots (only first one filled)
    bids_data = bid_order + (b"\x00" * 64 * 31)
    
    # 32 ask slots (empty)
    asks_data = b"\x00" * 64 * 32
    
    book_data = book_disc + bids_data + asks_data

    # Mock get_account_info response
    mock_account = Account(
        lamports=1000000,
        data=book_data,
        owner=program_id,
        executable=False,
        rent_epoch=0,
    )
    mock_resp = GetAccountInfoResp(
        value=mock_account,
        context=RpcResponseContext(slot=123, api_version=None),
    )
    rpc.get_account_info = AsyncMock(return_value=mock_resp)

    market = "2" * 44  # Valid base58 pubkey (44 chars)
    orders = await client.fetch_resting_orders(market)

    # Should deserialize one order
    assert len(orders) == 1
    assert orders[0].side == "Bid"
    assert orders[0].price == 50
    assert orders[0].qty == 10
    assert orders[0].order_id == 1


@pytest.mark.asyncio
async def test_fetch_resting_orders_empty_book() -> None:
    """fetch_resting_orders handles empty book (no account)."""
    rpc = AsyncMock(spec=AsyncClient)
    program_id = Pubkey.from_string("11111111111111111111111111111112")
    usdc_mint = Pubkey.from_string("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU")

    from solders.keypair import Keypair
    payer = Keypair()
    client = ChainOrderClient(rpc, program_id, payer, usdc_mint)

    # Mock get_account_info response with no account
    mock_resp = GetAccountInfoResp(
        value=None,
        context=RpcResponseContext(slot=123, api_version=None),
    )
    rpc.get_account_info = AsyncMock(return_value=mock_resp)

    market = "2" * 44  # Valid base58 pubkey (44 chars)
    orders = await client.fetch_resting_orders(market)

    # Should return empty list
    assert len(orders) == 0
