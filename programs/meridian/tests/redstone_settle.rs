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
        close_ts: 1700000000,
        payload,
    };

    let accounts = meridian::accounts::PostRedstonePrice {
        oracle_config: oracle_config_pda,
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
fn settle_market_fails_package_before_close() {
    // AC2: package timestamp before close_ts → OracleBeforeClose
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

    // Post RedStone price with early timestamp
    let mut builder = RedstonePayloadBuilder::new("NVDA", value, timestamp_ms);
    for signer in signing_signers {
        builder = builder.add_signer(signer.clone());
    }
    let payload = builder.build();

    let (price_pda, _) = Pubkey::find_program_address(&[b"redstone_price", &ticker], &meridian::ID);
    let (oracle_config_pda, _) = Pubkey::find_program_address(&[b"oracle_config"], &meridian::ID);

    let ix = meridian::instruction::PostRedstonePrice {
        symbol: ticker,
        close_ts: 1700000000,
        payload,
    };

    let accounts = meridian::accounts::PostRedstonePrice {
        oracle_config: oracle_config_pda,
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

    // Try to settle - should fail with OracleBeforeClose
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
    common::assert_meridian_error(
        &settle_result,
        meridian::errors::MeridianError::OracleBeforeClose,
    );
}

#[test]
fn settle_market_fails_package_too_late() {
    // AC2: package timestamp after close_ts + max_package_delay_secs → RedStonePackageTooLate
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

    let mut builder = RedstonePayloadBuilder::new("NVDA", value, timestamp_ms);
    for signer in signing_signers {
        builder = builder.add_signer(signer.clone());
    }
    let payload = builder.build();

    let (price_pda, _) = Pubkey::find_program_address(&[b"redstone_price", &ticker], &meridian::ID);
    let (oracle_config_pda, _) = Pubkey::find_program_address(&[b"oracle_config"], &meridian::ID);

    let ix = meridian::instruction::PostRedstonePrice {
        symbol: ticker,
        close_ts: 1700000000,
        payload,
    };

    let accounts = meridian::accounts::PostRedstonePrice {
        oracle_config: oracle_config_pda,
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

    // Try to settle - should fail with RedStonePackageTooLate
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
    common::assert_meridian_error(
        &settle_result,
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
        close_ts: 1700000000,
        payload,
    };

    let accounts = meridian::accounts::PostRedstonePrice {
        oracle_config: oracle_config_pda,
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
    let (mut harness, args, market_pda, signers) = setup_market_with_redstone();

    let signing_signers = &signers[..3];
    let payer = Keypair::new();
    harness
        .harness
        .svm
        .airdrop(&payer.pubkey(), FUNDING_LAMPORTS)
        .unwrap();

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
        close_ts: BASE_CLOSE_TS,
        payload,
    };

    let accounts = meridian::accounts::PostRedstonePrice {
        oracle_config: oracle_config_pda,
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
        close_ts: 1700000000,
        payload,
    };

    let accounts = meridian::accounts::PostRedstonePrice {
        oracle_config: oracle_config_pda,
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
        close_ts: 1700000000,
        payload,
    };

    let accounts = meridian::accounts::PostRedstonePrice {
        oracle_config: oracle_config_pda,
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
