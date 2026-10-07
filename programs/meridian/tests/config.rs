//! `initialize_config` and `update_config` (M1-02 AC1, AC2; FR-01): success and failure paths
//! against the built program in LiteSVM.

mod common;

use anchor_lang::error::ErrorCode;
use anchor_lang::prelude::Pubkey;
use common::{
    assert_anchor_error, assert_meridian_error, config_pda, default_params, expect_failure,
    expect_success, expected_tickers, find_event, mag7_slots, symbol, ticker, transaction_size,
    Harness, MAG7,
};
use meridian::errors::MeridianError;
use meridian::events::{ConfigInitialized, ConfigUpdated};
use meridian::state::{ConfigParams, Ticker, TickerSlot, MAX_TICKER_SLOTS_PER_CALL, TICKER_COUNT};
use solana_sdk::packet::PACKET_DATA_SIZE;
use solana_sdk::signature::Signer;

/// Asserts the scalar fields of `params` and the ticker array `tickers` are stored.
fn assert_stored(
    harness: &Harness,
    params: &ConfigParams,
    usdc_mint: Pubkey,
    tickers: &[Ticker; TICKER_COUNT],
) {
    let config = harness.config();
    assert_eq!(config.automation_authority, params.automation_authority);
    assert_eq!(config.usdc_mint, usdc_mint);
    assert_eq!(config.max_staleness_slots, params.max_staleness_slots);
    assert_eq!(config.max_conf_bps, params.max_conf_bps);
    assert_eq!(config.override_delay_secs, params.override_delay_secs);
    assert_eq!(&config.tickers, tickers);
}

/// Asserts `params` applied over an empty ticker array are stored.
fn assert_params_stored(harness: &Harness, params: &ConfigParams, usdc_mint: Pubkey) {
    assert_stored(harness, params, usdc_mint, &expected_tickers(params, None));
}

// ---- initialize_config ---------------------------------------------------------------------

#[test]
fn initialize_config_stores_all_fields() {
    let mut harness = Harness::new();
    let automation = Pubkey::new_unique();
    let params = default_params(automation);

    let result = harness.initialize_config(&params);
    let meta = expect_success(&result);

    let config = harness.config();
    assert_eq!(config.admin, harness.admin.pubkey());
    assert!(!config.paused);
    let (expected_pda, expected_bump) =
        Pubkey::find_program_address(&[meridian::state::CONFIG_SEED], &meridian::ID);
    assert_eq!(expected_pda, config_pda());
    assert_eq!(config.bump, expected_bump);
    assert_params_stored(&harness, &params, harness.usdc_mint);
    for (stored, text) in config.tickers.iter().zip(MAG7).take(6) {
        assert_eq!(stored.symbol_bytes(), text.as_bytes());
        assert_eq!(config.ticker(&symbol(text)), Some(stored));
    }
    assert!(config.tickers[6].is_empty());
    assert_eq!(config.ticker(&symbol("TSLA")), None);
    assert_eq!(config.ticker(&symbol("")), None, "empty slots never match");

    let event: ConfigInitialized = find_event(meta).expect("ConfigInitialized event emitted");
    assert_eq!(event.admin, harness.admin.pubkey());
    assert_eq!(event.automation_authority, automation);
    assert_eq!(event.usdc_mint, harness.usdc_mint);

    // The seventh ticker arrives with update_config and leaves the first six untouched.
    let mut rest = params.clone();
    rest.tickers = mag7_slots(6..7);
    expect_success(&harness.update_config(&rest));
    let config = harness.config();
    let full = expected_tickers(&rest, Some(expected_tickers(&params, None)));
    assert_stored(&harness, &rest, harness.usdc_mint, &full);
    for (stored, text) in config.tickers.iter().zip(MAG7) {
        assert!(!stored.is_empty());
        assert_eq!(config.ticker(&symbol(text)), Some(stored));
    }
}

