//! M2-15 AC2: `settle_market` with RedStone path tests.
//! Tests: success after post, rejection cases (OracleBeforeClose, RedStonePackageTooLate,
//! OracleStale, wrong PDA, NotClosed), property test at strike boundary.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::arithmetic_side_effects
)]

mod common;

use anchor_lang::prelude::Pubkey;
use anchor_lang::{AccountDeserialize, InstructionData, ToAccountMetas};
use common::redstone::{RedstonePayloadBuilder, TestSigner};
use common::{
    config_pda, expect_success, symbol, MarketArgs, MarketHarness, BASE_CLOSE_TS,
    BASE_TRADING_DATE, FUNDING_LAMPORTS,
};
use meridian::state::{Market, MarketStatus, Outcome};
use solana_sdk::instruction::Instruction;
use solana_sdk::signature::{Keypair, Signer};
use solana_sdk::system_program;

const THRESHOLD: u8 = 3;

/// Sets up oracle config and creates a market. Returns the signers for use in tests.
fn setup_market_with_redstone() -> (MarketHarness, MarketArgs, Pubkey, Vec<TestSigner>) {
    let mut harness = MarketHarness::new();

    // Setup RedStone oracle config
    let admin = harness.harness.admin.insecure_clone();

    let signers: Vec<TestSigner> = (0..5).map(|_| TestSigner::generate()).collect();
    let addresses: Vec<[u8; 20]> = signers.iter().map(|s| s.ethereum_address()).collect();

    let (oracle_config_pda, _) = Pubkey::find_program_address(&[b"oracle_config"], &meridian::ID);

    let params = meridian::SetOracleConfigParams {
        signers: addresses.clone(),
        signer_threshold: THRESHOLD,
        max_package_delay_secs: 600,
    };

    let ix = meridian::instruction::SetOracleConfig { params };
    let accounts = meridian::accounts::SetOracleConfig {
        config: config_pda(),
        oracle_config: oracle_config_pda,
        admin: admin.pubkey(),
        system_program: system_program::ID,
    };

    let instruction = Instruction {
        program_id: meridian::ID,
        accounts: accounts.to_account_metas(None),
        data: ix.data(),
    };
    let result = harness
        .harness
        .send_with_budget(instruction, &[&admin], 400_000);
    expect_success(&result);

    // Create a market
    let args = MarketArgs {
        ticker: symbol("NVDA"),
        strike_cents: 200_000, // $2000 strike
        trading_date: BASE_TRADING_DATE,
        close_ts: BASE_CLOSE_TS,
    };

    let addresses = harness.create_market(&args);

    // Advance time to after market close
    harness.harness.set_unix_timestamp(BASE_CLOSE_TS + 300); // 5 min after close

    (harness, args, addresses.market, signers)
}

#[test]
fn settle_market_succeeds_after_redstone_post() {
    // AC2: settle_market succeeds after a fresh post_redstone_price
    let (mut harness, args, market_pda, signers) = setup_market_with_redstone();

    // Use first 3 signers (threshold is 3)
    let signing_signers = &signers[..3];

    let payer = Keypair::new();
    harness
        .harness
        .svm
        .airdrop(&payer.pubkey(), FUNDING_LAMPORTS)
        .unwrap();

    let ticker = args.ticker;
    let value = 2050_0000_0000u128; // $2050 > $2000 strike → YES wins
    let timestamp_ms = BASE_CLOSE_TS
        .checked_mul(1000)
        .and_then(|t| t.checked_add(1000))
        .unwrap(); // 1s after close

    // Post RedStone price
    let mut builder = RedstonePayloadBuilder::new("NVDA", value, timestamp_ms);
    for signer in signing_signers {
        builder = builder.add_signer(signer.clone());
    }
    let payload = builder.build();

    let (price_pda, _) = Pubkey::find_program_address(&[b"redstone_price", &ticker], &meridian::ID);

    let (oracle_config_pda, _) = Pubkey::find_program_address(&[b"oracle_config"], &meridian::ID);

    let ix = meridian::instruction::PostRedstonePrice {
        symbol: ticker,
        payload,
    };

    let accounts = meridian::accounts::PostRedstonePrice {
        oracle_config: oracle_config_pda,
        market: market_pda,
        redstone_price: price_pda,
        payer: payer.pubkey(),
        system_program: system_program::ID,
    };

    let instruction = Instruction {
        program_id: meridian::ID,
        accounts: accounts.to_account_metas(None),
        data: ix.data(),
    };
    let result = harness
        .harness
        .send_with_budget(instruction, &[&payer], 400_000);
    expect_success(&result);

    // Now settle the market
    let settler = Keypair::new();
    harness
        .harness
        .svm
        .airdrop(&settler.pubkey(), FUNDING_LAMPORTS)
        .unwrap();

    let settle_ix = meridian::instruction::SettleMarket {};
    let settle_accounts = meridian::accounts::SettleMarket {
        config: config_pda(),
        market: market_pda,
        feed_tiingo: Pubkey::default(),
        feed_twelve_data: Pubkey::default(),
        redstone_price: Some(price_pda),
        oracle_config: Some(oracle_config_pda),
        payer: settler.pubkey(),
    };

    let settle_instruction = Instruction {
        program_id: meridian::ID,
        accounts: settle_accounts.to_account_metas(None),
        data: settle_ix.data(),
    };
    let settle_result = harness.harness.send(settle_instruction, &[&settler]);
    expect_success(&settle_result);

    // Verify market is settled with YES outcome
    let account = harness.harness.svm.get_account(&market_pda).unwrap();
    let mut data = account.data.as_slice();
    let market = Market::try_deserialize(&mut data).unwrap();
    assert_eq!(market.status, MarketStatus::Settled);
    assert_eq!(market.outcome, Outcome::Yes);
}

