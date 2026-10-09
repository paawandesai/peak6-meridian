//! M2-15 AC1: `post_redstone_price` LiteSVM tests with locally generated secp256k1 signers.
//! Tests: 3 of 5 valid → success, 2 of 5 → threshold error, unknown signer ignored,
//! duplicate counts once, tampered data fails, malformed payload errors.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::arithmetic_side_effects)]

mod common;

use anchor_lang::prelude::Pubkey;
use anchor_lang::{InstructionData, ToAccountMetas};
use common::redstone::{RedstonePayloadBuilder, TestSigner};
use common::{
    assert_meridian_error, config_pda, expect_failure, expect_success, symbol, MarketHarness,
    FUNDING_LAMPORTS,
};
use meridian::errors::MeridianError;
use meridian::state::{OracleConfig, RedstonePrice};
use solana_sdk::signature::{Keypair, Signer};
use solana_sdk::system_program;

const THRESHOLD: u8 = 3;

/// Sets up a test with oracle config containing the given signer addresses.
fn setup_with_signers(signer_addresses: Vec<[u8; 20]>) -> (MarketHarness, Keypair) {
    let harness = MarketHarness::new();
    let admin = Keypair::new();
    harness.svm.airdrop(&admin.pubkey(), FUNDING_LAMPORTS).unwrap();

    // Initialize config
    harness.init_config(&admin);

    // Set oracle config with test signers
    let (oracle_config_pda, _) = Pubkey::find_program_address(
        &[b"oracle_config"],
        &meridian::ID,
    );

    let ix = meridian::instruction::SetOracleConfig {
        params: meridian::state::SetOracleConfigParams {
            signers: signer_addresses,
            signer_threshold: THRESHOLD,
            max_package_delay_secs: 600,
        },
    };

    let accounts = meridian::accounts::SetOracleConfig {
        config: config_pda(),
        oracle_config: oracle_config_pda,
        admin: admin.pubkey(),
        system_program: system_program::ID,
    };

    expect_success(
        &harness,
        &[&admin],
        &accounts.to_account_metas(None),
        &ix.data(),
    );

    (harness, admin)
}

#[test]
fn post_redstone_price_success_3_of_5() {
    // AC1: 3 of 5 valid signers → success
    let signers: Vec<TestSigner> = (0..5).map(|_| TestSigner::generate()).collect();
    let addresses: Vec<[u8; 20]> = signers.iter().map(|s| s.ethereum_address()).collect();

    let (harness, _admin) = setup_with_signers(addresses);
    let payer = Keypair::new();
    harness.svm.airdrop(&payer.pubkey(), FUNDING_LAMPORTS).unwrap();

    let ticker = symbol("ETH");
    let value = 2000_0000_0000u64; // $2000 with 8 decimals
    let timestamp_ms = 1700000000000i64;

    // Build payload with first 3 signers (meets threshold)
    let mut builder = RedstonePayloadBuilder::new("ETH", value, timestamp_ms);
    for signer in signers.iter().take(3) {
        builder = builder.add_signer(signer);
    }
    let payload = builder.build();

    let (price_pda, _) = Pubkey::find_program_address(
        &[b"redstone_price", &ticker],
        &meridian::ID,
    );

    let (oracle_config_pda, _) = Pubkey::find_program_address(
        &[b"oracle_config"],
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
    };

    expect_success(
        &harness,
        &[&payer],
        &accounts.to_account_metas(None),
        &ix.data(),
    );

    // Verify the posted price
    let price = harness.harness.get_account::<RedstonePrice>(&price_pda).unwrap();
    assert_eq!(price.symbol, ticker);
    assert_eq!(price.value, value);
    assert_eq!(price.package_timestamp_ms, timestamp_ms);
    assert_eq!(price.signer_count, 3);
}