/// Why `ConfigParams` carries ticker slots: all seven tickers do not fit in one transaction.
#[test]
fn six_ticker_slots_fit_in_one_transaction_and_seven_do_not() {
    let harness = Harness::new();
    let admin = harness.admin.insecure_clone();

    let six = default_params(Pubkey::new_unique());
    assert_eq!(six.tickers.len(), MAX_TICKER_SLOTS_PER_CALL);
    let tx = harness.transaction(
        Harness::initialize_config_ix(&admin, harness.usdc_mint, &six),
        &[&admin],
    );
    assert!(
        transaction_size(&tx) <= PACKET_DATA_SIZE,
        "{}",
        transaction_size(&tx)
    );

    let mut seven = default_params(Pubkey::new_unique());
    seven.tickers = mag7_slots(0..7);
    let tx = harness.transaction(
        Harness::initialize_config_ix(&admin, harness.usdc_mint, &seven),
        &[&admin],
    );
    assert!(
        transaction_size(&tx) > PACKET_DATA_SIZE,
        "{}",
        transaction_size(&tx)
    );
}

#[test]
fn initialize_config_rejects_more_than_six_ticker_slots() {
    let mut harness = Harness::new();
    let mut params = default_params(Pubkey::new_unique());
    // Seven distinct slots cannot be sent, so repeat a valid one to exceed the cap on-chain.
    params.tickers = mag7_slots([0, 1, 2, 3, 4, 5, 5]);
    // Shrink the transaction below the packet limit by sending small feed-less slots instead.
    for slot in &mut params.tickers {
        slot.ticker.feeds = [Pubkey::default(); 2];
    }
    let result = harness.svm.send_transaction(harness.transaction(
        Harness::initialize_config_ix(&harness.admin.insecure_clone(), harness.usdc_mint, &params),
        &[&harness.admin.insecure_clone()],
    ));
    assert_meridian_error(&result, MeridianError::TooManyTickerSlots);
    assert!(harness.config_is_absent());
}

#[test]
fn initialize_config_rejects_bad_ticker_slots() {
    let mut harness = Harness::new();
    let base = default_params(Pubkey::new_unique());

    let mut params = base.clone();
    params.tickers[2].index = TICKER_COUNT as u8;
    assert_meridian_error(
        &harness.initialize_config(&params),
        MeridianError::InvalidTickerSlot,
    );

    let mut params = base.clone();
    params.tickers[2].index = params.tickers[1].index;
    assert_meridian_error(
        &harness.initialize_config(&params),
        MeridianError::DuplicateTickerSlot,
    );
    assert!(harness.config_is_absent());

    // Any subset of slots is fine, including none.
    let mut params = base.clone();
    params.tickers = Vec::new();
    expect_success(&harness.initialize_config(&params));
    assert_params_stored(&harness, &params, harness.usdc_mint);
    assert!(harness.config().tickers.iter().all(Ticker::is_empty));
}

#[test]
fn initialize_config_second_call_fails_and_keeps_the_first_config() {
    let mut harness = Harness::new();
    let first = default_params(Pubkey::new_unique());
    expect_success(&harness.initialize_config(&first));

    let second = default_params(Pubkey::new_unique());
    expect_failure(&harness.initialize_config(&second));
    assert_params_stored(&harness, &first, harness.usdc_mint);

    // Not even another signer with another mint can re-initialise (AB-06).
    let intruder = harness.funded_keypair();
    let other_mint = harness.create_mint(6);
    expect_failure(&harness.initialize_config_as(&intruder, other_mint, &second));
    let config = harness.config();
    assert_eq!(config.admin, harness.admin.pubkey());
    assert_params_stored(&harness, &first, harness.usdc_mint);
}

