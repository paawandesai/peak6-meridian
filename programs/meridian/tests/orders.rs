//! M1-05: `place_order`, `cancel_order` and `settle_funds` against the built program in LiteSVM:
//! two-user trading flows (AC1), escrow conservation over random sequences (AC2), the compute
//! budget of a taker matching 8 resting orders (AC3), failure paths and events (D-031).
//! Abuse cases AB-09 and AB-11 live in `tests/security/program`.

// Test code: the program rules on unwrap/panic/arithmetic do not apply here.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::arithmetic_side_effects,
    clippy::too_many_arguments,
    clippy::result_large_err
)]

mod common;

use anchor_lang::error::ErrorCode;
use anchor_spl::token::spl_token::error::TokenError;
use common::orders::{notional, place_order_ix};
use common::{
    assert_anchor_error, assert_meridian_error, assert_token_error, expect_success, find_event,
    MarketAddresses, MarketHarness, User,
};
use meridian::errors::MeridianError;
use meridian::events::{Fill, FundsSettled, OrderCancelled, OrderPlaced};
use meridian::state::{OrderKind, Side, PAIR_COLLATERAL};
use proptest::prelude::*;

const USDC: u64 = PAIR_COLLATERAL;
/// Compute budget every instruction must fit in (NFR-02).
const CU_LIMIT: u32 = 400_000;

/// A market plus a way to create funded users.
struct World {
    h: MarketHarness,
    m: MarketAddresses,
}

impl World {
    fn new() -> Self {
        let mut h = MarketHarness::new();
        let m = h.base_market();
        World { h, m }
    }

    /// A user holding `usdc` USDC and `yes` YES (minted as pairs; the NO side stays with them).
    fn user(&mut self, usdc: u64, yes: u64) -> User {
        let user = self.h.harness.user_for(&self.m, usdc * USDC + yes * USDC);
        if yes > 0 {
            expect_success(&self.h.harness.mint_pair(&user, &self.m, yes));
        }
        user
    }

    fn place(
        &mut self,
        user: &User,
        side: Side,
        price: u8,
        qty: u64,
        kind: OrderKind,
        makers: &[&User],
    ) -> litesvm::types::TransactionResult {
        let m = self.m;
        self.h
            .harness
            .place_order(user, &m, side, price, qty, kind, makers)
    }

    fn usdc(&self, user: &User) -> u64 {
        self.h.harness.token_amount(user.usdc)
    }

    fn yes(&self, user: &User) -> u64 {
        self.h.harness.token_amount(user.yes)
    }

    fn balances(&self, user: &User) -> (u64, u64, u8) {
        self.h.harness.balances(&self.m, user)
    }

    fn conserved(&self, users: &[&User]) {
        self.h.harness.assert_escrow_conservation(&self.m, users);
    }

    fn orders(&self) -> (usize, usize) {
        let book = self.h.harness.book(self.m.book);
        (
            book.bids.iter().filter(|o| o.qty > 0).count(),
            book.asks.iter().filter(|o| o.qty > 0).count(),
        )
    }
}

// ---- AC1: two-user flows ----------------------------------------------------------------------

