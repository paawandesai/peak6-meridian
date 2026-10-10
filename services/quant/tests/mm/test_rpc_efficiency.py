"""P1-7: RPC efficiency tests showing RPC call count reduction."""

import struct
from unittest.mock import AsyncMock, Mock, call

import pytest
from solana.rpc.async_api import AsyncClient
from solders.pubkey import Pubkey
from solders.rpc.responses import GetMultipleAccountsResp, RpcResponseContext

from meridian_quant.mm.chain import ChainMarketSource, ChainOrderClient


@pytest.fixture
def mock_program_id() -> Pubkey:
    """Mock program ID."""
    return Pubkey.from_string("4MangoMjqJ2firMokCjjGgoK8d4MXcrgL7XJaL3w6fVg")


@pytest.fixture
def mock_usdc_mint() -> Pubkey:
    """Mock USDC mint."""
    return Pubkey.from_string("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")


@pytest.mark.asyncio
async def test_fetch_open_markets_rpc_count(mock_program_id: Pubkey) -> None:
    """Test that fetch_open_markets uses discriminator filter (1 RPC call).

    BEFORE P1-7: get_program_accounts with no filter fetched all accounts (Books, Markets,
    OpenOrders, etc.) and filtered in Python. With 50 markets, that could mean fetching
    ~200+ program accounts.

    AFTER P1-7: get_program_accounts with memcmp filter fetches only Market accounts (1 call).
    """
    mock_rpc = AsyncMock(spec=AsyncClient)
    market_source = ChainMarketSource(mock_rpc, mock_program_id)

    # Mock response: 50 open markets
    market_discriminator = bytes([219, 190, 213, 55, 0, 227, 198, 154])
    mock_accounts = []
    for i in range(50):
        # Build minimal Market account data
        ticker = f"TICKER{i}".ljust(8, "\x00")[:8].encode("ascii")
        strike_cents = struct.pack("<Q", 10000 + i * 100)  # $100.00 + i
        trading_date = struct.pack("<I", 20261010)
        close_ts = struct.pack("<q", 1728590400 + i)  # Mock unix timestamp
        pubkeys = b"\x00" * 32 * 6  # yes_mint, no_mint, vault, escrow_usdc, escrow_yes, book
        pairs_outstanding = struct.pack("<Q", 100)
        status = bytes([0])  # Open

        data = market_discriminator + ticker + strike_cents + trading_date + close_ts + pubkeys + pairs_outstanding + status
        # Pad to reasonable size
        data += b"\x00" * (260 - len(data))

        mock_account = Mock()
        # Use valid base58 pubkey (33 char base58 represents 32 bytes)
        # Generate valid pubkey by creating from bytes
        pubkey_bytes = bytes([i]) + b"\x00" * 31
        mock_account.pubkey = Pubkey(pubkey_bytes)
        mock_account.account = Mock()
        mock_account.account.data = data
        mock_accounts.append(mock_account)

    mock_response = Mock()
    mock_response.value = mock_accounts
    mock_rpc.get_program_accounts.return_value = mock_response

    # Fetch markets
    markets = await market_source.fetch_open_markets()

    # Verify results
    assert len(markets) == 50

    # AFTER P1-7: get_program_accounts called ONCE with discriminator memcmp filter
    assert mock_rpc.get_program_accounts.call_count == 1
    call_args = mock_rpc.get_program_accounts.call_args
    # Check that filters parameter includes memcmp filter
    assert "filters" in call_args.kwargs
    filters = call_args.kwargs["filters"]
    assert len(filters) == 1
    # MemcmpOpts object with offset=0 and base64-encoded discriminator
    from solana.rpc.types import MemcmpOpts
    assert isinstance(filters[0], MemcmpOpts)
    assert filters[0].offset == 0
    # Verify the discriminator is base64-encoded
    import base64
    assert filters[0].bytes == base64.b64encode(market_discriminator).decode("ascii")

    print(
        f"✓ fetch_open_markets RPC calls: 1 (with discriminator filter)"
    )
    print(f"  BEFORE P1-7: Would fetch all ~200+ program accounts without filter")
    print(f"  AFTER P1-7: Fetches only 50 Market accounts with memcmp filter")