#[test]
fn post_redstone_price_fails_package_before_close() {
    // AC2: post_redstone_price rejects package timestamp before close_ts → OracleBeforeClose
    let (mut harness, args, market_pda, signers) = setup_market_with_redstone();

    let signing_signers = &signers[..3];
    let payer = Keypair::new();
    harness
        .harness
        .svm
        .airdrop(&payer.pubkey(), FUNDING_LAMPORTS)
        .unwrap();

    let ticker = args.ticker;
    let value = 2050_0000_0000u128;
    // Timestamp BEFORE close_ts
    let timestamp_ms = BASE_CLOSE_TS
        .checked_sub(60)
        .and_then(|t| t.checked_mul(1000))
        .unwrap(); // 1 min before close

    let mut builder = RedstonePayloadBuilder::new(
        std::str::from_utf8(&ticker).unwrap().trim_end_matches('\0'),
        value,
        timestamp_ms,
    );
    for signer in signing_signers {
        builder = builder.add_signer(signer.clone());
    }
    let payload = builder.build();

    let (price_pda, _) = Pubkey::find_program_address(&[b"redstone_price", &ticker], &meridian::ID);
    let (oracle_config_pda, _) = Pubkey::find_program_address(&[b"oracle_config"], &meridian::ID);

    let post_ix = meridian::instruction::PostRedstonePrice {
        symbol: ticker,
        payload,
    };

    let post_accounts = meridian::accounts::PostRedstonePrice {
        oracle_config: oracle_config_pda,
        market: market_pda,
        redstone_price: price_pda,
        payer: payer.pubkey(),
        system_program: system_program::ID,
    };

    let post_instruction = Instruction {
        program_id: meridian::ID,
        accounts: post_accounts.to_account_metas(None),
        data: post_ix.data(),
    };
    let post_result = harness.harness.send(post_instruction, &[&payer]);
    common::assert_meridian_error(
        &post_result,
        meridian::errors::MeridianError::OracleBeforeClose,
    );
}

#[test]
fn post_redstone_price_fails_package_too_late() {
    // AC2: post_redstone_price rejects package timestamp after close_ts + max_package_delay_secs → RedStonePackageTooLate
    let (mut harness, args, market_pda, signers) = setup_market_with_redstone();

    let signing_signers = &signers[..3];
    let payer = Keypair::new();
    harness
        .harness
        .svm
        .airdrop(&payer.pubkey(), FUNDING_LAMPORTS)
        .unwrap();

    let ticker = args.ticker;
    let value = 2050_0000_0000u128;
    // Timestamp after close_ts + max_package_delay_secs (600s)
    let timestamp_ms = BASE_CLOSE_TS
        .checked_add(601)
        .and_then(|t| t.checked_mul(1000))
        .unwrap(); // 601s after close > 600s max delay

    let mut builder = RedstonePayloadBuilder::new(
        std::str::from_utf8(&ticker).unwrap().trim_end_matches('\0'),
        value,
        timestamp_ms,
    );
    for signer in signing_signers {
        builder = builder.add_signer(signer.clone());
    }
    let payload = builder.build();

    let (price_pda, _) = Pubkey::find_program_address(&[b"redstone_price", &ticker], &meridian::ID);
    let (oracle_config_pda, _) = Pubkey::find_program_address(&[b"oracle_config"], &meridian::ID);

    let post_ix = meridian::instruction::PostRedstonePrice {
        symbol: ticker,
        payload,
    };

    let post_accounts = meridian::accounts::PostRedstonePrice {
        oracle_config: oracle_config_pda,
        market: market_pda,
        redstone_price: price_pda,
        payer: payer.pubkey(),
        system_program: system_program::ID,
    };

    let post_instruction = Instruction {
        program_id: meridian::ID,
        accounts: post_accounts.to_account_metas(None),
        data: post_ix.data(),
    };
    let post_result = harness.harness.send(post_instruction, &[&payer]);
    common::assert_meridian_error(
        &post_result,
        meridian::errors::MeridianError::RedStonePackageTooLate,
    );
}

