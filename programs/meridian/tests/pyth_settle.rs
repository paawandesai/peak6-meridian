//! `settle_market` on the Pyth Lazer path (M3-10b, D-055): an Ed25519Program instruction
//! carrying a Pyth `PayloadData` signed by the Config-pinned signer, read through the
//! instructions sysvar. Success and failure paths, plus Pyth settlement on a Config that was
//! migrated from v1 by `migrate_config`.

mod common;

use common::migration::pyth_params;
use common::pyth::{pyth_payload, META_FEED_ID, PYTH_EXPONENT};
use common::settlement::SettlementHarness;
use common::{
    default_params, error_code, expect_failure, expect_success, find_event, BASE_CLOSE_TS,
};
use meridian::errors::MeridianError;
use meridian::events::MarketSettled;
use meridian::state::{MarketStatus, Outcome, SettleSource, STRIKE_CENTS_TO_SCALED};
use solana_sdk::instruction::InstructionError;
use solana_sdk::signature::{Keypair, Signer};
use solana_sdk::transaction::TransactionError;

/// $681.25 with 8 fractional digits.
const PRICE_ABOVE: i64 = 68_125_000_000;
/// $679.99 with 8 fractional digits.
const PRICE_BELOW: i64 = 67_999_000_000;

/// A settlement harness whose Config pins `signer` as the Pyth Lazer signer with MAG7 feed ids.
fn pyth_harness(signer: &Keypair) -> SettlementHarness {
    let mut sh = SettlementHarness::new();
    let automation = sh.h().config().automation_authority;
    let pyth = pyth_params(signer.pubkey());
    let mut params = default_params(automation);
    params.tickers = vec![];
    params.pyth_lazer_signer = pyth.pyth_lazer_signer;
    params.pyth_feed_ids = pyth.pyth_feed_ids;
    params.pyth_max_age_secs = pyth.pyth_max_age_secs;
    expect_success(&sh.h().update_config(&params));
    sh
}

/// Asserts the settle instruction (index 1, after the Ed25519 instruction) failed with `expected`.
fn assert_settle_error(result: &litesvm::types::TransactionResult, expected: MeridianError) {
    let failure = expect_failure(result);
    assert_eq!(
        failure.err,
        TransactionError::InstructionError(1, InstructionError::Custom(error_code(expected))),
        "expected {expected:?}; logs: {:#?}",
        failure.meta.logs
    );
}

#[test]
fn pyth_settles_yes_above_the_strike_and_records_the_scaled_price() {
    let signer = Keypair::new();
    let mut sh = pyth_harness(&signer);
    let meta = expect_success(&sh.settle_pyth(&signer, PRICE_ABOVE)).clone();

    let market = sh.market();
    assert_eq!(market.status, MarketStatus::Settled);
    assert_eq!(market.outcome, Outcome::Yes);
    assert_eq!(market.settle_source, SettleSource::Oracle);
    // 8 fractional digits → 18: × 10^10.
    let scaled = i128::from(PRICE_ABOVE) * 10i128.pow(10);
    assert_eq!(market.settle_price_scaled, scaled);
    assert_eq!(scaled, 68_125 * STRIKE_CENTS_TO_SCALED);
    let event: MarketSettled = find_event(&meta).expect("MarketSettled emitted");
    assert_eq!(event.price, scaled);
    assert_eq!(event.outcome, Outcome::Yes);
}

#[test]
fn pyth_settles_no_below_the_strike() {
    let signer = Keypair::new();
    let mut sh = pyth_harness(&signer);
    expect_success(&sh.settle_pyth(&signer, PRICE_BELOW));
    assert_eq!(sh.market().outcome, Outcome::No);
}

#[test]
fn pyth_rejects_a_signer_that_is_not_pinned() {
    let pinned = Keypair::new();
    let mut sh = pyth_harness(&pinned);
    let impostor = Keypair::new();
    assert_settle_error(
        &sh.settle_pyth(&impostor, PRICE_ABOVE),
        MeridianError::OracleFeedHashMismatch,
    );
    assert_eq!(sh.market().status, MarketStatus::Open);
}

