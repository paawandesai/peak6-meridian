"""Instruction account structure tests for chain.py (AC1).

Verifies that ChainOrderClient builds instructions matching the IDL by
intercepting Instruction creation and verifying AccountMeta flags before
Message compilation. Regressions in chain.py account order/flags would fail.
"""

from unittest.mock import AsyncMock, MagicMock

import pytest
from solders.hash import Hash
from solders.instruction import Instruction
from solders.keypair import Keypair
from solders.message import Message
from solders.pubkey import Pubkey
from solders.signature import Signature

from meridian_quant.mm.chain import (
    TOKEN_PROGRAM_ID,
    ChainOrderClient,
    derive_market_pda,
    derive_open_orders_pda,
)
from meridian_quant.mm.types import RestingOrder

# Test market: AAPL 2026-10-08 strike $230.00
# Derived from program 5dJoSJfkx23ZkTGxMtnWxD7fabmM6WiezubXHWqKUffi
# PDA seeds: b"market" + b"AAPL" + 20261008.to_bytes(4, 'little') + 23000.to_bytes(8, 'little')
TEST_MARKET_PUBKEY = "DyAQwhVQNpAhWMUhd83YShjS244PoU2QotChDStexM7Z"


class InstructionCapture:
    """Captures instructions passed to Message.new_with_blockhash.

    PyO3 Instruction uses __new__ not __init__, so patching __init__ doesn't work.
    Instead, intercept Message.new_with_blockhash and capture the instruction list.
    """

    def __init__(self) -> None:
        self.instructions: list[Instruction] = []
        self.original_new_with_blockhash = Message.new_with_blockhash

    def __enter__(self) -> "InstructionCapture":
        """Patch Message.new_with_blockhash to capture instructions."""

        def capturing_new(instructions: object, payer: object, blockhash: object) -> Message:
            # Capture the instructions before Message compilation
            if isinstance(instructions, list):
                self.instructions.extend(instructions)
            return self.original_new_with_blockhash(instructions, payer, blockhash)  # type: ignore[arg-type]

        Message.new_with_blockhash = capturing_new  # type: ignore[method-assign]
        return self

    def __exit__(self, *args: object) -> None:
        """Restore original Message.new_with_blockhash."""
        Message.new_with_blockhash = self.original_new_with_blockhash  # type: ignore[method-assign]


