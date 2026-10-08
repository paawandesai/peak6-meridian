//! M1-07 acceptance tests: settlement outcomes (AC1), payout properties (AC2), the recorded
//! Switchboard fixture (AC4), override, the local oracle and winner redeem. Abuse cases live in
//! `tests/security/program`.

// Test code: the program rules on unwrap/panic/arithmetic do not apply here.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::arithmetic_side_effects
)]

mod common;

use base64::prelude::{Engine, BASE64_STANDARD};
use common::settlement::*;
use common::*;
use meridian::errors::MeridianError;
use meridian::events::{MarketSettled, Redeemed};
use meridian::oracle::{SWITCHBOARD_DEVNET_PID, SWITCHBOARD_MAINNET_PID};
use meridian::state::{MarketStatus, Outcome, SettleSource, PAIR_COLLATERAL};
use proptest::prelude::*;
use solana_sdk::signature::Signer;

const STRIKE: u64 = BASE_STRIKE_CENTS;
const USDC: u64 = PAIR_COLLATERAL;

// ---- AC1: outcomes -------------------------------------------------------------------------

#[test]
fn close_above_strike_settles_yes() {
    let mut s = SettlementHarness::new();
    s.publish_close(scaled_cents(STRIKE + 1));
    let result = s.settle();
    let event = find_event::<MarketSettled>(expect_success(&result)).expect("MarketSettled");
    assert_eq!(event.outcome, Outcome::Yes);
    assert_eq!(event.source, SettleSource::Oracle);
    assert_eq!(event.price, scaled_cents(STRIKE + 1));
    assert_eq!(event.oracle_slot, START_SLOT);
    let market = s.market();
    assert_eq!(market.status, MarketStatus::Settled);
    assert_eq!(market.outcome, Outcome::Yes);
    assert_eq!(market.settle_source, SettleSource::Oracle);
    assert_eq!(market.settle_slot, START_SLOT);
    assert_eq!(market.settled_at, BASE_CLOSE_TS + SETTLE_DELAY_SECS);
}

#[test]
fn close_below_strike_settles_no() {
    let mut s = SettlementHarness::new();
    s.settle_at(STRIKE - 1);
    assert_eq!(s.market().outcome, Outcome::No);
}

#[test]
fn close_exactly_at_strike_settles_yes() {
    let mut s = SettlementHarness::new();
    s.settle_at(STRIKE);
    assert_eq!(s.market().outcome, Outcome::Yes);
}

#[test]
fn settle_price_is_the_mean_of_the_two_feeds() {
    let mut s = SettlementHarness::new();
    // 680.00 and 680.30 differ by ~4.4 bps: allowed; mean 680.15 is at or above the strike.
    s.publish_pair(scaled_cents(68_000), scaled_cents(68_030));
    expect_success(&s.settle());
    let market = s.market();
    assert_eq!(market.settle_price_scaled, scaled_cents(68_015));
    assert_eq!(market.outcome, Outcome::Yes);
}

#[test]
fn the_mean_decides_not_either_feed() {
    let mut s = SettlementHarness::new();
    // 679.90 (below) and 680.10 (above) average to exactly the strike.
    s.publish_pair(scaled_cents(67_990), scaled_cents(68_010));
    expect_success(&s.settle());
    assert_eq!(s.market().outcome, Outcome::Yes);
}

#[test]
fn spread_above_max_conf_bps_is_rejected_and_at_the_limit_passes() {
    let mut s = SettlementHarness::new();
    // 5 bps of a ~$680 mean is ~34.0 cents; 35 cents is over, 34 cents is inside.
    s.publish_pair(scaled_cents(68_000), scaled_cents(68_035));
    assert_meridian_error(&s.settle(), MeridianError::OracleSpreadTooWide);
    assert_eq!(s.market().status, MarketStatus::Open);
    s.publish_pair(scaled_cents(68_000), scaled_cents(68_034));
    expect_success(&s.settle());
}

#[test]
fn non_positive_values_are_rejected() {
    let mut s = SettlementHarness::new();
    s.publish_pair(scaled_cents(68_000), 0);
    assert_meridian_error(&s.settle(), MeridianError::OracleInvalidValue);
    s.publish_pair(-scaled_cents(68_000), -scaled_cents(68_000));
    assert_meridian_error(&s.settle(), MeridianError::OracleInvalidValue);
}

// ---- AC4: the recorded fixture --------------------------------------------------------------

