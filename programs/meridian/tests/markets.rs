//! M1-04: `create_strike_market`, `add_strike`, `mint_pair`, `redeem` (pair mode), `pause` and
//! `unpause` against the built program in LiteSVM: success and failure paths (D-031), the
//! vault and supply invariants after every instruction (AC1, AC2; NFR-07) and the events.
//! Abuse cases AB-01, AB-06, AB-11 and AB-12 live in `tests/security/program`.

// Test code: the program rules on unwrap/panic/arithmetic do not apply here.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::arithmetic_side_effects
)]

mod common;

use std::cell::RefCell;

use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::program_option::COption;
use anchor_spl::token::spl_token::error::TokenError;
use common::{
    assert_meridian_error, assert_token_error, config_pda, expect_failure, expect_success,
    find_event, symbol, MarketAddresses, MarketArgs, MarketHarness, User, BASE_CLOSE_TS,
    BASE_TRADING_DATE, BASE_UNIX_TS, FUNDING_LAMPORTS,
};
use meridian::errors::MeridianError;
use meridian::events::{MarketCreated, PairsMinted, Paused, Redeemed, Unpaused};
use meridian::state::{
    Market, MarketStatus, Outcome, SettleSource, MARKET_SEED, PAIR_COLLATERAL, STRIKE_STEP_CENTS,
};
use proptest::prelude::*;
use solana_sdk::signature::Signer;

/// One USDC in base units.
const USDC: u64 = PAIR_COLLATERAL;

/// Asserts every account of a freshly created market and the stored fields.
fn assert_market_created(h: &MarketHarness, addresses: &MarketAddresses, args: &MarketArgs) {
    let harness = &h.harness;
    let market = harness.market(addresses.market);
    let (expected_pda, bump) = Pubkey::find_program_address(
        &[
            MARKET_SEED,
            &args.ticker,
            &args.trading_date.to_le_bytes(),
            &args.strike_cents.to_le_bytes(),
        ],
        &meridian::ID,
    );
    assert_eq!(addresses.market, expected_pda);
    assert_eq!(
        format!("{market:?}"),
        format!(
            "{:?}",
            Market {
                ticker: args.ticker,
                strike_cents: args.strike_cents,
                trading_date: args.trading_date,
                close_ts: args.close_ts,
                yes_mint: addresses.yes_mint,
                no_mint: addresses.no_mint,
                vault: addresses.vault,
                escrow_usdc: addresses.escrow_usdc,
                escrow_yes: addresses.escrow_yes,
                book: addresses.book,
                pairs_outstanding: 0,
                status: MarketStatus::Open,
                outcome: Outcome::None,
                settle_price_scaled: 0,
                settle_slot: 0,
                settled_at: 0,
                settle_source: SettleSource::None,
                bump,
            }
        )
    );

    for mint in [addresses.yes_mint, addresses.no_mint] {
        let mint = harness.mint(mint);
        assert_eq!(mint.decimals, 0, "YES/NO mints have 0 decimals");
        assert_eq!(mint.supply, 0);
        assert_eq!(mint.mint_authority, COption::Some(addresses.market));
        assert_eq!(mint.freeze_authority, COption::None);
    }
    for (account, mint) in [
        (addresses.vault, harness.usdc_mint),
        (addresses.escrow_usdc, harness.usdc_mint),
        (addresses.escrow_yes, addresses.yes_mint),
    ] {
        let token_account = harness.token_account(account);
        assert_eq!(token_account.mint, mint);
        assert_eq!(
            token_account.owner, addresses.market,
            "authority = market PDA"
        );
        assert_eq!(token_account.amount, 0);
    }
    let book = harness.book(addresses.book);
    assert_eq!(book.market, addresses.market);
    assert_eq!(book.next_seq, 1);
    assert!(book.bids.iter().chain(book.asks.iter()).all(|o| o.qty == 0));
    harness.assert_market_invariants(addresses);
}

/// Asserts no account of the market exists.
fn assert_market_absent(h: &MarketHarness, addresses: &MarketAddresses) {
    for address in [
        addresses.market,
        addresses.yes_mint,
        addresses.no_mint,
        addresses.vault,
        addresses.escrow_usdc,
        addresses.escrow_yes,
        addresses.book,
    ] {
        assert!(h.harness.is_absent(address), "{address} must not exist");
    }
}

