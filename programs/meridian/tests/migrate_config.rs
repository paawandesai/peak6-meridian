//! `migrate_config` (M3-10b): grows the v1 Config account (1,076 bytes) to the current layout
//! (1,144 bytes) in place. Success and failure paths against the built program in LiteSVM,
//! including the recorded devnet v1 account and the behaviour of other instructions before and
//! after the migration.

mod common;

use anchor_lang::error::ErrorCode;
use anchor_lang::prelude::Pubkey;
use anchor_lang::{AccountDeserialize, Discriminator};
use base64::prelude::{Engine, BASE64_STANDARD};
use common::migration::pyth_params;
use common::{
    assert_anchor_error, assert_meridian_error, config_pda, default_params, expect_failure,
    expect_success, find_event, repo_root, Harness, MarketArgs, MarketHarness, BASE_UNIX_TS,
};
use meridian::errors::MeridianError;
use meridian::events::ConfigMigrated;
use meridian::state::{
    Config, PythConfigParams, CONFIG_ADMIN_OFFSET, CONFIG_LEN, CONFIG_PYTH_FIELDS_LEN,
    CONFIG_V1_LEN, PAIR_COLLATERAL, TICKER_COUNT,
};
use solana_sdk::signature::Signer;

/// The devnet Config account (PDA 6Bf88kHF…, program H8SBU6m8…) as dumped by
/// `solana account 6Bf88kHFDDjdXG1BEdrj1edkLwWt9pEiKPFp6Ekhkoew -u devnet --output json` on
/// 2026-10-10, before the M3-10b upgrade: 1,076 bytes, admin 6cp7Exvk….
pub const DEVNET_CONFIG_FIXTURE: &str =
    "programs/meridian/tests/fixtures/config/config_v1_devnet.json";

/// The recorded devnet v1 Config: (lamports, data).
pub fn devnet_v1_config() -> (u64, Vec<u8>) {
    let path = repo_root().join(DEVNET_CONFIG_FIXTURE);
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("cannot read {}: {error}", path.display()));
    let json: serde_json::Value = serde_json::from_str(&text).unwrap();
    let account = &json["account"];
    assert_eq!(account["owner"].as_str().unwrap(), meridian::ID.to_string());
    let lamports = account["lamports"].as_u64().unwrap();
    let data = BASE64_STANDARD
        .decode(account["data"][0].as_str().unwrap())
        .unwrap();
    assert_eq!(data.len(), CONFIG_V1_LEN, "the fixture is a v1 account");
    (lamports, data)
}

/// A market harness whose Config was rewritten as a v1 account; returns it with the v1 bytes.
fn v1_harness() -> (MarketHarness, Vec<u8>) {
    let mut market_harness = MarketHarness::new();
    let v1 = market_harness.harness.downgrade_config_to_v1();
    (market_harness, v1)
}

/// The Pyth tail as `Config` stores it: signer, feed ids (LE u32), max age (LE i64).
fn tail_bytes(params: &PythConfigParams) -> Vec<u8> {
    let mut out = params.pyth_lazer_signer.to_bytes().to_vec();
    for id in params.pyth_feed_ids {
        out.extend_from_slice(&id.to_le_bytes());
    }
    out.extend_from_slice(&params.pyth_max_age_secs.to_le_bytes());
    out
}

/// Asserts the account is unchanged: same bytes and lamports.
fn assert_untouched(harness: &Harness, data: &[u8], lamports: u64) {
    let account = harness.config_account();
    assert_eq!(account.data, data, "config bytes unchanged");
    assert_eq!(account.lamports, lamports, "config lamports unchanged");
}

#[test]
fn layout_constants_match_the_devnet_account() {
    assert_eq!(CONFIG_V1_LEN, 1_076);
    assert_eq!(CONFIG_LEN, 1_144);
    assert_eq!(CONFIG_PYTH_FIELDS_LEN, 68);
    let (_, data) = devnet_v1_config();
    assert_eq!(&data[..8], Config::DISCRIMINATOR);
    let (_, bump) = Pubkey::find_program_address(&[meridian::state::CONFIG_SEED], &meridian::ID);
    assert_eq!(
        data[CONFIG_V1_LEN - 1],
        bump,
        "v1 ends with the canonical bump"
    );
}