#[test]
fn settle_market_fails_stale_oracle() {
    // AC2: posted more than 30 slots before settle → OracleStale
    let (mut harness, args, market_pda, signers) = setup_market_with_redstone();

    let signing_signers = &signers[..3];
    let payer = Keypair::new();
    harness
        .harness
        .svm
        .airdrop(&payer.pubkey(), FUNDING_LAMPORTS)
        .unwrap();

    let ticker = args.ticker;
    let value = 2050_0000_0000u128;
    let timestamp_ms = BASE_CLOSE_TS
        .checked_mul(1000)
        .and_then(|t| t.checked_add(1000))
        .unwrap();

    // Post RedStone price
    let mut builder = RedstonePayloadBuilder::new("NVDA", value, timestamp_ms);
    for signer in signing_signers {
        builder = builder.add_signer(signer.clone());
    }
    let payload = builder.build();

    let (price_pda, _) = Pubkey::find_program_address(&[b"redstone_price", &ticker], &meridian::ID);
    let (oracle_config_pda, _) = Pubkey::find_program_address(&[b"oracle_config"], &meridian::ID);

    let ix = meridian::instruction::PostRedstonePrice {
        symbol: ticker,
        payload,
    };

    let accounts = meridian::accounts::PostRedstonePrice {
        oracle_config: oracle_config_pda,
        market: market_pda,
        redstone_price: price_pda,
        payer: payer.pubkey(),
        system_program: system_program::ID,
    };

    let instruction = Instruction {
        program_id: meridian::ID,
        accounts: accounts.to_account_metas(None),
        data: ix.data(),
    };
    let result = harness
        .harness
        .send_with_budget(instruction, &[&payer], 400_000);
    expect_success(&result);

    // Get the slot when the price was posted
    let price_account = harness.harness.svm.get_account(&price_pda).unwrap();
    let mut price_data = price_account.data.as_slice();
    let price = meridian::state::RedstonePrice::try_deserialize(&mut price_data).unwrap();
    let posted_slot = price.posted_slot;

    // Advance to 31 slots after posting (> 30 max_staleness_slots)
    harness.harness.set_slot(posted_slot + 31);

    // Try to settle - should fail with OracleStale
    let settler = Keypair::new();
    harness
        .harness
        .svm
        .airdrop(&settler.pubkey(), FUNDING_LAMPORTS)
        .unwrap();

    let settle_ix = meridian::instruction::SettleMarket {};
    let settle_accounts = meridian::accounts::SettleMarket {
        config: config_pda(),
        market: market_pda,
        feed_tiingo: Pubkey::default(),
        feed_twelve_data: Pubkey::default(),
        redstone_price: Some(price_pda),
        oracle_config: Some(oracle_config_pda),
        payer: settler.pubkey(),
    };

    let settle_instruction = Instruction {
        program_id: meridian::ID,
        accounts: settle_accounts.to_account_metas(None),
        data: settle_ix.data(),
    };
    let settle_result = harness.harness.send(settle_instruction, &[&settler]);
    common::assert_meridian_error(&settle_result, meridian::errors::MeridianError::OracleStale);
}