// ---- create_strike_market -----------------------------------------------------------------

#[test]
fn create_strike_market_creates_every_account_and_emits_market_created() {
    let mut h = MarketHarness::new();
    let args = MarketArgs::base();
    let (addresses, result) = h.harness.create_strike_market_as(&h.automation, &args);
    let meta = expect_success(&result);
    assert_market_created(&h, &addresses, &args);

    let event: MarketCreated = find_event(meta).expect("MarketCreated emitted");
    assert_eq!(event.market, addresses.market);
    assert_eq!(event.ticker, args.ticker);
    assert_eq!(event.strike_cents, args.strike_cents);
    assert_eq!(event.trading_date, args.trading_date);
    assert_eq!(event.close_ts, args.close_ts);
    assert_eq!(event.yes_mint, addresses.yes_mint);
    assert_eq!(event.no_mint, addresses.no_mint);
}

#[test]
fn create_strike_market_accepts_every_configured_ticker_and_the_strike_ladder() {
    let mut h = MarketHarness::new();
    // META P = 680 → 620 … 740 (domain.md § Strike algorithm) on the base date, plus the
    // seventh ticker (TSLA, written by update_config) and an early-close day.
    for strike in [62_000, 64_000, 66_000, 68_000, 70_000, 72_000, 74_000] {
        let args = MarketArgs::base().with_strike(strike);
        let addresses = h.create_market(&args);
        assert_market_created(&h, &addresses, &args);
    }
    let tsla = MarketArgs {
        ticker: symbol("TSLA"),
        strike_cents: 25_000,
        trading_date: 20_261_127,
        close_ts: BASE_CLOSE_TS + 52 * 86_400 - 3 * 3_600,
    };
    let addresses = h.create_market(&tsla);
    assert_market_created(&h, &addresses, &tsla);
}

#[test]
fn create_strike_market_rejects_a_duplicate_market() {
    let mut h = MarketHarness::new();
    let args = MarketArgs::base();
    let addresses = h.create_market(&args);
    let user = h.harness.user_for(&addresses, 3 * USDC);
    expect_success(&h.harness.mint_pair(&user, &addresses, 3));

    let (again, result) = h.harness.create_strike_market_as(&h.automation, &args);
    assert_eq!(again, addresses, "same inputs, same PDA");
    expect_failure(&result);
    // Nothing was reset.
    let market = h.harness.market(addresses.market);
    assert_eq!(market.pairs_outstanding, 3);
    h.harness.assert_market_invariants(&addresses);
}

#[test]
fn create_strike_market_rejects_an_unknown_ticker() {
    let mut h = MarketHarness::new();
    for text in ["NFLX", "meta", "META1", ""] {
        let args = MarketArgs {
            ticker: symbol(text),
            ..MarketArgs::base()
        };
        let (addresses, result) = h.harness.create_strike_market_as(&h.automation, &args);
        assert_meridian_error(&result, MeridianError::UnknownTicker);
        assert_market_absent(&h, &addresses);
    }
}

#[test]
fn create_strike_market_rejects_a_close_time_not_in_the_future() {
    let mut h = MarketHarness::new();
    assert_eq!(h.harness.clock().unix_timestamp, BASE_UNIX_TS);
    for close_ts in [BASE_UNIX_TS - 1, BASE_UNIX_TS, 0, i64::MIN] {
        let args = MarketArgs {
            close_ts,
            ..MarketArgs::base()
        };
        let (addresses, result) = h.harness.create_strike_market_as(&h.automation, &args);
        assert_meridian_error(&result, MeridianError::CloseInThePast);
        assert_market_absent(&h, &addresses);
    }
    // One second in the future is enough.
    let args = MarketArgs {
        close_ts: BASE_UNIX_TS + 1,
        ..MarketArgs::base()
    };
    let addresses = h.create_market(&args);
    assert_market_created(&h, &addresses, &args);
}