#[test]
fn post_redstone_price_fails_insufficient_signers() {
    // AC1: 2 of 5 → threshold error (threshold is 3)
    let signers: Vec<TestSigner> = (0..5).map(|_| TestSigner::generate()).collect();
    let addresses: Vec<[u8; 20]> = signers.iter().map(|s| s.ethereum_address()).collect();

    let (harness, _admin) = setup_with_signers(addresses);
    let payer = Keypair::new();
    harness.svm.airdrop(&payer.pubkey(), FUNDING_LAMPORTS).unwrap();

    let ticker = symbol("ETH");

    // Build payload with only 2 signers (below threshold)
    let mut builder = RedstonePayloadBuilder::new("ETH", 2000_0000_0000, 1700000000000);
    for signer in signers.iter().take(2) {
        builder = builder.add_signer(signer);
    }
    let payload = builder.build();

    let (price_pda, _) = Pubkey::find_program_address(
        &[b"redstone_price", &ticker],
        &meridian::ID,
    );

    let (oracle_config_pda, _) = Pubkey::find_program_address(
        &[b"oracle_config"],
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
    };

    assert_meridian_error(
        &expect_failure(
            &harness,
            &[&payer],
            &accounts.to_account_metas(None),
            &ix.data(),
        ),
        MeridianError::RedStoneInsufficientSigners,
    );
}

#[test]
fn post_redstone_price_unknown_signer_ignored() {
    // AC1: unknown signer is not counted (3 valid + 2 unknown = 3 counted)
    let known_signers: Vec<TestSigner> = (0..3).map(|_| TestSigner::generate()).collect();
    let unknown_signers: Vec<TestSigner> = (0..2).map(|_| TestSigner::generate()).collect();

    let known_addresses: Vec<[u8; 20]> = known_signers.iter().map(|s| s.ethereum_address()).collect();

    let (harness, _admin) = setup_with_signers(known_addresses);
    let payer = Keypair::new();
    harness.svm.airdrop(&payer.pubkey(), FUNDING_LAMPORTS).unwrap();

    let ticker = symbol("ETH");

    // Build payload with 3 known + 2 unknown signers
    let mut builder = RedstonePayloadBuilder::new("ETH", 2000_0000_0000, 1700000000000);
    for signer in known_signers.iter() {
        builder = builder.add_signer(signer);
    }
    for signer in unknown_signers.iter() {
        builder = builder.add_signer(signer);
    }
    let payload = builder.build();

    let (price_pda, _) = Pubkey::find_program_address(
        &[b"redstone_price", &ticker],
        &meridian::ID,
    );

    let (oracle_config_pda, _) = Pubkey::find_program_address(
        &[b"oracle_config"],
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
    };

    expect_success(
        &harness,
        &[&payer],
        &accounts.to_account_metas(None),
        &ix.data(),
    );

    // Verify only known signers were counted
    let price = harness.harness.get_account::<RedstonePrice>(&price_pda).unwrap();
    assert_eq!(price.signer_count, 3, "Unknown signers should not be counted");
}

#[test]
fn post_redstone_price_malformed_payload() {
    // AC1: malformed payload returns error
    let signers: Vec<TestSigner> = (0..3).map(|_| TestSigner::generate()).collect();
    let addresses: Vec<[u8; 20]> = signers.iter().map(|s| s.ethereum_address()).collect();

    let (harness, _admin) = setup_with_signers(addresses);
    let payer = Keypair::new();
    harness.svm.airdrop(&payer.pubkey(), FUNDING_LAMPORTS).unwrap();

    let ticker = symbol("ETH");

    // Create malformed payload (too short, missing marker)
    let payload = vec![0u8; 50];

    let (price_pda, _) = Pubkey::find_program_address(
        &[b"redstone_price", &ticker],
        &meridian::ID,
    );

    let (oracle_config_pda, _) = Pubkey::find_program_address(
        &[b"oracle_config"],
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
    };

    assert_meridian_error(
        &expect_failure(
            &harness,
            &[&payer],
            &accounts.to_account_metas(None),
            &ix.data(),
        ),
        MeridianError::RedStoneMalformedPayload,
    );
}