#[test]
fn recorded_fixture_settles_a_market() {
    const FIXTURE: &str =
        include_str!("../../../tests/fixtures/switchboard/pull_feed_meta_tiingo.json");
    let json: serde_json::Value = serde_json::from_str(FIXTURE).unwrap();
    let data = BASE64_STANDARD
        .decode(json["account"]["data"][0].as_str().unwrap())
        .unwrap();
    let mut s = SettlementHarness::with_strike(68_000);
    // The fixture is the Tiingo feed: pin its hash (0xab…) and place it at the pinned key.
    let (key, _) = s.pinned("META", 0);
    let mut config_params = default_params(s.market_harness.automation.pubkey());
    let mut meta = ticker("META", 6);
    meta.feeds = [key, s.pinned("META", 1).0];
    meta.feed_hashes = [[0xab; 32], s.pinned("META", 1).1];
    config_params.tickers = vec![meridian::state::TickerSlot {
        index: 5,
        ticker: meta,
    }];
    expect_success(&s.h().update_config(&config_params));
    s.h().set_feed_account(key, SWITCHBOARD_DEVNET_PID, data);
    // Fixture: $681.25 at slot 412345678, updated close + 301 s. Move the clock there.
    s.h().set_slot(412_345_678 + 5);
    s.h().set_unix_timestamp(BASE_CLOSE_TS + 301);
    // Twelve Data agrees within 5 bps.
    let (key1, hash1) = s.pinned("META", 1);
    let data1 = pull_feed_data(
        hash1,
        scaled_cents(68_130),
        412_345_678,
        BASE_CLOSE_TS + 301,
    );
    s.h().set_feed_account(key1, SWITCHBOARD_MAINNET_PID, data1);
    expect_success(&s.settle());
    let market = s.market();
    assert_eq!(market.outcome, Outcome::Yes);
    assert_eq!(
        market.settle_price_scaled,
        scaled_cents(68_127) + 5 * 10i128.pow(15)
    );
    assert_eq!(market.settle_slot, 412_345_678);
}

// ---- override -------------------------------------------------------------------------------

#[test]
fn override_after_the_delay_settles_with_the_manual_price() {
    let mut s = SettlementHarness::new();
    s.h().set_unix_timestamp(BASE_CLOSE_TS + 3_600);
    let result = s.admin_override(STRIKE - 500);
    let event = find_event::<MarketSettled>(expect_success(&result)).expect("MarketSettled");
    assert_eq!(event.source, SettleSource::Override);
    assert_eq!(event.outcome, Outcome::No);
    let market = s.market();
    assert_eq!(market.settle_source, SettleSource::Override);
    assert_eq!(market.settle_slot, 0);
    assert_eq!(market.settle_price_scaled, scaled_cents(STRIKE - 500));
}

#[test]
fn override_at_the_strike_is_yes_and_zero_price_is_rejected() {
    let mut s = SettlementHarness::new();
    s.h().set_unix_timestamp(BASE_CLOSE_TS + 3_600);
    assert_meridian_error(&s.admin_override(0), MeridianError::OracleInvalidValue);
    expect_success(&s.admin_override(STRIKE));
    assert_eq!(s.market().outcome, Outcome::Yes);
}

// ---- local oracle ---------------------------------------------------------------------------

#[test]
fn local_oracle_feeds_settle_a_market() {
    let mut s = SettlementHarness::new();
    let meta = symbol("META");
    // Pin the local feeds (account and hash = the PDA bytes) in the config.
    let feeds = [local_feed_pda(&meta, 0), local_feed_pda(&meta, 1)];
    let mut pinned = ticker("META", 6);
    pinned.feeds = feeds;
    pinned.feed_hashes = [feeds[0].to_bytes(), feeds[1].to_bytes()];
    let mut params = default_params(s.market_harness.automation.pubkey());
    params.tickers = vec![meridian::state::TickerSlot {
        index: 5,
        ticker: pinned,
    }];
    expect_success(&s.h().update_config(&params));

    let admin = s.h().admin.insecure_clone();
    for (source, value) in [
        (0u8, scaled_cents(STRIKE + 10)),
        (1u8, scaled_cents(STRIKE + 12)),
    ] {
        let ix = Harness::local_oracle_set_ix(admin.pubkey(), meta, source, value, START_SLOT);
        expect_success(&s.h().send(ix, &[&admin]));
    }
    expect_success(&s.settle_with(feeds[0], feeds[1]));
    let market = s.market();
    assert_eq!(market.outcome, Outcome::Yes);
    assert_eq!(market.settle_price_scaled, scaled_cents(STRIKE + 11));
}