#[test]
fn create_strike_market_rejects_a_bad_strike() {
    let mut h = MarketHarness::new();
    for strike_cents in [0, 1, 999, 1_001, 68_050, STRIKE_STEP_CENTS + 1, u64::MAX] {
        let args = MarketArgs::base().with_strike(strike_cents);
        let (addresses, result) = h.harness.create_strike_market_as(&h.automation, &args);
        assert_meridian_error(&result, MeridianError::InvalidStrike);
        assert_market_absent(&h, &addresses);
    }
    let args = MarketArgs::base().with_strike(STRIKE_STEP_CENTS);
    let addresses = h.create_market(&args);
    assert_market_created(&h, &addresses, &args);
}

#[test]
fn create_strike_market_rejects_a_malformed_trading_date() {
    let mut h = MarketHarness::new();
    for trading_date in [
        0,
        2_026_106,
        20_261_000,
        20_261_032,
        20_261_301,
        20_260_229,
        19_991_231,
        u32::MAX,
    ] {
        let args = MarketArgs {
            trading_date,
            ..MarketArgs::base()
        };
        let (addresses, result) = h.harness.create_strike_market_as(&h.automation, &args);
        assert_meridian_error(&result, MeridianError::InvalidTradingDate);
        assert_market_absent(&h, &addresses);
    }
    // Leap day 2028-02-29 and the last day of the year are valid dates.
    for trading_date in [20_280_229, 20_261_231] {
        let args = MarketArgs {
            trading_date,
            ..MarketArgs::base()
        };
        let addresses = h.create_market(&args);
        assert_market_created(&h, &addresses, &args);
    }
}

#[test]
fn create_strike_market_rejects_a_mint_other_than_the_config_usdc_mint() {
    let mut h = MarketHarness::new();
    let args = MarketArgs::base();
    let addresses = MarketAddresses::derive(&args);
    let other_mint = h.harness.create_mint(6);
    let ix = common::Harness::create_strike_market_ix(
        h.automation.pubkey(),
        config_pda(),
        other_mint,
        &addresses,
        &args,
    );
    let result = h.harness.send(ix, &[&h.automation]);
    assert_meridian_error(&result, MeridianError::InvalidUsdcMint);
    assert_market_absent(&h, &addresses);
}

// ---- add_strike -----------------------------------------------------------------------------

#[test]
fn add_strike_creates_the_market_as_the_admin() {
    let mut h = MarketHarness::new();
    let args = MarketArgs::base().with_strike(75_000);
    let admin = h.harness.admin.insecure_clone();
    let (addresses, result) = h.harness.add_strike_as(&admin, &args);
    let meta = expect_success(&result);
    assert_market_created(&h, &addresses, &args);
    let event: MarketCreated = find_event(meta).expect("MarketCreated emitted");
    assert_eq!(event.market, addresses.market);
    assert_eq!(event.strike_cents, 75_000);

    // The added strike is a normal market: it mints and redeems.
    let user = h.harness.user_for(&addresses, 2 * USDC);
    expect_success(&h.harness.mint_pair(&user, &addresses, 2));
    expect_success(&h.harness.redeem(&user, &addresses, 2, 2));
    h.harness.assert_market_invariants(&addresses);
}

#[test]
fn add_strike_applies_the_same_validation_as_create_strike_market() {
    let mut h = MarketHarness::new();
    let admin = h.harness.admin.insecure_clone();
    let base = MarketArgs::base();
    let cases = [
        (
            MarketArgs {
                ticker: symbol("NFLX"),
                ..base
            },
            MeridianError::UnknownTicker,
        ),
        (base.with_strike(68_500), MeridianError::InvalidStrike),
        (
            MarketArgs {
                trading_date: 20_261_399,
                ..base
            },
            MeridianError::InvalidTradingDate,
        ),
        (
            MarketArgs {
                close_ts: BASE_UNIX_TS,
                ..base
            },
            MeridianError::CloseInThePast,
        ),
    ];
    for (args, expected) in cases {
        let (addresses, result) = h.harness.add_strike_as(&admin, &args);
        assert_meridian_error(&result, expected);
        assert_market_absent(&h, &addresses);
    }
    // Duplicate of a market the automation created.
    let addresses = h.base_market();
    let (again, result) = h.harness.add_strike_as(&admin, &base);
    assert_eq!(again, addresses);
    expect_failure(&result);
    assert_market_created(&h, &addresses, &base);
}

// ---- mint_pair ------------------------------------------------------------------------------

