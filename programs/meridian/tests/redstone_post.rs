//! M2-15 AC1: `post_redstone_price` LiteSVM tests with locally generated secp256k1 signers.
//! Tests: 3 of 5 valid → success, 2 of 5 → threshold error, unknown signer ignored,
//! duplicate signer counts once, invalid recovery ID → RedStoneInvalidSignature,
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
    assert_meridian_error_with_budget, config_pda, expect_success, symbol, MarketHarness,
    FUNDING_LAMPORTS,
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
    let value = 2000_0000_0000u64; // $2000 with 8 decimals
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
    let value = 2000_0000_0000u64;
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

    // Verify duplicate was counted only once (3 unique, not 4)
    let account = harness.harness.svm.get_account(&price_pda).unwrap();
    let mut data = account.data.as_slice();
    let price = RedstonePrice::try_deserialize(&mut data).unwrap();
    assert_eq!(price.signer_count, 3, "Duplicate signer should count once (3 unique from 4 packages)");
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
    assert_meridian_error_with_budget(&result, MeridianError::RedStoneInvalidSignature);
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
    assert_meridian_error_with_budget(&result, MeridianError::RedStoneFeedIdMismatch);
}