#[test]
fn migrate_grows_the_account_keeps_every_old_byte_and_sets_pyth() {
    let (mut mh, v1) = v1_harness();
    let h = &mut mh.harness;
    let admin = h.admin.pubkey();
    let admin_before = h.svm.get_balance(&admin).unwrap();
    let lamports_before = h.config_account().lamports;
    let signer = Pubkey::new_unique();
    let params = pyth_params(signer);

    let result = h.migrate_config(Some(params));
    let meta = expect_success(&result);

    let account = h.config_account();
    assert_eq!(account.data.len(), CONFIG_LEN);
    assert_eq!(account.owner, meridian::ID);
    assert_eq!(
        &account.data[..CONFIG_V1_LEN],
        &v1[..],
        "old prefix byte-for-byte"
    );
    assert_eq!(&account.data[CONFIG_V1_LEN..], &tail_bytes(&params)[..]);
    let rent = h.svm.minimum_balance_for_rent_exemption(CONFIG_LEN);
    assert_eq!(account.lamports, rent, "topped up to exactly rent-exempt");
    let top_up = rent - lamports_before;
    assert!(top_up > 0);
    let admin_after = h.svm.get_balance(&admin).unwrap();
    assert_eq!(
        admin_before - admin_after,
        top_up + 5_000,
        "admin paid top-up + fee"
    );

    let config = h.config();
    assert_eq!(config.admin, admin);
    assert_eq!(config.automation_authority, mh.automation.pubkey());
    assert_eq!(config.pyth_lazer_signer, signer);
    assert_eq!(config.pyth_feed_ids, params.pyth_feed_ids);
    assert_eq!(config.pyth_max_age_secs, 30);

    let event: ConfigMigrated = find_event(meta).expect("ConfigMigrated emitted");
    assert_eq!(event.admin, admin);
    assert_eq!(event.old_len, 1_076);
    assert_eq!(event.new_len, 1_144);
    assert_eq!(event.rent_top_up, top_up);
    assert!(event.pyth_set);
    assert_eq!(event.pyth_lazer_signer, signer);
    assert_eq!(event.pyth_max_age_secs, 30);
}

#[test]
fn migrate_without_pyth_zero_fills_the_new_fields() {
    let (mut mh, v1) = v1_harness();
    let h = &mut mh.harness;
    let meta = expect_success(&h.migrate_config(None)).clone();

    let account = h.config_account();
    assert_eq!(&account.data[..CONFIG_V1_LEN], &v1[..]);
    assert!(account.data[CONFIG_V1_LEN..].iter().all(|byte| *byte == 0));
    let config = h.config();
    assert_eq!(config.pyth_lazer_signer, Pubkey::default());
    assert_eq!(config.pyth_feed_ids, [0u32; TICKER_COUNT]);
    assert_eq!(config.pyth_max_age_secs, 0);
    let event: ConfigMigrated = find_event(&meta).expect("ConfigMigrated emitted");
    assert!(!event.pyth_set);

    // A later update_config sets them (and requires a positive max age).
    let mut params = default_params(mh.automation.pubkey());
    params.tickers = vec![];
    params.pyth_max_age_secs = 0;
    assert_meridian_error(
        &mh.harness.update_config(&params),
        MeridianError::InvalidPythMaxAge,
    );
    params.pyth_max_age_secs = 45;
    params.pyth_lazer_signer = Pubkey::new_unique();
    params.pyth_feed_ids[5] = meridian::pyth::feed_ids::META;
    expect_success(&mh.harness.update_config(&params));
    let config = mh.harness.config();
    assert_eq!(config.pyth_max_age_secs, 45);
    assert_eq!(config.pyth_lazer_signer, params.pyth_lazer_signer);
    assert_eq!(config.pyth_feed_ids[5], meridian::pyth::feed_ids::META);
    assert_eq!(
        &mh.harness.config_account().data[CONFIG_ADMIN_OFFSET..40],
        &v1[8..40]
    );
}

#[test]
fn migrate_skips_the_transfer_when_the_account_already_holds_enough_rent() {
    let (mut mh, v1) = v1_harness();
    let h = &mut mh.harness;
    let rich = h.svm.minimum_balance_for_rent_exemption(CONFIG_LEN) + 1;
    h.put_account(config_pda(), meridian::ID, rich, v1);
    let meta = expect_success(&h.migrate_config(None)).clone();
    let event: ConfigMigrated = find_event(&meta).expect("ConfigMigrated emitted");
    assert_eq!(event.rent_top_up, 0);
    assert_eq!(h.config_account().lamports, rich);
}