#[test]
fn mint_pair_moves_collateral_and_mints_both_sides() {
    let mut h = MarketHarness::new();
    let addresses = h.base_market();
    let user = h.harness.user_for(&addresses, 10 * USDC);

    let result = h.harness.mint_pair(&user, &addresses, 7);
    let meta = expect_success(&result);
    assert_eq!(h.harness.token_amount(user.usdc), 3 * USDC);
    assert_eq!(h.harness.token_amount(user.yes), 7);
    assert_eq!(h.harness.token_amount(user.no), 7);
    assert_eq!(h.harness.token_amount(addresses.vault), 7 * USDC);
    assert_eq!(h.harness.market(addresses.market).pairs_outstanding, 7);
    h.harness.assert_market_invariants(&addresses);
    let event: PairsMinted = find_event(meta).expect("PairsMinted emitted");
    assert_eq!(event.market, addresses.market);
    assert_eq!(event.user, user.pubkey());
    assert_eq!(event.qty, 7);
    assert_eq!(event.pairs_outstanding, 7);

    // A second mint accumulates.
    let result = h.harness.mint_pair(&user, &addresses, 3);
    let meta = expect_success(&result);
    assert_eq!(h.harness.token_amount(user.usdc), 0);
    assert_eq!(h.harness.token_amount(user.yes), 10);
    assert_eq!(h.harness.token_amount(user.no), 10);
    assert_eq!(h.harness.market(addresses.market).pairs_outstanding, 10);
    let event: PairsMinted = find_event(meta).expect("PairsMinted emitted");
    assert_eq!(event.qty, 3);
    assert_eq!(event.pairs_outstanding, 10);
    h.harness.assert_market_invariants(&addresses);
}

#[test]
fn mint_pair_rejects_zero_and_insufficient_usdc() {
    let mut h = MarketHarness::new();
    let addresses = h.base_market();
    let user = h.harness.user_for(&addresses, 5 * USDC);

    assert_meridian_error(
        &h.harness.mint_pair(&user, &addresses, 0),
        MeridianError::InvalidQuantity,
    );
    assert_token_error(
        &h.harness.mint_pair(&user, &addresses, 6),
        TokenError::InsufficientFunds,
    );
    assert_eq!(h.harness.token_amount(user.usdc), 5 * USDC);
    assert_eq!(h.harness.token_amount(user.yes), 0);
    assert_eq!(h.harness.market(addresses.market).pairs_outstanding, 0);
    h.harness.assert_market_invariants(&addresses);
    expect_success(&h.harness.mint_pair(&user, &addresses, 5));
    h.harness.assert_market_invariants(&addresses);
}

#[test]
fn mint_pair_requires_the_user_signature_over_their_usdc() {
    let mut h = MarketHarness::new();
    let addresses = h.base_market();
    let victim = h.harness.user_for(&addresses, 5 * USDC);
    let thief = h.harness.user_for(&addresses, 0);
    // The thief signs but names the victim's USDC account: the token program rejects it.
    let ix = common::Harness::mint_pair_ix(
        &User {
            keypair: thief.keypair.insecure_clone(),
            usdc: victim.usdc,
            yes: thief.yes,
            no: thief.no,
        },
        &addresses,
        1,
    );
    let result = h.harness.send(ix, &[&thief.keypair]);
    assert_token_error(&result, TokenError::OwnerMismatch);
    assert_eq!(h.harness.token_amount(victim.usdc), 5 * USDC);
    h.harness.assert_market_invariants(&addresses);
}

// ---- redeem (pair mode) ---------------------------------------------------------------------

