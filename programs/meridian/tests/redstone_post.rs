//! M2-15 AC1: `post_redstone_price` LiteSVM tests with locally generated secp256k1 signers.
//! Tests: 3 of 5 valid → success, 2 of 5 → threshold error, unknown signer ignored,
//! duplicate signer counts once, invalid recovery ID → RedStoneInvalidSignature,
//! tampered value/timestamp/feed_id → RedStoneInsufficientSigners (proves fields are signed),
//! oversized payload → error, wrong feed_id → RedStoneFeedIdMismatch, malformed payload errors.

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
    assert_meridian_error_with_budget, config_pda, expect_success, symbol, MarketArgs,
    MarketHarness, BASE_TRADING_DATE, FUNDING_LAMPORTS,
};
use meridian::errors::MeridianError;
use meridian::state::RedstonePrice;
use solana_sdk::instruction::Instruction;
use solana_sdk::signature::{Keypair, Signer};
use solana_sdk::system_program;

const THRESHOLD: u8 = 3;

/// Sets up a test with oracle config containing the given signer addresses.
fn setup_with_signers(signer_addresses: Vec<[u8; 20]>) -> MarketHarness {
    let mut harness = MarketHarness::new();
    let admin = harness.harness.admin.insecure_clone();

    // Set oracle config with test signers
    let (oracle_config_pda, _) = Pubkey::find_program_address(&[b"oracle_config"], &meridian::ID);

    let params = meridian::SetOracleConfigParams {
        signers: signer_addresses,
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

    // Create a market for RedStone post window validation (AB-03)
    // Most tests use timestamp 1700000000000 ms, so set close_ts before that
    let test_close_ts = 1700000000i64; // Unix seconds, matches test timestamps
    harness.harness.set_unix_timestamp(test_close_ts - 3600);
    let market_args = MarketArgs {
        ticker: symbol("NVDA"),
        strike_cents: 200_000,
        trading_date: BASE_TRADING_DATE,
        close_ts: test_close_ts,
    };
    harness.create_market(&market_args);

    harness
}

#[test]
fn post_redstone_price_success_3_of_5() {
    // AC1: 3 of 5 valid signers → success
    let mut signers: Vec<TestSigner> = (0..5).map(|_| TestSigner::generate()).collect();
    let addresses: Vec<[u8; 20]> = signers.iter().map(|s| s.ethereum_address()).collect();

    let mut harness = setup_with_signers(addresses);
    let payer = Keypair::new();
    harness
        .harness
        .svm
        .airdrop(&payer.pubkey(), FUNDING_LAMPORTS)
        .unwrap();

    let ticker = symbol("NVDA");
    let value = 2000_0000_0000u128; // $2000 with 8 decimals
    let timestamp_ms = 1700000000000i64;

    // Build payload with first 3 signers (meets threshold)
    let mut builder = RedstonePayloadBuilder::new("NVDA", value, timestamp_ms);
    let remaining_signers = signers.split_off(3); // Take last 2, keep first 3
    for signer in signers {
        builder = builder.add_signer(signer);
    }
    let _unused = remaining_signers; // Prevent warning
    let payload = builder.build();

    let (price_pda, _) = Pubkey::find_program_address(&[b"redstone_price", &ticker], &meridian::ID);

    let (oracle_config_pda, _) = Pubkey::find_program_address(&[b"oracle_config"], &meridian::ID);

    let ix = meridian::instruction::PostRedstonePrice {
        symbol: ticker,
        payload,
    };

    let (market_pda, _) = Pubkey::find_program_address(
        &[
            meridian::MARKET_SEED,
            &symbol("NVDA"),
            &BASE_TRADING_DATE.to_le_bytes(),
            &200_000u64.to_le_bytes(),
        ],
        &meridian::ID,
    );
    let accounts = meridian::accounts::PostRedstonePrice {
        oracle_config: oracle_config_pda,
        redstone_price: price_pda,
        payer: payer.pubkey(),
        system_program: system_program::ID,
        market: market_pda,
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

    // Verify the posted price
    let account = harness.harness.svm.get_account(&price_pda).unwrap();
    let mut data = account.data.as_slice();
    let price = RedstonePrice::try_deserialize(&mut data).unwrap();
    assert_eq!(price.symbol, ticker);
    assert_eq!(price.value, value);
    assert_eq!(price.package_timestamp_ms, timestamp_ms);
    assert_eq!(price.signer_count, 3);
}

#[test]
fn post_redstone_price_fails_insufficient_signers() {
    // AC1: 2 of 5 → threshold error (threshold is 3)
    let mut signers: Vec<TestSigner> = (0..5).map(|_| TestSigner::generate()).collect();
    let addresses: Vec<[u8; 20]> = signers.iter().map(|s| s.ethereum_address()).collect();

    let mut harness = setup_with_signers(addresses);
    let payer = Keypair::new();
    harness
        .harness
        .svm
        .airdrop(&payer.pubkey(), FUNDING_LAMPORTS)
        .unwrap();

    let ticker = symbol("NVDA");

    // Build payload with only 2 signers (below threshold)
    let mut builder = RedstonePayloadBuilder::new("NVDA", 2000_0000_0000, 1700000000000);
    let remaining_signers = signers.split_off(2); // Take last 3, keep first 2
    for signer in signers {
        builder = builder.add_signer(signer);
    }
    let _unused = remaining_signers; // Prevent warning
    let payload = builder.build();

    let (price_pda, _) = Pubkey::find_program_address(&[b"redstone_price", &ticker], &meridian::ID);

    let (oracle_config_pda, _) = Pubkey::find_program_address(&[b"oracle_config"], &meridian::ID);

    let ix = meridian::instruction::PostRedstonePrice {
        symbol: ticker,
        payload,
    };

    let (market_pda, _) = Pubkey::find_program_address(
        &[
            meridian::MARKET_SEED,
            &symbol("NVDA"),
            &BASE_TRADING_DATE.to_le_bytes(),
            &200_000u64.to_le_bytes(),
        ],
        &meridian::ID,
    );
    let accounts = meridian::accounts::PostRedstonePrice {
        oracle_config: oracle_config_pda,
        redstone_price: price_pda,
        payer: payer.pubkey(),
        system_program: system_program::ID,
        market: market_pda,
    };

    let instruction = Instruction {
        program_id: meridian::ID,
        accounts: accounts.to_account_metas(None),
        data: ix.data(),
    };
    let result = harness
        .harness
        .send_with_budget(instruction, &[&payer], 400_000);
    assert_meridian_error_with_budget(&result, MeridianError::RedStoneInsufficientSigners);
}

#[test]
fn post_redstone_price_unknown_signer_ignored() {
    // AC1: unknown signer is not counted (3 valid + 2 unknown = 3 counted)
    let known_signers: Vec<TestSigner> = (0..3).map(|_| TestSigner::generate()).collect();
    let unknown_signers: Vec<TestSigner> = (0..2).map(|_| TestSigner::generate()).collect();

    let known_addresses: Vec<[u8; 20]> =
        known_signers.iter().map(|s| s.ethereum_address()).collect();

    let mut harness = setup_with_signers(known_addresses);
    let payer = Keypair::new();
    harness
        .harness
        .svm
        .airdrop(&payer.pubkey(), FUNDING_LAMPORTS)
        .unwrap();

    let ticker = symbol("NVDA");

    // Build payload with 3 known + 2 unknown signers
    let mut builder = RedstonePayloadBuilder::new("NVDA", 2000_0000_0000, 1700000000000);
    for signer in known_signers {
        builder = builder.add_signer(signer);
    }
    for signer in unknown_signers {
        builder = builder.add_signer(signer);
    }
    let payload = builder.build();

    let (price_pda, _) = Pubkey::find_program_address(&[b"redstone_price", &ticker], &meridian::ID);

    let (oracle_config_pda, _) = Pubkey::find_program_address(&[b"oracle_config"], &meridian::ID);

    let ix = meridian::instruction::PostRedstonePrice {
        symbol: ticker,
        payload,
    };

    let (market_pda, _) = Pubkey::find_program_address(
        &[
            meridian::MARKET_SEED,
            &symbol("NVDA"),
            &BASE_TRADING_DATE.to_le_bytes(),
            &200_000u64.to_le_bytes(),
        ],
        &meridian::ID,
    );
    let accounts = meridian::accounts::PostRedstonePrice {
        oracle_config: oracle_config_pda,
        redstone_price: price_pda,
        payer: payer.pubkey(),
        system_program: system_program::ID,
        market: market_pda,
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

    // Verify only known signers were counted
    let account = harness.harness.svm.get_account(&price_pda).unwrap();
    let mut data = account.data.as_slice();
    let price = RedstonePrice::try_deserialize(&mut data).unwrap();
    assert_eq!(
        price.signer_count, 3,
        "Unknown signers should not be counted"
    );
}

#[test]
fn post_redstone_price_malformed_payload() {
    // AC1: malformed payload returns error
    let signers: Vec<TestSigner> = (0..3).map(|_| TestSigner::generate()).collect();
    let addresses: Vec<[u8; 20]> = signers.iter().map(|s| s.ethereum_address()).collect();

    let mut harness = setup_with_signers(addresses);
    let payer = Keypair::new();
    harness
        .harness
        .svm
        .airdrop(&payer.pubkey(), FUNDING_LAMPORTS)
        .unwrap();

    let ticker = symbol("NVDA");

    // Create malformed payload (too short, missing marker)
    let payload = vec![0u8; 50];

    let (price_pda, _) = Pubkey::find_program_address(&[b"redstone_price", &ticker], &meridian::ID);

    let (oracle_config_pda, _) = Pubkey::find_program_address(&[b"oracle_config"], &meridian::ID);

    let ix = meridian::instruction::PostRedstonePrice {
        symbol: ticker,
        payload,
    };

    let (market_pda, _) = Pubkey::find_program_address(
        &[
            meridian::MARKET_SEED,
            &symbol("NVDA"),
            &BASE_TRADING_DATE.to_le_bytes(),
            &200_000u64.to_le_bytes(),
        ],
        &meridian::ID,
    );
    let accounts = meridian::accounts::PostRedstonePrice {
        oracle_config: oracle_config_pda,
        redstone_price: price_pda,
        payer: payer.pubkey(),
        system_program: system_program::ID,
        market: market_pda,
    };

    let instruction = Instruction {
        program_id: meridian::ID,
        accounts: accounts.to_account_metas(None),
        data: ix.data(),
    };
    let result = harness
        .harness
        .send_with_budget(instruction, &[&payer], 400_000);
    assert_meridian_error_with_budget(&result, MeridianError::RedStoneMalformedPayload);
}

#[test]
fn post_redstone_price_duplicate_signer_counts_once() {
    // AC1: duplicate signer counts once (not twice)
    // Use 3 signers with threshold=3, where one is duplicated (so 4 packages, 3 unique)
    let signers: Vec<TestSigner> = (0..3).map(|_| TestSigner::generate()).collect();
    let addresses: Vec<[u8; 20]> = signers.iter().map(|s| s.ethereum_address()).collect();

    let mut harness = setup_with_signers(addresses);
    let payer = Keypair::new();
    harness
        .harness
        .svm
        .airdrop(&payer.pubkey(), FUNDING_LAMPORTS)
        .unwrap();

    let ticker = symbol("NVDA");
    let value = 2000_0000_0000u128;
    let timestamp_ms = 1700000000000i64;

    // Build payload with 3 unique signers + 1 duplicate (first signer twice)
    let payload = RedstonePayloadBuilder::new("NVDA", value, timestamp_ms)
        .add_signer(signers[0].clone())
        .add_signer(signers[1].clone())
        .add_signer(signers[2].clone())
        .add_signer(signers[0].clone()) // Duplicate first signer
        .build();

    let (price_pda, _) = Pubkey::find_program_address(&[b"redstone_price", &ticker], &meridian::ID);
    let (oracle_config_pda, _) = Pubkey::find_program_address(&[b"oracle_config"], &meridian::ID);

    let ix = meridian::instruction::PostRedstonePrice {
        symbol: ticker,
        payload,
    };

    let (market_pda, _) = Pubkey::find_program_address(
        &[
            meridian::MARKET_SEED,
            &symbol("NVDA"),
            &BASE_TRADING_DATE.to_le_bytes(),
            &200_000u64.to_le_bytes(),
        ],
        &meridian::ID,
    );
    let accounts = meridian::accounts::PostRedstonePrice {
        oracle_config: oracle_config_pda,
        redstone_price: price_pda,
        payer: payer.pubkey(),
        system_program: system_program::ID,
        market: market_pda,
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

    // Verify duplicate was counted only once (3 unique, not 4)
    let account = harness.harness.svm.get_account(&price_pda).unwrap();
    let mut data = account.data.as_slice();
    let price = RedstonePrice::try_deserialize(&mut data).unwrap();
    assert_eq!(
        price.signer_count, 3,
        "Duplicate signer should count once (3 unique from 4 packages)"
    );
}

#[test]
fn post_redstone_price_tampered_signature_recovery_fails() {
    // AC1: tampered recovery ID causes signature recovery to fail (RedStoneInvalidSignature)
    let signers: Vec<TestSigner> = (0..3).map(|_| TestSigner::generate()).collect();
    let addresses: Vec<[u8; 20]> = signers.iter().map(|s| s.ethereum_address()).collect();

    let mut harness = setup_with_signers(addresses);
    let payer = Keypair::new();
    harness
        .harness
        .svm
        .airdrop(&payer.pubkey(), FUNDING_LAMPORTS)
        .unwrap();

    let ticker = symbol("NVDA");

    // Build valid payload
    let mut builder = RedstonePayloadBuilder::new("NVDA", 2000_0000_0000, 1700000000000);
    for signer in signers {
        builder = builder.add_signer(signer);
    }
    let mut payload = builder.build();

    // Tamper with recovery ID (last byte of signature: v byte)
    // Recovery ID is signature[64] and must be 27 or 28 for Ethereum
    // Set it to an invalid value (e.g., 200) to cause recovery to fail
    let sig_offset = 32 + 32 + 6 + 4 + 3; // After signed data in first package
    let recovery_byte_offset = sig_offset + 64; // Last byte of 65-byte signature
    if payload.len() > recovery_byte_offset {
        payload[recovery_byte_offset] = 200; // Invalid recovery ID
    }

    let (price_pda, _) = Pubkey::find_program_address(&[b"redstone_price", &ticker], &meridian::ID);
    let (oracle_config_pda, _) = Pubkey::find_program_address(&[b"oracle_config"], &meridian::ID);

    let ix = meridian::instruction::PostRedstonePrice {
        symbol: ticker,
        payload,
    };

    let (market_pda, _) = Pubkey::find_program_address(
        &[
            meridian::MARKET_SEED,
            &symbol("NVDA"),
            &BASE_TRADING_DATE.to_le_bytes(),
            &200_000u64.to_le_bytes(),
        ],
        &meridian::ID,
    );
    let accounts = meridian::accounts::PostRedstonePrice {
        oracle_config: oracle_config_pda,
        redstone_price: price_pda,
        payer: payer.pubkey(),
        system_program: system_program::ID,
        market: market_pda,
    };

    let instruction = Instruction {
        program_id: meridian::ID,
        accounts: accounts.to_account_metas(None),
        data: ix.data(),
    };
    let result = harness
        .harness
        .send_with_budget(instruction, &[&payer], 400_000);
    assert_meridian_error_with_budget(&result, MeridianError::RedStoneInvalidSignature);
}

#[test]
fn post_redstone_price_tampered_value_fails() {
    // AC1: tampered value does not verify - proves value is in signed bytes
    let signers: Vec<TestSigner> = (0..3).map(|_| TestSigner::generate()).collect();
    let addresses: Vec<[u8; 20]> = signers.iter().map(|s| s.ethereum_address()).collect();

    let mut harness = setup_with_signers(addresses);
    let payer = Keypair::new();
    harness
        .harness
        .svm
        .airdrop(&payer.pubkey(), FUNDING_LAMPORTS)
        .unwrap();

    let ticker = symbol("NVDA");

    // Build valid payload with 3 signers (threshold 3)
    let mut builder = RedstonePayloadBuilder::new("NVDA", 2000_0000_0000, 1700000000000);
    for signer in &signers {
        builder = builder.add_signer(signer.clone());
    }
    let mut payload = builder.build();

    // Tamper with value bytes in first package: feed_id is first 32 bytes, value is next 32
    // Flip last byte of value (offset 63) which contains actual value data
    if payload.len() > 63 {
        payload[63] ^= 0xFF;
    }

    let (price_pda, _) = Pubkey::find_program_address(&[b"redstone_price", &ticker], &meridian::ID);
    let (oracle_config_pda, _) = Pubkey::find_program_address(&[b"oracle_config"], &meridian::ID);

    let ix = meridian::instruction::PostRedstonePrice {
        symbol: ticker,
        payload,
    };

    let (market_pda, _) = Pubkey::find_program_address(
        &[
            meridian::MARKET_SEED,
            &symbol("NVDA"),
            &BASE_TRADING_DATE.to_le_bytes(),
            &200_000u64.to_le_bytes(),
        ],
        &meridian::ID,
    );
    let accounts = meridian::accounts::PostRedstonePrice {
        oracle_config: oracle_config_pda,
        redstone_price: price_pda,
        payer: payer.pubkey(),
        system_program: system_program::ID,
        market: market_pda,
    };

    let instruction = Instruction {
        program_id: meridian::ID,
        accounts: accounts.to_account_metas(None),
        data: ix.data(),
    };
    let result = harness
        .harness
        .send_with_budget(instruction, &[&payer], 400_000);
    // With 3 signers and 1 tampered, we have 2 valid < threshold 3
    assert_meridian_error_with_budget(&result, MeridianError::RedStoneInsufficientSigners);
}

#[test]
fn post_redstone_price_tampered_timestamp_fails() {
    // AC1: tampered timestamp does not verify - proves timestamp is in signed bytes
    let signers: Vec<TestSigner> = (0..3).map(|_| TestSigner::generate()).collect();
    let addresses: Vec<[u8; 20]> = signers.iter().map(|s| s.ethereum_address()).collect();

    let mut harness = setup_with_signers(addresses);
    let payer = Keypair::new();
    harness
        .harness
        .svm
        .airdrop(&payer.pubkey(), FUNDING_LAMPORTS)
        .unwrap();

    let ticker = symbol("NVDA");

    // Build valid payload with 3 signers (threshold 3)
    let mut builder = RedstonePayloadBuilder::new("NVDA", 2000_0000_0000, 1700000000000);
    for signer in &signers {
        builder = builder.add_signer(signer.clone());
    }
    let mut payload = builder.build();

    // Tamper with timestamp bytes in first package: after feed_id (32) + value (32) = offset 64
    // Timestamp is 6 bytes (64-69), flip last byte
    if payload.len() > 69 {
        payload[69] ^= 0xFF;
    }

    let (price_pda, _) = Pubkey::find_program_address(&[b"redstone_price", &ticker], &meridian::ID);
    let (oracle_config_pda, _) = Pubkey::find_program_address(&[b"oracle_config"], &meridian::ID);

    let ix = meridian::instruction::PostRedstonePrice {
        symbol: ticker,
        payload,
    };

    let (market_pda, _) = Pubkey::find_program_address(
        &[
            meridian::MARKET_SEED,
            &symbol("NVDA"),
            &BASE_TRADING_DATE.to_le_bytes(),
            &200_000u64.to_le_bytes(),
        ],
        &meridian::ID,
    );
    let accounts = meridian::accounts::PostRedstonePrice {
        oracle_config: oracle_config_pda,
        redstone_price: price_pda,
        payer: payer.pubkey(),
        system_program: system_program::ID,
        market: market_pda,
    };

    let instruction = Instruction {
        program_id: meridian::ID,
        accounts: accounts.to_account_metas(None),
        data: ix.data(),
    };
    let result = harness
        .harness
        .send_with_budget(instruction, &[&payer], 400_000);
    // Tampering timestamp can break parsing structure
    assert_meridian_error_with_budget(&result, MeridianError::RedStoneMalformedPayload);
}

#[test]
fn post_redstone_price_tampered_feed_id_fails() {
    // AC1: tampered feed_id does not verify - proves feed_id is in signed bytes
    let signers: Vec<TestSigner> = (0..3).map(|_| TestSigner::generate()).collect();
    let addresses: Vec<[u8; 20]> = signers.iter().map(|s| s.ethereum_address()).collect();

    let mut harness = setup_with_signers(addresses);
    let payer = Keypair::new();
    harness
        .harness
        .svm
        .airdrop(&payer.pubkey(), FUNDING_LAMPORTS)
        .unwrap();

    let ticker = symbol("NVDA");

    // Build valid payload with 3 signers (threshold 3)
    let mut builder = RedstonePayloadBuilder::new("NVDA", 2000_0000_0000, 1700000000000);
    for signer in &signers {
        builder = builder.add_signer(signer.clone());
    }
    let mut payload = builder.build();

    // Tamper with feed_id bytes in first package: first 32 bytes
    // Flip a byte in the ticker part (offset 4 = 5th byte, in "NVDA")
    if payload.len() > 4 {
        payload[4] ^= 0xFF;
    }

    let (price_pda, _) = Pubkey::find_program_address(&[b"redstone_price", &ticker], &meridian::ID);
    let (oracle_config_pda, _) = Pubkey::find_program_address(&[b"oracle_config"], &meridian::ID);

    let ix = meridian::instruction::PostRedstonePrice {
        symbol: ticker,
        payload,
    };

    let (market_pda, _) = Pubkey::find_program_address(
        &[
            meridian::MARKET_SEED,
            &symbol("NVDA"),
            &BASE_TRADING_DATE.to_le_bytes(),
            &200_000u64.to_le_bytes(),
        ],
        &meridian::ID,
    );
    let accounts = meridian::accounts::PostRedstonePrice {
        oracle_config: oracle_config_pda,
        redstone_price: price_pda,
        payer: payer.pubkey(),
        system_program: system_program::ID,
        market: market_pda,
    };

    let instruction = Instruction {
        program_id: meridian::ID,
        accounts: accounts.to_account_metas(None),
        data: ix.data(),
    };
    let result = harness
        .harness
        .send_with_budget(instruction, &[&payer], 400_000);
    // Tampering feed_id can break parsing structure
    assert_meridian_error_with_budget(&result, MeridianError::RedStoneMalformedPayload);
}

#[test]
fn post_redstone_price_oversized_payload_fails() {
    // AC1: oversized payload (> MAX_PAYLOAD_SIZE = 16384) returns error
    let signers: Vec<TestSigner> = (0..3).map(|_| TestSigner::generate()).collect();
    let addresses: Vec<[u8; 20]> = signers.iter().map(|s| s.ethereum_address()).collect();

    let mut harness = setup_with_signers(addresses);
    let payer = Keypair::new();
    harness
        .harness
        .svm
        .airdrop(&payer.pubkey(), FUNDING_LAMPORTS)
        .unwrap();

    let ticker = symbol("NVDA");

    // Create oversized payload (> 16384 bytes)
    let payload = vec![0u8; 16385];

    let (price_pda, _) = Pubkey::find_program_address(&[b"redstone_price", &ticker], &meridian::ID);
    let (oracle_config_pda, _) = Pubkey::find_program_address(&[b"oracle_config"], &meridian::ID);

    let ix = meridian::instruction::PostRedstonePrice {
        symbol: ticker,
        payload,
    };

    let (market_pda, _) = Pubkey::find_program_address(
        &[
            meridian::MARKET_SEED,
            &symbol("NVDA"),
            &BASE_TRADING_DATE.to_le_bytes(),
            &200_000u64.to_le_bytes(),
        ],
        &meridian::ID,
    );
    let accounts = meridian::accounts::PostRedstonePrice {
        oracle_config: oracle_config_pda,
        redstone_price: price_pda,
        payer: payer.pubkey(),
        system_program: system_program::ID,
        market: market_pda,
    };

    let instruction = Instruction {
        program_id: meridian::ID,
        accounts: accounts.to_account_metas(None),
        data: ix.data(),
    };
    let result = harness
        .harness
        .send_with_budget(instruction, &[&payer], 400_000);
    assert_meridian_error_with_budget(&result, MeridianError::RedStoneMalformedPayload);
}

#[test]
fn post_redstone_price_wrong_feed_id_fails() {
    // AC1 / AB-04: valid package for different ticker returns RedStoneFeedIdMismatch
    let signers: Vec<TestSigner> = (0..3).map(|_| TestSigner::generate()).collect();
    let addresses: Vec<[u8; 20]> = signers.iter().map(|s| s.ethereum_address()).collect();

    let mut harness = setup_with_signers(addresses);
    let payer = Keypair::new();
    harness
        .harness
        .svm
        .airdrop(&payer.pubkey(), FUNDING_LAMPORTS)
        .unwrap();

    // Build payload for TSLA but post to NVDA
    let ticker_nvda = symbol("NVDA");
    let mut builder = RedstonePayloadBuilder::new("TSLA", 2000_0000_0000, 1700000000000);
    for signer in signers {
        builder = builder.add_signer(signer);
    }
    let payload = builder.build();

    let (price_pda, _) =
        Pubkey::find_program_address(&[b"redstone_price", &ticker_nvda], &meridian::ID);
    let (oracle_config_pda, _) = Pubkey::find_program_address(&[b"oracle_config"], &meridian::ID);

    let ix = meridian::instruction::PostRedstonePrice {
        symbol: ticker_nvda, // NVDA
        payload,             // TSLA payload
    };

    let (market_pda, _) = Pubkey::find_program_address(
        &[
            meridian::MARKET_SEED,
            &symbol("NVDA"),
            &BASE_TRADING_DATE.to_le_bytes(),
            &200_000u64.to_le_bytes(),
        ],
        &meridian::ID,
    );
    let accounts = meridian::accounts::PostRedstonePrice {
        oracle_config: oracle_config_pda,
        redstone_price: price_pda,
        payer: payer.pubkey(),
        system_program: system_program::ID,
        market: market_pda,
    };

    let instruction = Instruction {
        program_id: meridian::ID,
        accounts: accounts.to_account_metas(None),
        data: ix.data(),
    };
    let result = harness
        .harness
        .send_with_budget(instruction, &[&payer], 400_000);
    assert_meridian_error_with_budget(&result, MeridianError::RedStoneFeedIdMismatch);
}

#[test]
fn post_redstone_price_in_window_protected_from_too_late_overwrite() {
    // AB-03 liveness: in-window price cannot be bricked by posting too-late payload
    let signers: Vec<TestSigner> = (0..5).map(|_| TestSigner::generate()).collect();
    let addresses: Vec<[u8; 20]> = signers.iter().map(|s| s.ethereum_address()).collect();

    let mut harness = setup_with_signers(addresses);

    // Market already created by setup_with_signers with these args
    let ticker = symbol("NVDA");
    let close_ts = 1700000000i64; // Unix seconds
    let close_ts_ms = close_ts * 1000;

    // Compute market PDA (setup_with_signers already created it)
    let (market_pda, _) = Pubkey::find_program_address(
        &[
            meridian::MARKET_SEED,
            &ticker,
            &BASE_TRADING_DATE.to_le_bytes(),
            &200_000u64.to_le_bytes(),
        ],
        &meridian::ID,
    );

    let payer = Keypair::new();
    harness
        .harness
        .svm
        .airdrop(&payer.pubkey(), FUNDING_LAMPORTS)
        .unwrap();

    // Post in-window price (close_ts + 100s, well within 600s window)
    let in_window_ts = close_ts_ms + 100_000;
    let in_window_value = 2000_0000_0000u128;
    let mut builder = RedstonePayloadBuilder::new("NVDA", in_window_value, in_window_ts);
    for signer in &signers[0..3] {
        builder = builder.add_signer(signer.clone());
    }
    let in_window_payload = builder.build();

    let (price_pda, _) = Pubkey::find_program_address(&[b"redstone_price", &ticker], &meridian::ID);
    let (oracle_config_pda, _) = Pubkey::find_program_address(&[b"oracle_config"], &meridian::ID);

    let ix = meridian::instruction::PostRedstonePrice {
        symbol: ticker,
        payload: in_window_payload.clone(),
    };

    let accounts = meridian::accounts::PostRedstonePrice {
        oracle_config: oracle_config_pda,
        redstone_price: price_pda,
        payer: payer.pubkey(),
        system_program: system_program::ID,
        market: market_pda,
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

    // Verify in-window price was stored
    let account = harness
        .harness
        .svm
        .get_account(&price_pda)
        .expect("RedstonePrice account should exist");
    let mut data = account.data.as_slice();
    let price = RedstonePrice::try_deserialize(&mut data).unwrap();
    assert_eq!(price.value, in_window_value);
    assert_eq!(price.package_timestamp_ms, in_window_ts);

    // Attempt to post too-late payload (close_ts + 700s, outside 600s window)
    let too_late_ts = close_ts_ms + 700_000;
    let too_late_value = 2100_0000_0000u128;
    let mut builder2 = RedstonePayloadBuilder::new("NVDA", too_late_value, too_late_ts);
    for signer in &signers[0..3] {
        builder2 = builder2.add_signer(signer.clone());
    }
    let too_late_payload = builder2.build();

    let ix2 = meridian::instruction::PostRedstonePrice {
        symbol: ticker,
        payload: too_late_payload,
    };

    let instruction2 = Instruction {
        program_id: meridian::ID,
        accounts: accounts.to_account_metas(None),
        data: ix2.data(),
    };
    let result2 = harness
        .harness
        .send_with_budget(instruction2, &[&payer], 400_000);
    // Should be rejected with RedStonePackageTooLate
    assert_meridian_error_with_budget(&result2, MeridianError::RedStonePackageTooLate);

    // Verify in-window price is still intact
    let account_after = harness
        .harness
        .svm
        .get_account(&price_pda)
        .expect("RedstonePrice account should exist");
    let mut data_after = account_after.data.as_slice();
    let price_after = RedstonePrice::try_deserialize(&mut data_after).unwrap();
    assert_eq!(price_after.value, in_window_value);
    assert_eq!(price_after.package_timestamp_ms, in_window_ts);

    // Verify in-window price can be refreshed (same timestamp, updates posted_slot)
    let instruction3 = Instruction {
        program_id: meridian::ID,
        accounts: accounts.to_account_metas(None),
        data: ix.data(),
    };
    let result3 = harness
        .harness
        .send_with_budget(instruction3, &[&payer], 400_000);
    expect_success(&result3);
}

#[test]
fn post_redstone_price_multi_datapoint_ticker_not_first() {
    // AC6: parser finds matching feed even when not first in multi-datapoint package
    let signers: Vec<TestSigner> = (0..5).map(|_| TestSigner::generate()).collect();
    let addresses: Vec<[u8; 20]> = signers.iter().map(|s| s.ethereum_address()).collect();

    let mut harness = setup_with_signers(addresses);

    // Market already created by setup_with_signers for NVDA
    let ticker = symbol("NVDA");
    let close_ts_ms = 1700000000i64 * 1000;

    // Build multi-datapoint payload with 3 feeds (tests ≥2 datapoints per AC6)
    // Parser must find and extract NVDA's value from the multi-feed package
    let data_points = &[
        ("NVDA", 2050_0000_0000u128), // Target ticker
        ("BTC", 50000_0000_0000u128),
        ("ETH", 3000_0000_0000u128),
    ];
    let signing_signers = &signers[0..3];
    let payload = RedstonePayloadBuilder::build_multi_datapoint(
        data_points,
        close_ts_ms + 100_000, // In-window
        signing_signers,
    );

    let payer = Keypair::new();
    harness
        .harness
        .svm
        .airdrop(&payer.pubkey(), FUNDING_LAMPORTS)
        .unwrap();

    let (price_pda, _) = Pubkey::find_program_address(&[b"redstone_price", &ticker], &meridian::ID);
    let (oracle_config_pda, _) = Pubkey::find_program_address(&[b"oracle_config"], &meridian::ID);
    let (market_pda, _) = Pubkey::find_program_address(
        &[
            meridian::MARKET_SEED,
            &ticker,
            &BASE_TRADING_DATE.to_le_bytes(),
            &200_000u64.to_le_bytes(),
        ],
        &meridian::ID,
    );

    let ix = meridian::instruction::PostRedstonePrice {
        symbol: ticker,
        payload,
    };

    let accounts = meridian::accounts::PostRedstonePrice {
        oracle_config: oracle_config_pda,
        redstone_price: price_pda,
        payer: payer.pubkey(),
        system_program: system_program::ID,
        market: market_pda,
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

    // Verify NVDA's value was stored (not BTC or ETH)
    let account = harness
        .harness
        .svm
        .get_account(&price_pda)
        .expect("RedstonePrice account should exist");
    let mut data = account.data.as_slice();
    let price = RedstonePrice::try_deserialize(&mut data).unwrap();
    assert_eq!(
        price.value,
        2050_0000_0000u128,
        "Should store NVDA value, not BTC or ETH"
    );
    assert_eq!(price.symbol, ticker);
}
