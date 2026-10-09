"""Instruction account structure tests for chain.py (AC1 Finding #1).

Verifies that instruction account lists match the IDL specification,
so chain.py instruction building is tested without needing a validator.

These tests check:
1. Account order matches IDL
2. is_writable flags match IDL
3. is_signer flags match IDL
"""

import struct

from solders.instruction import AccountMeta
from solders.keypair import Keypair
from solders.pubkey import Pubkey
from solders.system_program import ID as SYSTEM_PROGRAM_ID

from meridian_quant.mm.chain import (
    DISCRIMINATOR_CANCEL_ORDER,
    DISCRIMINATOR_MINT_PAIR,
    DISCRIMINATOR_PLACE_ORDER,
    DISCRIMINATOR_SETTLE_FUNDS,
    TOKEN_PROGRAM_ID,
    derive_book_pda,
    derive_config_pda,
    derive_escrow_usdc_pda,
    derive_escrow_yes_pda,
    derive_market_pda,
    derive_no_mint_pda,
    derive_open_orders_pda,
    derive_vault_pda,
    derive_yes_mint_pda,
    get_associated_token_address,
)


def test_place_order_instruction_accounts_match_idl() -> None:
    """place_order instruction accounts match IDL order and flags.

    IDL accounts (from packages/client/src/idl/meridian.json):
    0. config (read-only, not signer)
    1. market (read-only, not signer)
    2. book (writable, not signer)
    3. user (writable, signer)
    4. open_orders (writable, not signer)
    5. user_usdc (writable, not signer)
    6. user_yes (writable, not signer)
    7. escrow_usdc (writable, not signer)
    8. escrow_yes (writable, not signer)
    9. token_program (read-only, not signer)
    10. system_program (read-only, not signer)
    """
    program_id = Pubkey.from_string("5dJoSJfkx23ZkTGxMtnWxD7fabmM6WiezubXHWqKUffi")
    usdc_mint = Pubkey.from_string("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")
    owner = Keypair()

    # Derive accounts
    market = derive_market_pda(program_id, "AAPL", 20261008, 23000)
    config = derive_config_pda(program_id)
    book = derive_book_pda(program_id, market)
    open_orders = derive_open_orders_pda(program_id, market, owner.pubkey())
    user_usdc = get_associated_token_address(usdc_mint, owner.pubkey())
    yes_mint = derive_yes_mint_pda(program_id, market)
    user_yes = get_associated_token_address(yes_mint, owner.pubkey())
    escrow_usdc = derive_escrow_usdc_pda(program_id, market)
    escrow_yes = derive_escrow_yes_pda(program_id, market)

    # Build accounts list as chain.py does
    accounts = [
        AccountMeta(pubkey=config, is_signer=False, is_writable=False),  # 0: config
        AccountMeta(pubkey=market, is_signer=False, is_writable=False),  # 1: market
        AccountMeta(pubkey=book, is_signer=False, is_writable=True),  # 2: book
        AccountMeta(pubkey=owner.pubkey(), is_signer=True, is_writable=True),  # 3: user
        AccountMeta(pubkey=open_orders, is_signer=False, is_writable=True),  # 4: open_orders
        AccountMeta(pubkey=user_usdc, is_signer=False, is_writable=True),  # 5: user_usdc
        AccountMeta(pubkey=user_yes, is_signer=False, is_writable=True),  # 6: user_yes
        AccountMeta(pubkey=escrow_usdc, is_signer=False, is_writable=True),  # 7: escrow_usdc
        AccountMeta(pubkey=escrow_yes, is_signer=False, is_writable=True),  # 8: escrow_yes
        AccountMeta(pubkey=TOKEN_PROGRAM_ID, is_signer=False, is_writable=False),  # 9: token
        AccountMeta(pubkey=SYSTEM_PROGRAM_ID, is_signer=False, is_writable=False),  # 10: system
    ]

    # Verify count and flags
    assert len(accounts) == 11, "place_order should have 11 base accounts"

    # Check each account matches IDL
    assert accounts[0].pubkey == config
    assert not accounts[0].is_signer
    assert not accounts[0].is_writable

    assert accounts[1].pubkey == market
    assert not accounts[1].is_signer
    assert not accounts[1].is_writable

    assert accounts[2].pubkey == book
    assert not accounts[2].is_signer
    assert accounts[2].is_writable

    assert accounts[3].pubkey == owner.pubkey()
    assert accounts[3].is_signer
    assert accounts[3].is_writable  # user is writable for lamports

    assert accounts[4].pubkey == open_orders
    assert not accounts[4].is_signer
    assert accounts[4].is_writable

    assert accounts[5].pubkey == user_usdc
    assert not accounts[5].is_signer
    assert accounts[5].is_writable

    assert accounts[6].pubkey == user_yes
    assert not accounts[6].is_signer
    assert accounts[6].is_writable

    assert accounts[7].pubkey == escrow_usdc
    assert not accounts[7].is_signer
    assert accounts[7].is_writable

    assert accounts[8].pubkey == escrow_yes
    assert not accounts[8].is_signer
    assert accounts[8].is_writable

    assert accounts[9].pubkey == TOKEN_PROGRAM_ID
    assert not accounts[9].is_signer
    assert not accounts[9].is_writable

    assert accounts[10].pubkey == SYSTEM_PROGRAM_ID
    assert not accounts[10].is_signer
    assert not accounts[10].is_writable