#[test]
fn migrate_rejects_a_non_admin_and_changes_nothing() {
    let (mut mh, v1) = v1_harness();
    let h = &mut mh.harness;
    let lamports = h.config_account().lamports;
    let intruder = h.funded_keypair();
    let automation = mh.automation.insecure_clone();
    for signer in [&intruder, &automation] {
        let result = mh
            .harness
            .migrate_config_as(signer, Some(pyth_params(signer.pubkey())));
        assert_meridian_error(&result, MeridianError::AdminOnly);
    }
    assert_untouched(&mh.harness, &v1, lamports);
}

#[test]
fn migrate_rejects_an_account_that_is_not_the_config_pda() {
    let (mut mh, v1) = v1_harness();
    let h = &mut mh.harness;
    // A program-owned copy of the v1 bytes at another address: same discriminator and admin.
    let fake = Pubkey::new_unique();
    let lamports = h.svm.minimum_balance_for_rent_exemption(CONFIG_V1_LEN);
    h.put_account(fake, meridian::ID, lamports, v1.clone());
    let admin = h.admin.insecure_clone();
    let ix = Harness::migrate_config_ix(admin.pubkey(), fake, None);
    assert_anchor_error(&h.send(ix, &[&admin]), ErrorCode::ConstraintSeeds);
    assert_eq!(h.svm.get_account(&fake).unwrap().data, v1);
}

#[test]
fn migrate_rejects_a_config_pda_not_owned_by_the_program() {
    let (mut mh, v1) = v1_harness();
    let h = &mut mh.harness;
    let lamports = h.config_account().lamports;
    h.put_account(config_pda(), Pubkey::new_unique(), lamports, v1);
    assert_anchor_error(&h.migrate_config(None), ErrorCode::ConstraintOwner);
}

#[test]
fn migrate_twice_fails_with_already_migrated_and_changes_nothing() {
    let (mut mh, _) = v1_harness();
    let h = &mut mh.harness;
    let params = pyth_params(Pubkey::new_unique());
    expect_success(&h.migrate_config(Some(params)));
    let migrated = h.config_account();

    let other = pyth_params(Pubkey::new_unique());
    assert_meridian_error(
        &h.migrate_config(Some(other)),
        MeridianError::ConfigAlreadyMigrated,
    );
    assert_meridian_error(
        &h.migrate_config(None),
        MeridianError::ConfigAlreadyMigrated,
    );
    assert_untouched(h, &migrated.data, migrated.lamports);
}

#[test]
fn migrate_on_a_fresh_current_config_fails_with_already_migrated() {
    let mut h = Harness::new();
    expect_success(&h.initialize_config(&default_params(Pubkey::new_unique())));
    assert_eq!(h.config_account().data.len(), CONFIG_LEN);
    assert_meridian_error(
        &h.migrate_config(None),
        MeridianError::ConfigAlreadyMigrated,
    );
}

#[test]
fn migrate_non_admin_on_a_migrated_config_is_still_admin_only() {
    let (mut mh, _) = v1_harness();
    expect_success(&mh.harness.migrate_config(None));
    let intruder = mh.harness.funded_keypair();
    assert_meridian_error(
        &mh.harness.migrate_config_as(&intruder, None),
        MeridianError::AdminOnly,
    );
}

#[test]
fn migrate_rejects_a_bad_discriminator_size_or_bump() {
    let (mut mh, v1) = v1_harness();
    let h = &mut mh.harness;
    let lamports = h.config_account().lamports;

    let mut bad_discriminator = v1.clone();
    bad_discriminator[0] ^= 0xff;
    h.put_account(
        config_pda(),
        meridian::ID,
        lamports,
        bad_discriminator.clone(),
    );
    assert_meridian_error(&h.migrate_config(None), MeridianError::ConfigLayoutMismatch);
    assert_untouched(h, &bad_discriminator, lamports);

    for len in [CONFIG_V1_LEN - 1, CONFIG_V1_LEN + 1, CONFIG_LEN + 1] {
        let mut data = v1.clone();
        data.resize(len, 0);
        if len >= CONFIG_V1_LEN {
            data[CONFIG_V1_LEN - 1] = v1[CONFIG_V1_LEN - 1];
        }
        h.put_account(config_pda(), meridian::ID, lamports, data.clone());
        assert_meridian_error(&h.migrate_config(None), MeridianError::ConfigLayoutMismatch);
        assert_untouched(h, &data, lamports);
    }

    let mut bad_bump = v1.clone();
    bad_bump[CONFIG_V1_LEN - 1] = bad_bump[CONFIG_V1_LEN - 1].wrapping_sub(1);
    h.put_account(config_pda(), meridian::ID, lamports, bad_bump.clone());
    assert_meridian_error(&h.migrate_config(None), MeridianError::ConfigLayoutMismatch);
    assert_untouched(h, &bad_bump, lamports);
}

