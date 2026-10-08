//! AB-02 (NFR-07; M1-07 AC3): redeem abuse. A loser's token pays 0, a token cannot be redeemed
//! twice, winner redeem needs a settled market, and pair redeem needs YES and NO of the same
//! market held by the signer.

use anchor_spl::token::spl_token::error::TokenError;
use meridian::errors::MeridianError;
use meridian::state::{MarketStatus, Outcome, PAIR_COLLATERAL};
use security_tests::harness::settlement::SettlementHarness;
use security_tests::harness::{
    assert_anchor_error, assert_meridian_error, assert_token_error, expect_success, MarketArgs,
    User, BASE_STRIKE_CENTS,
};
use solana_sdk::signature::Signer as _;

const USDC: u64 = PAIR_COLLATERAL;

#[test]
fn loser_token_pays_zero_and_is_burned() {
    let mut s = SettlementHarness::new();
    let user = s.holder(5);
    s.settle_at(BASE_STRIKE_CENTS + 1); // YES wins
    let addresses = s.addresses;
    let usdc_before = s.h().token_amount(user.usdc);
    let vault_before = s.h().token_amount(addresses.vault);

    expect_success(&s.h().redeem(&user, &addresses, 0, 5));
    assert_eq!(s.h().token_amount(user.usdc), usdc_before, "loser pays 0");
    assert_eq!(s.h().token_amount(addresses.vault), vault_before);
    assert_eq!(s.h().token_amount(user.no), 0, "the losing token is burned");
    assert_eq!(
        s.h().token_amount(user.yes),
        5,
        "the winning token is untouched"
    );
    assert_eq!(s.h().market(addresses.market).pairs_outstanding, 5);
}

#[test]
fn a_token_cannot_be_redeemed_twice() {
    let mut s = SettlementHarness::new();
    let user = s.holder(2);
    // A second holder keeps funds in the vault: a double redeem must fail on the burn, not on
    // an empty vault.
    let other = s.holder(3);
    s.settle_at(BASE_STRIKE_CENTS);
    let addresses = s.addresses;

    expect_success(&s.h().redeem(&user, &addresses, 2, 0));
    assert_token_error(
        &s.h().redeem(&user, &addresses, 2, 0),
        TokenError::InsufficientFunds,
    );
    assert_eq!(s.h().token_amount(user.usdc), 2 * USDC);
    assert_eq!(s.h().token_amount(addresses.vault), 3 * USDC);
    assert_eq!(s.h().token_amount(other.yes), 3);
}

#[test]
fn cannot_redeem_more_than_held() {
    let mut s = SettlementHarness::new();
    let user = s.holder(2);
    let _other = s.holder(3);
    s.settle_at(BASE_STRIKE_CENTS + 1);
    let addresses = s.addresses;
    assert_token_error(
        &s.h().redeem(&user, &addresses, 3, 0),
        TokenError::InsufficientFunds,
    );
    assert_eq!(s.h().token_amount(addresses.vault), 5 * USDC);
}

#[test]
fn winner_redeem_before_settlement_is_rejected() {
    let mut s = SettlementHarness::new();
    let user = s.holder(4);
    let addresses = s.addresses;
    // Before settlement only pairs redeem: one-sided and unequal quantities fail.
    for (yes, no) in [(4, 0), (0, 4), (4, 3)] {
        assert_meridian_error(
            &s.h().redeem(&user, &addresses, yes, no),
            MeridianError::PairQuantityMismatch,
        );
    }
    assert_meridian_error(
        &s.h().redeem(&user, &addresses, 0, 0),
        MeridianError::NothingToRedeem,
    );
    assert_eq!(s.h().token_amount(user.usdc), 0);
    assert_eq!(s.h().token_amount(addresses.vault), 4 * USDC);
    let market = s.h().market(addresses.market);
    assert_eq!(market.status, MarketStatus::Open);
    assert_eq!(market.outcome, Outcome::None);
}

#[test]
fn pair_redeem_with_another_markets_tokens_is_rejected() {
    let mut s = SettlementHarness::new();
    let user = s.holder(2);
    let other_args = MarketArgs::base().with_strike(70_000);
    s.h()
        .set_unix_timestamp(security_tests::harness::BASE_UNIX_TS);
    let other = s.market_harness.create_market(&other_args);
    let other_user = s.h().user_for(&other, 2 * USDC);
    s.h()
        .set_unix_timestamp(security_tests::harness::BASE_UNIX_TS);
    expect_success(&s.h().mint_pair(&other_user, &other, 2));
    s.h()
        .set_unix_timestamp(security_tests::harness::BASE_CLOSE_TS + 300);
    let addresses = s.addresses;

    // The other market's token accounts against this market's mints.
    let result = s.h().send(
        security_tests::harness::Harness::redeem_ix(&other_user, &addresses, 2, 2),
        &[&other_user.keypair],
    );
    assert_anchor_error(&result, anchor_lang::error::ErrorCode::ConstraintTokenMint);
    assert_eq!(s.h().token_amount(addresses.vault), 2 * USDC);
    assert_eq!(s.h().token_amount(user.yes), 2);
}

#[test]
fn cannot_redeem_someone_elses_tokens() {
    let mut s = SettlementHarness::new();
    let victim = s.holder(2);
    let _other = s.holder(1);
    let attacker = s.h().funded_keypair();
    let usdc_mint = s.h().usdc_mint;
    let attacker_usdc = s.h().create_token_account(usdc_mint, attacker.pubkey(), 0);
    let addresses = s.addresses;
    s.settle_at(BASE_STRIKE_CENTS + 1);

    // The attacker signs but names the victim's token accounts.
    let forged = User {
        keypair: attacker,
        usdc: attacker_usdc,
        yes: victim.yes,
        no: victim.no,
    };
    let result = s.h().send(
        security_tests::harness::Harness::redeem_ix(&forged, &addresses, 2, 0),
        &[&forged.keypair],
    );
    assert_token_error(&result, TokenError::OwnerMismatch);
    assert_eq!(s.h().token_amount(attacker_usdc), 0);
    assert_eq!(s.h().token_amount(victim.yes), 2);
}