#[test]
fn initialize_config_rejects_a_mint_without_six_decimals() {
    let mut harness = Harness::new();
    let params = default_params(Pubkey::new_unique());
    for decimals in [0, 5, 7, 9] {
        let mint = harness.create_mint(decimals);
        let admin = harness.admin.insecure_clone();
        let result = harness.initialize_config_as(&admin, mint, &params);
        assert_meridian_error(&result, MeridianError::InvalidUsdcMint);
    }
    assert!(harness.config_is_absent());
}

#[test]
fn initialize_config_rejects_a_non_mint_account_as_usdc_mint() {
    let mut harness = Harness::new();
    let params = default_params(Pubkey::new_unique());
    let admin = harness.admin.insecure_clone();
    let not_a_mint = harness.funded_keypair().pubkey();
    let result = harness.initialize_config_as(&admin, not_a_mint, &params);
    assert_anchor_error(&result, ErrorCode::AccountOwnedByWrongProgram);
    assert!(harness.config_is_absent());
}

#[test]
fn initialize_config_rejects_invalid_ticker_symbols() {
    let mut harness = Harness::new();
    let base = default_params(Pubkey::new_unique());
    let bad_symbols: [[u8; 8]; 4] = [
        *b"\0\0\0\0\0\0\0\0",
        *b"meta\0\0\0\0",
        *b"MET\0A\0\0\0",
        *b"META-1\0\0",
    ];
    for bad in bad_symbols {
        let mut params = base.clone();
        params.tickers[3].ticker.symbol = bad;
        let result = harness.initialize_config(&params);
        assert_meridian_error(&result, MeridianError::InvalidTickerSymbol);
    }
    assert!(harness.config_is_absent());
}

#[test]
fn initialize_config_rejects_duplicate_ticker_symbols() {
    let mut harness = Harness::new();
    let mut params = default_params(Pubkey::new_unique());
    params.tickers[5].ticker = ticker("AAPL", 42);
    let result = harness.initialize_config(&params);
    assert_meridian_error(&result, MeridianError::DuplicateTickerSymbol);
    assert!(harness.config_is_absent());

    // Also across calls: a slot written later may not repeat a symbol already stored.
    expect_success(&harness.initialize_config(&default_params(Pubkey::new_unique())));
    let mut params = default_params(Pubkey::new_unique());
    params.tickers = vec![TickerSlot {
        index: 6,
        ticker: ticker("MSFT", 7),
    }];
    assert_meridian_error(
        &harness.update_config(&params),
        MeridianError::DuplicateTickerSymbol,
    );
    // Rewriting the slot that holds the symbol is fine.
    let mut params = default_params(Pubkey::new_unique());
    params.tickers = vec![TickerSlot {
        index: 1,
        ticker: ticker("MSFT", 7),
    }];
    expect_success(&harness.update_config(&params));
}

#[test]
fn initialize_config_rejects_out_of_range_parameters() {
    let mut harness = Harness::new();
    let base = default_params(Pubkey::new_unique());

    let mut params = base.clone();
    params.max_staleness_slots = 0;
    assert_meridian_error(
        &harness.initialize_config(&params),
        MeridianError::InvalidMaxStaleness,
    );

    for bps in [0, 10_001, u16::MAX] {
        let mut params = base.clone();
        params.max_conf_bps = bps;
        assert_meridian_error(
            &harness.initialize_config(&params),
            MeridianError::InvalidMaxConfBps,
        );
    }
    assert!(harness.config_is_absent());

    // The boundaries themselves are accepted.
    let mut params = base.clone();
    params.max_staleness_slots = 1;
    params.max_conf_bps = 10_000;
    params.override_delay_secs = 0;
    expect_success(&harness.initialize_config(&params));
    assert_params_stored(&harness, &params, harness.usdc_mint);
}

// ---- update_config ------------------------------------------------------------------------