#[test]
fn settle_market_fails_wrong_price_pda() {
    // AC2 / AB-04: non-PDA or other-ticker price account fails
    let (mut harness, _args, market_pda, signers) = setup_market_with_redstone();

    let signing_signers = &signers[..3];
    let payer = Keypair::new();
    harness
        .harness
        .svm
        .airdrop(&payer.pubkey(), FUNDING_LAMPORTS)
        .unwrap();

    // Create TSLA market for post_redstone_price (requires matching ticker)
    harness.harness.set_unix_timestamp(BASE_CLOSE_TS - 3600);
    let tsla_args = MarketArgs {
        ticker: symbol("TSLA"),
        strike_cents: 200_000,
        trading_date: BASE_TRADING_DATE,
        close_ts: BASE_CLOSE_TS,
    };
    harness.create_market(&tsla_args);

    // Post price for TSLA instead of NVDA
    let wrong_ticker = symbol("TSLA");
    let value = 2050_0000_0000u128;
    let timestamp_ms = BASE_CLOSE_TS
        .checked_mul(1000)
        .and_then(|t| t.checked_add(1000))
        .unwrap();

    let mut builder = RedstonePayloadBuilder::new("TSLA", value, timestamp_ms);
    for signer in signing_signers {
        builder = builder.add_signer(signer.clone());
    }
    let payload = builder.build();

    let (wrong_price_pda, _) =
        Pubkey::find_program_address(&[b"redstone_price", &wrong_ticker], &meridian::ID);
    let (oracle_config_pda, _) = Pubkey::find_program_address(&[b"oracle_config"], &meridian::ID);

    let ix = meridian::instruction::PostRedstonePrice {
        symbol: wrong_ticker,
        payload,
    };

    let accounts = meridian::accounts::PostRedstonePrice {
        oracle_config: oracle_config_pda,
        market: {
            let (pda, _) = Pubkey::find_program_address(
                &[
                    meridian::MARKET_SEED,
                    &symbol("TSLA"),
                    &BASE_TRADING_DATE.to_le_bytes(),
                    &200_000u64.to_le_bytes(),
                ],
                &meridian::ID,
            );
            pda
        },
        redstone_price: wrong_price_pda,
        payer: payer.pubkey(),
        system_program: system_program::ID,
    };

    let instruction = Instruction {
        program_id: meridian::ID,
        accounts: accounts.to_account_metas(None),
        data: ix.data(),
    };
    let result = harness
        .harness
        .send_with_budget(instruction, &[&payer], 400_000);
    expect_success(&result);

    // Try to settle NVDA market with TSLA price - should fail with constraint error
    let settler = Keypair::new();
    harness
        .harness
        .svm
        .airdrop(&settler.pubkey(), FUNDING_LAMPORTS)
        .unwrap();

    let settle_ix = meridian::instruction::SettleMarket {};
    let settle_accounts = meridian::accounts::SettleMarket {
        config: config_pda(),
        market: market_pda,
        feed_tiingo: Pubkey::default(),
        feed_twelve_data: Pubkey::default(),
        redstone_price: Some(wrong_price_pda), // TSLA price for NVDA market
        oracle_config: Some(oracle_config_pda),
        payer: settler.pubkey(),
    };

    let settle_instruction = Instruction {
        program_id: meridian::ID,
        accounts: settle_accounts.to_account_metas(None),
        data: settle_ix.data(),
    };
    let settle_result = harness.harness.send(settle_instruction, &[&settler]);
    // Should fail with constraint error (seeds constraint in settle_market)
    common::assert_anchor_error(
        &settle_result,
        anchor_lang::error::ErrorCode::ConstraintSeeds,
    );
}

#[test]
fn settle_market_fails_before_close() {
    // AC2 / AB-05: settle before close → NotClosed
    let (mut harness, args, market_pda, signers) = setup_market_with_redstone();

    // Rewind time to BEFORE market close
    harness.harness.set_unix_timestamp(BASE_CLOSE_TS - 300); // 5 min before close

    let signing_signers = &signers[..3];
    let payer = Keypair::new();
    harness
        .harness
        .svm
        .airdrop(&payer.pubkey(), FUNDING_LAMPORTS)
        .unwrap();

    let ticker = args.ticker;
    let value = 2050_0000_0000u128;
    // Valid timestamp after close
    let timestamp_ms = BASE_CLOSE_TS
        .checked_mul(1000)
        .and_then(|t| t.checked_add(1000))
        .unwrap();

    let mut builder = RedstonePayloadBuilder::new("NVDA", value, timestamp_ms);
    for signer in signing_signers {
        builder = builder.add_signer(signer.clone());
    }
    let payload = builder.build();

    let (price_pda, _) = Pubkey::find_program_address(&[b"redstone_price", &ticker], &meridian::ID);
    let (oracle_config_pda, _) = Pubkey::find_program_address(&[b"oracle_config"], &meridian::ID);

    let ix = meridian::instruction::PostRedstonePrice {
        symbol: ticker,
        payload,
    };

    let accounts = meridian::accounts::PostRedstonePrice {
        oracle_config: oracle_config_pda,
        market: market_pda,
        redstone_price: price_pda,
        payer: payer.pubkey(),
        system_program: system_program::ID,
    };

    let instruction = Instruction {
        program_id: meridian::ID,
        accounts: accounts.to_account_metas(None),
        data: ix.data(),
    };
    let result = harness
        .harness
        .send_with_budget(instruction, &[&payer], 400_000);
    expect_success(&result);

    // Try to settle before close - should fail with NotClosed
    let settler = Keypair::new();
    harness
        .harness
        .svm
        .airdrop(&settler.pubkey(), FUNDING_LAMPORTS)
        .unwrap();

    let settle_ix = meridian::instruction::SettleMarket {};
    let settle_accounts = meridian::accounts::SettleMarket {
        config: config_pda(),
        market: market_pda,
        feed_tiingo: Pubkey::default(),
        feed_twelve_data: Pubkey::default(),
        redstone_price: Some(price_pda),
        oracle_config: Some(oracle_config_pda),
        payer: settler.pubkey(),
    };

    let settle_instruction = Instruction {
        program_id: meridian::ID,
        accounts: settle_accounts.to_account_metas(None),
        data: settle_ix.data(),
    };
    let settle_result = harness.harness.send(settle_instruction, &[&settler]);
    common::assert_meridian_error(&settle_result, meridian::errors::MeridianError::NotClosed);
}

