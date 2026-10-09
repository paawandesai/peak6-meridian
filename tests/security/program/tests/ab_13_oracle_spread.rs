//! AB-13 (NFR-06; M2-02 AC4): one data source returns a wrong close (bug, outage, or
//! manipulation). The on-chain check rejects a spread > max_conf_bps (0.05% = 5 bps) between the
//! two feeds with OracleSpreadTooWide. The operational off-chain check (check-feeds script) is
//! tested in ts/ab_13_feed_spread.test.ts. This test verifies the program's on-chain guard.

use meridian::errors::MeridianError;
use meridian::state::MarketStatus;
use security_tests::harness::settlement::{scaled_cents, SettlementHarness};
use security_tests::harness::{assert_meridian_error, expect_success, BASE_STRIKE_CENTS};

#[test]
fn spread_at_exactly_5_bps_passes() {
    let mut s = SettlementHarness::new();
    // For a mean price around $680 (BASE_STRIKE_CENTS = 68000), 5 bps = 0.05% = 34.0 cents.
    // Feed1: $680.00, Feed2: $680.34 (exactly at limit).
    s.publish_pair(scaled_cents(68_000), scaled_cents(68_034));
    expect_success(&s.settle());
    assert_eq!(s.market().status, MarketStatus::Settled);
}

#[test]
fn spread_above_5_bps_rejected_with_oracle_spread_too_wide() {
    let mut s = SettlementHarness::new();
    // 5 bps of a ~$680 mean is ~34.0 cents; 35 cents is over the limit.
    s.publish_pair(scaled_cents(68_000), scaled_cents(68_035));
    assert_meridian_error(&s.settle(), MeridianError::OracleSpreadTooWide);
    assert_eq!(s.market().status, MarketStatus::Open);
}

#[test]
fn spread_rejected_regardless_of_which_feed_is_higher() {
    let mut s = SettlementHarness::new();
    // Test with feed2 < feed1 (spread magnitude still matters, not direction).
    // Feed1: $680.00, Feed2: $679.65 (35 cents below, > 5 bps).
    s.publish_pair(scaled_cents(68_000), scaled_cents(67_965));
    assert_meridian_error(&s.settle(), MeridianError::OracleSpreadTooWide);
    assert_eq!(s.market().status, MarketStatus::Open);
}

#[test]
fn zero_spread_always_passes() {
    let mut s = SettlementHarness::new();
    s.publish_close(scaled_cents(BASE_STRIKE_CENTS));
    expect_success(&s.settle());
    assert_eq!(s.market().status, MarketStatus::Settled);
}

#[test]
fn small_spread_inside_limit_passes() {
    let mut s = SettlementHarness::new();
    // 1 cent spread on a $680 price is well within 5 bps.
    s.publish_pair(scaled_cents(68_000), scaled_cents(68_001));
    expect_success(&s.settle());
    assert_eq!(s.market().status, MarketStatus::Settled);
}