#[test]
fn limit_ask_rests_then_taker_bid_fills_and_maker_settles() {
    let mut w = World::new();
    let alice = w.user(0, 10);
    let bob = w.user(10, 0);

    let result = w.place(&alice, Side::Ask, 60, 10, OrderKind::Limit, &[]);
    let meta = expect_success(&result);
    let placed: OrderPlaced = find_event(meta).expect("OrderPlaced");
    assert_eq!(
        (placed.side, placed.price, placed.qty, placed.rested_qty),
        (Side::Ask, 60, 10, 10)
    );
    assert_eq!(placed.owner, alice.pubkey());
    assert_eq!(w.yes(&alice), 0);
    assert_eq!(w.h.harness.token_amount(w.m.escrow_yes), 10);
    assert_eq!(w.balances(&alice), (0, 0, 1));
    w.conserved(&[&alice, &bob]);

    // Bob takes 4 at Alice's price and receives the YES immediately.
    let result = w.place(&bob, Side::Bid, 60, 4, OrderKind::Ioc, &[&alice]);
    let meta = expect_success(&result);
    let fill: Fill = find_event(meta).expect("Fill");
    assert_eq!(
        (
            fill.maker,
            fill.taker,
            fill.price,
            fill.qty,
            fill.taker_side
        ),
        (alice.pubkey(), bob.pubkey(), 60, 4, Side::Bid)
    );
    assert_eq!(w.yes(&bob), 4);
    assert_eq!(w.usdc(&bob), 10 * USDC - notional(60, 4));
    // Alice is credited in her OpenOrders; her wallet is untouched until settle_funds.
    assert_eq!(w.balances(&alice), (notional(60, 4), 0, 1));
    assert_eq!(w.usdc(&alice), 0);
    assert_eq!(w.orders(), (0, 1));
    w.conserved(&[&alice, &bob]);

    let result = w.h.harness.settle_funds(&alice, &w.m);
    let settled: FundsSettled = find_event(expect_success(&result)).expect("FundsSettled");
    assert_eq!((settled.usdc, settled.yes), (notional(60, 4), 0));
    assert_eq!(w.usdc(&alice), notional(60, 4));
    assert_eq!(w.balances(&alice), (0, 0, 1));
    w.conserved(&[&alice, &bob]);

    // Finish the order: Alice's slot is released when the maker is fully filled.
    expect_success(&w.place(&bob, Side::Bid, 60, 6, OrderKind::Ioc, &[&alice]));
    assert_eq!(w.balances(&alice), (notional(60, 6), 0, 0));
    assert_eq!(w.orders(), (0, 0));
    w.conserved(&[&alice, &bob]);
}

#[test]
fn partial_fills_walk_the_book_at_maker_prices_and_rest_the_remainder() {
    let mut w = World::new();
    let alice = w.user(0, 3);
    let carol = w.user(0, 3);
    let bob = w.user(10, 0);
    expect_success(&w.place(&alice, Side::Ask, 50, 3, OrderKind::Limit, &[]));
    expect_success(&w.place(&carol, Side::Ask, 60, 3, OrderKind::Limit, &[]));

    // Bob bids 70 for 5: 3 @ 50, 2 @ 60 (price improvement), nothing rests.
    let result = w.place(&bob, Side::Bid, 70, 5, OrderKind::Limit, &[&alice, &carol]);
    expect_success(&result);
    assert_eq!(w.yes(&bob), 5);
    assert_eq!(w.usdc(&bob), 10 * USDC - notional(50, 3) - notional(60, 2));
    assert_eq!(w.balances(&alice), (notional(50, 3), 0, 0));
    assert_eq!(w.balances(&carol), (notional(60, 2), 0, 1));
    assert_eq!(w.orders(), (0, 1));
    w.conserved(&[&alice, &bob, &carol]);

    // Bob bids 70 for 4 more: 1 @ 60 fills, 3 rest at 70 (escrowed in full).
    let before = w.usdc(&bob);
    let result = w.place(&bob, Side::Bid, 70, 4, OrderKind::Limit, &[&carol]);
    let meta = expect_success(&result);
    let placed: OrderPlaced = find_event(meta).expect("OrderPlaced");
    assert_eq!(placed.rested_qty, 3);
    assert_eq!(before - w.usdc(&bob), notional(60, 1) + notional(70, 3));
    assert_eq!(w.balances(&bob), (0, 0, 1));
    assert_eq!(w.balances(&carol), (notional(60, 3), 0, 0));
    assert_eq!(w.orders(), (1, 0));
    w.conserved(&[&alice, &bob, &carol]);
}

