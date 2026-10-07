//! AB-11 (NFR-09, FR-11, FR-12; M1-04 AC5): no minting at or after `close_ts` or while paused;
//! pair redeem keeps working in both states. New orders are covered when M1-05 lands.

use meridian::errors::MeridianError;
use meridian::state::PAIR_COLLATERAL;
use security_tests::harness::{
    assert_meridian_error, expect_success, MarketArgs, MarketHarness, BASE_CLOSE_TS,
};

const USDC: u64 = PAIR_COLLATERAL;

#[test]
fn mint_pair_fails_while_paused_and_pair_redeem_still_works() {
    let mut h = MarketHarness::new();
    let addresses = h.base_market();
    let user = h.harness.user_for(&addresses, 10 * USDC);
    expect_success(&h.harness.mint_pair(&user, &addresses, 6));

    expect_success(&h.harness.pause());
    assert_meridian_error(
        &h.harness.mint_pair(&user, &addresses, 1),
        MeridianError::Paused,
    );
    expect_success(&h.harness.redeem(&user, &addresses, 2, 2));
    assert_eq!(h.harness.token_amount(user.usdc), 6 * USDC);
    assert_eq!(h.harness.token_amount(user.yes), 4);
    assert_eq!(h.harness.market(addresses.market).pairs_outstanding, 4);
    h.harness.assert_market_invariants(&addresses);

    // The pause is global: a market created while paused cannot mint either.
    let other = h.create_market(&MarketArgs::base().with_strike(70_000));
    let other_user = h.harness.user_for(&other, USDC);
    assert_meridian_error(
        &h.harness.mint_pair(&other_user, &other, 1),
        MeridianError::Paused,
    );

    expect_success(&h.harness.unpause());
    expect_success(&h.harness.mint_pair(&user, &addresses, 1));
    expect_success(&h.harness.mint_pair(&other_user, &other, 1));
    h.harness.assert_market_invariants(&addresses);
    h.harness.assert_market_invariants(&other);
}

#[test]
fn mint_pair_fails_at_and_after_close_and_pair_redeem_still_works() {
    let mut h = MarketHarness::new();
    let addresses = h.base_market();
    let user = h.harness.user_for(&addresses, 10 * USDC);
    expect_success(&h.harness.mint_pair(&user, &addresses, 6));

    // One second before close: still mintable.
    h.harness.set_unix_timestamp(BASE_CLOSE_TS - 1);
    expect_success(&h.harness.mint_pair(&user, &addresses, 1));

    // Exactly at close and long after: no minting, redeem works.
    for now in [
        BASE_CLOSE_TS,
        BASE_CLOSE_TS + 1,
        BASE_CLOSE_TS + 30 * 86_400,
    ] {
        h.harness.set_unix_timestamp(now);
        assert_meridian_error(
            &h.harness.mint_pair(&user, &addresses, 1),
            MeridianError::MarketClosed,
        );
        expect_success(&h.harness.redeem(&user, &addresses, 1, 1));
        h.harness.assert_market_invariants(&addresses);
    }
    assert_eq!(h.harness.token_amount(user.yes), 4);
    assert_eq!(h.harness.token_amount(user.usdc), 6 * USDC);
    assert_eq!(h.harness.market(addresses.market).pairs_outstanding, 4);
}

#[test]
fn closed_and_paused_at_once_still_allows_pair_redeem() {
    let mut h = MarketHarness::new();
    let addresses = h.base_market();
    let user = h.harness.user_for(&addresses, 3 * USDC);
    expect_success(&h.harness.mint_pair(&user, &addresses, 3));

    h.harness.set_unix_timestamp(BASE_CLOSE_TS + 300);
    expect_success(&h.harness.pause());
    // Pause is checked first; either way no mint.
    assert_meridian_error(
        &h.harness.mint_pair(&user, &addresses, 1),
        MeridianError::Paused,
    );
    expect_success(&h.harness.redeem(&user, &addresses, 3, 3));
    assert_eq!(h.harness.token_amount(user.usdc), 3 * USDC);
    assert_eq!(h.harness.market(addresses.market).pairs_outstanding, 0);
    h.harness.assert_market_invariants(&addresses);
}

#[test]
fn close_is_per_market_so_a_later_market_still_mints() {
    let mut h = MarketHarness::new();
    let today = h.base_market();
    let tomorrow = h.create_market(&MarketArgs {
        trading_date: 20_261_007,
        close_ts: BASE_CLOSE_TS + 86_400,
        ..MarketArgs::base()
    });
    let user_today = h.harness.user_for(&today, USDC);
    let user_tomorrow = h.harness.user_for(&tomorrow, USDC);
    h.harness.set_unix_timestamp(BASE_CLOSE_TS);
    assert_meridian_error(
        &h.harness.mint_pair(&user_today, &today, 1),
        MeridianError::MarketClosed,
    );
    expect_success(&h.harness.mint_pair(&user_tomorrow, &tomorrow, 1));
    h.harness.assert_market_invariants(&today);
    h.harness.assert_market_invariants(&tomorrow);
}