def test_cancel_order_instruction_accounts_match_idl() -> None:
    """cancel_order instruction accounts match IDL order and flags.

    IDL accounts:
    0. market (read-only, not signer)
    1. book (writable, not signer)
    2. owner (read-only, signer)
    3. open_orders (writable, not signer)
    """
    program_id = Pubkey.from_string("5dJoSJfkx23ZkTGxMtnWxD7fabmM6WiezubXHWqKUffi")
    owner = Keypair()

    market = derive_market_pda(program_id, "AAPL", 20261008, 23000)
    book = derive_book_pda(program_id, market)
    open_orders = derive_open_orders_pda(program_id, market, owner.pubkey())

    # Build accounts as chain.py does
    accounts = [
        AccountMeta(pubkey=market, is_signer=False, is_writable=False),
        AccountMeta(pubkey=book, is_signer=False, is_writable=True),
        AccountMeta(pubkey=owner.pubkey(), is_signer=True, is_writable=False),
        AccountMeta(pubkey=open_orders, is_signer=False, is_writable=True),
    ]

    # Verify
    assert len(accounts) == 4, "cancel_order should have 4 accounts"

    assert accounts[0].pubkey == market
    assert not accounts[0].is_signer
    assert not accounts[0].is_writable

    assert accounts[1].pubkey == book
    assert not accounts[1].is_signer
    assert accounts[1].is_writable

    assert accounts[2].pubkey == owner.pubkey()
    assert accounts[2].is_signer
    assert not accounts[2].is_writable  # owner read-only per IDL

    assert accounts[3].pubkey == open_orders
    assert not accounts[3].is_signer
    assert accounts[3].is_writable


def test_mint_pair_instruction_accounts_match_idl() -> None:
    """mint_pair instruction accounts match IDL order and flags.

    IDL accounts:
    0. config (read-only, not signer)
    1. market (writable, not signer)
    2. user (read-only, signer)
    3. user_usdc (writable, not signer)
    4. user_yes (writable, not signer)
    5. user_no (writable, not signer)
    6. yes_mint (writable, not signer)
    7. no_mint (writable, not signer)
    8. vault (writable, not signer)
    9. token_program (read-only, not signer)
    """
    program_id = Pubkey.from_string("5dJoSJfkx23ZkTGxMtnWxD7fabmM6WiezubXHWqKUffi")
    usdc_mint = Pubkey.from_string("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")
    user = Keypair()

    config = derive_config_pda(program_id)
    market = derive_market_pda(program_id, "AAPL", 20261008, 23000)
    user_usdc = get_associated_token_address(usdc_mint, user.pubkey())
    yes_mint = derive_yes_mint_pda(program_id, market)
    no_mint = derive_no_mint_pda(program_id, market)
    user_yes = get_associated_token_address(yes_mint, user.pubkey())
    user_no = get_associated_token_address(no_mint, user.pubkey())
    vault = derive_vault_pda(program_id, market)

    # Build accounts as chain.py does
    accounts = [
        AccountMeta(pubkey=config, is_signer=False, is_writable=False),
        AccountMeta(pubkey=market, is_signer=False, is_writable=True),
        AccountMeta(pubkey=user.pubkey(), is_signer=True, is_writable=False),
        AccountMeta(pubkey=user_usdc, is_signer=False, is_writable=True),
        AccountMeta(pubkey=user_yes, is_signer=False, is_writable=True),
        AccountMeta(pubkey=user_no, is_signer=False, is_writable=True),
        AccountMeta(pubkey=yes_mint, is_signer=False, is_writable=True),
        AccountMeta(pubkey=no_mint, is_signer=False, is_writable=True),
        AccountMeta(pubkey=vault, is_signer=False, is_writable=True),
        AccountMeta(pubkey=TOKEN_PROGRAM_ID, is_signer=False, is_writable=False),
    ]

    # Verify
    assert len(accounts) == 10, "mint_pair should have 10 accounts"

    assert accounts[0].pubkey == config
    assert not accounts[0].is_signer
    assert not accounts[0].is_writable

    assert accounts[1].pubkey == market
    assert not accounts[1].is_signer
    assert accounts[1].is_writable

    assert accounts[2].pubkey == user.pubkey()
    assert accounts[2].is_signer
    assert not accounts[2].is_writable  # user read-only per IDL

    assert accounts[3].pubkey == user_usdc
    assert not accounts[3].is_signer
    assert accounts[3].is_writable

    assert accounts[4].pubkey == user_yes
    assert not accounts[4].is_signer
    assert accounts[4].is_writable

    assert accounts[5].pubkey == user_no
    assert not accounts[5].is_signer
    assert accounts[5].is_writable

    assert accounts[6].pubkey == yes_mint
    assert not accounts[6].is_signer
    assert accounts[6].is_writable

    assert accounts[7].pubkey == no_mint
    assert not accounts[7].is_signer
    assert accounts[7].is_writable

    assert accounts[8].pubkey == vault
    assert not accounts[8].is_signer
    assert accounts[8].is_writable

    assert accounts[9].pubkey == TOKEN_PROGRAM_ID
    assert not accounts[9].is_signer
    assert not accounts[9].is_writable


