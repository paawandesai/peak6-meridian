"""Known-answer tests for chain.py (Finding #1).

Verifies PDA derivations are deterministic and discriminators match IDL,
so chain.py is not untested when the validator test is skipped in CI.
"""

from solders.pubkey import Pubkey

from meridian_quant.mm.chain import (
    DISCRIMINATOR_CANCEL_ORDER,
    DISCRIMINATOR_MINT_PAIR,
    DISCRIMINATOR_PLACE_ORDER,
    DISCRIMINATOR_SETTLE_FUNDS,
    derive_book_pda,
    derive_config_pda,
    derive_market_pda,
    derive_no_mint_pda,
    derive_open_orders_pda,
    derive_yes_mint_pda,
    get_associated_token_address,
)


def test_config_pda_deterministic() -> None:
    """Config PDA derivation is deterministic: same program_id → same PDA."""
    program_id = Pubkey.from_string("5dJoSJfkx23ZkTGxMtnWxD7fabmM6WiezubXHWqKUffi")
    config1 = derive_config_pda(program_id)
    config2 = derive_config_pda(program_id)
    assert config1 == config2, "Config PDA must be deterministic"


def test_market_pda_deterministic() -> None:
    """Market PDA derivation is deterministic and uses ticker/date/strike seeds."""
    program_id = Pubkey.from_string("5dJoSJfkx23ZkTGxMtnWxD7fabmM6WiezubXHWqKUffi")

    # Same inputs → same PDA
    market1 = derive_market_pda(program_id, "AAPL", 20261008, 23000)
    market2 = derive_market_pda(program_id, "AAPL", 20261008, 23000)
    assert market1 == market2, "Market PDA must be deterministic"

    # Different ticker → different PDA
    market_msft = derive_market_pda(program_id, "MSFT", 20261008, 23000)
    assert market1 != market_msft, "Different ticker should yield different PDA"

    # Different date → different PDA
    market_diff_date = derive_market_pda(program_id, "AAPL", 20261009, 23000)
    assert market1 != market_diff_date, "Different date should yield different PDA"

    # Different strike → different PDA
    market_diff_strike = derive_market_pda(program_id, "AAPL", 20261008, 24000)
    assert market1 != market_diff_strike, "Different strike should yield different PDA"


def test_book_pda_deterministic() -> None:
    """Book PDA derivation is deterministic and uses market seed."""
    program_id = Pubkey.from_string("5dJoSJfkx23ZkTGxMtnWxD7fabmM6WiezubXHWqKUffi")
    market = derive_market_pda(program_id, "AAPL", 20261008, 23000)

    book1 = derive_book_pda(program_id, market)
    book2 = derive_book_pda(program_id, market)
    assert book1 == book2, "Book PDA must be deterministic"


def test_open_orders_pda_deterministic() -> None:
    """OpenOrders PDA derivation is deterministic and uses market/owner seeds."""
    program_id = Pubkey.from_string("5dJoSJfkx23ZkTGxMtnWxD7fabmM6WiezubXHWqKUffi")
    market = derive_market_pda(program_id, "AAPL", 20261008, 23000)
    owner = Pubkey.from_string("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU")

    oo1 = derive_open_orders_pda(program_id, market, owner)
    oo2 = derive_open_orders_pda(program_id, market, owner)
    assert oo1 == oo2, "OpenOrders PDA must be deterministic"

    # Different owner → different PDA
    other_owner = Pubkey.from_string("9YzC7wfVrJv3oPWKT7Yyod7nFN3c5SQfXx3zx8E8fKG3")
    oo_other = derive_open_orders_pda(program_id, market, other_owner)
    assert oo1 != oo_other, "Different owner should yield different OpenOrders PDA"


def test_yes_no_mint_pdas_different() -> None:
    """YES and NO mint PDAs are different for same market."""
    program_id = Pubkey.from_string("5dJoSJfkx23ZkTGxMtnWxD7fabmM6WiezubXHWqKUffi")
    market = derive_market_pda(program_id, "AAPL", 20261008, 23000)

    yes_mint = derive_yes_mint_pda(program_id, market)
    no_mint = derive_no_mint_pda(program_id, market)

    assert yes_mint != no_mint, "YES and NO mints must be different"
    assert yes_mint == derive_yes_mint_pda(program_id, market), "YES mint deterministic"
    assert no_mint == derive_no_mint_pda(program_id, market), "NO mint deterministic"


def test_discriminators_match_idl() -> None:
    """Instruction discriminators match target/idl/meridian.json."""
    # These are the first 8 bytes of sha256("global:<instruction_name>")
    # Verified against target/idl/meridian.json discriminator fields

    assert bytes([51, 194, 155, 175, 109, 130, 96, 106]) == DISCRIMINATOR_PLACE_ORDER
    assert bytes([95, 129, 237, 240, 8, 49, 223, 132]) == DISCRIMINATOR_CANCEL_ORDER
    assert bytes([19, 149, 94, 110, 181, 186, 33, 107]) == DISCRIMINATOR_MINT_PAIR
    assert bytes([238, 64, 163, 96, 75, 171, 16, 33]) == DISCRIMINATOR_SETTLE_FUNDS


def test_ata_derivation_deterministic() -> None:
    """Associated Token Account derivation is deterministic."""
    mint = Pubkey.from_string("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")
    owner = Pubkey.from_string("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU")

    ata1 = get_associated_token_address(mint, owner)
    ata2 = get_associated_token_address(mint, owner)

    assert ata1 == ata2, "ATA derivation must be deterministic"

    # Different owner → different ATA
    other_owner = Pubkey.from_string("9YzC7wfVrJv3oPWKT7Yyod7nFN3c5SQfXx3zx8E8fKG3")
    ata_other = get_associated_token_address(mint, other_owner)
    assert ata1 != ata_other, "Different owner should yield different ATA"