#[test]
fn redeem_pair_burns_both_sides_and_returns_collateral() {
    let mut h = MarketHarness::new();
    let addresses = h.base_market();
    let user = h.harness.user_for(&addresses, 10 * USDC);
    expect_success(&h.harness.mint_pair(&user, &addresses, 10));

    let result = h.harness.redeem(&user, &addresses, 4, 4);
    let meta = expect_success(&result);
    assert_eq!(h.harness.token_amount(user.usdc), 4 * USDC);
    assert_eq!(h.harness.token_amount(user.yes), 6);
    assert_eq!(h.harness.token_amount(user.no), 6);
    assert_eq!(h.harness.token_amount(addresses.vault), 6 * USDC);
    assert_eq!(h.harness.market(addresses.market).pairs_outstanding, 6);
    h.harness.assert_market_invariants(&addresses);
    let event: Redeemed = find_event(meta).expect("Redeemed emitted");
    assert_eq!(event.market, addresses.market);
    assert_eq!(event.user, user.pubkey());
    assert_eq!(event.yes_qty, 4);
    assert_eq!(event.no_qty, 4);
    assert_eq!(event.usdc, 4 * USDC);

    // Redeeming everything empties the vault.
    expect_success(&h.harness.redeem(&user, &addresses, 6, 6));
    assert_eq!(h.harness.token_amount(user.usdc), 10 * USDC);
    assert_eq!(h.harness.token_amount(addresses.vault), 0);
    assert_eq!(h.harness.market(addresses.market).pairs_outstanding, 0);
    h.harness.assert_market_invariants(&addresses);
}

#[test]
fn redeem_pair_rejects_unequal_zero_and_unowned_quantities() {
    let mut h = MarketHarness::new();
    let addresses = h.base_market();
    let user = h.harness.user_for(&addresses, 5 * USDC);
    expect_success(&h.harness.mint_pair(&user, &addresses, 5));

    for (yes, no) in [(3, 2), (0, 1), (1, 0), (5, 4)] {
        assert_meridian_error(
            &h.harness.redeem(&user, &addresses, yes, no),
            MeridianError::PairQuantityMismatch,
        );
    }
    assert_meridian_error(
        &h.harness.redeem(&user, &addresses, 0, 0),
        MeridianError::NothingToRedeem,
    );
    // More than the user holds: the burn fails and nothing moves.
    let other = h.harness.user_for(&addresses, 5 * USDC);
    expect_success(&h.harness.mint_pair(&other, &addresses, 5));
    assert_token_error(
        &h.harness.redeem(&user, &addresses, 6, 6),
        TokenError::InsufficientFunds,
    );
    assert_eq!(h.harness.token_amount(user.usdc), 0);
    assert_eq!(h.harness.token_amount(user.yes), 5);
    assert_eq!(h.harness.token_amount(user.no), 5);
    assert_eq!(h.harness.market(addresses.market).pairs_outstanding, 10);
    h.harness.assert_market_invariants(&addresses);
}

#[test]
fn redeem_pair_cannot_spend_another_users_tokens() {
    let mut h = MarketHarness::new();
    let addresses = h.base_market();
    let victim = h.harness.user_for(&addresses, 5 * USDC);
    expect_success(&h.harness.mint_pair(&victim, &addresses, 5));
    let thief = h.harness.user_for(&addresses, 0);
    let ix = common::Harness::redeem_ix(
        &User {
            keypair: thief.keypair.insecure_clone(),
            usdc: thief.usdc,
            yes: victim.yes,
            no: victim.no,
        },
        &addresses,
        5,
        5,
    );
    let result = h.harness.send(ix, &[&thief.keypair]);
    assert_token_error(&result, TokenError::OwnerMismatch);
    assert_eq!(h.harness.token_amount(victim.yes), 5);
    assert_eq!(h.harness.token_amount(thief.usdc), 0);
    h.harness.assert_market_invariants(&addresses);
}

#[test]
fn redeem_after_settlement_is_winner_mode_which_arrives_with_m1_07() {
    let mut h = MarketHarness::new();
    let addresses = h.base_market();
    let user = h.harness.user_for(&addresses, 5 * USDC);
    expect_success(&h.harness.mint_pair(&user, &addresses, 5));

    // Write a settled market directly (no settlement instruction exists yet).
    let mut account = h.harness.svm.get_account(&addresses.market).unwrap();
    let mut market = h.harness.market(addresses.market);
    market.status = MarketStatus::Settled;
    market.outcome = Outcome::Yes;
    market.settle_source = SettleSource::Override;
    let mut data = Vec::new();
    anchor_lang::AccountSerialize::try_serialize(&market, &mut data).unwrap();
    account.data[..data.len()].copy_from_slice(&data);
    h.harness
        .svm
        .set_account(addresses.market, account)
        .unwrap();

    assert_meridian_error(
        &h.harness.redeem(&user, &addresses, 1, 1),
        MeridianError::NotImplemented,
    );
    assert_meridian_error(
        &h.harness.mint_pair(&user, &addresses, 1),
        MeridianError::AlreadySettled,
    );
    assert_eq!(h.harness.token_amount(user.yes), 5);
    h.harness.assert_market_invariants(&addresses);
}

