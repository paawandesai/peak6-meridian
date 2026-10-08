//! AB-09 · Book manipulation, program level (M1-05 AC4; NFR-09; threat-model.md): cancel or
//! `settle_funds` for another owner, price 0/100, zero size. The engine-level cases are in
//! `ab_09_ab_10_book.rs`; here every attack goes through the real instructions and must leave
//! the book, the escrows and every balance untouched.

use anchor_lang::error::ErrorCode;
use meridian::errors::MeridianError;
use meridian::state::{OrderKind, Side, PAIR_COLLATERAL};
use security_tests::harness::orders::{cancel_order_ix, notional, settle_funds_ix};
use security_tests::harness::{
    assert_anchor_error, assert_meridian_error, expect_success, find_event, MarketAddresses,
    MarketHarness, User,
};

const USDC: u64 = PAIR_COLLATERAL;

/// Alice rests a bid and an ask; Mallory is the attacker.
struct Scene {
    h: MarketHarness,
    m: MarketAddresses,
    alice: User,
    mallory: User,
    bid_id: u64,
    ask_id: u64,
}

fn scene() -> Scene {
    let mut h = MarketHarness::new();
    let m = h.base_market();
    let alice = h.harness.user_for(&m, 20 * USDC);
    let mallory = h.harness.user_for(&m, 20 * USDC);
    expect_success(&h.harness.mint_pair(&alice, &m, 5));
    let bid = h
        .harness
        .place_order(&alice, &m, Side::Bid, 40, 5, OrderKind::Limit, &[]);
    let bid_id = find_event::<meridian::events::OrderPlaced>(expect_success(&bid))
        .unwrap()
        .order_id;
    let ask = h
        .harness
        .place_order(&alice, &m, Side::Ask, 80, 5, OrderKind::Limit, &[]);
    let ask_id = find_event::<meridian::events::OrderPlaced>(expect_success(&ask))
        .unwrap()
        .order_id;
    // Mallory has an OpenOrders of her own (the strongest position to attack from).
    expect_success(
        &h.harness
            .place_order(&mallory, &m, Side::Bid, 10, 1, OrderKind::Limit, &[]),
    );
    Scene {
        h,
        m,
        alice,
        mallory,
        bid_id,
        ask_id,
    }
}

/// Book bytes, both escrows, both OpenOrders balances and the attacker's wallet.
type Snapshot = (Vec<u8>, u64, u64, (u64, u64, u8), (u64, u64, u8), u64, u64);

fn snapshot(s: &Scene) -> Snapshot {
    let hr = &s.h.harness;
    (
        hr.book_data(s.m.book),
        hr.token_amount(s.m.escrow_usdc),
        hr.token_amount(s.m.escrow_yes),
        hr.balances(&s.m, &s.alice),
        hr.balances(&s.m, &s.mallory),
        hr.token_amount(s.mallory.usdc),
        hr.token_amount(s.mallory.yes),
    )
}

#[test]
fn cancelling_another_owners_order_fails_whichever_open_orders_is_passed() {
    let mut s = scene();
    let before = snapshot(&s);
    let (m, alice, mallory) = (s.m, s.alice.pubkey(), s.mallory.pubkey());
    for id in [s.bid_id, s.ask_id] {
        // Mallory signs with her own OpenOrders: the engine refuses (NotOwner).
        let ix = cancel_order_ix(&mallory, &mallory, &m, id);
        assert_meridian_error(
            &s.h.harness.send(ix, &[&s.mallory.keypair]),
            MeridianError::NotOrderOwner,
        );
        // Mallory names Alice's OpenOrders: the stored owner is not the signer.
        let ix = cancel_order_ix(&mallory, &alice, &m, id);
        assert_meridian_error(
            &s.h.harness.send(ix, &[&s.mallory.keypair]),
            MeridianError::NotOrderOwner,
        );
    }
    assert_eq!(snapshot(&s), before, "failed attacks change nothing");
    s.h.harness
        .assert_escrow_conservation(&m, &[&s.alice, &s.mallory]);

    // The real owner still can.
    expect_success(&s.h.harness.cancel_order(&s.alice, &m, s.bid_id));
    expect_success(&s.h.harness.cancel_order(&s.alice, &m, s.ask_id));
    assert_eq!(s.h.harness.balances(&m, &s.alice), (notional(40, 5), 5, 0));
}

#[test]
fn settle_funds_for_another_owner_fails_and_cannot_redirect_funds() {
    let mut s = scene();
    let m = s.m;
    expect_success(&s.h.harness.cancel_order(&s.alice, &m, s.bid_id));
    let before = snapshot(&s);
    let (alice, mallory) = (s.alice.pubkey(), s.mallory.pubkey());

    // Mallory signs for Alice's OpenOrders, paying out to her own accounts.
    let ix = settle_funds_ix(&mallory, &alice, &s.mallory, &m);
    assert_meridian_error(
        &s.h.harness.send(ix, &[&s.mallory.keypair]),
        MeridianError::NotOrderOwner,
    );
    // Mallory's own OpenOrders but Alice's token accounts, and vice versa.
    let ix = settle_funds_ix(&mallory, &mallory, &s.alice, &m);
    assert_anchor_error(
        &s.h.harness.send(ix, &[&s.mallory.keypair]),
        ErrorCode::ConstraintTokenOwner,
    );
    let ix = settle_funds_ix(&alice, &alice, &s.mallory, &m);
    assert_anchor_error(
        &s.h.harness.send(ix, &[&s.alice.keypair]),
        ErrorCode::ConstraintTokenOwner,
    );
    assert_eq!(snapshot(&s), before);

    expect_success(&s.h.harness.settle_funds(&s.alice, &m));
    assert_eq!(s.h.harness.token_amount(s.alice.usdc), 15 * USDC);
    s.h.harness
        .assert_escrow_conservation(&m, &[&s.alice, &s.mallory]);
}

#[test]
fn price_outside_1_to_99_and_zero_quantity_are_rejected_on_every_side_and_kind() {
    let mut s = scene();
    let before = snapshot(&s);
    let m = s.m;
    for side in [Side::Bid, Side::Ask] {
        for kind in [OrderKind::Limit, OrderKind::Ioc] {
            for price in [0u8, 100, 101, u8::MAX] {
                assert_meridian_error(
                    &s.h.harness
                        .place_order(&s.mallory, &m, side, price, 1, kind, &[&s.alice]),
                    MeridianError::InvalidPrice,
                );
            }
            assert_meridian_error(
                &s.h.harness
                    .place_order(&s.mallory, &m, side, 50, 0, kind, &[&s.alice]),
                MeridianError::InvalidQuantity,
            );
        }
    }
    assert_eq!(snapshot(&s), before);
}

#[test]
fn forged_open_orders_cannot_receive_a_makers_credit() {
    // Mallory passes an account she controls instead of Alice's OpenOrders: the fill is refused
    // rather than credited to the wrong place.
    let mut s = scene();
    let before = snapshot(&s);
    let m = s.m;
    assert_anchor_error(
        &s.h.harness.place_order(
            &s.mallory,
            &m,
            Side::Bid,
            80,
            5,
            OrderKind::Ioc,
            &[&s.mallory],
        ),
        ErrorCode::AccountNotEnoughKeys,
    );
    assert_eq!(snapshot(&s), before);
}
