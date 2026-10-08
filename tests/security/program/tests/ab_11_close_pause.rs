//! AB-11 (NFR-09, FR-11, FR-12; M1-04 AC5, M1-05 AC4): no minting and no new orders at or after
//! `close_ts` or while paused; pair redeem, `cancel_order` and `settle_funds` keep working in
//! both states.

use meridian::errors::MeridianError;
use meridian::state::{OrderKind, Side, PAIR_COLLATERAL};
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

/// Alice rests a bid (id returned) and an ask; Bob holds USDC and YES to attack with.
fn market_with_resting_orders(
    h: &mut MarketHarness,
) -> (
    security_tests::harness::MarketAddresses,
    security_tests::harness::User,
    security_tests::harness::User,
    u64,
) {
    let m = h.base_market();
    let alice = h.harness.user_for(&m, 20 * USDC);
    let bob = h.harness.user_for(&m, 20 * USDC);
    expect_success(&h.harness.mint_pair(&alice, &m, 4));
    let meta = h
        .harness
        .place_order(&alice, &m, Side::Bid, 40, 4, OrderKind::Limit, &[]);
    let bid_id =
        security_tests::harness::find_event::<meridian::events::OrderPlaced>(expect_success(&meta))
            .expect("OrderPlaced")
            .order_id;
    expect_success(
        &h.harness
            .place_order(&alice, &m, Side::Ask, 80, 4, OrderKind::Limit, &[]),
    );
    (m, alice, bob, bid_id)
}

#[test]
fn new_orders_fail_while_paused_but_cancel_and_settle_funds_work() {
    let mut h = MarketHarness::new();
    let (m, alice, bob, bid_id) = market_with_resting_orders(&mut h);
    expect_success(&h.harness.pause());

    for (side, price, kind) in [
        (Side::Bid, 80, OrderKind::Ioc),
        (Side::Bid, 10, OrderKind::Limit),
        (Side::Ask, 40, OrderKind::Ioc),
        (Side::Ask, 90, OrderKind::Limit),
    ] {
        assert_meridian_error(
            &h.harness
                .place_order(&bob, &m, side, price, 1, kind, &[&alice]),
            MeridianError::Paused,
        );
    }
    expect_success(&h.harness.cancel_order(&alice, &m, bid_id));
    expect_success(&h.harness.settle_funds(&alice, &m));
    assert_eq!(h.harness.token_amount(alice.usdc), 16 * USDC);
    h.harness.assert_escrow_conservation(&m, &[&alice, &bob]);

    expect_success(&h.harness.unpause());
    expect_success(
        &h.harness
            .place_order(&bob, &m, Side::Bid, 80, 1, OrderKind::Ioc, &[&alice]),
    );
    h.harness.assert_escrow_conservation(&m, &[&alice, &bob]);
}

#[test]
fn new_orders_fail_at_and_after_close_but_cancel_and_settle_funds_work() {
    let mut h = MarketHarness::new();
    let (m, alice, bob, bid_id) = market_with_resting_orders(&mut h);

    // One second before close: still tradable.
    h.harness.set_unix_timestamp(BASE_CLOSE_TS - 1);
    expect_success(
        &h.harness
            .place_order(&bob, &m, Side::Bid, 80, 1, OrderKind::Ioc, &[&alice]),
    );

    for now in [
        BASE_CLOSE_TS,
        BASE_CLOSE_TS + 1,
        BASE_CLOSE_TS + 30 * 86_400,
    ] {
        h.harness.set_unix_timestamp(now);
        for (side, price, kind) in [
            (Side::Bid, 80, OrderKind::Ioc),
            (Side::Bid, 10, OrderKind::Limit),
            (Side::Ask, 40, OrderKind::Ioc),
        ] {
            assert_meridian_error(
                &h.harness
                    .place_order(&bob, &m, side, price, 1, kind, &[&alice]),
                MeridianError::MarketClosed,
            );
        }
        h.harness.assert_escrow_conservation(&m, &[&alice, &bob]);
    }
    expect_success(&h.harness.cancel_order(&alice, &m, bid_id));
    expect_success(&h.harness.settle_funds(&alice, &m));
    expect_success(&h.harness.settle_funds(&bob, &m));
    assert_eq!(h.harness.token_amount(bob.yes), 1);
    h.harness.assert_escrow_conservation(&m, &[&alice, &bob]);
}

#[test]
fn paused_and_closed_at_once_still_allows_cancel_and_settle_funds() {
    let mut h = MarketHarness::new();
    let (m, alice, bob, bid_id) = market_with_resting_orders(&mut h);
    h.harness.set_unix_timestamp(BASE_CLOSE_TS + 300);
    expect_success(&h.harness.pause());
    assert_meridian_error(
        &h.harness
            .place_order(&bob, &m, Side::Bid, 80, 1, OrderKind::Ioc, &[&alice]),
        MeridianError::Paused,
    );
    expect_success(&h.harness.cancel_order(&alice, &m, bid_id));
    expect_success(&h.harness.settle_funds(&alice, &m));
    h.harness.assert_escrow_conservation(&m, &[&alice, &bob]);
}