async def mock_rpc_client() -> AsyncMock:
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

    Intercepts Instruction creation to verify AccountMeta before Message compilation.
    IDL order: config, market, book, user, open_orders, user_usdc, user_yes,
    escrow_usdc, escrow_yes, token_program, system_program + remaining_accounts.
    """
    program_id = Pubkey.from_string("5dJoSJfkx23ZkTGxMtnWxD7fabmM6WiezubXHWqKUffi")
    usdc_mint = Pubkey.from_string("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")
    payer = Keypair()

    mock_client = await mock_rpc_client()

    # Mock fetch_resting_orders to return empty (no contra orders)
    async def mock_fetch_orders(market: str) -> list[object]:
        return []

    client = ChainOrderClient(mock_client, program_id, payer, usdc_mint)
    client.fetch_resting_orders = mock_fetch_orders  # type: ignore[assignment]

    # Capture instructions created during place_order
    with InstructionCapture() as capture:
        await client.place_order(
            market=TEST_MARKET_PUBKEY,
            side="Bid",
            price=50,
            qty=10,
            owner=str(payer.pubkey()),
        )

    # Verify we captured exactly one instruction (place_order)
    assert len(capture.instructions) == 1
    instruction = capture.instructions[0]

    # Verify account count (11 base accounts, no remaining_accounts since no contra orders)
    assert len(instruction.accounts) == 11

    # Verify AccountMeta flags for each account position (IDL order)
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
async def test_place_order_includes_same_side_owners_in_remaining_accounts() -> None:
    """place_order includes OpenOrders for same-side owners (displaced refunds).

    When the book is full (32 orders), placing a better order displaces the worst
    order and refunds it. The program needs that displaced owner's OpenOrders in
    remaining_accounts to credit them (place_order.rs credit_other).

    Stubs a same-side resting order and asserts that owner's PDA is in remaining_accounts.
    """
    program_id = Pubkey.from_string("5dJoSJfkx23ZkTGxMtnWxD7fabmM6WiezubXHWqKUffi")
    usdc_mint = Pubkey.from_string("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")
    payer = Keypair()

    # Create distinct owners for resting orders
    same_side_owner = Keypair()
    contra_side_owner = Keypair()

    mock_client = await mock_rpc_client()

    # Mock fetch_resting_orders to return both same-side and contra-side orders
    async def mock_fetch_orders(market: str) -> list[object]:
        return [
            RestingOrder(
                order_id=1,
                market=market,
                side="Bid",  # Same side as our new order
                price=48,
                qty=10,
                owner=str(same_side_owner.pubkey()),
            ),
            RestingOrder(
                order_id=2,
                market=market,
                side="Ask",  # Contra side
                price=52,
                qty=10,
                owner=str(contra_side_owner.pubkey()),
            ),
        ]

    client = ChainOrderClient(mock_client, program_id, payer, usdc_mint)
    client.fetch_resting_orders = mock_fetch_orders  # type: ignore[assignment]

    # Capture instruction
    with InstructionCapture() as capture:
        await client.place_order(
            market=TEST_MARKET_PUBKEY,
            side="Bid",  # Same side as the first resting order
            price=50,
            qty=10,
            owner=str(payer.pubkey()),
        )

    instruction = capture.instructions[0]

    # Base accounts (11) + remaining_accounts for both unique owners (2)
    # Payer is already in named accounts, so only same_side_owner and contra_side_owner
    assert len(instruction.accounts) == 11 + 2

    # Verify remaining_accounts contains both owners' OpenOrders PDAs
    remaining = instruction.accounts[11:]  # After the 11 base accounts

    market_pda = Pubkey.from_string(TEST_MARKET_PUBKEY)

    expected_same_side_oo = derive_open_orders_pda(program_id, market_pda, same_side_owner.pubkey())
    expected_contra_side_oo = derive_open_orders_pda(
        program_id, market_pda, contra_side_owner.pubkey()
    )

    remaining_pubkeys = {acc.pubkey for acc in remaining}
    assert expected_same_side_oo in remaining_pubkeys, (
        "Same-side owner OpenOrders missing from remaining_accounts (needed for displaced refund)"
    )
    assert expected_contra_side_oo in remaining_pubkeys, (
        "Contra-side owner OpenOrders missing from remaining_accounts"
    )

    # Verify all remaining_accounts are writable (program may credit them)
    for acc in remaining:
        assert acc.is_writable, f"OpenOrders {acc.pubkey} must be writable in remaining_accounts"


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

    # Capture instruction creation
    with InstructionCapture() as capture:
        await client.cancel_order(
            market=TEST_MARKET_PUBKEY,
            order_id=42,
            owner=str(payer.pubkey()),
        )

    assert len(capture.instructions) == 1
    instruction = capture.instructions[0]

    # Verify account count and AccountMeta flags
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

    # Capture all instructions (might include ATA creation + mint_pair)
    with InstructionCapture() as capture:
        await client.mint_pair(
            market=TEST_MARKET_PUBKEY,
            qty=100,
            owner=str(payer.pubkey()),
        )

    # Find the mint_pair instruction (10 accounts, after any ATA creation)
    mint_instruction = [ix for ix in capture.instructions if len(ix.accounts) == 10][0]

    # Verify account count and AccountMeta flags
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

    # Capture instruction creation
    with InstructionCapture() as capture:
        await client.settle_funds(
            market=TEST_MARKET_PUBKEY,
            owner=str(payer.pubkey()),
        )

    assert len(capture.instructions) == 1
    instruction = capture.instructions[0]

    # Verify account count and AccountMeta flags
    # IDL order: market, owner, open_orders, escrow_usdc, escrow_yes,
    # owner_usdc, owner_yes, token_program
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


def test_known_pda_meta_market() -> None:
    """Verify derive_market_pda matches published fixture from pda.test.ts.

    Fixture: META/20261006/68000 with program 3Rovid...HDZq
    Expected: BGd5Y6qA5uT2zzgUzsZ3Mmw8m3Y8vJJLRWEybtDuU8im
    """
    # Program ID from packages/client/src/idl/meridian.json
    program_id = Pubkey.from_string("3RovidBTwYzUfhniunxsUgnLzsbWz6qt3PGpvD23HDZq")

    # Fixture from packages/client/src/pda.test.ts
    market_pda = derive_market_pda(program_id, "META", 20261006, 68000)

    # Expected address from pda.test.ts EXPECTED.market
    expected = Pubkey.from_string("BGd5Y6qA5uT2zzgUzsZ3Mmw8m3Y8vJJLRWEybtDuU8im")

    assert market_pda == expected, f"Expected {expected}, got {market_pda}"