// ---- pause / unpause ------------------------------------------------------------------------

#[test]
fn pause_and_unpause_toggle_the_flag_and_emit_events() {
    let mut h = MarketHarness::new();
    assert!(!h.harness.config().paused);

    let result = h.harness.pause();
    let meta = expect_success(&result);
    assert!(h.harness.config().paused);
    let event: Paused = find_event(meta).expect("Paused emitted");
    assert_eq!(event.admin, h.harness.admin.pubkey());

    // Idempotent: pausing twice stays paused and still reports it.
    let result = h.harness.pause();
    let meta = expect_success(&result);
    assert!(h.harness.config().paused);
    assert!(find_event::<Paused>(meta).is_some());

    let result = h.harness.unpause();
    let meta = expect_success(&result);
    assert!(!h.harness.config().paused);
    let event: Unpaused = find_event(meta).expect("Unpaused emitted");
    assert_eq!(event.admin, h.harness.admin.pubkey());
    let result = h.harness.unpause();
    let meta = expect_success(&result);
    assert!(!h.harness.config().paused);
    assert!(find_event::<Unpaused>(meta).is_some());

    // Pause changes nothing else in the config.
    let config = h.harness.config();
    assert_eq!(config.admin, h.harness.admin.pubkey());
    assert_eq!(config.automation_authority, h.automation.pubkey());
    assert_eq!(config.usdc_mint, h.harness.usdc_mint);
}

#[test]
fn pause_blocks_minting_and_unpause_restores_it() {
    let mut h = MarketHarness::new();
    let addresses = h.base_market();
    let user = h.harness.user_for(&addresses, 5 * USDC);
    expect_success(&h.harness.pause());
    assert_meridian_error(
        &h.harness.mint_pair(&user, &addresses, 1),
        MeridianError::Paused,
    );
    expect_success(&h.harness.unpause());
    expect_success(&h.harness.mint_pair(&user, &addresses, 1));
    h.harness.assert_market_invariants(&addresses);
}

// ---- AC1 / AC2: invariants over random sequences ---------------------------------------------

/// One step of a random sequence: which of the three users acts and with what quantities.
#[derive(Clone, Copy, Debug)]
enum Op {
    Mint { user: usize, qty: u64 },
    Redeem { user: usize, yes: u64, no: u64 },
}

fn op() -> impl Strategy<Value = Op> {
    prop_oneof![
        3 => (0..3usize, 0..40u64).prop_map(|(user, qty)| Op::Mint { user, qty }),
        // Mostly matched pair quantities, sometimes mismatched ones (which must be rejected).
        2 => (0..3usize, 0..40u64).prop_map(|(user, qty)| Op::Redeem { user, yes: qty, no: qty }),
        1 => (0..3usize, 0..40u64, 0..40u64)
            .prop_map(|(user, yes, no)| Op::Redeem { user, yes, no }),
    ]
}

/// Off-chain model of what each user should hold.
#[derive(Clone, Copy, Debug, Default)]
struct Holding {
    usdc: u64,
    pairs: u64,
}

thread_local! {
    /// One LiteSVM per thread, shared by every proptest case (loading the program is the slow
    /// part); each case gets its own market, so cases never interact.
    static SHARED: RefCell<Option<(MarketHarness, u64)>> = const { RefCell::new(None) };
}