#[test]
fn migrate_rejects_a_non_positive_pyth_max_age_and_changes_nothing() {
    let (mut mh, v1) = v1_harness();
    let h = &mut mh.harness;
    let lamports = h.config_account().lamports;
    for max_age in [0, -1, i64::MIN] {
        let mut params = pyth_params(Pubkey::new_unique());
        params.pyth_max_age_secs = max_age;
        assert_meridian_error(
            &h.migrate_config(Some(params)),
            MeridianError::InvalidPythMaxAge,
        );
    }
    assert_untouched(h, &v1, lamports);
}

#[test]
fn before_migration_config_instructions_fail_cleanly_and_user_exits_still_work() {
    let mut mh = MarketHarness::new();
    let addresses = mh.base_market();
    let user = mh.harness.user_for(&addresses, 3 * PAIR_COLLATERAL);
    expect_success(&mh.harness.mint_pair(&user, &addresses, 3));
    mh.harness.downgrade_config_to_v1();
    let h = &mut mh.harness;

    // Every instruction that loads Config fails with Anchor's decode error, never a panic.
    let pause = h.pause();
    assert_anchor_error(&pause, ErrorCode::AccountDidNotDeserialize);
    assert!(!expect_failure(&pause)
        .meta
        .logs
        .iter()
        .any(|line| line.contains("panicked")));
    assert_anchor_error(
        &h.update_config(&default_params(mh.automation.pubkey())),
        ErrorCode::AccountDidNotDeserialize,
    );
    let (_, created) = mh
        .harness
        .create_strike_market_as(&mh.automation, &MarketArgs::base().with_strike(69_000));
    assert_anchor_error(&created, ErrorCode::AccountDidNotDeserialize);
    assert_anchor_error(
        &mh.harness.mint_pair(&user, &addresses, 1),
        ErrorCode::AccountDidNotDeserialize,
    );

    // Pair redeem never loads Config: users can always exit (domain.md § Market lifecycle).
    expect_success(&mh.harness.redeem(&user, &addresses, 1, 1));

    // After the migration the same instructions work again.
    expect_success(&mh.harness.migrate_config(None));
    expect_success(&mh.harness.mint_pair(&user, &addresses, 1));
    let (_, created) = mh
        .harness
        .create_strike_market_as(&mh.automation, &MarketArgs::base().with_strike(69_000));
    expect_success(&created);
    expect_success(&mh.harness.pause());
    expect_success(&mh.harness.unpause());
    mh.harness.assert_market_invariants(&addresses);
}

#[test]
fn the_recorded_devnet_account_migrates_with_every_old_field_preserved() {
    let mut h = Harness::new();
    h.set_unix_timestamp(BASE_UNIX_TS);
    let (lamports, mut data) = devnet_v1_config();

    // As recorded, only the devnet admin (6cp7Exvk…) may migrate it.
    h.put_account(config_pda(), meridian::ID, lamports, data.clone());
    assert_meridian_error(&h.migrate_config(None), MeridianError::AdminOnly);
    assert_untouched(&h, &data, lamports);

    // With the admin field pointed at the harness admin, everything else is the devnet bytes.
    data[CONFIG_ADMIN_OFFSET..CONFIG_ADMIN_OFFSET + 32]
        .copy_from_slice(&h.admin.pubkey().to_bytes());
    h.put_account(config_pda(), meridian::ID, lamports, data.clone());
    let params = pyth_params(Pubkey::new_unique());
    expect_success(&h.migrate_config(Some(params)));

    let account = h.config_account();
    assert_eq!(account.data.len(), CONFIG_LEN);
    assert_eq!(&account.data[..CONFIG_V1_LEN], &data[..]);
    assert_eq!(&account.data[CONFIG_V1_LEN..], &tail_bytes(&params)[..]);
    let config = Config::try_deserialize(&mut account.data.as_slice()).unwrap();
    assert_eq!(config.pyth_feed_ids, params.pyth_feed_ids);
    // Admin-only instructions now decode the grown account.
    expect_success(&h.pause());
    expect_success(&h.unpause());
}