#[test]
fn ioc_remainder_is_cancelled_and_never_escrowed() {
    let mut w = World::new();
    let alice = w.user(0, 2);
    let bob = w.user(10, 0);
    expect_success(&w.place(&alice, Side::Ask, 60, 2, OrderKind::Limit, &[]));

    let result = w.place(&bob, Side::Bid, 60, 5, OrderKind::Ioc, &[&alice]);
    let meta = expect_success(&result);
    let cancelled: OrderCancelled = find_event(meta).expect("OrderCancelled");
    assert_eq!((cancelled.owner, cancelled.qty), (bob.pubkey(), 3));
    assert_eq!(w.yes(&bob), 2);
    assert_eq!(w.usdc(&bob), 10 * USDC - notional(60, 2));
    assert_eq!(w.balances(&bob), (0, 0, 0));
    assert_eq!(w.orders(), (0, 0));
    w.conserved(&[&alice, &bob]);

    // An IOC that crosses nothing is a harmless no-op that moves no tokens.
    let before = w.usdc(&bob);
    expect_success(&w.place(&bob, Side::Bid, 10, 5, OrderKind::Ioc, &[]));
    assert_eq!(w.usdc(&bob), before);
    assert_eq!(w.orders(), (0, 0));
    w.conserved(&[&alice, &bob]);
}

#[test]
fn taker_ask_is_paid_immediately_and_bid_maker_receives_yes() {
    let mut w = World::new();
    let alice = w.user(0, 6);
    let bob = w.user(10, 0);
    expect_success(&w.place(&bob, Side::Bid, 55, 4, OrderKind::Limit, &[]));
    assert_eq!(w.usdc(&bob), 10 * USDC - notional(55, 4));
    w.conserved(&[&alice, &bob]);

    // Alice sells 6 down to 50: 4 fill at Bob's 55, 2 are cancelled (IOC).
    expect_success(&w.place(&alice, Side::Ask, 50, 6, OrderKind::Ioc, &[&bob]));
    assert_eq!(w.usdc(&alice), notional(55, 4));
    assert_eq!(
        w.yes(&alice),
        2,
        "the cancelled remainder never left her wallet"
    );
    assert_eq!(w.balances(&bob), (0, 4, 0));
    w.conserved(&[&alice, &bob]);

    expect_success(&w.h.harness.settle_funds(&bob, &w.m));
    assert_eq!(w.yes(&bob), 4);
    assert_eq!(w.balances(&bob), (0, 0, 0));
    w.conserved(&[&alice, &bob]);
}

#[test]
fn cancel_refunds_to_open_orders_and_settle_funds_withdraws() {
    let mut w = World::new();
    let bob = w.user(10, 5);
    let start_usdc = w.usdc(&bob);

    let meta = expect_success(&w.place(&bob, Side::Bid, 40, 5, OrderKind::Limit, &[])).clone();
    let bid_id = find_event::<OrderPlaced>(&meta).unwrap().order_id;
    let meta = expect_success(&w.place(&bob, Side::Ask, 80, 3, OrderKind::Limit, &[])).clone();
    let ask_id = find_event::<OrderPlaced>(&meta).unwrap().order_id;
    assert_eq!(w.balances(&bob), (0, 0, 2));
    assert_eq!(w.usdc(&bob), start_usdc - notional(40, 5));
    w.conserved(&[&bob]);

    let result = w.h.harness.cancel_order(&bob, &w.m, bid_id);
    let cancelled: OrderCancelled = find_event(expect_success(&result)).expect("OrderCancelled");
    assert_eq!((cancelled.order_id, cancelled.qty), (bid_id, 5));
    // The refund sits in OpenOrders; the escrow has not moved.
    assert_eq!(w.balances(&bob), (notional(40, 5), 0, 1));
    assert_eq!(w.usdc(&bob), start_usdc - notional(40, 5));
    w.conserved(&[&bob]);

    expect_success(&w.h.harness.cancel_order(&bob, &w.m, ask_id));
    assert_eq!(w.balances(&bob), (notional(40, 5), 3, 0));
    assert_eq!(w.orders(), (0, 0));
    w.conserved(&[&bob]);

    expect_success(&w.h.harness.settle_funds(&bob, &w.m));
    assert_eq!(w.usdc(&bob), start_usdc);
    assert_eq!(w.yes(&bob), 5);
    assert_eq!(w.balances(&bob), (0, 0, 0));
    assert_eq!(w.h.harness.token_amount(w.m.escrow_usdc), 0);
    assert_eq!(w.h.harness.token_amount(w.m.escrow_yes), 0);
    w.conserved(&[&bob]);

    // Cancelling again, or settling with nothing owed, fails cleanly / is a no-op.
    assert_meridian_error(
        &w.h.harness.cancel_order(&bob, &w.m, bid_id),
        MeridianError::OrderNotFound,
    );
    expect_success(&w.h.harness.settle_funds(&bob, &w.m));
}