#[test]
fn update_config_replaces_every_configurable_field_but_not_the_admin() {
    let mut harness = Harness::new();
    let initial = default_params(Pubkey::new_unique());
    expect_success(&harness.initialize_config(&initial));

    let mut updated = default_params(Pubkey::new_unique());
    updated.max_staleness_slots = 45;
    updated.max_conf_bps = 10;
    updated.override_delay_secs = 7_200;
    updated.tickers[0].ticker = ticker("NFLX", 99);
    let new_mint = harness.create_mint(6);
    let admin = harness.admin.insecure_clone();

    let result = harness.update_config_as(&admin, config_pda(), new_mint, &updated);
    let meta = expect_success(&result);

    let config = harness.config();
    assert_eq!(config.admin, harness.admin.pubkey());
    assert!(!config.paused);
    let tickers = expected_tickers(&updated, Some(expected_tickers(&initial, None)));
    assert_stored(&harness, &updated, new_mint, &tickers);
    assert_eq!(config.tickers[0].symbol_bytes(), b"NFLX");
    assert_ne!(config.automation_authority, initial.automation_authority);

    let event: ConfigUpdated = find_event(meta).expect("ConfigUpdated event emitted");
    assert_eq!(event.admin, harness.admin.pubkey());
    assert_eq!(event.automation_authority, updated.automation_authority);
    assert_eq!(event.usdc_mint, new_mint);
}

#[test]
fn update_config_fails_for_a_non_admin_signer() {
    let mut harness = Harness::new();
    let initial = default_params(Pubkey::new_unique());
    expect_success(&harness.initialize_config(&initial));

    let intruder = harness.funded_keypair();
    let usdc_mint = harness.usdc_mint;
    let attempt = default_params(intruder.pubkey());
    let result = harness.update_config_as(&intruder, config_pda(), usdc_mint, &attempt);
    assert_meridian_error(&result, MeridianError::AdminOnly);
    assert_params_stored(&harness, &initial, usdc_mint);
}

#[test]
fn update_config_fails_before_initialize_config() {
    let mut harness = Harness::new();
    let params = default_params(Pubkey::new_unique());
    let result = harness.update_config(&params);
    assert_anchor_error(&result, ErrorCode::AccountNotInitialized);
    assert!(harness.config_is_absent());
}

#[test]
fn update_config_rejects_invalid_parameters_and_keeps_the_old_config() {
    let mut harness = Harness::new();
    let initial = default_params(Pubkey::new_unique());
    expect_success(&harness.initialize_config(&initial));

    let mut params = initial.clone();
    params.max_conf_bps = 0;
    assert_meridian_error(
        &harness.update_config(&params),
        MeridianError::InvalidMaxConfBps,
    );

    let mut params = initial.clone();
    params.max_staleness_slots = 0;
    assert_meridian_error(
        &harness.update_config(&params),
        MeridianError::InvalidMaxStaleness,
    );

    let mut params = initial.clone();
    params.tickers[1].ticker.symbol = *b"msft\0\0\0\0";
    assert_meridian_error(
        &harness.update_config(&params),
        MeridianError::InvalidTickerSymbol,
    );

    let mut params = initial.clone();
    params.tickers[2].ticker = params.tickers[1].ticker;
    assert_meridian_error(
        &harness.update_config(&params),
        MeridianError::DuplicateTickerSymbol,
    );

    let mut params = initial.clone();
    params.tickers[2].index = 9;
    assert_meridian_error(
        &harness.update_config(&params),
        MeridianError::InvalidTickerSlot,
    );

    let mut params = initial.clone();
    params.tickers[2].index = params.tickers[0].index;
    assert_meridian_error(
        &harness.update_config(&params),
        MeridianError::DuplicateTickerSlot,
    );

    let bad_mint = harness.create_mint(9);
    let admin = harness.admin.insecure_clone();
    assert_meridian_error(
        &harness.update_config_as(&admin, config_pda(), bad_mint, &initial),
        MeridianError::InvalidUsdcMint,
    );

    assert_params_stored(&harness, &initial, harness.usdc_mint);
}