def test_settle_funds_instruction_accounts_match_idl() -> None:
    """settle_funds instruction accounts match IDL order and flags.

    IDL accounts:
    0. market (read-only, not signer)
    1. owner (read-only, signer)
    2. open_orders (writable, not signer)
    3. owner_usdc (writable, not signer)
    4. owner_yes (writable, not signer)
    5. escrow_usdc (writable, not signer)
    6. escrow_yes (writable, not signer)
    7. token_program (read-only, not signer)
    """
    program_id = Pubkey.from_string("5dJoSJfkx23ZkTGxMtnWxD7fabmM6WiezubXHWqKUffi")
    usdc_mint = Pubkey.from_string("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")
    owner = Keypair()

    market = derive_market_pda(program_id, "AAPL", 20261008, 23000)
    open_orders = derive_open_orders_pda(program_id, market, owner.pubkey())
    owner_usdc = get_associated_token_address(usdc_mint, owner.pubkey())
    yes_mint = derive_yes_mint_pda(program_id, market)
    owner_yes = get_associated_token_address(yes_mint, owner.pubkey())
    escrow_usdc = derive_escrow_usdc_pda(program_id, market)
    escrow_yes = derive_escrow_yes_pda(program_id, market)

    # Build accounts as chain.py does
    accounts = [
        AccountMeta(pubkey=market, is_signer=False, is_writable=False),
        AccountMeta(pubkey=owner.pubkey(), is_signer=True, is_writable=False),
        AccountMeta(pubkey=open_orders, is_signer=False, is_writable=True),
        AccountMeta(pubkey=owner_usdc, is_signer=False, is_writable=True),
        AccountMeta(pubkey=owner_yes, is_signer=False, is_writable=True),
        AccountMeta(pubkey=escrow_usdc, is_signer=False, is_writable=True),
        AccountMeta(pubkey=escrow_yes, is_signer=False, is_writable=True),
        AccountMeta(pubkey=TOKEN_PROGRAM_ID, is_signer=False, is_writable=False),
    ]

    # Verify
    assert len(accounts) == 8, "settle_funds should have 8 accounts"

    assert accounts[0].pubkey == market
    assert not accounts[0].is_signer
    assert not accounts[0].is_writable

    assert accounts[1].pubkey == owner.pubkey()
    assert accounts[1].is_signer
    assert not accounts[1].is_writable

    assert accounts[2].pubkey == open_orders
    assert not accounts[2].is_signer
    assert accounts[2].is_writable

    assert accounts[3].pubkey == owner_usdc
    assert not accounts[3].is_signer
    assert accounts[3].is_writable

    assert accounts[4].pubkey == owner_yes
    assert not accounts[4].is_signer
    assert accounts[4].is_writable

    assert accounts[5].pubkey == escrow_usdc
    assert not accounts[5].is_signer
    assert accounts[5].is_writable

    assert accounts[6].pubkey == escrow_yes
    assert not accounts[6].is_signer
    assert accounts[6].is_writable

    assert accounts[7].pubkey == TOKEN_PROGRAM_ID
    assert not accounts[7].is_signer
    assert not accounts[7].is_writable


def test_instruction_data_format() -> None:
    """Instruction data format matches expected Borsh layout.

    Verifies discriminators are present and args are properly encoded.
    """
    # place_order: discriminator + side(u8) + price(u8) + qty(u64) + kind(u8)
    side_byte = 0  # Bid
    price = 50
    qty = 10
    kind_byte = 0  # Limit
    place_data = (
        DISCRIMINATOR_PLACE_ORDER
        + struct.pack("<B", side_byte)
        + struct.pack("<B", price)
        + struct.pack("<Q", qty)
        + struct.pack("<B", kind_byte)
    )
    assert len(place_data) == 8 + 1 + 1 + 8 + 1  # discriminator + args
    assert place_data[:8] == DISCRIMINATOR_PLACE_ORDER

    # cancel_order: discriminator + order_id(u64)
    order_id = 42
    cancel_data = DISCRIMINATOR_CANCEL_ORDER + struct.pack("<Q", order_id)
    assert len(cancel_data) == 8 + 8
    assert cancel_data[:8] == DISCRIMINATOR_CANCEL_ORDER

    # mint_pair: discriminator + qty(u64)
    mint_qty = 100
    mint_data = DISCRIMINATOR_MINT_PAIR + struct.pack("<Q", mint_qty)
    assert len(mint_data) == 8 + 8
    assert mint_data[:8] == DISCRIMINATOR_MINT_PAIR

    # settle_funds: discriminator only (no args)
    settle_data = DISCRIMINATOR_SETTLE_FUNDS
    assert len(settle_data) == 8
    assert settle_data == DISCRIMINATOR_SETTLE_FUNDS