#[test]
fn self_trade_cancels_the_resting_order_and_refunds_it() {
    let mut w = World::new();
    let alice = w.user(10, 5);
    expect_success(&w.place(&alice, Side::Bid, 40, 3, OrderKind::Limit, &[]));
    // Her ask at 40 would trade against her own bid: the bid is cancelled instead.
    let result = w.place(&alice, Side::Ask, 40, 2, OrderKind::Limit, &[]);
    let meta = expect_success(&result);
    assert!(find_event::<Fill>(meta).is_none(), "no self-fill");
    assert_eq!(w.balances(&alice), (notional(40, 3), 0, 1));
    assert_eq!(w.orders(), (0, 1));
    w.conserved(&[&alice]);
}

#[test]
fn displaced_order_is_refunded_to_its_owner_through_remaining_accounts() {
    let mut w = World::new();
    // 4 owners × 8 bids fill the 32 slots; prices 10..=41, so the worst is 10 (owner 0).
    let owners: Vec<User> = (0..4).map(|_| w.user(5, 0)).collect();
    for (k, owner) in owners.iter().enumerate() {
        for j in 0..8u8 {
            let price = 10 + (k as u8) * 8 + j;
            expect_success(&w.place(owner, Side::Bid, price, 1, OrderKind::Limit, &[]));
        }
    }
    assert_eq!(w.orders(), (32, 0));
    let refs: Vec<&User> = owners.iter().collect();
    w.conserved(&refs);

    let newcomer = w.user(5, 0);
    let before = w.h.harness.book_data(w.m.book);
    // Without the displaced owner's OpenOrders the credit has nowhere to go: all-or-nothing.
    assert_anchor_error(
        &w.place(&newcomer, Side::Bid, 50, 1, OrderKind::Limit, &[]),
        ErrorCode::AccountNotEnoughKeys,
    );
    assert_eq!(w.h.harness.book_data(w.m.book), before);

    let result = w.place(&newcomer, Side::Bid, 50, 1, OrderKind::Limit, &[&owners[0]]);
    let cancelled: OrderCancelled = find_event(expect_success(&result)).expect("OrderCancelled");
    assert_eq!(cancelled.owner, owners[0].pubkey());
    assert_eq!(w.balances(&owners[0]), (notional(10, 1), 0, 7));
    assert_eq!(w.orders(), (32, 0));
    let mut all = refs.clone();
    all.push(&newcomer);
    w.conserved(&all);
}

// ---- failure paths ----------------------------------------------------------------------------

#[test]
fn a_maker_credit_needs_the_makers_own_open_orders_account() {
    let mut w = World::new();
    let alice = w.user(0, 4);
    let bob = w.user(10, 0);
    let mallory = w.user(10, 0);
    expect_success(&w.place(&alice, Side::Ask, 60, 4, OrderKind::Limit, &[]));
    expect_success(&w.place(&mallory, Side::Bid, 10, 1, OrderKind::Limit, &[]));
    let before = w.h.harness.book_data(w.m.book);

    // No accounts, or someone else's accounts: the fill cannot be credited, nothing happens.
    for makers in [vec![], vec![&bob], vec![&mallory]] {
        assert_anchor_error(
            &w.place(&bob, Side::Bid, 60, 4, OrderKind::Ioc, &makers),
            ErrorCode::AccountNotEnoughKeys,
        );
    }
    assert_eq!(w.h.harness.book_data(w.m.book), before);
    assert_eq!(w.yes(&bob), 0);
    assert_eq!(w.usdc(&bob), 10 * USDC);
    w.conserved(&[&alice, &bob, &mallory]);
}

#[test]
fn orders_without_funds_fail_atomically() {
    let mut w = World::new();
    let alice = w.user(0, 0);
    let before = w.h.harness.book_data(w.m.book);
    assert_token_error(
        &w.place(&alice, Side::Bid, 50, 1, OrderKind::Limit, &[]),
        TokenError::InsufficientFunds,
    );
    assert_token_error(
        &w.place(&alice, Side::Ask, 50, 1, OrderKind::Limit, &[]),
        TokenError::InsufficientFunds,
    );
    assert_eq!(w.h.harness.book_data(w.m.book), before);
    w.conserved(&[&alice]);
}

