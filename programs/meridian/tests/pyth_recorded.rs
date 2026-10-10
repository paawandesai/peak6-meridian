//! `settle_market` from updates Pyth Lazer itself signed (D-055, D-056): the close of Friday
//! 2026-10-09 for all seven tickers, recorded by `pnpm --filter e2e pyth-record` into
//! `tests/fixtures/pyth/lazer_<ticker>_close_2026-10-09.json`. The Config pins Pyth's production
//! signer (`9gKEEcFzSd1PDYBKWAKZi4Sq4ZCUaVX5oTr8kEjdwsfR`); the Ed25519 precompile verifies
//! Pyth's real signature, then the program applies its own rules to the real payload.

// Test code: the program rules on unwrap/panic/arithmetic do not apply here.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::arithmetic_side_effects
)]

mod common;

use anchor_lang::prelude::Pubkey;
use common::migration::pyth_params;
use common::settlement::SettlementHarness;
use common::{default_params, error_code, expect_failure, expect_success, symbol, MarketArgs};
use meridian::errors::MeridianError;
use meridian::pyth::parse_pyth_lazer_message;
use meridian::state::{MarketStatus, Outcome, SettleSource};
use solana_sdk::instruction::InstructionError;
use solana_sdk::transaction::TransactionError;

/// Pyth Lazer's production Ed25519 signer (trusted by the Pyth Lazer program on mainnet and devnet).
const PYTH_LAZER_SIGNER: Pubkey = anchor_lang::pubkey!("9gKEEcFzSd1PDYBKWAKZi4Sq4ZCUaVX5oTr8kEjdwsfR");
/// 2026-10-09 16:00 ET.
const FRIDAY_CLOSE_TS: i64 = 1_791_576_000;
const FRIDAY: u32 = 20_261_009;
const TICKERS: [&str; 7] = ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA"];

struct Recorded {
    message: Vec<u8>,
    price_cents: u64,
}

fn recorded(ticker: &str) -> Recorded {
    let path = format!(
        "{}/tests/fixtures/pyth/lazer_{}_close_2026-10-09.json",
        env!("CARGO_MANIFEST_DIR"),
        ticker.to_lowercase()
    );
    let json: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    let hex = json["solanaHex"].as_str().unwrap();
    let message = (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
        .collect();
    let price_cents = json["priceCents"].as_str().unwrap().parse().unwrap();
    Recorded {
        message,
        price_cents,
    }
}

/// A Friday market for `ticker` at `strike_cents` closing at `close_ts`, with Pyth's production
/// signer pinned and `max_conf_bps` as given.
fn friday(ticker: &str, strike_cents: u64, close_ts: i64, max_conf_bps: u16) -> SettlementHarness {
    let mut sh = SettlementHarness::with_market(&MarketArgs {
        ticker: symbol(ticker),
        strike_cents,
        trading_date: FRIDAY,
        close_ts,
    });
    let automation = sh.h().config().automation_authority;
    let pyth = pyth_params(PYTH_LAZER_SIGNER);
    let mut params = default_params(automation);
    params.tickers = vec![];
    params.max_conf_bps = max_conf_bps;
    params.pyth_lazer_signer = pyth.pyth_lazer_signer;
    params.pyth_feed_ids = pyth.pyth_feed_ids;
    params.pyth_max_age_secs = pyth.pyth_max_age_secs;
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

#[test]
fn every_recorded_friday_close_is_signed_by_pyth_and_parses() {
    for ticker in TICKERS {
        let r = recorded(ticker);
        let (signer, reading) = parse_pyth_lazer_message(&r.message).unwrap();
        assert_eq!(signer, PYTH_LAZER_SIGNER, "{ticker}");
        assert_eq!(reading.timestamp_us, FRIDAY_CLOSE_TS * 1_000_000, "{ticker}");
        assert!(reading.confidence.is_some(), "{ticker}");
    }
}

#[test]
fn each_ticker_settles_from_its_real_friday_close() {
    for ticker in TICKERS {
        let r = recorded(ticker);
        // Strikes are multiples of $10: one at or below the close (YES), one above (NO).
        let below = r.price_cents / 1_000 * 1_000;
        for (strike, outcome) in [(below, Outcome::Yes), (below + 1_000, Outcome::No)] {
            let mut sh = friday(ticker, strike, FRIDAY_CLOSE_TS, 5);
            expect_success(&sh.settle_pyth_recorded(&r.message));
            let market = sh.market();
            assert_eq!(market.status, MarketStatus::Settled, "{ticker} {strike}");
            assert_eq!(market.outcome, outcome, "{ticker} {strike}");
            assert_eq!(market.settle_source, SettleSource::Oracle);
            let (_, reading) = parse_pyth_lazer_message(&r.message).unwrap();
            assert_eq!(market.settle_price_scaled, reading.value_scaled);
        }
    }
}

#[test]
fn the_real_update_is_rejected_under_a_different_pinned_signer() {
    let r = recorded("AAPL");
    let mut sh = friday("AAPL", 33_000, FRIDAY_CLOSE_TS, 5);
    let automation = sh.h().config().automation_authority;
    let mut params = default_params(automation);
    params.tickers = vec![];
    let pyth = pyth_params(Pubkey::new_unique());
    params.pyth_lazer_signer = pyth.pyth_lazer_signer;
    params.pyth_feed_ids = pyth.pyth_feed_ids;
    expect_success(&sh.h().update_config(&params));
    assert_settle_error(
        &sh.settle_pyth_recorded(&r.message),
        MeridianError::PythWrongSigner,
    );
    assert_eq!(sh.market().status, MarketStatus::Open);
}

#[test]
fn the_real_aapl_update_cannot_settle_an_amzn_market() {
    let r = recorded("AAPL");
    let mut sh = friday("AMZN", 26_000, FRIDAY_CLOSE_TS, 5);
    assert_settle_error(
        &sh.settle_pyth_recorded(&r.message),
        MeridianError::OracleFeedHashMismatch,
    );
}

#[test]
fn the_real_close_cannot_settle_a_market_closing_later() {
    // A market closing one second after 16:00 ET: Pyth's 16:00:00 update is pre-close for it.
    let r = recorded("AAPL");
    let mut sh = friday("AAPL", 33_000, FRIDAY_CLOSE_TS + 1, 5);
    assert_settle_error(
        &sh.settle_pyth_recorded(&r.message),
        MeridianError::OracleBeforeClose,
    );
}

#[test]
fn the_real_close_is_rejected_when_its_confidence_is_wider_than_max_conf_bps() {
    // AAPL's recorded confidence is 2.49 bps: fine at 5, too wide at 2.
    let r = recorded("AAPL");
    let mut sh = friday("AAPL", 33_000, FRIDAY_CLOSE_TS, 2);
    assert_settle_error(
        &sh.settle_pyth_recorded(&r.message),
        MeridianError::PythConfidenceTooWide,
    );
    assert_eq!(sh.market().status, MarketStatus::Open);
}

#[test]
fn the_real_close_cannot_settle_a_market_whose_window_ended_before_it() {
    // A market closing 31 s before 16:00 ET with a 30 s window: the 16:00:00 update is too late.
    let r = recorded("AAPL");
    let mut sh = friday("AAPL", 33_000, FRIDAY_CLOSE_TS - 31, 5);
    assert_settle_error(
        &sh.settle_pyth_recorded(&r.message),
        MeridianError::PythAfterCloseWindow,
    );
}
