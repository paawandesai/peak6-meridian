//! AB-12 (NFR-07; M1-04 AC6): quantities near `u64::MAX` fail cleanly with `MathOverflow`
//! (or a token-program error) before any token moves; nothing wraps around and the vault
//! invariant holds afterwards.

use anchor_lang::AccountSerialize;
use anchor_spl::token::spl_token::error::TokenError;
use meridian::errors::MeridianError;
use meridian::state::PAIR_COLLATERAL;
use security_tests::harness::{
    assert_meridian_error, assert_token_error, expect_failure, expect_success, MarketHarness,
};

const USDC: u64 = PAIR_COLLATERAL;
/// The largest quantity whose collateral still fits in a u64.
const MAX_COLLATERAL_QTY: u64 = u64::MAX / PAIR_COLLATERAL;

#[test]
fn mint_pair_rejects_quantities_whose_collateral_overflows() {
    let mut h = MarketHarness::new();
    let addresses = h.base_market();
    let user = h.harness.user_for(&addresses, 10 * USDC);
    expect_success(&h.harness.mint_pair(&user, &addresses, 3));

    for qty in [u64::MAX, u64::MAX - 1, u64::MAX / 2, MAX_COLLATERAL_QTY + 1] {
        assert_meridian_error(
            &h.harness.mint_pair(&user, &addresses, qty),
            MeridianError::MathOverflow,
        );
        h.harness.assert_market_invariants(&addresses);
    }
    // The collateral fits but nobody has it: the transfer fails, nothing is minted.
    assert_token_error(
        &h.harness.mint_pair(&user, &addresses, MAX_COLLATERAL_QTY),
        TokenError::InsufficientFunds,
    );
    assert_eq!(h.harness.token_amount(user.usdc), 7 * USDC);
    assert_eq!(h.harness.token_amount(user.yes), 3);
    assert_eq!(h.harness.market(addresses.market).pairs_outstanding, 3);
    h.harness.assert_market_invariants(&addresses);
}

#[test]
fn mint_pair_rejects_a_pair_count_that_would_wrap() {
    let mut h = MarketHarness::new();
    let addresses = h.base_market();
    let user = h.harness.user_for(&addresses, 10 * USDC);
    expect_success(&h.harness.mint_pair(&user, &addresses, 1));

    // Forge the stored pair count to the edge; the collateral of 2 more pairs fits, the count
    // does not.
    let mut account = h.harness.svm.get_account(&addresses.market).unwrap();
    let mut market = h.harness.market(addresses.market);
    market.pairs_outstanding = u64::MAX - 1;
    let mut data = Vec::new();
    market.try_serialize(&mut data).unwrap();
    account.data[..data.len()].copy_from_slice(&data);
    h.harness
        .svm
        .set_account(addresses.market, account)
        .unwrap();

    assert_meridian_error(
        &h.harness.mint_pair(&user, &addresses, 2),
        MeridianError::MathOverflow,
    );
    assert_eq!(
        h.harness.market(addresses.market).pairs_outstanding,
        u64::MAX - 1
    );
    assert_eq!(h.harness.token_amount(user.usdc), 9 * USDC);
    assert_eq!(h.harness.token_amount(user.yes), 1);
    assert_eq!(h.harness.token_amount(addresses.vault), USDC);
}

#[test]
fn redeem_rejects_quantities_that_overflow_or_exceed_pairs_outstanding() {
    let mut h = MarketHarness::new();
    let addresses = h.base_market();
    let user = h.harness.user_for(&addresses, 5 * USDC);
    expect_success(&h.harness.mint_pair(&user, &addresses, 5));

    for qty in [u64::MAX, u64::MAX - 1, MAX_COLLATERAL_QTY + 1] {
        assert_meridian_error(
            &h.harness.redeem(&user, &addresses, qty, qty),
            MeridianError::MathOverflow,
        );
        h.harness.assert_market_invariants(&addresses);
    }
    // Collateral fits, but more pairs than exist: rejected before any burn.
    for qty in [MAX_COLLATERAL_QTY, 6] {
        let result = h.harness.redeem(&user, &addresses, qty, qty);
        expect_failure(&result);
        h.harness.assert_market_invariants(&addresses);
    }
    // Mismatched huge quantities fail on the pair rule first.
    assert_meridian_error(
        &h.harness.redeem(&user, &addresses, u64::MAX, u64::MAX - 1),
        MeridianError::PairQuantityMismatch,
    );
    assert_eq!(h.harness.token_amount(user.yes), 5);
    assert_eq!(h.harness.token_amount(user.usdc), 0);
    assert_eq!(h.harness.token_amount(addresses.vault), 5 * USDC);
    assert_eq!(h.harness.market(addresses.market).pairs_outstanding, 5);
}

#[test]
fn the_vault_never_pays_more_than_it_holds() {
    let mut h = MarketHarness::new();
    let addresses = h.base_market();
    let alice = h.harness.user_for(&addresses, 4 * USDC);
    let bob = h.harness.user_for(&addresses, 4 * USDC);
    expect_success(&h.harness.mint_pair(&alice, &addresses, 4));
    expect_success(&h.harness.mint_pair(&bob, &addresses, 4));
    expect_success(&h.harness.redeem(&alice, &addresses, 4, 4));
    expect_success(&h.harness.redeem(&bob, &addresses, 4, 4));
    assert_eq!(h.harness.token_amount(addresses.vault), 0);
    assert_eq!(h.harness.market(addresses.market).pairs_outstanding, 0);
    // Nothing left to redeem for anyone.
    expect_failure(&h.harness.redeem(&alice, &addresses, 1, 1));
    expect_failure(&h.harness.redeem(&bob, &addresses, 1, 1));
    h.harness.assert_market_invariants(&addresses);
}
