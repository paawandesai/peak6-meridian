//! AB-04 on the Pyth Lazer path (D-055, D-056): a settle_market that reads a Pyth update must
//! only accept bytes the pinned signer signed, verified by the Ed25519 precompile BEFORE the
//! settle runs, for the market's own feed, in the protocol's real encoding.

use anchor_lang::prelude::Pubkey;
use litesvm::types::TransactionResult;
use meridian::errors::MeridianError;
use meridian::pyth::feed_ids;
use meridian::state::MarketStatus;
use security_tests::harness::migration::pyth_params;
use security_tests::harness::pyth::{
    ed25519_ix, ed25519_ix_raw, pyth_payload, settle_market_pyth_ix, META_FEED_ID, PYTH_EXPONENT,
};
use security_tests::harness::settlement::SettlementHarness;
use security_tests::harness::{
    default_params, error_code, expect_failure, expect_success, symbol, MarketArgs, BASE_CLOSE_TS,
};
use solana_sdk::compute_budget::ComputeBudgetInstruction;
use solana_sdk::instruction::{Instruction, InstructionError};
use solana_sdk::signature::{Keypair, Signer};
use solana_sdk::transaction::{Transaction, TransactionError};

const PRICE: i64 = 68_125_000_000;

fn pinned_to(signer: Pubkey, mut sh: SettlementHarness) -> SettlementHarness {
    let automation = sh.h().config().automation_authority;
    let pyth = pyth_params(signer);
    let mut params = default_params(automation);
    params.tickers = vec![];
    params.pyth_lazer_signer = pyth.pyth_lazer_signer;
    params.pyth_feed_ids = pyth.pyth_feed_ids;
    params.pyth_max_age_secs = pyth.pyth_max_age_secs;
    expect_success(&sh.h().update_config(&params));
    sh
}

// LiteSVM's TransactionResult carries the failed transaction's metadata by value.
#[allow(clippy::result_large_err)]
fn send(sh: &mut SettlementHarness, instructions: &[Instruction]) -> TransactionResult {
    let payer = sh.payer.insecure_clone();
    let h = sh.h();
    h.svm.expire_blockhash();
    let tx = Transaction::new_signed_with_payer(
        instructions,
        Some(&payer.pubkey()),
        &[&payer],
        h.svm.latest_blockhash(),
    );
    h.svm.send_transaction(tx)
}

fn assert_error_at(result: &TransactionResult, index: u8, expected: MeridianError) {
    let failure = expect_failure(result);
    assert_eq!(
        failure.err,
        TransactionError::InstructionError(index, InstructionError::Custom(error_code(expected))),
        "expected {expected:?}; logs: {:#?}",
        failure.meta.logs
    );
}

fn at_close() -> Vec<u8> {
    pyth_payload(
        META_FEED_ID,
        PRICE,
        PYTH_EXPONENT,
        BASE_CLOSE_TS * 1_000_000,
    )
}

#[test]
fn ab_04_an_update_signed_by_anyone_but_the_pinned_signer_is_rejected() {
    let pinned = Keypair::new();
    let mut sh = pinned_to(pinned.pubkey(), SettlementHarness::new());
    let attacker = Keypair::new();
    assert_error_at(
        &sh.settle_pyth_signed(&attacker, &at_close()),
        1,
        MeridianError::PythWrongSigner,
    );
    assert_eq!(sh.market().status, MarketStatus::Open);
}

#[test]
fn ab_04_pyths_real_signed_close_is_rejected_when_another_signer_is_pinned() {
    // Pyth's own update (AAPL, 2026-10-09 16:00 ET) with an attacker key pinned instead of Pyth's.
    let json: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../programs/meridian/tests/fixtures/pyth/lazer_aapl_close_2026-10-09.json"
    ))
    .unwrap();
    let hex = json["solanaHex"].as_str().unwrap();
    let message: Vec<u8> = (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
        .collect();
    let close = json["closeTs"].as_i64().unwrap();
    let mut sh = pinned_to(
        Pubkey::new_unique(),
        SettlementHarness::with_market(&MarketArgs {
            ticker: symbol("AAPL"),
            strike_cents: 33_000,
            trading_date: 20_261_009,
            close_ts: close,
        }),
    );
    let settle = settle_market_pyth_ix(sh.payer.pubkey(), &sh.addresses, 0);
    assert_error_at(
        &send(&mut sh, &[ed25519_ix_raw(&message), settle]),
        1,
        MeridianError::PythWrongSigner,
    );
}

#[test]
fn ab_04_a_validly_signed_update_for_another_feed_is_rejected() {
    let signer = Keypair::new();
    let mut sh = pinned_to(signer.pubkey(), SettlementHarness::new());
    let tsla = pyth_payload(
        feed_ids::TSLA,
        PRICE,
        PYTH_EXPONENT,
        BASE_CLOSE_TS * 1_000_000,
    );
    assert_error_at(
        &sh.settle_pyth_signed(&signer, &tsla),
        1,
        MeridianError::OracleFeedHashMismatch,
    );
}

#[test]
fn ab_04_the_index_must_point_at_an_ed25519_instruction() {
    // Index 0 is a compute-budget instruction, not the Ed25519 precompile.
    let signer = Keypair::new();
    let mut sh = pinned_to(signer.pubkey(), SettlementHarness::new());
    let settle = settle_market_pyth_ix(sh.payer.pubkey(), &sh.addresses, 0);
    let decoy = ComputeBudgetInstruction::set_compute_unit_limit(400_000);
    assert_error_at(
        &send(&mut sh, &[decoy, settle]),
        1,
        MeridianError::OracleWrongOwner,
    );
}

#[test]
fn ab_04_an_ed25519_instruction_after_the_settle_is_not_trusted() {
    // The verify instruction must have run before settle_market reads it.
    let signer = Keypair::new();
    let mut sh = pinned_to(signer.pubkey(), SettlementHarness::new());
    let settle = settle_market_pyth_ix(sh.payer.pubkey(), &sh.addresses, 1);
    assert_error_at(
        &send(&mut sh, &[settle, ed25519_ix(&signer, &at_close())]),
        0,
        MeridianError::OracleInvalidValue,
    );
    assert_eq!(sh.market().status, MarketStatus::Open);
}

#[test]
fn ab_04_a_payload_in_the_pre_fix_encoding_is_rejected() {
    // !151's parser expected a presence byte before Price; the real protocol has none. A payload
    // in that shape, even signed by the pinned key, must not parse.
    let signer = Keypair::new();
    let mut sh = pinned_to(signer.pubkey(), SettlementHarness::new());
    let mut legacy = at_close();
    legacy.truncate(19);
    legacy[18] = 2; // Price + Exponent
    legacy.extend_from_slice(&[0, 1]);
    legacy.extend_from_slice(&PRICE.to_le_bytes());
    legacy.push(4);
    legacy.extend_from_slice(&PYTH_EXPONENT.to_le_bytes());
    assert_error_at(
        &sh.settle_pyth_signed(&signer, &legacy),
        1,
        MeridianError::OracleInvalidValue,
    );
}
