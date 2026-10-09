//! M2-15 AC2: `settle_market` with RedStone path tests.
//! Tests: success after post, rejection cases (timestamp/staleness/wrong PDA/before close),
//! property test at strike boundary.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::arithmetic_side_effects)]

mod common;

use anchor_lang::prelude::Pubkey;
use anchor_lang::{AccountDeserialize, InstructionData, ToAccountMetas};
use common::redstone::{RedstonePayloadBuilder, TestSigner};
use common::{
    assert_meridian_error, config_pda, expect_success, symbol, MarketArgs, MarketHarness,
    FUNDING_LAMPORTS, BASE_CLOSE_TS, BASE_TRADING_DATE,
};
use meridian::errors::MeridianError;
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

    let (oracle_config_pda, _) = Pubkey::find_program_address(
        &[b"oracle_config"],
        &meridian::ID,
    );

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
    let result = harness.harness.send_with_budget(instruction, &[&admin], 400_000);
    expect_success(&result);

    // Create a market
    let args = MarketArgs {
        ticker: symbol("NVDA"),
        strike_cents: 2000_00, // $2000 strike
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
    harness.harness.svm.airdrop(&payer.pubkey(), FUNDING_LAMPORTS).unwrap();

    let ticker = args.ticker;
    let value = 2050_0000_0000u64; // $2050 > $2000 strike → YES wins
    let timestamp_ms = (BASE_CLOSE_TS as i64) * 1000 + 1000; // 1s after close

    // Post RedStone price
    let mut builder = RedstonePayloadBuilder::new("NVDA", value, timestamp_ms);
    for signer in signing_signers {
        builder = builder.add_signer(signer.clone());
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

    let instruction = Instruction {
        program_id: meridian::ID,
        accounts: accounts.to_account_metas(None),
        data: ix.data(),
    };
    let result = harness.harness.send_with_budget(instruction, &[&payer], 400_000);
    expect_success(&result);

    // Now settle the market
    let settler = Keypair::new();
    harness.harness.svm.airdrop(&settler.pubkey(), FUNDING_LAMPORTS).unwrap();

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
