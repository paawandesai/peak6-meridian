//! AB-06 (NFR-08, D-030): admin-only instructions reject every other signer. M1-02 covers
//! `update_config`; later tickets extend this file for override, pause and add_strike.

use anchor_lang::error::ErrorCode;
use anchor_lang::prelude::Pubkey;
use meridian::errors::MeridianError;
use security_tests::harness::{
    assert_anchor_error, assert_meridian_error, config_pda, default_params, expect_failure,
    expect_success, Harness,
};
use solana_sdk::signature::Signer;

#[test]
fn update_config_succeeds_for_the_admin() {
    let mut harness = Harness::new();
    expect_success(&harness.initialize_config(&default_params(Pubkey::new_unique())));

    let params = default_params(Pubkey::new_unique());
    expect_success(&harness.update_config(&params));
    let config = harness.config();
    assert_eq!(config.admin, harness.admin.pubkey());
    assert_eq!(config.automation_authority, params.automation_authority);
}

#[test]
fn update_config_rejects_every_other_signer() {
    let mut harness = Harness::new();
    expect_success(&harness.initialize_config(&default_params(Pubkey::new_unique())));
    let usdc_mint = harness.usdc_mint;

    // A random wallet, and the automation authority itself (it may only create markets, AB-19).
    let intruder = harness.funded_keypair();
    let automation = harness.funded_keypair();
    let mut params = default_params(automation.pubkey());
    params.max_conf_bps = 500;
    expect_success(&harness.update_config(&params));

    for signer in [&intruder, &automation] {
        let attempt = default_params(signer.pubkey());
        let result = harness.update_config_as(signer, config_pda(), usdc_mint, &attempt);
        assert_meridian_error(&result, MeridianError::AdminOnly);
    }
    let config = harness.config();
    assert_eq!(config.admin, harness.admin.pubkey());
    assert_eq!(config.automation_authority, automation.pubkey());
    assert_eq!(config.max_conf_bps, 500);
}

#[test]
fn update_config_rejects_a_substituted_config_account() {
    let mut harness = Harness::new();
    expect_success(&harness.initialize_config(&default_params(Pubkey::new_unique())));
    let usdc_mint = harness.usdc_mint;

    // A non-admin cannot point the instruction at an account that is not the config PDA: a
    // wallet is rejected on its owner, before the seeds and admin checks even run.
    let intruder = harness.funded_keypair();
    let fake_config = harness.funded_keypair().pubkey();
    let result = harness.update_config_as(
        &intruder,
        fake_config,
        usdc_mint,
        &default_params(intruder.pubkey()),
    );
    assert_anchor_error(&result, ErrorCode::AccountOwnedByWrongProgram);
    assert_eq!(harness.config().admin, harness.admin.pubkey());
}

#[test]
fn nobody_can_re_initialize_the_config_to_take_over_admin() {
    let mut harness = Harness::new();
    expect_success(&harness.initialize_config(&default_params(Pubkey::new_unique())));

    let intruder = harness.funded_keypair();
    let mint = harness.create_mint(6);
    expect_failure(&harness.initialize_config_as(
        &intruder,
        mint,
        &default_params(intruder.pubkey()),
    ));
    assert_eq!(harness.config().admin, harness.admin.pubkey());
}

#[test]
fn update_config_cannot_change_the_admin() {
    // `ConfigParams` has no admin field: the only way to change the admin is a new deployment.
    let mut harness = Harness::new();
    expect_success(&harness.initialize_config(&default_params(Pubkey::new_unique())));
    expect_success(&harness.update_config(&default_params(Pubkey::new_unique())));
    assert_eq!(harness.config().admin, harness.admin.pubkey());
    let field_names = [
        "automation_authority",
        "tickers",
        "max_staleness_slots",
        "max_conf_bps",
        "override_delay_secs",
    ];
    let source = include_str!("../../../../programs/meridian/src/state/config.rs");
    let params_struct = source
        .split("pub struct ConfigParams {")
        .nth(1)
        .and_then(|rest| rest.split('}').next())
        .expect("ConfigParams struct");
    for name in field_names {
        assert!(
            params_struct.contains(&format!("pub {name}:")),
            "ConfigParams has {name}"
        );
    }
    assert!(
        !params_struct.contains("pub admin:"),
        "ConfigParams must not carry admin"
    );
}
