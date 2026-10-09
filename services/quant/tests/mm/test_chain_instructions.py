"""Instruction account structure tests for chain.py (AC1).

Verifies that ChainOrderClient builds instructions matching the IDL by calling
the actual methods with a mocked RPC client. Regressions in chain.py account
order would fail these tests.
"""

from unittest.mock import AsyncMock, MagicMock

import pytest
from solders.hash import Hash
from solders.keypair import Keypair
from solders.pubkey import Pubkey
from solders.signature import Signature

from meridian_quant.mm.chain import ChainOrderClient, TOKEN_PROGRAM_ID


async def mock_rpc_client():
    """Create a mocked AsyncClient for testing instruction building."""
    mock_client = AsyncMock()

    # Mock get_latest_blockhash - return object with .value.blockhash
    blockhash_resp = MagicMock()
    blockhash_resp.value.blockhash = Hash.default()
    mock_client.get_latest_blockhash.return_value = blockhash_resp

    # Mock send_transaction - return object with .value (Signature)
    sig_resp = MagicMock()
    sig_resp.value = Signature.default()
    mock_client.send_transaction.return_value = sig_resp

    # Mock confirm_transaction
    mock_client.confirm_transaction.return_value = MagicMock()

    return mock_client


@pytest.mark.asyncio
async def test_place_order_builds_correct_instruction_accounts() -> None:
    """place_order builds instruction with accounts matching IDL order.

    IDL order: config, market, book, user, open_orders, user_usdc, user_yes,
    escrow_usdc, escrow_yes, token_program, system_program + remaining_accounts.
    """
    program_id = Pubkey.from_string("5dJoSJfkx23ZkTGxMtnWxD7fabmM6WiezubXHWqKUffi")
    usdc_mint = Pubkey.from_string("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")
    payer = Keypair()

    mock_client = await mock_rpc_client()

    # Mock fetch_resting_orders to return empty (no contra orders)
    async def mock_fetch_orders(market: str):
        return []

    client = ChainOrderClient(mock_client, program_id, payer, usdc_mint)
    client.fetch_resting_orders = mock_fetch_orders  # type: ignore[method-assign]

    # Call place_order - this builds and "sends" the instruction
    await client.place_order(
        market="AAPL_20261008_23000",
        side="Bid",
        price=50,
        qty=10,
        owner=str(payer.pubkey()),
    )

    # Extract the instruction from the send_transaction call
    assert mock_client.send_transaction.called
    transaction = mock_client.send_transaction.call_args[0][0]
    instruction = transaction.message.instructions[0]

    # Verify account count (11 base accounts, no remaining_accounts since no contra orders)
    assert len(instruction.accounts) == 11

    # Verify flags for each account position (IDL order)
    accounts = instruction.accounts
    assert not accounts[0].is_signer and not accounts[0].is_writable  # config
    assert not accounts[1].is_signer and not accounts[1].is_writable  # market
    assert not accounts[2].is_signer and accounts[2].is_writable  # book
    assert accounts[3].is_signer and accounts[3].is_writable  # user
    assert not accounts[4].is_signer and accounts[4].is_writable  # open_orders
    assert not accounts[5].is_signer and accounts[5].is_writable  # user_usdc
    assert not accounts[6].is_signer and accounts[6].is_writable  # user_yes
    assert not accounts[7].is_signer and accounts[7].is_writable  # escrow_usdc
    assert not accounts[8].is_signer and accounts[8].is_writable  # escrow_yes
    assert not accounts[9].is_signer and not accounts[9].is_writable  # token_program
    assert accounts[9].pubkey == TOKEN_PROGRAM_ID
    assert not accounts[10].is_signer and not accounts[10].is_writable  # system_program


@pytest.mark.asyncio
async def test_cancel_order_builds_correct_instruction_accounts() -> None:
    """cancel_order builds instruction with accounts matching IDL order.

    IDL order: market, book, owner, open_orders.
    """
    program_id = Pubkey.from_string("5dJoSJfkx23ZkTGxMtnWxD7fabmM6WiezubXHWqKUffi")
    usdc_mint = Pubkey.from_string("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")
    payer = Keypair()

    mock_client = await mock_rpc_client()
    client = ChainOrderClient(mock_client, program_id, payer, usdc_mint)

    await client.cancel_order(
        market="AAPL_20261008_23000",
        order_id=42,
        owner=str(payer.pubkey()),
    )

    assert mock_client.send_transaction.called
    transaction = mock_client.send_transaction.call_args[0][0]
    instruction = transaction.message.instructions[0]

    # Verify account count and flags
    assert len(instruction.accounts) == 4
    accounts = instruction.accounts
    assert not accounts[0].is_signer and not accounts[0].is_writable  # market
    assert not accounts[1].is_signer and accounts[1].is_writable  # book
    assert accounts[2].is_signer and not accounts[2].is_writable  # owner
    assert not accounts[3].is_signer and accounts[3].is_writable  # open_orders