#[test]
fn token_accounts_must_belong_to_the_signer_and_the_market() {
    let mut w = World::new();
    let alice = w.user(10, 5);
    let bob = w.user(10, 5);
    let m = w.m;
    // Bob's order paying from Alice's USDC account.
    let mut ix = place_order_ix(&bob, &m, Side::Bid, 50, 1, OrderKind::Limit, &[]);
    ix.accounts[5].pubkey = alice.usdc;
    let result = w.h.harness.send(ix, &[&bob.keypair]);
    assert_anchor_error(&result, ErrorCode::ConstraintTokenOwner);
    // Escrow accounts swapped for the user's own.
    let mut ix = place_order_ix(&bob, &m, Side::Ask, 50, 1, OrderKind::Limit, &[]);
    ix.accounts[7].pubkey = bob.yes;
    let result = w.h.harness.send(ix, &[&bob.keypair]);
    assert_anchor_error(&result, ErrorCode::ConstraintHasOne);
    assert_eq!(w.orders(), (0, 0));
    w.conserved(&[&alice, &bob]);
}

#[test]
fn invalid_price_quantity_and_owner_cap_are_rejected_before_any_transfer() {
    let mut w = World::new();
    let alice = w.user(10, 0);
    for price in [0u8, 100, 255] {
        assert_meridian_error(
            &w.place(&alice, Side::Bid, price, 1, OrderKind::Limit, &[]),
            MeridianError::InvalidPrice,
        );
    }
    assert_meridian_error(
        &w.place(&alice, Side::Bid, 50, 0, OrderKind::Ioc, &[]),
        MeridianError::InvalidQuantity,
    );
    for _ in 0..8 {
        expect_success(&w.place(&alice, Side::Bid, 10, 1, OrderKind::Limit, &[]));
    }
    assert_meridian_error(
        &w.place(&alice, Side::Bid, 10, 1, OrderKind::Limit, &[]),
        MeridianError::TooManyRestingOrders,
    );
    assert_eq!(w.balances(&alice), (0, 0, 8));
    w.conserved(&[&alice]);
}

#[test]
fn overflowing_notional_fails_with_math_overflow() {
    let mut w = World::new();
    let alice = w.user(10, 0);
    assert_meridian_error(
        &w.place(&alice, Side::Bid, 99, u64::MAX, OrderKind::Limit, &[]),
        MeridianError::MathOverflow,
    );
    w.conserved(&[&alice]);
}

// ---- AC3: compute budget ----------------------------------------------------------------------

#[test]
fn taker_matching_eight_resting_orders_stays_under_400k_compute_units() {
    let mut w = World::new();
    let makers: Vec<User> = (0..8).map(|_| w.user(0, 1)).collect();
    for maker in &makers {
        expect_success(&w.place(maker, Side::Ask, 50, 1, OrderKind::Limit, &[]));
    }
    let taker = w.user(10, 0);
    let owners: Vec<_> = makers.iter().map(|m| m.pubkey()).collect();
    let m = w.m;
    let ix = place_order_ix(&taker, &m, Side::Bid, 50, 8, OrderKind::Ioc, &owners);
    let result =
        w.h.harness
            .send_with_budget(ix, &[&taker.keypair], CU_LIMIT);
    let meta = expect_success(&result);
    println!(
        "place_order with 8 fills: {} CU",
        meta.compute_units_consumed
    );
    assert!(
        meta.compute_units_consumed < u64::from(CU_LIMIT),
        "8-fill taker used {} CU",
        meta.compute_units_consumed
    );
    assert_eq!(w.yes(&taker), 8);
    assert_eq!(w.orders(), (0, 0));
    let mut all: Vec<&User> = makers.iter().collect();
    all.push(&taker);
    w.conserved(&all);
}

