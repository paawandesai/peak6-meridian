//! AB-06 (NFR-08, D-030): admin-only instructions reject every other signer. M1-02 covers
//! `update_config`; later tickets extend this file for override, pause and add_strike, and
//! M3-10b for `migrate_config`.

use anchor_lang::error::ErrorCode;
use anchor_lang::prelude::Pubkey;
use meridian::errors::MeridianError;
use security_tests::harness::migration::pyth_params;
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

// ---- M1-04: create_strike_market (automation only), add_strike and pause (admin only) ------

use meridian::state::PAIR_COLLATERAL;
use security_tests::harness::{expect_success as ok, MarketArgs, MarketHarness};

#[test]
fn create_strike_market_rejects_every_signer_but_the_automation_authority() {
    let mut h = MarketHarness::new();
    let admin = h.harness.admin.insecure_clone();
    let intruder = h.harness.funded_keypair();
    let args = MarketArgs::base();
    for signer in [&admin, &intruder] {
        let (addresses, result) = h.harness.create_strike_market_as(signer, &args);
        assert_meridian_error(&result, MeridianError::AutomationOnly);
        assert!(h.harness.is_absent(addresses.market));
    }
    let automation = h.automation.insecure_clone();
    let (addresses, result) = h.harness.create_strike_market_as(&automation, &args);
    ok(&result);
    assert!(!h.harness.is_absent(addresses.market));
}

#[test]
fn add_strike_rejects_every_signer_but_the_admin() {
    let mut h = MarketHarness::new();
    let automation = h.automation.insecure_clone();
    let intruder = h.harness.funded_keypair();
    let args = MarketArgs::base().with_strike(75_000);
    // The automation authority may only create the daily markets (AB-19), not add strikes.
    for signer in [&automation, &intruder] {
        let (addresses, result) = h.harness.add_strike_as(signer, &args);
        assert_meridian_error(&result, MeridianError::AdminOnly);
        assert!(h.harness.is_absent(addresses.market));
    }
    let admin = h.harness.admin.insecure_clone();
    let (addresses, result) = h.harness.add_strike_as(&admin, &args);
    ok(&result);
    assert!(!h.harness.is_absent(addresses.market));
}

#[test]
fn pause_and_unpause_reject_every_signer_but_the_admin() {
    let mut h = MarketHarness::new();
    let automation = h.automation.insecure_clone();
    let intruder = h.harness.funded_keypair();
    for signer in [&automation, &intruder] {
        assert_meridian_error(&h.harness.pause_as(signer), MeridianError::AdminOnly);
        assert!(!h.harness.config().paused);
    }
    ok(&h.harness.pause());
    assert!(h.harness.config().paused);
    for signer in [&automation, &intruder] {
        assert_meridian_error(&h.harness.unpause_as(signer), MeridianError::AdminOnly);
        assert!(h.harness.config().paused);
    }
    ok(&h.harness.unpause());
    assert!(!h.harness.config().paused);
}

#[test]
fn a_stolen_automation_key_cannot_move_funds_or_pause() {
    // D-030: the automation authority creates markets and nothing else.
    let mut h = MarketHarness::new();
    let addresses = h.base_market();
    let user = h.harness.user_for(&addresses, PAIR_COLLATERAL);
    ok(&h.harness.mint_pair(&user, &addresses, 1));
    let automation = h.automation.insecure_clone();
    assert_meridian_error(&h.harness.pause_as(&automation), MeridianError::AdminOnly);
    assert_meridian_error(
        &h.harness
            .add_strike_as(&automation, &MarketArgs::base().with_strike(70_000))
            .1,
        MeridianError::AdminOnly,
    );
    assert_meridian_error(
        &h.harness.update_config_as(
            &automation,
            config_pda(),
            h.harness.usdc_mint,
            &default_params(automation.pubkey()),
        ),
        MeridianError::AdminOnly,
    );
    h.harness.assert_market_invariants(&addresses);
}

// ---- M3-10b: migrate_config ------------------------------------------------------------------

#[test]
fn migrate_config_succeeds_for_the_admin() {
    let mut harness = Harness::new();
    expect_success(&harness.initialize_config(&default_params(Pubkey::new_unique())));
    harness.downgrade_config_to_v1();
    let signer = Pubkey::new_unique();
    expect_success(&harness.migrate_config(Some(pyth_params(signer))));
    let config = harness.config();
    assert_eq!(config.admin, harness.admin.pubkey());
    assert_eq!(config.pyth_lazer_signer, signer);
}

#[test]
fn migrate_config_rejects_every_other_signer_and_cannot_pin_a_pyth_signer() {
    let mut harness = Harness::new();
    let automation = harness.funded_keypair();
    expect_success(&harness.initialize_config(&default_params(automation.pubkey())));
    let v1 = harness.downgrade_config_to_v1();
    let intruder = harness.funded_keypair();

    // A non-admin must not be able to grow the account and pin its own Pyth Lazer signer
    // (which would let it settle every market with prices it signs, AB-04).
    for signer in [&intruder, &automation] {
        let result = harness.migrate_config_as(signer, Some(pyth_params(signer.pubkey())));
        assert_meridian_error(&result, MeridianError::AdminOnly);
    }
    assert_eq!(harness.config_account().data, v1, "config untouched");

    // Nor through a substituted account at another address.
    let fake = harness.funded_keypair().pubkey();
    let ix = Harness::migrate_config_ix(intruder.pubkey(), fake, Some(pyth_params(fake)));
    let result = harness.send(ix, &[&intruder]);
    assert_anchor_error(&result, ErrorCode::ConstraintSeeds);
}