@pytest.mark.asyncio
async def test_mint_pair_builds_correct_instruction_accounts() -> None:
    """mint_pair builds instruction with accounts matching IDL order.

    IDL order: config, market, user, user_usdc, user_yes, user_no,
    yes_mint, no_mint, vault, token_program.
    """
    program_id = Pubkey.from_string("5dJoSJfkx23ZkTGxMtnWxD7fabmM6WiezubXHWqKUffi")
    usdc_mint = Pubkey.from_string("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")
    payer = Keypair()

    mock_client = await mock_rpc_client()

    # Mock getAccountInfo to return None (accounts don't exist yet)
    account_resp = MagicMock()
    account_resp.value = None
    mock_client.get_account_info.return_value = account_resp

    client = ChainOrderClient(mock_client, program_id, payer, usdc_mint)

    await client.mint_pair(
        market="AAPL_20261008_23000",
        qty=100,
        owner=str(payer.pubkey()),
    )

    assert mock_client.send_transaction.called
    transaction = mock_client.send_transaction.call_args[0][0]
    # Find the mint_pair instruction (might be after ATA creation instructions)
    instructions = transaction.message.instructions
    mint_instruction = [ix for ix in instructions if len(ix.accounts) == 10][0]

    # Verify account count and flags
    assert len(mint_instruction.accounts) == 10
    accounts = mint_instruction.accounts
    assert not accounts[0].is_signer and not accounts[0].is_writable  # config
    assert not accounts[1].is_signer and accounts[1].is_writable  # market
    assert accounts[2].is_signer and not accounts[2].is_writable  # user
    assert not accounts[3].is_signer and accounts[3].is_writable  # user_usdc
    assert not accounts[4].is_signer and accounts[4].is_writable  # user_yes
    assert not accounts[5].is_signer and accounts[5].is_writable  # user_no
    assert not accounts[6].is_signer and accounts[6].is_writable  # yes_mint
    assert not accounts[7].is_signer and accounts[7].is_writable  # no_mint
    assert not accounts[8].is_signer and accounts[8].is_writable  # vault
    assert not accounts[9].is_signer and not accounts[9].is_writable  # token_program
    assert accounts[9].pubkey == TOKEN_PROGRAM_ID


@pytest.mark.asyncio
async def test_settle_funds_builds_correct_instruction_accounts() -> None:
    """settle_funds builds instruction with accounts matching IDL order.

    IDL order: market, owner, open_orders, escrow_usdc, escrow_yes,
    owner_usdc, owner_yes, token_program.
    """
    program_id = Pubkey.from_string("5dJoSJfkx23ZkTGxMtnWxD7fabmM6WiezubXHWqKUffi")
    usdc_mint = Pubkey.from_string("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")
    payer = Keypair()

    mock_client = await mock_rpc_client()
    client = ChainOrderClient(mock_client, program_id, payer, usdc_mint)

    await client.settle_funds(
        market="AAPL_20261008_23000",
        owner=str(payer.pubkey()),
    )

    assert mock_client.send_transaction.called
    transaction = mock_client.send_transaction.call_args[0][0]
    instruction = transaction.message.instructions[0]

    # Verify account count and flags (IDL order: market, owner, open_orders,
    # escrow_usdc, escrow_yes, owner_usdc, owner_yes, token_program)
    assert len(instruction.accounts) == 8
    accounts = instruction.accounts
    assert not accounts[0].is_signer and not accounts[0].is_writable  # market
    assert accounts[1].is_signer and not accounts[1].is_writable  # owner
    assert not accounts[2].is_signer and accounts[2].is_writable  # open_orders
    assert not accounts[3].is_signer and accounts[3].is_writable  # escrow_usdc
    assert not accounts[4].is_signer and accounts[4].is_writable  # escrow_yes
    assert not accounts[5].is_signer and accounts[5].is_writable  # owner_usdc
    assert not accounts[6].is_signer and accounts[6].is_writable  # owner_yes
    assert not accounts[7].is_signer and not accounts[7].is_writable  # token_program
    assert accounts[7].pubkey == TOKEN_PROGRAM_ID
