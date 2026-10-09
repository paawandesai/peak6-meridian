//! M2-15 AC3: RedStone permission tests.
//! Tests: set_oracle_config admin-only, threshold validation, post_redstone_price permissionless.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::arithmetic_side_effects)]

mod common;

use anchor_lang::prelude::Pubkey;
use anchor_lang::{InstructionData, ToAccountMetas};
use common::redstone::{RedstonePayloadBuilder, TestSigner};
use common::{
    assert_meridian_error, config_pda, expect_success, symbol, MarketHarness, FUNDING_LAMPORTS,
};
use meridian::errors::MeridianError;
use solana_sdk::instruction::Instruction;
use solana_sdk::signature::{Keypair, Signer};
use solana_sdk::system_program;

const THRESHOLD: u8 = 3;

#[test]
fn set_oracle_config_rejects_non_admin() {
    // AC3: set_oracle_config rejects non-admin signer
    let mut harness = MarketHarness::new();
    let non_admin = Keypair::new();
    harness.harness.svm.airdrop(&non_admin.pubkey(), FUNDING_LAMPORTS).unwrap();

    let signers: Vec<[u8; 20]> = (0..5).map(|_| [0u8; 20]).collect();

    let (oracle_config_pda, _) = Pubkey::find_program_address(
        &[b"oracle_config"],
        &meridian::ID,
    );

    let params = meridian::SetOracleConfigParams {
        signers,
        signer_threshold: THRESHOLD,
        max_package_delay_secs: 600,
    };

    let ix = meridian::instruction::SetOracleConfig { params };
    let accounts = meridian::accounts::SetOracleConfig {
        config: config_pda(),
        oracle_config: oracle_config_pda,
        admin: non_admin.pubkey(),
        system_program: system_program::ID,
    };

    let instruction = Instruction {
        program_id: meridian::ID,
        accounts: accounts.to_account_metas(None),
        data: ix.data(),
    };
    let result = harness.harness.send(instruction, &[&non_admin]);
    assert_meridian_error(&result, MeridianError::AdminOnly);
}

#[test]
fn set_oracle_config_rejects_threshold_zero() {
    // AC3: set_oracle_config rejects threshold=0
    let mut harness = MarketHarness::new();
    let admin = harness.harness.admin.insecure_clone();

    let signers: Vec<[u8; 20]> = (0..5).map(|_| [0u8; 20]).collect();

    let (oracle_config_pda, _) = Pubkey::find_program_address(
        &[b"oracle_config"],
        &meridian::ID,
    );

    let params = meridian::SetOracleConfigParams {
        signers,
        signer_threshold: 0, // Invalid: must be >= 1
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
    assert_meridian_error(&result, MeridianError::OracleThresholdTooLow);
}

#[test]
fn set_oracle_config_rejects_threshold_too_high() {
    // AC3: set_oracle_config rejects threshold > signers.len()
    let mut harness = MarketHarness::new();
    let admin = harness.harness.admin.insecure_clone();

    let signers: Vec<[u8; 20]> = (0..3).map(|_| [0u8; 20]).collect();

    let (oracle_config_pda, _) = Pubkey::find_program_address(
        &[b"oracle_config"],
        &meridian::ID,
    );

    let params = meridian::SetOracleConfigParams {
        signers,
        signer_threshold: 5, // Invalid: > 3 signers
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
    assert_meridian_error(&result, MeridianError::OracleThresholdTooHigh);
}

#[test]
fn post_redstone_price_is_permissionless() {
    // AC3: post_redstone_price succeeds for any payer (permissionless)
    let mut harness = MarketHarness::new();
    let admin = harness.harness.admin.insecure_clone();

    // Setup oracle config first
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

    // Now post price as a random payer (not admin)
    let random_payer = Keypair::new();
    harness.harness.svm.airdrop(&random_payer.pubkey(), FUNDING_LAMPORTS).unwrap();

    let ticker = symbol("NVDA");
    let mut builder = RedstonePayloadBuilder::new("NVDA", 2000_0000_0000, 1700000000000);
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
        payer: random_payer.pubkey(),
        system_program: system_program::ID,
    };

    let post_instruction = Instruction {
        program_id: meridian::ID,
        accounts: post_accounts.to_account_metas(None),
        data: post_ix.data(),
    };
    let post_result = harness.harness.send(post_instruction, &[&random_payer]);
    expect_success(&post_result); // Succeeds even though payer is not admin
}