#[test]
fn settle_market_at_strike_boundary() {
    // AC2 property test: value == strike_cents * 10^6 settles YES
    let (mut harness, args, market_pda, signers) = setup_market_with_redstone();

    let signing_signers = &signers[..3];
    let payer = Keypair::new();
    harness
        .harness
        .svm
        .airdrop(&payer.pubkey(), FUNDING_LAMPORTS)
        .unwrap();

    let ticker = args.ticker;
    // Exactly at strike: $2000.00 strike → 2000_0000_0000 (8 decimals)
    let value = u128::from(args.strike_cents)
        .checked_mul(1_000_000)
        .expect("strike * 10^6");
    let timestamp_ms = BASE_CLOSE_TS
        .checked_mul(1000)
        .and_then(|t| t.checked_add(1000))
        .unwrap();

    let mut builder = RedstonePayloadBuilder::new("NVDA", value, timestamp_ms);
    for signer in signing_signers {
        builder = builder.add_signer(signer.clone());
    }
    let payload = builder.build();

    let (price_pda, _) = Pubkey::find_program_address(&[b"redstone_price", &ticker], &meridian::ID);
    let (oracle_config_pda, _) = Pubkey::find_program_address(&[b"oracle_config"], &meridian::ID);

    let ix = meridian::instruction::PostRedstonePrice {
        symbol: ticker,
        payload,
    };

    let accounts = meridian::accounts::PostRedstonePrice {
        oracle_config: oracle_config_pda,
        market: market_pda,
        redstone_price: price_pda,
        payer: payer.pubkey(),
        system_program: system_program::ID,
    };

    let instruction = Instruction {
        program_id: meridian::ID,
        accounts: accounts.to_account_metas(None),
        data: ix.data(),
    };
    let result = harness
        .harness
        .send_with_budget(instruction, &[&payer], 400_000);
    expect_success(&result);

    // Settle the market
    let settler = Keypair::new();
    harness
        .harness
        .svm
        .airdrop(&settler.pubkey(), FUNDING_LAMPORTS)
        .unwrap();

    let settle_ix = meridian::instruction::SettleMarket {};
    let settle_accounts = meridian::accounts::SettleMarket {
        config: config_pda(),
        market: market_pda,
        feed_tiingo: Pubkey::default(),
        feed_twelve_data: Pubkey::default(),
        redstone_price: Some(price_pda),
        oracle_config: Some(oracle_config_pda),
        payer: settler.pubkey(),
    };

    let settle_instruction = Instruction {
        program_id: meridian::ID,
        accounts: settle_accounts.to_account_metas(None),
        data: settle_ix.data(),
    };
    let settle_result = harness.harness.send(settle_instruction, &[&settler]);
    expect_success(&settle_result);

    // Verify market settled YES (value >= strike → YES wins)
    let account = harness.harness.svm.get_account(&market_pda).unwrap();
    let mut data = account.data.as_slice();
    let market = Market::try_deserialize(&mut data).unwrap();
    assert_eq!(market.status, MarketStatus::Settled);
    assert_eq!(
        market.outcome,
        Outcome::Yes,
        "At strike boundary, YES should win"
    );
}

