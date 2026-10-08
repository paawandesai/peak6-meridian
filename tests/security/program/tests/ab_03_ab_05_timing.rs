//! AB-03 (stale oracle value, yesterday's close) and AB-05 (settle before close); NFR-06,
//! M1-07 AC3. On-chain a feed must be updated at or after `close_ts` and at most
//! `max_staleness_slots` (30) before the current slot; settlement needs `now ≥ close_ts`.

use meridian::errors::MeridianError;
use meridian::oracle::SWITCHBOARD_DEVNET_PID;
use meridian::state::MarketStatus;
use security_tests::harness::settlement::{
    pull_feed_data, scaled_cents, SettlementHarness, START_SLOT,
};
use security_tests::harness::{
    assert_meridian_error, expect_success, BASE_CLOSE_TS, BASE_STRIKE_CENTS,
};

/// Publishes the pinned META feed `source` with explicit slot and update time.
fn publish_at(s: &mut SettlementHarness, source: usize, slot: u64, updated_at: i64) {
    let (key, hash) = s.pinned("META", source);
    let data = pull_feed_data(hash, scaled_cents(BASE_STRIKE_CENTS), slot, updated_at);
    s.h().set_feed_account(key, SWITCHBOARD_DEVNET_PID, data);
}

fn assert_still_open(s: &mut SettlementHarness) {
    assert_eq!(s.market().status, MarketStatus::Open);
}

#[test]
fn ab_03_stale_feed_is_rejected_at_31_slots_and_accepted_at_30() {
    for source in [0, 1] {
        let mut s = SettlementHarness::new();
        let now = BASE_CLOSE_TS + 300;
        s.publish_close(scaled_cents(BASE_STRIKE_CENTS));
        publish_at(&mut s, source, START_SLOT - 31, now);
        assert_meridian_error(&s.settle(), MeridianError::OracleStale);
        assert_still_open(&mut s);

        publish_at(&mut s, source, START_SLOT - 30, now);
        expect_success(&s.settle());
    }
}

#[test]
fn ab_03_feed_with_a_slot_in_the_future_is_rejected() {
    let mut s = SettlementHarness::new();
    s.publish_close(scaled_cents(BASE_STRIKE_CENTS));
    publish_at(&mut s, 1, START_SLOT + 1, BASE_CLOSE_TS + 300);
    assert_meridian_error(&s.settle(), MeridianError::OracleInvalidValue);
}

#[test]
fn ab_03_feed_updated_before_close_is_rejected_yesterdays_close() {
    for source in [0, 1] {
        let mut s = SettlementHarness::new();
        s.publish_close(scaled_cents(BASE_STRIKE_CENTS));
        // Fresh slot, but the value was produced one second before the close.
        publish_at(&mut s, source, START_SLOT, BASE_CLOSE_TS - 1);
        assert_meridian_error(&s.settle(), MeridianError::OracleBeforeClose);
        assert_still_open(&mut s);

        // Exactly at the close is accepted.
        publish_at(&mut s, source, START_SLOT, BASE_CLOSE_TS);
        expect_success(&s.settle());
    }
}

#[test]
fn ab_03_a_day_old_feed_fails_both_checks() {
    let mut s = SettlementHarness::new();
    s.publish_close(scaled_cents(BASE_STRIKE_CENTS));
    publish_at(&mut s, 0, 1, BASE_CLOSE_TS - 86_400);
    let result = s.settle();
    assert!(
        result.is_err(),
        "a previous day's value must not settle today's market"
    );
    assert_still_open(&mut s);
}

#[test]
fn ab_05_settle_before_close_is_rejected_even_with_fresh_feeds() {
    let mut s = SettlementHarness::new();
    s.h().set_unix_timestamp(BASE_CLOSE_TS - 1);
    s.publish_close(scaled_cents(BASE_STRIKE_CENTS));
    assert_meridian_error(&s.settle(), MeridianError::NotClosed);
    assert_still_open(&mut s);

    // Far before close, too.
    s.h().set_unix_timestamp(BASE_CLOSE_TS - 6 * 3_600);
    s.publish_close(scaled_cents(BASE_STRIKE_CENTS));
    assert_meridian_error(&s.settle(), MeridianError::NotClosed);
}

#[test]
fn ab_05_settle_exactly_at_close_succeeds_with_a_feed_updated_at_close() {
    let mut s = SettlementHarness::new();
    s.h().set_unix_timestamp(BASE_CLOSE_TS);
    s.publish_close(scaled_cents(BASE_STRIKE_CENTS));
    expect_success(&s.settle());
}