fn run_sequence(budgets: [u64; 3], ops: &[Op]) {
    SHARED.with(|cell| {
        let mut slot = cell.borrow_mut();
        let (h, next_strike) = slot.get_or_insert_with(|| (MarketHarness::new(), 0));
        *next_strike += STRIKE_STEP_CENTS;
        let strike = *next_strike;
        // Each market costs the creator rent for seven accounts; keep the payer funded.
        h.harness.svm.expire_blockhash();
        h.harness
            .svm
            .airdrop(&h.automation.pubkey(), FUNDING_LAMPORTS)
            .unwrap();
        // Spread the markets over dates too, so the PDA space stays obviously distinct.
        let args = MarketArgs {
            trading_date: BASE_TRADING_DATE
                + u32::try_from(strike / STRIKE_STEP_CENTS % 20).unwrap(),
            ..MarketArgs::base().with_strike(strike)
        };
        let addresses = h.create_market(&args);
        h.harness.assert_market_invariants(&addresses);

        let users: Vec<User> = budgets
            .iter()
            .map(|budget| h.harness.user_for(&addresses, budget * USDC))
            .collect();
        let mut model: [Holding; 3] = budgets.map(|usdc| Holding { usdc, pairs: 0 });
        let mut pairs_outstanding = 0u64;

        for op in ops {
            match *op {
                Op::Mint { user, qty } => {
                    let result = h.harness.mint_pair(&users[user], &addresses, qty);
                    let holding = &mut model[user];
                    if qty == 0 {
                        assert_meridian_error(&result, MeridianError::InvalidQuantity);
                    } else if holding.usdc < qty {
                        assert_token_error(&result, TokenError::InsufficientFunds);
                    } else {
                        expect_success(&result);
                        holding.usdc -= qty;
                        holding.pairs += qty;
                        pairs_outstanding += qty;
                    }
                }
                Op::Redeem { user, yes, no } => {
                    let result = h.harness.redeem(&users[user], &addresses, yes, no);
                    let holding = &mut model[user];
                    if yes != no {
                        assert_meridian_error(&result, MeridianError::PairQuantityMismatch);
                    } else if yes == 0 {
                        assert_meridian_error(&result, MeridianError::NothingToRedeem);
                    } else if holding.pairs < yes {
                        expect_failure(&result);
                    } else {
                        expect_success(&result);
                        holding.usdc += yes;
                        holding.pairs -= yes;
                        pairs_outstanding -= yes;
                    }
                }
            }
            // AC1 and AC2 after every instruction, successful or not.
            h.harness.assert_market_invariants(&addresses);
            assert_eq!(
                h.harness.market(addresses.market).pairs_outstanding,
                pairs_outstanding
            );
            for (user, holding) in users.iter().zip(model.iter()) {
                assert_eq!(h.harness.token_amount(user.usdc), holding.usdc * USDC);
                assert_eq!(h.harness.token_amount(user.yes), holding.pairs);
                assert_eq!(h.harness.token_amount(user.no), holding.pairs);
            }
        }
        let total: u64 = model.iter().map(|holding| holding.pairs).sum();
        assert_eq!(total, pairs_outstanding, "every pair is held by someone");
    });
}

proptest! {
    #![proptest_config(ProptestConfig {
        cases: 1_000,
        // Integration tests have no lib.rs for the default regression file; failures print
        // the minimal sequence instead.
        failure_persistence: None,
        ..ProptestConfig::default()
    })]

    /// AC1 + AC2 (NFR-07): over ≥ 1,000 random mint/redeem sequences across three users,
    /// vault = 1,000,000 × pairs outstanding and YES supply = NO supply = pairs outstanding
    /// after every instruction, and each user's balances match the model.
    #[test]
    fn vault_and_supplies_track_pairs_outstanding(
        budgets in [0..60u64, 0..60u64, 0..60u64],
        ops in prop::collection::vec(op(), 1..=16),
    ) {
        run_sequence(budgets, &ops);
    }
}

#[test]
fn a_fixed_sequence_exercises_every_branch_of_the_model() {
    run_sequence(
        [5, 0, 3],
        &[
            Op::Mint { user: 0, qty: 0 },
            Op::Mint { user: 0, qty: 6 },
            Op::Mint { user: 0, qty: 5 },
            Op::Mint { user: 1, qty: 1 },
            Op::Mint { user: 2, qty: 3 },
            Op::Redeem {
                user: 0,
                yes: 2,
                no: 1,
            },
            Op::Redeem {
                user: 0,
                yes: 0,
                no: 0,
            },
            Op::Redeem {
                user: 2,
                yes: 4,
                no: 4,
            },
            Op::Redeem {
                user: 2,
                yes: 3,
                no: 3,
            },
            Op::Redeem {
                user: 0,
                yes: 5,
                no: 5,
            },
            Op::Mint { user: 2, qty: 3 },
        ],
    );
}