#[test]
fn settle_market_fails_cross_market_timestamp_mismatch() {
    // AC2 / AB-03: post for Market A (close_ts=X), settle Market B (close_ts=Y, Y != X)
    // RedstonePrice timestamp doesn't match B's window → fails settle-side validation

    // Setup without pre-creating a market
    let mut harness = MarketHarness::new();
    let admin = harness.harness.admin.insecure_clone();

    // Setup RedStone oracle config
    let signers: Vec<TestSigner> = (0..5).map(|_| TestSigner::generate()).collect();
    let addresses: Vec<[u8; 20]> = signers.iter().map(|s| s.ethereum_address()).collect();
    let signing_signers = &signers[..3];

    let (oracle_config_pda, _) = Pubkey::find_program_address(&[b"oracle_config"], &meridian::ID);
    let params = meridian::SetOracleConfigParams {
        signers: addresses.clone(),
        signer_threshold: THRESHOLD,
        max_package_delay_secs: 600,
    };
    let ix = meridian::instruction::SetOracleConfig { params };
    let accounts = meridian::accounts::SetOracleConfig {
        config: config_pda(),
        oracle_config: oracle_config_pda,
        admin: admin.pubkey(),
        system_program: system_program::ID,
    };
    let instruction = Instruction {
        program_id: meridian::ID,
        accounts: accounts.to_account_metas(None),
        data: ix.data(),
    };
    let result = harness
        .harness
        .send_with_budget(instruction, &[&admin], 400_000);
    expect_success(&result);

    let payer = Keypair::new();
    harness
        .harness
        .svm
        .airdrop(&payer.pubkey(), FUNDING_LAMPORTS)
        .unwrap();

    let ticker = symbol("NVDA");

    // Market A: close_ts = BASE_CLOSE_TS, strike 200k
    let market_a_close_ts = BASE_CLOSE_TS;
    harness.harness.set_unix_timestamp(market_a_close_ts - 3600);
    let market_a_args = MarketArgs {
        ticker,
        strike_cents: 200_000,
        trading_date: BASE_TRADING_DATE,
        close_ts: market_a_close_ts,
    };
    let market_a_addrs = harness.create_market(&market_a_args);

    // Market B: same ticker, different close_ts (1 day later)
    let market_b_close_ts = market_a_close_ts + 86400; // +1 day
    harness.harness.set_unix_timestamp(market_b_close_ts - 3600);
    let market_b_args = MarketArgs {
        ticker,
        strike_cents: 205_000, // Different strike to get different PDA
        trading_date: BASE_TRADING_DATE,
        close_ts: market_b_close_ts,
    };
    let market_b_addrs = harness.create_market(&market_b_args);

    // Advance past Market A close
    harness.harness.set_unix_timestamp(market_a_close_ts + 300);

    // Post RedStone price for Market A's window (close_ts_a + 100s)
    let timestamp_ms_a = market_a_close_ts * 1000 + 100_000;
    let value = 2050_0000_0000u128;
    let mut builder = RedstonePayloadBuilder::new(
        std::str::from_utf8(&ticker).unwrap().trim_end_matches('\0'),
        value,
        timestamp_ms_a,
    );
    for signer in signing_signers {
        builder = builder.add_signer(signer.clone());
    }
    let payload = builder.build();

    let (price_pda, _) = Pubkey::find_program_address(&[b"redstone_price", &ticker], &meridian::ID);
    let (oracle_config_pda, _) = Pubkey::find_program_address(&[b"oracle_config"], &meridian::ID);

    let post_ix = meridian::instruction::PostRedstonePrice {
        symbol: ticker,
        payload,
    };
    let post_accounts = meridian::accounts::PostRedstonePrice {
        oracle_config: oracle_config_pda,
        market: market_a_addrs.market,
        redstone_price: price_pda,
        payer: payer.pubkey(),
        system_program: system_program::ID,
    };
    let post_instruction = Instruction {
        program_id: meridian::ID,
        accounts: post_accounts.to_account_metas(None),
        data: post_ix.data(),
    };
    let post_result = harness.harness.send(post_instruction, &[&payer]);
    expect_success(&post_result);

    // Advance past Market B close
    harness.harness.set_unix_timestamp(market_b_close_ts + 300);

    // Try to settle Market B - RedstonePrice timestamp (A's window) is before B's close_ts
    let settler = Keypair::new();
    harness
        .harness
        .svm
        .airdrop(&settler.pubkey(), FUNDING_LAMPORTS)
        .unwrap();

    let settle_ix = meridian::instruction::SettleMarket {};
    let settle_accounts = meridian::accounts::SettleMarket {
        config: config_pda(),
        market: market_b_addrs.market,
        feed_tiingo: Pubkey::default(),
        feed_twelve_data: Pubkey::default(),
        redstone_price: Some(price_pda),
        oracle_config: Some(oracle_config_pda),
        payer: settler.pubkey(),
    };
    let settle_instruction = Instruction {
        program_id: meridian::ID,
        accounts: settle_accounts.to_account_metas(None),
        data: settle_ix.data(),
    };
    let settle_result = harness.harness.send(settle_instruction, &[&settler]);
    // timestamp_ms_a < market_b_close_ts_ms, so settle-side OracleBeforeClose
    common::assert_meridian_error(
        &settle_result,
        meridian::errors::MeridianError::OracleBeforeClose,
    );
}