#[test]
fn pyth_rejects_another_tickers_feed() {
    let signer = Keypair::new();
    let mut sh = pyth_harness(&signer);
    let now = sh.h().clock().unix_timestamp;
    let tsla = meridian::pyth::feed_ids::TSLA;
    let message = pyth_payload(tsla, PRICE_ABOVE, PYTH_EXPONENT, now * 1_000_000);
    assert_settle_error(
        &sh.settle_pyth_signed(&signer, &message),
        MeridianError::OracleFeedHashMismatch,
    );
}

#[test]
fn pyth_rejects_a_price_from_before_close_and_a_stale_price() {
    let signer = Keypair::new();
    let mut sh = pyth_harness(&signer);
    let before_close = pyth_payload(
        META_FEED_ID,
        PRICE_ABOVE,
        PYTH_EXPONENT,
        (BASE_CLOSE_TS - 1) * 1_000_000,
    );
    assert_settle_error(
        &sh.settle_pyth_signed(&signer, &before_close),
        MeridianError::OracleBeforeClose,
    );
    let now = sh.h().clock().unix_timestamp;
    let stale = pyth_payload(
        META_FEED_ID,
        PRICE_ABOVE,
        PYTH_EXPONENT,
        (now - 31) * 1_000_000,
    );
    assert_settle_error(
        &sh.settle_pyth_signed(&signer, &stale),
        MeridianError::OracleStale,
    );
    assert_eq!(sh.market().status, MarketStatus::Open);
}

#[test]
fn pyth_rejects_a_forged_signature() {
    let signer = Keypair::new();
    let mut sh = pyth_harness(&signer);
    let now = sh.h().clock().unix_timestamp;
    let message = pyth_payload(META_FEED_ID, PRICE_ABOVE, PYTH_EXPONENT, now * 1_000_000);
    let mut ix = common::pyth::ed25519_ix(&signer, &message);
    // Flip a price byte after signing: the Ed25519 precompile fails the transaction.
    let last = ix.data.len() - 3;
    ix.data[last] ^= 0x01;
    let payer = sh.payer.insecure_clone();
    let settle = common::pyth::settle_market_pyth_ix(payer.pubkey(), &sh.addresses, 0);
    let h = sh.h();
    h.svm.expire_blockhash();
    let tx = solana_sdk::transaction::Transaction::new_signed_with_payer(
        &[ix, settle],
        Some(&payer.pubkey()),
        &[&payer],
        h.svm.latest_blockhash(),
    );
    let result = h.svm.send_transaction(tx);
    // The Ed25519 precompile (instruction 0) rejects it: PrecompileError::InvalidSignature = 2.
    assert_eq!(
        expect_failure(&result).err,
        TransactionError::InstructionError(0, InstructionError::Custom(2))
    );
    assert_eq!(sh.market().status, MarketStatus::Open);
}

#[test]
fn without_a_configured_feed_id_the_pyth_inputs_are_ignored() {
    // Feed ids zero (the state right after migrate_config without Pyth parameters): the Pyth
    // inputs are not used and, with no RedStone price either, the Switchboard path runs and
    // fails on the placeholder feed accounts instead of settling from an unpinned signer.
    let signer = Keypair::new();
    let mut sh = SettlementHarness::new();
    let result = sh.settle_pyth(&signer, PRICE_ABOVE);
    let failure = expect_failure(&result);
    assert_eq!(
        failure.err,
        TransactionError::InstructionError(
            1,
            InstructionError::Custom(error_code(MeridianError::OracleWrongOwner))
        ),
        "logs: {:#?}",
        failure.meta.logs
    );
    assert_eq!(sh.market().status, MarketStatus::Open);
}

#[test]
fn pyth_settles_on_a_config_migrated_from_v1() {
    let signer = Keypair::new();
    let mut sh = SettlementHarness::new();
    let v1 = sh.h().downgrade_config_to_v1();
    expect_success(&sh.h().migrate_config(Some(pyth_params(signer.pubkey()))));
    assert_eq!(&sh.h().config_account().data[..v1.len()], &v1[..]);
    expect_success(&sh.settle_pyth(&signer, PRICE_ABOVE));
    assert_eq!(sh.market().outcome, Outcome::Yes);
}
