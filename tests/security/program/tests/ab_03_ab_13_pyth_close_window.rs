//! AB-03 and AB-13 on the Pyth Lazer path (D-055): a signed Pyth update settles a market only if
//! it was taken in `[close_ts, close_ts + pyth_max_age_secs]` (never before the close, never a
//! later after-hours price picked by a permissionless settler) and its confidence is within
//! `max_conf_bps` of the price.

use meridian::errors::MeridianError;
use meridian::state::MarketStatus;
use security_tests::harness::migration::pyth_params;
use security_tests::harness::pyth::{
    pyth_payload, pyth_payload_with_confidence, META_FEED_ID, PYTH_EXPONENT,
};
use security_tests::harness::settlement::SettlementHarness;
use security_tests::harness::{
    default_params, error_code, expect_failure, expect_success, BASE_CLOSE_TS,
};
use solana_sdk::instruction::InstructionError;
use solana_sdk::signature::{Keypair, Signer};
use solana_sdk::transaction::TransactionError;

/// $681.25 with 8 fractional digits; 5 bps of it is 34_062_500.
const PRICE: i64 = 68_125_000_000;
/// The fixture Config's close window.
const WINDOW: i64 = 30;

fn harness(signer: &Keypair) -> SettlementHarness {
    let mut sh = SettlementHarness::new();
    let automation = sh.h().config().automation_authority;
    let pyth = pyth_params(signer.pubkey());
    let mut params = default_params(automation);
    params.tickers = vec![];
    params.pyth_lazer_signer = pyth.pyth_lazer_signer;
    params.pyth_feed_ids = pyth.pyth_feed_ids;
    params.pyth_max_age_secs = WINDOW;
    expect_success(&sh.h().update_config(&params));
    sh
}

fn assert_settle_error(result: &litesvm::types::TransactionResult, expected: MeridianError) {
    let failure = expect_failure(result);
    assert_eq!(
        failure.err,
        TransactionError::InstructionError(1, InstructionError::Custom(error_code(expected))),
        "expected {expected:?}; logs: {:#?}",
        failure.meta.logs
    );
}

fn at_us(timestamp_us: i64) -> Vec<u8> {
    pyth_payload(META_FEED_ID, PRICE, PYTH_EXPONENT, timestamp_us)
}

#[test]
fn ab_03_an_update_from_before_close_is_rejected() {
    let signer = Keypair::new();
    let mut sh = harness(&signer);
    for before in [1, 1_000_000, 3_600 * 1_000_000] {
        assert_settle_error(
            &sh.settle_pyth_signed(&signer, &at_us(BASE_CLOSE_TS * 1_000_000 - before)),
            MeridianError::OracleBeforeClose,
        );
    }
    assert_eq!(sh.market().status, MarketStatus::Open);
}

#[test]
fn ab_03_a_later_after_hours_update_is_rejected_even_if_fresh() {
    // An hour after close, the settler submits an update taken a second ago: fresh, validly
    // signed, but outside the close window, so it cannot replace the closing price.
    let signer = Keypair::new();
    let mut sh = harness(&signer);
    sh.h().set_unix_timestamp(BASE_CLOSE_TS + 3_600);
    assert_settle_error(
        &sh.settle_pyth_signed(&signer, &at_us((BASE_CLOSE_TS + 3_599) * 1_000_000)),
        MeridianError::PythAfterCloseWindow,
    );
    assert_settle_error(
        &sh.settle_pyth_signed(&signer, &at_us((BASE_CLOSE_TS + WINDOW + 1) * 1_000_000)),
        MeridianError::PythAfterCloseWindow,
    );
    // The closing update itself still settles, an hour later.
    expect_success(&sh.settle_pyth_signed(&signer, &at_us(BASE_CLOSE_TS * 1_000_000)));
}

#[test]
fn ab_03_an_update_from_the_future_is_rejected() {
    let signer = Keypair::new();
    let mut sh = harness(&signer);
    sh.h().set_unix_timestamp(BASE_CLOSE_TS + 5);
    assert_settle_error(
        &sh.settle_pyth_signed(&signer, &at_us((BASE_CLOSE_TS + 10) * 1_000_000)),
        MeridianError::OracleInvalidValue,
    );
}

#[test]
fn ab_13_a_confidence_wider_than_max_conf_bps_is_rejected() {
    let signer = Keypair::new();
    let mut sh = harness(&signer);
    let at = BASE_CLOSE_TS * 1_000_000;
    for confidence in [34_062_501, PRICE, i64::MAX, 0] {
        let payload =
            pyth_payload_with_confidence(META_FEED_ID, PRICE, PYTH_EXPONENT, confidence, at);
        assert_settle_error(
            &sh.settle_pyth_signed(&signer, &payload),
            MeridianError::PythConfidenceTooWide,
        );
    }
    assert_eq!(sh.market().status, MarketStatus::Open);
    let edge = pyth_payload_with_confidence(META_FEED_ID, PRICE, PYTH_EXPONENT, 34_062_500, at);
    expect_success(&sh.settle_pyth_signed(&signer, &edge));
}