#[test]
fn post_redstone_price_fails_older_than_stored() {
    // AC2 / AB-03: posting older timestamp after newer → RedStonePackageOlderThanStored
    let (mut harness, args, market_pda, signers) = setup_market_with_redstone();

    let signing_signers = &signers[..3];
    let payer = Keypair::new();
    harness
        .harness
        .svm
        .airdrop(&payer.pubkey(), FUNDING_LAMPORTS)
        .unwrap();

    let ticker = args.ticker;
    let value = 2050_0000_0000u128;

    // Post newer timestamp first (close + 200s)
    let newer_timestamp_ms = BASE_CLOSE_TS * 1000 + 200_000;
    let mut builder_newer = RedstonePayloadBuilder::new(
        std::str::from_utf8(&ticker).unwrap().trim_end_matches('\0'),
        value,
        newer_timestamp_ms,
    );
    for signer in signing_signers {
        builder_newer = builder_newer.add_signer(signer.clone());
    }
    let payload_newer = builder_newer.build();

    let (price_pda, _) = Pubkey::find_program_address(&[b"redstone_price", &ticker], &meridian::ID);
    let (oracle_config_pda, _) = Pubkey::find_program_address(&[b"oracle_config"], &meridian::ID);

    let post_ix_newer = meridian::instruction::PostRedstonePrice {
        symbol: ticker,
        payload: payload_newer,
    };
    let post_accounts = meridian::accounts::PostRedstonePrice {
        oracle_config: oracle_config_pda,
        market: market_pda,
        redstone_price: price_pda,
        payer: payer.pubkey(),
        system_program: system_program::ID,
    };
    let post_instruction_newer = Instruction {
        program_id: meridian::ID,
        accounts: post_accounts.to_account_metas(None),
        data: post_ix_newer.data(),
    };
    let post_result_newer = harness.harness.send(post_instruction_newer, &[&payer]);
    expect_success(&post_result_newer);

    // Try to post older timestamp (close + 100s < close + 200s)
    let older_timestamp_ms = BASE_CLOSE_TS * 1000 + 100_000;
    let mut builder_older = RedstonePayloadBuilder::new(
        std::str::from_utf8(&ticker).unwrap().trim_end_matches('\0'),
        value + 100_0000_0000, // Different value to distinguish
        older_timestamp_ms,
    );
    for signer in signing_signers {
        builder_older = builder_older.add_signer(signer.clone());
    }
    let payload_older = builder_older.build();

    let post_ix_older = meridian::instruction::PostRedstonePrice {
        symbol: ticker,
        payload: payload_older,
    };
    let post_instruction_older = Instruction {
        program_id: meridian::ID,
        accounts: post_accounts.to_account_metas(None),
        data: post_ix_older.data(),
    };
    let post_result_older = harness.harness.send(post_instruction_older, &[&payer]);
    // Older timestamp rejected
    common::assert_meridian_error(
        &post_result_older,
        meridian::errors::MeridianError::RedStonePackageOlderThanStored,
    );
}