#[test]
fn cancel_and_settle_fit_the_compute_budget() {
    let mut w = World::new();
    let bob = w.user(10, 0);
    let meta = expect_success(&w.place(&bob, Side::Bid, 40, 5, OrderKind::Limit, &[])).clone();
    let id = find_event::<OrderPlaced>(&meta).unwrap().order_id;
    let m = w.m;
    let ix = common::orders::cancel_order_ix(&bob.pubkey(), &bob.pubkey(), &m, id);
    let result = w.h.harness.send_with_budget(ix, &[&bob.keypair], CU_LIMIT);
    assert!(expect_success(&result).compute_units_consumed < u64::from(CU_LIMIT));
    let ix = common::orders::settle_funds_ix(&bob.pubkey(), &bob.pubkey(), &bob, &m);
    let result = w.h.harness.send_with_budget(ix, &[&bob.keypair], CU_LIMIT);
    assert!(expect_success(&result).compute_units_consumed < u64::from(CU_LIMIT));
}

// ---- AC2: escrow conservation over random sequences -------------------------------------------

#[derive(Clone, Debug)]
enum Op {
    Place {
        user: usize,
        side: Side,
        price: u8,
        qty: u64,
        kind: OrderKind,
    },
    Cancel {
        user: usize,
        nth: usize,
    },
    Settle {
        user: usize,
    },
}

fn op_strategy() -> impl Strategy<Value = Op> {
    prop_oneof![
        6 => (0..3usize, prop::bool::ANY, 45..56u8, 1..6u64, prop::bool::ANY).prop_map(
            |(user, bid, price, qty, ioc)| Op::Place {
                user,
                side: if bid { Side::Bid } else { Side::Ask },
                price,
                qty,
                kind: if ioc { OrderKind::Ioc } else { OrderKind::Limit },
            }
        ),
        2 => (0..3usize, 0..8usize).prop_map(|(user, nth)| Op::Cancel { user, nth }),
        2 => (0..3usize).prop_map(|user| Op::Settle { user }),
    ]
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(12))]

    /// After every instruction (successful or rejected): escrow USDC = Σ resting bid notional +
    /// Σ free USDC, escrow YES = Σ resting ask qty + Σ free YES, and `resting_count` matches
    /// the book; users never gain or lose tokens overall.
    #[test]
    fn escrow_is_conserved_after_every_instruction(ops in prop::collection::vec(op_strategy(), 1..14)) {
        let mut w = World::new();
        let users: Vec<User> = (0..3).map(|_| w.user(40, 40)).collect();
        let refs: Vec<&User> = users.iter().collect();
        let total_usdc: u64 = users.iter().map(|u| w.usdc(u)).sum::<u64>() + w.h.harness.token_amount(w.m.escrow_usdc);
        let total_yes: u64 = users.iter().map(|u| w.yes(u)).sum::<u64>() + w.h.harness.token_amount(w.m.escrow_yes);
        for op in ops {
            match op {
                Op::Place { user, side, price, qty, kind } => {
                    let others: Vec<&User> = users.iter().filter(|u| u.pubkey() != users[user].pubkey()).collect();
                    let _ = w.place(&users[user], side, price, qty, kind, &others);
                }
                Op::Cancel { user, nth } => {
                    let book = w.h.harness.book(w.m.book);
                    let mine: Vec<u64> = book.bids.iter().chain(book.asks.iter())
                        .filter(|o| o.qty > 0 && o.owner == users[user].pubkey())
                        .map(|o| o.order_id).collect();
                    if let Some(id) = mine.get(nth % mine.len().max(1)) {
                        let m = w.m;
                        expect_success(&w.h.harness.cancel_order(&users[user], &m, *id));
                    }
                }
                Op::Settle { user } => {
                    if w.h.harness.open_orders(w.m.market, users[user].pubkey()).is_some() {
                        let m = w.m;
                        expect_success(&w.h.harness.settle_funds(&users[user], &m));
                    }
                }
            }
            w.conserved(&refs);
            let usdc: u64 = users.iter().map(|u| w.usdc(u)).sum::<u64>() + w.h.harness.token_amount(w.m.escrow_usdc);
            let yes: u64 = users.iter().map(|u| w.yes(u)).sum::<u64>() + w.h.harness.token_amount(w.m.escrow_yes);
            prop_assert_eq!(usdc, total_usdc);
            prop_assert_eq!(yes, total_yes);
        }
    }
}
