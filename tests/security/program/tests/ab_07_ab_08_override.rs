//! AB-07 (override before the delay) and AB-08 (re-settle or change an outcome); NFR-08,
//! M1-07 AC3. An override needs the admin and `now ≥ close_ts + override_delay_secs`; any
//! settle on a settled market fails, in every order, and leaves the record untouched.

use meridian::errors::MeridianError;
use meridian::state::{Market, MarketStatus, Outcome, SettleSource};
use security_tests::harness::settlement::{scaled_cents, SettlementHarness};
use security_tests::harness::{
    assert_meridian_error, expect_success, BASE_CLOSE_TS, BASE_STRIKE_CENTS,
};
use solana_sdk::signature::Signer;

const DELAY: i64 = 3_600;

fn snapshot(s: &mut SettlementHarness) -> Market {
    s.market()
}

fn same_record(a: &Market, b: &Market) -> bool {
    a.status == b.status
        && a.outcome == b.outcome
        && a.settle_price_scaled == b.settle_price_scaled
        && a.settle_slot == b.settle_slot
        && a.settled_at == b.settled_at
        && a.settle_source == b.settle_source
}

#[test]
fn ab_07_override_before_the_delay_is_rejected() {
    let mut s = SettlementHarness::new();
    for now in [BASE_CLOSE_TS - 1, BASE_CLOSE_TS, BASE_CLOSE_TS + DELAY - 1] {
        s.h().set_unix_timestamp(now);
        assert_meridian_error(
            &s.admin_override(BASE_STRIKE_CENTS),
            MeridianError::OverrideTooEarly,
        );
    }
    assert_eq!(snapshot(&mut s).status, MarketStatus::Open);
    s.h().set_unix_timestamp(BASE_CLOSE_TS + DELAY);
    expect_success(&s.admin_override(BASE_STRIKE_CENTS));
}

#[test]
fn ab_07_override_honours_a_changed_delay() {
    let mut s = SettlementHarness::new();
    let mut params = security_tests::harness::default_params(s.market_harness.automation.pubkey());
    params.tickers = Vec::new();
    params.override_delay_secs = 7_200;
    expect_success(&s.h().update_config(&params));
    s.h().set_unix_timestamp(BASE_CLOSE_TS + DELAY);
    assert_meridian_error(
        &s.admin_override(BASE_STRIKE_CENTS),
        MeridianError::OverrideTooEarly,
    );
    s.h().set_unix_timestamp(BASE_CLOSE_TS + 7_200);
    expect_success(&s.admin_override(BASE_STRIKE_CENTS));
}

#[test]
fn override_by_a_non_admin_is_rejected_even_after_the_delay() {
    let mut s = SettlementHarness::new();
    s.h().set_unix_timestamp(BASE_CLOSE_TS + DELAY);
    let attacker = s.h().funded_keypair();
    let addresses = s.addresses;
    let ix = security_tests::harness::Harness::override_ix(
        attacker.pubkey(),
        &addresses,
        BASE_STRIKE_CENTS,
    );
    assert_meridian_error(&s.h().send(ix, &[&attacker]), MeridianError::AdminOnly);
    // The automation authority is not the admin either.
    let automation = s.market_harness.automation.insecure_clone();
    let ix = security_tests::harness::Harness::override_ix(
        automation.pubkey(),
        &addresses,
        BASE_STRIKE_CENTS,
    );
    assert_meridian_error(&s.h().send(ix, &[&automation]), MeridianError::AdminOnly);
    assert_eq!(snapshot(&mut s).status, MarketStatus::Open);
}

/// First settlement paths, then every second attempt against each of them (AB-08).
#[derive(Clone, Copy, Debug)]
enum Path {
    Oracle,
    Override,
}

/// Settles with `first`: Oracle → YES at the strike, Override → NO below it.
fn settle_by(s: &mut SettlementHarness, path: Path) {
    match path {
        Path::Oracle => s.settle_at(BASE_STRIKE_CENTS),
        Path::Override => {
            expect_success(&s.admin_override(BASE_STRIKE_CENTS - 1));
        }
    }
}

/// Tries to settle again with `path` using the opposite outcome; must fail.
fn resettle_by(s: &mut SettlementHarness, path: Path) {
    match path {
        Path::Oracle => {
            s.publish_close(scaled_cents(BASE_STRIKE_CENTS + 50_000));
            assert_meridian_error(&s.settle(), MeridianError::AlreadySettled);
            s.publish_close(scaled_cents(1));
            assert_meridian_error(&s.settle(), MeridianError::AlreadySettled);
        }
        Path::Override => {
            assert_meridian_error(
                &s.admin_override(BASE_STRIKE_CENTS + 50_000),
                MeridianError::AlreadySettled,
            );
            assert_meridian_error(&s.admin_override(1), MeridianError::AlreadySettled);
        }
    }
}

#[test]
fn ab_08_a_settled_market_never_settles_again_in_any_order() {
    for (first, second) in [
        (Path::Oracle, Path::Oracle),
        (Path::Oracle, Path::Override),
        (Path::Override, Path::Oracle),
        (Path::Override, Path::Override),
    ] {
        let mut s = SettlementHarness::new();
        s.h().set_unix_timestamp(BASE_CLOSE_TS + DELAY + 10);
        settle_by(&mut s, first);
        let settled = snapshot(&mut s);
        assert_eq!(settled.status, MarketStatus::Settled, "{first:?}");

        resettle_by(&mut s, second);
        assert!(
            same_record(&settled, &snapshot(&mut s)),
            "{first:?} then {second:?} changed the record"
        );
    }
}

#[test]
fn ab_08_the_first_outcome_and_source_stick() {
    let mut s = SettlementHarness::new();
    s.h().set_unix_timestamp(BASE_CLOSE_TS + DELAY);
    settle_by(&mut s, Path::Override);
    let market = snapshot(&mut s);
    assert_eq!(market.outcome, Outcome::No);
    assert_eq!(market.settle_source, SettleSource::Override);
    resettle_by(&mut s, Path::Oracle);
    assert_eq!(snapshot(&mut s).outcome, Outcome::No);
    assert_eq!(snapshot(&mut s).settle_source, SettleSource::Override);
}