#[test]
fn settle_market_fails_package_too_late_at_settle() {
    // AC2 / AB-03: stored timestamp after settling market's window end → RedStonePackageTooLate
    // Tests settle-side validation when post used a later market
    let mut harness = MarketHarness::new();
    let admin = harness.harness.admin.insecure_clone();

    // Setup RedStone oracle config
    let signers: Vec<TestSigner> = (0..5).map(|_| TestSigner::generate()).collect();
    let addresses: Vec<[u8; 20]> = signers.iter().map(|s| s.ethereum_address()).collect();
    let signing_signers = &signers[..3];

    let (oracle_config_pda, _) = Pubkey::find_program_address(&[b"oracle_config"], &meridian::ID);
    let params = meridian::SetOracleConfigParams {
        signers: addresses.clone(),
        signer_threshold: THRESHOLD,
        max_package_delay_secs: 600,
    };
    let ix = meridian::instruction::SetOracleConfig { params };
    let accounts = meridian::accounts::SetOracleConfig {
        config: config_pda(),
        oracle_config: oracle_config_pda,
        admin: admin.pubkey(),
        system_program: system_program::ID,
    };
    let instruction = Instruction {
        program_id: meridian::ID,
        accounts: accounts.to_account_metas(None),
        data: ix.data(),
    };
    let result = harness
        .harness
        .send_with_budget(instruction, &[&admin], 400_000);
    expect_success(&result);

    let payer = Keypair::new();
    harness
        .harness
        .svm
        .airdrop(&payer.pubkey(), FUNDING_LAMPORTS)
        .unwrap();

    let ticker = symbol("NVDA");

    // Market A: early close_ts
    let market_a_close_ts = BASE_CLOSE_TS;
    harness.harness.set_unix_timestamp(market_a_close_ts - 3600);
    let market_a_args = MarketArgs {
        ticker,
        strike_cents: 200_000,
        trading_date: BASE_TRADING_DATE,
        close_ts: market_a_close_ts,
    };
    let market_a_addrs = harness.create_market(&market_a_args);

    // Market B: same ticker, much later close_ts (e.g., next day)
    let market_b_close_ts = market_a_close_ts + 86400; // +1 day
    harness.harness.set_unix_timestamp(market_b_close_ts - 3600);
    let market_b_args = MarketArgs {
        ticker,
        strike_cents: 205_000, // Different strike for different PDA
        trading_date: BASE_TRADING_DATE,
        close_ts: market_b_close_ts,
    };
    let market_b_addrs = harness.create_market(&market_b_args);

    // Advance past Market B close
    harness.harness.set_unix_timestamp(market_b_close_ts + 300);

    // Post RedStone price for Market B's window (B close + 700s, AFTER B's 600s window end)
    // This is after B's window but we use Market B to post so post_redstone_price allows it
    // Actually, post won't allow it either. Let me use Market B close + 500s (within window)
    // Then try to settle Market A, whose window ended long ago

    // Actually, the test case is: post with a LATE market, then settle an EARLY market
    // The stored timestamp is valid for the late market but TOO LATE for the early market

    // Reverse: Market A is LATE, Market B is EARLY
    // Post using late Market A (timestamp valid for A), try to settle early Market B
    // The timestamp is too late for B's window

    // Let me restructure: Market A (early close), Market B (late close)
    // Post with Market B at timestamp that's valid for B but would be too late for A
    // Then try to settle Market A → should fail with RedStonePackageTooLate

    // Wait, that doesn't work either because Market A already closed before we posted.

    // Let me think differently:
    // Market A: close_ts = X
    // Post at timestamp X + 700s using Market A → fails (too late)
    //
    // So I need to post at a timestamp that's valid for one market but too late for another.
    // Market A: close_ts = 1000, window = [1000, 1600]
    // Market B: close_ts = 500, window = [500, 1100]
    // Post at timestamp 1500 using Market A (valid: 1000 <= 1500 <= 1600)
    // Try to settle Market B → 1500 > 1100, so RedStonePackageTooLate

    // But this requires Market B to close BEFORE Market A, which is backwards from my setup.
    // Let me swap them:

    // Market A: early close (BASE_CLOSE_TS)
    // Market B: late close (BASE_CLOSE_TS + 86400)
    // Post timestamp valid for B (B_close + 500s) using Market B
    // This timestamp is way after A's window end (A_close + 600s)
    // Try to settle Market A → should fail with RedStonePackageTooLate

    let timestamp_ms = market_b_close_ts * 1000 + 500_000; // Valid for B (within 600s)
    // This is market_a_close_ts + 86400 + 500s, which is >> market_a_close_ts + 600s
    let value = 2050_0000_0000u128;
    let mut builder = RedstonePayloadBuilder::new(
        std::str::from_utf8(&ticker).unwrap().trim_end_matches('\0'),
        value,
        timestamp_ms,
    );
    for signer in signing_signers {
        builder = builder.add_signer(signer.clone());
    }
    let payload = builder.build();

    let (price_pda, _) = Pubkey::find_program_address(&[b"redstone_price", &ticker], &meridian::ID);

    let post_ix = meridian::instruction::PostRedstonePrice {
        symbol: ticker,
        payload,
    };
    let post_accounts = meridian::accounts::PostRedstonePrice {
        oracle_config: oracle_config_pda,
        market: market_b_addrs.market, // Post using Market B (late close)
        redstone_price: price_pda,
        payer: payer.pubkey(),
        system_program: system_program::ID,
    };
    let post_instruction = Instruction {
        program_id: meridian::ID,
        accounts: post_accounts.to_account_metas(None),
        data: post_ix.data(),
    };
    let post_result = harness.harness.send(post_instruction, &[&payer]);
    expect_success(&post_result);

    // Try to settle Market A (early close) - timestamp is after A's window end
    let settler = Keypair::new();
    harness
        .harness
        .svm
        .airdrop(&settler.pubkey(), FUNDING_LAMPORTS)
        .unwrap();

    let settle_ix = meridian::instruction::SettleMarket {};
    let settle_accounts = meridian::accounts::SettleMarket {
        config: config_pda(),
        market: market_a_addrs.market,
        feed_tiingo: Pubkey::default(),
        feed_twelve_data: Pubkey::default(),
        redstone_price: Some(price_pda),
        oracle_config: Some(oracle_config_pda),
        payer: settler.pubkey(),
    };
    let settle_instruction = Instruction {
        program_id: meridian::ID,
        accounts: settle_accounts.to_account_metas(None),
        data: settle_ix.data(),
    };
    let settle_result = harness.harness.send(settle_instruction, &[&settler]);
    // timestamp_ms >> market_a window end, so settle-side RedStonePackageTooLate
    common::assert_meridian_error(
        &settle_result,
        meridian::errors::MeridianError::RedStonePackageTooLate,
    );
}
