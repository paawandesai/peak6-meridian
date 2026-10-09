//! PDA fixtures shared with `packages/client` (M1-02 AC4): the addresses below are asserted
//! by `packages/client/src/pda.test.ts` for the same inputs, proving both sides use the seeds
//! in architecture.md § Data model.

use anchor_lang::prelude::Pubkey;
use meridian::state::{
    BOOK_SEED, CONFIG_SEED, ESCROW_USDC_SEED, ESCROW_YES_SEED, MARKET_SEED, NO_MINT_SEED,
    OPEN_ORDERS_SEED, VAULT_SEED, YES_MINT_SEED,
};

const FIXTURE_SYMBOL: &[u8; 8] = b"META\0\0\0\0";
const FIXTURE_TRADING_DATE: u32 = 20_261_006;
const FIXTURE_STRIKE_CENTS: u64 = 68_000;
/// `11111111111111111111111111111112`: a fixed owner for the OpenOrders fixture.
const FIXTURE_OWNER: Pubkey = Pubkey::new_from_array({
    let mut bytes = [0u8; 32];
    bytes[31] = 1;
    bytes
});

fn pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &meridian::ID).0
}

#[test]
fn pda_fixtures_match_the_client() {
    let config = pda(&[CONFIG_SEED]);
    let market = pda(&[
        MARKET_SEED,
        FIXTURE_SYMBOL,
        &FIXTURE_TRADING_DATE.to_le_bytes(),
        &FIXTURE_STRIKE_CENTS.to_le_bytes(),
    ]);
    let market_key = market.to_bytes();
    let fixtures = [
        ("config", config),
        ("market", market),
        ("yes_mint", pda(&[YES_MINT_SEED, &market_key])),
        ("no_mint", pda(&[NO_MINT_SEED, &market_key])),
        ("vault", pda(&[VAULT_SEED, &market_key])),
        ("escrow_usdc", pda(&[ESCROW_USDC_SEED, &market_key])),
        ("escrow_yes", pda(&[ESCROW_YES_SEED, &market_key])),
        ("book", pda(&[BOOK_SEED, &market_key])),
        (
            "open_orders",
            pda(&[OPEN_ORDERS_SEED, &market_key, &FIXTURE_OWNER.to_bytes()]),
        ),
    ];
    let rendered: Vec<String> = fixtures
        .iter()
        .map(|(name, address)| format!("{name}={address}"))
        .collect();
    assert_eq!(rendered, EXPECTED_FIXTURES);
}

/// Expected `name=address` pairs, duplicated verbatim in the TS test.
const EXPECTED_FIXTURES: [&str; 9] = [
    "config=6Bf88kHFDDjdXG1BEdrj1edkLwWt9pEiKPFp6Ekhkoew",
    "market=G9bLfxQk3Pvk9Zu2b8HB4zs7YQ6NS3R6Q1VG7TTi95Gr",
    "yes_mint=C8MsZU2Wrm2FS4vGA1u484ZPFKyLcrLPCakaYEAEKNer",
    "no_mint=EcuD66AVujTCoemZ15DeC5EpcoHLEvcPPHrt121Kg69c",
    "vault=3v343hc9DQxd9ssbfqWoWXjyQMJoUoHC2J2e8WcraJPT",
    "escrow_usdc=6bRyY9qeL4ZTjR1ozRoDJdtG7exZWwdjw4qCJSa7D6ic",
    "escrow_yes=5YKtYZjoybHXRM4motot1tM7TrezTDQiMG4H1w9kkh8P",
    "book=8ivHiPDVum1zBLFHite5d9iTwgdxMnQy8JHqSYduVTr9",
    "open_orders=AkFEKoUmk3CxwGcx33wTquqj5L5gBovamkFgnAYvGxN1",
];
