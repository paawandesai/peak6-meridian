//! M2-15 AC4: RedStone compute and size limits.
//! Tests: CU under 400,000 for post and settle, transaction size within limit.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::arithmetic_side_effects)]

mod common;

use anchor_lang::prelude::Pubkey;
use anchor_lang::{InstructionData, ToAccountMetas};
use common::redstone::{RedstonePayloadBuilder, TestSigner};
use common::{
    config_pda, expect_success, symbol, transaction_size, MarketArgs, MarketHarness,
    FUNDING_LAMPORTS, BASE_CLOSE_TS, BASE_TRADING_DATE,
};
use solana_sdk::instruction::Instruction;
use solana_sdk::packet::PACKET_DATA_SIZE;
use solana_sdk::signature::{Keypair, Signer};
use solana_sdk::system_program;
use solana_sdk::transaction::Transaction;

const THRESHOLD: u8 = 3;
const MAX_CU: u64 = 400_000;

#[test]
fn post_redstone_price_stays_under_cu_limit() {
    // AC4: post_redstone_price with 5 signers < 400,000 CU
    let mut harness = MarketHarness::new();
    let admin = harness.harness.admin.insecure_clone();

    // Setup oracle config with 5 signers
    let signers_test: Vec<TestSigner> = (0..5).map(|_| TestSigner::generate()).collect();
    let addresses: Vec<[u8; 20]> = signers_test.iter().map(|s| s.ethereum_address()).collect();

    let (oracle_config_pda, _) = Pubkey::find_program_address(
        &[b"oracle_config"],
        &meridian::ID,
    );

    let params = meridian::SetOracleConfigParams {
        signers: addresses,
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
    let result = harness.harness.send(instruction, &[&admin]);
    expect_success(&result);

    // Post price with all 5 signers
    let payer = Keypair::new();
    harness.harness.svm.airdrop(&payer.pubkey(), FUNDING_LAMPORTS).unwrap();

    let ticker = symbol("NVDA");
    let mut builder = RedstonePayloadBuilder::new("NVDA", 2000_0000_0000, 1700000000000);
    for signer in signers_test {
        builder = builder.add_signer(signer);
    }
    let payload = builder.build();

    let (price_pda, _) = Pubkey::find_program_address(
        &[b"redstone_price", &ticker],
        &meridian::ID,
    );

    let post_ix = meridian::instruction::PostRedstonePrice {
        symbol: ticker,
        payload,
    };

    let post_accounts = meridian::accounts::PostRedstonePrice {
        oracle_config: oracle_config_pda,
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
    let meta = expect_success(&post_result);

    // Check CU consumption
    let cu_consumed = meta.compute_units_consumed;
    assert!(
        cu_consumed < MAX_CU,
        "post_redstone_price consumed {} CU, limit is {}",
        cu_consumed,
        MAX_CU
    );
}

#[test]
fn settle_market_with_redstone_stays_under_cu_limit() {
    // AC4: settle_market with RedStone < 400,000 CU
    let mut harness = MarketHarness::new();
    let admin = harness.harness.admin.insecure_clone();

    // Setup oracle config
    let signers_test: Vec<TestSigner> = (0..5).map(|_| TestSigner::generate()).collect();
    let addresses: Vec<[u8; 20]> = signers_test.iter().map(|s| s.ethereum_address()).collect();
    let mut signing_signers = signers_test;
    let remaining = signing_signers.split_off(3);
    drop(remaining);

    let (oracle_config_pda, _) = Pubkey::find_program_address(
        &[b"oracle_config"],
        &meridian::ID,
    );

    let params = meridian::SetOracleConfigParams {
        signers: addresses,
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
    let result = harness.harness.send(instruction, &[&admin]);
    expect_success(&result);

    // Create market
    let args = MarketArgs {
        ticker: symbol("NVDA"),
        strike_cents: 2000_00,
        trading_date: BASE_TRADING_DATE,
        close_ts: BASE_CLOSE_TS,
    };
    let addresses_market = harness.create_market(&args);

    // Advance time past close
    harness.harness.set_unix_timestamp(BASE_CLOSE_TS + 300);

    // Post RedStone price
    let payer = Keypair::new();
    harness.harness.svm.airdrop(&payer.pubkey(), FUNDING_LAMPORTS).unwrap();

    let ticker = args.ticker;
    let timestamp_ms = (BASE_CLOSE_TS as i64) * 1000 + 1000;
    let mut builder = RedstonePayloadBuilder::new("NVDA", 2050_0000_0000, timestamp_ms);
    for signer in signing_signers {
        builder = builder.add_signer(signer);
    }
    let payload = builder.build();

    let (price_pda, _) = Pubkey::find_program_address(
        &[b"redstone_price", &ticker],
        &meridian::ID,
    );

    let post_ix = meridian::instruction::PostRedstonePrice {
        symbol: ticker,
        payload,
    };

    let post_accounts = meridian::accounts::PostRedstonePrice {
        oracle_config: oracle_config_pda,
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

    // Settle market
    let settler = Keypair::new();
    harness.harness.svm.airdrop(&settler.pubkey(), FUNDING_LAMPORTS).unwrap();

    let settle_ix = meridian::instruction::SettleMarket {};
    let settle_accounts = meridian::accounts::SettleMarket {
        config: config_pda(),
        market: addresses_market.market,
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
    let meta = expect_success(&settle_result);

    // Check CU consumption
    let cu_consumed = meta.compute_units_consumed;
    assert!(
        cu_consumed < MAX_CU,
        "settle_market consumed {} CU, limit is {}",
        cu_consumed,
        MAX_CU
    );
}

#[test]
fn redstone_payload_fits_in_transaction() {
    // AC4: 5-signer payload fits in transaction (< 1232 bytes)
    let harness = MarketHarness::new();
    let admin = harness.harness.admin.insecure_clone();

    // Generate 5-signer payload
    let signers_test: Vec<TestSigner> = (0..5).map(|_| TestSigner::generate()).collect();
    let mut builder = RedstonePayloadBuilder::new("NVDA", 2000_0000_0000, 1700000000000);
    for signer in signers_test {
        builder = builder.add_signer(signer);
    }
    let payload = builder.build();

    let ticker = symbol("NVDA");
    let (price_pda, _) = Pubkey::find_program_address(
        &[b"redstone_price", &ticker],
        &meridian::ID,
    );

    let (oracle_config_pda, _) = Pubkey::find_program_address(
        &[b"oracle_config"],
        &meridian::ID,
    );

    let post_ix = meridian::instruction::PostRedstonePrice {
        symbol: ticker,
        payload,
    };

    let post_accounts = meridian::accounts::PostRedstonePrice {
        oracle_config: oracle_config_pda,
        redstone_price: price_pda,
        payer: admin.pubkey(),
        system_program: system_program::ID,
    };

    let instruction = Instruction {
        program_id: meridian::ID,
        accounts: post_accounts.to_account_metas(None),
        data: post_ix.data(),
    };

    // Build transaction and check size
    let tx = Transaction::new_signed_with_payer(
        &[instruction],
        Some(&admin.pubkey()),
        &[&admin],
        harness.harness.svm.latest_blockhash(),
    );

    let tx_size = transaction_size(&tx);
    assert!(
        tx_size <= PACKET_DATA_SIZE,
        "Transaction size {} exceeds packet limit {}",
        tx_size,
        PACKET_DATA_SIZE
    );
}