@pytest.mark.asyncio
async def test_batched_token_balance_rpc_count(
    mock_program_id: Pubkey, mock_usdc_mint: Pubkey
) -> None:
    """Test that get_multiple_token_balances batches RPC calls (P1-7 AC).

    BEFORE P1-7: For 50 markets, _sync_inventory made 100 individual RPC calls:
    - 50 x get_yes_token_balance (each calls get_account_info once)
    - 50 x get_no_token_balance (each calls get_account_info once)
    Total: 100 RPC calls

    AFTER P1-7: get_multiple_token_balances uses get_multiple_accounts:
    - 1 call for 100 ATAs (50 YES + 50 NO), or
    - 2 calls if chunked (first 99, then remaining 1)
    Total: 2 RPC calls (≤99 keys per chunk)

    RPC reduction: 100 → 2 = 98% reduction (AC: ≥50%)
    """
    from solders.keypair import Keypair

    mock_rpc = AsyncMock(spec=AsyncClient)
    mock_keypair = Keypair()
    order_client = ChainOrderClient(mock_rpc, mock_program_id, mock_keypair, mock_usdc_mint)

    # Create 50 valid market addresses
    markets = [str(Pubkey(bytes([i]) + b"\x00" * 31)) for i in range(50)]
    owner = str(mock_keypair.pubkey())

    # Mock get_multiple_accounts responses
    # SPL Token account data: amount (u64) at offset 0
    def make_token_account_data(amount: int) -> bytes:
        return struct.pack("<Q", amount) + b"\x00" * 157  # SPL Token account is 165 bytes

    # Build mock accounts for YES and NO ATAs (100 total)
    mock_account_data = []
    for i in range(50):
        # YES ATA: 10 tokens
        yes_account = Mock()
        yes_account.data = make_token_account_data(10)
        mock_account_data.append(yes_account)
        # NO ATA: 5 tokens
        no_account = Mock()
        no_account.data = make_token_account_data(5)
        mock_account_data.append(no_account)

    # Mock response for first chunk (99 accounts)
    mock_response_1 = Mock(spec=GetMultipleAccountsResp)
    mock_response_1.value = mock_account_data[:99]
    # Mock response for second chunk (1 account)
    mock_response_2 = Mock(spec=GetMultipleAccountsResp)
    mock_response_2.value = mock_account_data[99:]

    mock_rpc.get_multiple_accounts.side_effect = [mock_response_1, mock_response_2]

    # Fetch balances
    balances = await order_client.get_multiple_token_balances(markets, owner)

    # Verify results
    assert len(balances) == 50
    for market in markets:
        yes_bal, no_bal = balances[market]
        assert yes_bal == 10
        assert no_bal == 5

    # AFTER P1-7: get_multiple_accounts called TWICE (99 + 1)
    assert mock_rpc.get_multiple_accounts.call_count == 2
    # First call: 99 keys (chunked)
    first_call_keys = mock_rpc.get_multiple_accounts.call_args_list[0][0][0]
    assert len(first_call_keys) == 99
    # Second call: 1 key (remainder)
    second_call_keys = mock_rpc.get_multiple_accounts.call_args_list[1][0][0]
    assert len(second_call_keys) == 1

    print(
        f"✓ Batched token balance RPC calls: 2 (chunked at ≤99)"
    )
    print(f"  BEFORE P1-7: 100 individual get_account_info calls (50 YES + 50 NO)")
    print(f"  AFTER P1-7: 2 batched get_multiple_accounts calls (99 + 1)")
    print(f"  RPC REDUCTION: 100 → 2 = 98% (exceeds AC: ≥50%)")
