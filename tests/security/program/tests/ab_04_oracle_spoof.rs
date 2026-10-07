//! AB-04 (NFR-06; M1-07 AC3): spoofed oracle accounts. Every feed must be owned by the
//! Switchboard program, sit at the account pinned in the config for that ticker and source slot,
//! carry the pinned feed hash and have the exact Switchboard layout.

use anchor_lang::prelude::Pubkey;
use meridian::errors::MeridianError;
use meridian::oracle::SWITCHBOARD_DEVNET_PID;
use meridian::state::MarketStatus;
use security_tests::harness::settlement::{
    pull_feed_data, scaled_cents, SettlementHarness, START_SLOT,
};
use security_tests::harness::{
    assert_meridian_error, expect_success, BASE_CLOSE_TS, BASE_STRIKE_CENTS,
};

fn good_data(hash: [u8; 32]) -> Vec<u8> {
    pull_feed_data(
        hash,
        scaled_cents(BASE_STRIKE_CENTS),
        START_SLOT,
        BASE_CLOSE_TS + 300,
    )
}

fn assert_still_open(s: &mut SettlementHarness) {
    assert_eq!(
        s.h().market(s.addresses.market).status,
        MarketStatus::Open
    );
}

#[test]
fn wrong_owner_is_rejected() {
    for source in [0, 1] {
        let mut s = SettlementHarness::new();
        s.publish_close(scaled_cents(BASE_STRIKE_CENTS));
        let (key, hash) = s.pinned("META", source);
        // A perfect copy of a Switchboard feed, owned by an attacker program.
        s.h().set_feed_account(key, Pubkey::new_unique(), good_data(hash));
        assert_meridian_error(&s.settle(), MeridianError::OracleWrongOwner);
        // Or by the system program.
        s.h()
            .set_feed_account(key, anchor_lang::system_program::ID, good_data(hash));
        assert_meridian_error(&s.settle(), MeridianError::OracleWrongOwner);
        assert_still_open(&mut s);
    }
}

#[test]
fn wrong_feed_hash_is_rejected() {
    for source in [0, 1] {
        let mut s = SettlementHarness::new();
        s.publish_close(scaled_cents(BASE_STRIKE_CENTS));
        let (key, hash) = s.pinned("META", source);
        let mut wrong = hash;
        wrong[31] ^= 1;
        s.h().set_feed_account(key, SWITCHBOARD_DEVNET_PID, good_data(wrong));
        assert_meridian_error(&s.settle(), MeridianError::OracleFeedHashMismatch);
        assert_still_open(&mut s);
    }
}

#[test]
fn an_unpinned_feed_with_the_right_hash_is_rejected() {
    let mut s = SettlementHarness::new();
    s.publish_close(scaled_cents(BASE_STRIKE_CENTS));
    let (_, hash) = s.pinned("META", 0);
    let (pinned_second, _) = s.pinned("META", 1);
    // The attacker's own Switchboard-owned feed (even carrying the pinned hash) is not pinned.
    let rogue = Pubkey::new_unique();
    s.h().set_feed_account(rogue, SWITCHBOARD_DEVNET_PID, good_data(hash));
    assert_meridian_error(
        &s.settle_with(rogue, pinned_second),
        MeridianError::OracleFeedHashMismatch,
    );
    assert_still_open(&mut s);
}

#[test]
fn feeds_swapped_between_tickers_are_rejected() {
    let mut s = SettlementHarness::new();
    s.publish_close(scaled_cents(BASE_STRIKE_CENTS));
    for ticker in ["AAPL", "TSLA"] {
        s.publish(ticker, 0, scaled_cents(BASE_STRIKE_CENTS));
        s.publish(ticker, 1, scaled_cents(BASE_STRIKE_CENTS));
        let (a, _) = s.pinned(ticker, 0);
        let (b, _) = s.pinned(ticker, 1);
        assert_meridian_error(&s.settle_with(a, b), MeridianError::OracleFeedHashMismatch);
    }
    // One right feed and one from another ticker.
    let (meta_first, _) = s.pinned("META", 0);
    let (other_second, _) = s.pinned("AAPL", 1);
    assert_meridian_error(
        &s.settle_with(meta_first, other_second),
        MeridianError::OracleFeedHashMismatch,
    );
    assert_still_open(&mut s);
}

#[test]
fn the_same_ticker_feeds_in_the_wrong_source_order_are_rejected() {
    let mut s = SettlementHarness::new();
    s.publish_close(scaled_cents(BASE_STRIKE_CENTS));
    let (a, b) = s.meta_feeds();
    assert_meridian_error(&s.settle_with(b, a), MeridianError::OracleFeedHashMismatch);
    // The same feed twice is not two sources.
    assert_meridian_error(&s.settle_with(a, a), MeridianError::OracleFeedHashMismatch);
    expect_success(&s.settle_with(a, b));
}

#[test]
fn malformed_feed_data_is_rejected() {
    let mut s = SettlementHarness::new();
    s.publish_close(scaled_cents(BASE_STRIKE_CENTS));
    let (key, hash) = s.pinned("META", 0);
    let good = good_data(hash);

    let mut bad_discriminator = good.clone();
    bad_discriminator[0] ^= 0xff;
    let mut longer = good.clone();
    longer.push(0);
    for data in [
        bad_discriminator,
        good[..good.len() - 1].to_vec(),
        longer,
        Vec::new(),
    ] {
        s.h().set_feed_account(key, SWITCHBOARD_DEVNET_PID, data);
        assert_meridian_error(&s.settle(), MeridianError::OracleInvalidValue);
    }
    assert_still_open(&mut s);
}

#[test]
fn a_feed_for_the_local_oracle_cannot_be_forged_by_a_foreign_account() {
    // Whatever the build, an account owned by neither Switchboard nor this program fails.
    let mut s = SettlementHarness::new();
    s.publish_close(scaled_cents(BASE_STRIKE_CENTS));
    let (key, _) = s.pinned("META", 0);
    s.h().set_feed_account(key, Pubkey::new_unique(), vec![0u8; 100]);
    assert_meridian_error(&s.settle(), MeridianError::OracleWrongOwner);
}