#[test]
fn local_oracle_set_is_admin_only_and_validates_its_arguments() {
    let mut s = SettlementHarness::new();
    let meta = symbol("META");
    let attacker = s.h().funded_keypair();
    let value = scaled_cents(STRIKE);
    let ix = Harness::local_oracle_set_ix(attacker.pubkey(), meta, 0, value, START_SLOT);
    assert_meridian_error(&s.h().send(ix, &[&attacker]), MeridianError::AdminOnly);
    let admin = s.h().admin.insecure_clone();
    let ix = Harness::local_oracle_set_ix(admin.pubkey(), meta, 2, value, START_SLOT);
    assert_meridian_error(&s.h().send(ix, &[&admin]), MeridianError::InvalidTickerSlot);
    let ix = Harness::local_oracle_set_ix(admin.pubkey(), symbol("ZZZ"), 0, value, START_SLOT);
    assert_meridian_error(&s.h().send(ix, &[&admin]), MeridianError::UnknownTicker);
}

// ---- winner redeem --------------------------------------------------------------------------

#[test]
fn winners_redeem_one_usdc_per_token_and_the_vault_empties() {
    let mut s = SettlementHarness::new();
    let alice = s.holder(4);
    let bob = s.holder(6);
    s.settle_at(STRIKE + 100);
    let addresses = s.addresses;

    // Alice redeems all four YES (and burns her four NO for nothing).
    let result = s.h().redeem(&alice, &addresses, 4, 4);
    let event = find_event::<Redeemed>(expect_success(&result)).expect("Redeemed");
    assert_eq!(event.usdc, 4 * USDC);
    assert_eq!(s.h().token_amount(alice.usdc), 4 * USDC);
    assert_eq!(s.h().token_amount(alice.yes), 0);
    assert_eq!(s.h().token_amount(alice.no), 0);
    let market = s.h().market(addresses.market);
    assert_eq!(market.pairs_outstanding, 6);
    assert_eq!(s.h().token_amount(addresses.vault), 6 * USDC);

    // Bob redeems YES only, then clears NO separately.
    expect_success(&s.h().redeem(&bob, &addresses, 6, 0));
    assert_eq!(s.h().token_amount(bob.usdc), 6 * USDC);
    expect_success(&s.h().redeem(&bob, &addresses, 0, 6));
    assert_eq!(s.h().token_amount(bob.usdc), 6 * USDC);
    assert_eq!(s.h().token_amount(addresses.vault), 0);
    assert_eq!(s.h().mint_supply(addresses.yes_mint), 0);
    assert_eq!(s.h().mint_supply(addresses.no_mint), 0);
}

#[test]
fn no_wins_pays_the_no_holders() {
    let mut s = SettlementHarness::new();
    let alice = s.holder(3);
    s.settle_at(STRIKE - 100);
    let addresses = s.addresses;
    expect_success(&s.h().redeem(&alice, &addresses, 3, 3));
    assert_eq!(s.h().token_amount(alice.usdc), 3 * USDC);
    assert_eq!(s.h().token_amount(addresses.vault), 0);
}

#[test]
fn redeeming_nothing_fails_in_winner_mode() {
    let mut s = SettlementHarness::new();
    let alice = s.holder(1);
    s.settle_at(STRIKE);
    let addresses = s.addresses;
    assert_meridian_error(
        &s.h().redeem(&alice, &addresses, 0, 0),
        MeridianError::NothingToRedeem,
    );
}

// ---- AC2: payout properties -----------------------------------------------------------------

proptest! {
    #![proptest_config(ProptestConfig::with_cases(24))]

    /// For any close value and strike: YES payout + NO payout = 1 USDC per pair, and winner
    /// redeem never pays out more than the vault holds (it ends at exactly zero).
    #[test]
    fn payouts_sum_to_one_usdc_and_never_exceed_the_vault(
        strike_tens in 1u64..=200,
        close_cents in 1u64..=3_000_000,
        pairs in 1u64..=5,
    ) {
        let strike = strike_tens * 1_000;
        let mut s = SettlementHarness::with_strike(strike);
        let user = s.holder(pairs);
        // Both feeds agree exactly, so the spread rule never interferes.
        s.settle_at(close_cents);
        let addresses = s.addresses;
        let vault_before = s.h().token_amount(addresses.vault);
        prop_assert_eq!(vault_before, pairs * USDC);

        expect_success(&s.h().redeem(&user, &addresses, pairs, 0));
        let yes_payout = s.h().token_amount(user.usdc);
        expect_success(&s.h().redeem(&user, &addresses, 0, pairs));
        let total = s.h().token_amount(user.usdc);
        let no_payout = total - yes_payout;

        prop_assert_eq!(yes_payout + no_payout, pairs * USDC);
        prop_assert!(total <= vault_before);
        prop_assert_eq!(yes_payout == pairs * USDC, close_cents >= strike);
        prop_assert_eq!(s.h().token_amount(addresses.vault), 0);
    }
}
