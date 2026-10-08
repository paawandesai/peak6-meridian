//! M1-06: `buy_no` and `sell_no` against the built program in LiteSVM: the four trade paths on
//! one YES-vs-USDC book (domain.md § The four trade paths), their exact net prices (AC1, AC2),
//! the resting limit Buy NO (AC3), vault and escrow invariants over random mixes of all four
//! intents (AC4) and failure paths (D-031). Intent mapping in the TS client is AB-18.

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
use common::orders::{buy_no_ix, notional};
use common::{
    assert_anchor_error, assert_meridian_error, assert_token_error, expect_success, find_event,
    MarketAddresses, MarketHarness, User, BASE_CLOSE_TS,
};
use meridian::errors::MeridianError;
use meridian::events::{OrderPlaced, PairsMinted, Redeemed};
use meridian::state::{OrderKind, Side, PAIR_COLLATERAL};
use proptest::prelude::*;

const USDC: u64 = PAIR_COLLATERAL;
const CU_LIMIT: u32 = 400_000;

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

    /// A user with `usdc` USDC left after minting `pairs` pairs (so `pairs` YES and NO).
    fn user(&mut self, usdc: u64, pairs: u64) -> User {
        let user = self.h.harness.user_for(&self.m, (usdc + pairs) * USDC);
        if pairs > 0 {
            expect_success(&self.h.harness.mint_pair(&user, &self.m, pairs));
        }
        user
    }

    fn rest(&mut self, user: &User, side: Side, price: u8, qty: u64) {
        let m = self.m;
        expect_success(&self.h.harness.place_order(
            user,
            &m,
            side,
            price,
            qty,
            OrderKind::Limit,
            &[],
        ));
    }

    fn wallet(&self, user: &User) -> (u64, u64, u64) {
        self.h.harness.wallet(user)
    }

    fn conserved(&self, users: &[&User]) {
        self.h.harness.assert_escrow_conservation(&self.m, users);
    }

    fn pairs(&self) -> u64 {
        self.h.harness.market(self.m.market).pairs_outstanding
    }

    fn orders(&self) -> (usize, usize) {
        let book = self.h.harness.book(self.m.book);
        (
            book.bids.iter().filter(|o| o.qty > 0).count(),
            book.asks.iter().filter(|o| o.qty > 0).count(),
        )
    }
}

// ---- AC1: market Buy NO -----------------------------------------------------------------------

#[test]
fn market_buy_no_at_best_bid_62_costs_38_cents_per_contract_and_leaves_only_no() {
    let mut w = World::new();
    let bob = w.user(10, 0);
    let alice = w.user(50, 0);
    w.rest(&bob, Side::Bid, 62, 10);

    // Worst YES price to sell at: 1¢ (NO limit 99¢).
    let result =
        w.h.harness
            .buy_no(&alice, &w.m, 10, 1, OrderKind::Ioc, &[&bob]);
    let meta = expect_success(&result);
    assert_eq!(find_event::<PairsMinted>(meta).unwrap().qty, 10);
    assert!(
        find_event::<Redeemed>(meta).is_none(),
        "everything sold: nothing to redeem"
    );
    assert_eq!(w.wallet(&alice), (50 * USDC - 10 * 38 * 10_000, 0, 10));
    assert_eq!(w.h.harness.balances(&w.m, &bob), (0, 10, 0));
    assert_eq!(w.pairs(), 10);
    assert_eq!(w.orders(), (0, 0));
    w.conserved(&[&alice, &bob]);
}

#[test]
fn market_buy_no_pair_redeems_the_yes_that_found_no_bid() {
    let mut w = World::new();
    let bob = w.user(10, 0);
    let alice = w.user(50, 0);
    w.rest(&bob, Side::Bid, 62, 4);

    let result =
        w.h.harness
            .buy_no(&alice, &w.m, 10, 1, OrderKind::Ioc, &[&bob]);
    let meta = expect_success(&result);
    assert_eq!(find_event::<Redeemed>(meta).unwrap().yes_qty, 6);
    // 4 NO at 38¢ each; the other 6 pairs were minted and redeemed again for nothing.
    assert_eq!(w.wallet(&alice), (50 * USDC - 4 * 38 * 10_000, 0, 4));
    assert_eq!(w.pairs(), 4);
    w.conserved(&[&alice, &bob]);

    // An IOC floor above the best bid sells nothing: the whole mint is redeemed.
    let before = w.wallet(&alice);
    expect_success(&w.h.harness.buy_no(&alice, &w.m, 5, 90, OrderKind::Ioc, &[]));
    assert_eq!(w.wallet(&alice), before);
    assert_eq!(w.pairs(), 4);
    w.conserved(&[&alice, &bob]);
}

// ---- AC2: market Sell NO ----------------------------------------------------------------------

#[test]
fn market_sell_no_at_best_ask_65_returns_35_cents_per_contract_and_leaves_nothing() {
    let mut w = World::new();
    let carol = w.user(0, 10);
    let alice = w.user(50, 0);
    w.rest(&carol, Side::Ask, 65, 10);
    // Alice first buys 10 NO against a bid so that she holds NO only.
    let bob = w.user(10, 0);
    w.rest(&bob, Side::Bid, 62, 10);
    expect_success(
        &w.h.harness
            .buy_no(&alice, &w.m, 10, 1, OrderKind::Ioc, &[&bob]),
    );
    let (usdc_before, yes_before, no_before) = w.wallet(&alice);
    assert_eq!((yes_before, no_before), (0, 10));
    let pairs_before = w.pairs();

    // Worst YES price to buy at: 99¢.
    let result = w.h.harness.sell_no(&alice, &w.m, 10, 99, &[&carol]);
    let meta = expect_success(&result);
    assert_eq!(find_event::<Redeemed>(meta).unwrap().yes_qty, 10);
    assert_eq!(w.wallet(&alice), (usdc_before + 10 * 35 * 10_000, 0, 0));
    assert_eq!(w.pairs(), pairs_before - 10);
    assert_eq!(w.h.harness.balances(&w.m, &carol).0, notional(65, 10));
    w.conserved(&[&alice, &bob, &carol]);
}

#[test]
fn sell_no_only_redeems_the_yes_it_bought() {
    let mut w = World::new();
    let carol = w.user(0, 3);
    let alice = w.user(50, 10); // holds 10 YES + 10 NO
    w.rest(&carol, Side::Ask, 40, 3);

    // Wants to sell 10 NO but only 3 YES are offered: buys 3, redeems 3, keeps 7 NO + 10 YES.
    expect_success(&w.h.harness.sell_no(&alice, &w.m, 10, 99, &[&carol]));
    assert_eq!(
        w.wallet(&alice),
        (50 * USDC - notional(40, 3) + 3 * USDC, 10, 7)
    );
    w.conserved(&[&alice, &carol]);
}

// ---- AC3: limit Buy NO ------------------------------------------------------------------------

#[test]
fn limit_buy_no_leaves_no_and_a_resting_yes_ask_at_100_minus_the_limit() {
    let mut w = World::new();
    let alice = w.user(50, 0);
    // NO limit 30¢ → YES ask at 70¢.
    let result =
        w.h.harness
            .buy_no(&alice, &w.m, 10, 70, OrderKind::Limit, &[]);
    let meta = expect_success(&result);
    let placed: OrderPlaced = find_event(meta).unwrap();
    assert_eq!(
        (placed.side, placed.price, placed.rested_qty),
        (Side::Ask, 70, 10)
    );
    assert_eq!(
        w.wallet(&alice),
        (40 * USDC, 0, 10),
        "paid 10 USDC; YES is in escrow"
    );
    assert_eq!(w.h.harness.balances(&w.m, &alice), (0, 0, 1));
    assert_eq!(w.orders(), (0, 1));
    assert_eq!(w.pairs(), 10);
    w.conserved(&[&alice]);

    // A buyer lifts it: Alice's effective NO price becomes 30¢.
    let bob = w.user(10, 0);
    expect_success(&w.h.harness.place_order(
        &bob,
        &w.m,
        Side::Bid,
        70,
        10,
        OrderKind::Ioc,
        &[&alice],
    ));
    assert_eq!(w.h.harness.balances(&w.m, &alice), (notional(70, 10), 0, 0));
    expect_success(&w.h.harness.settle_funds(&alice, &w.m));
    assert_eq!(w.wallet(&alice), (40 * USDC + notional(70, 10), 0, 10));
    w.conserved(&[&alice, &bob]);
}

#[test]
fn limit_buy_no_that_partly_crosses_sells_what_it_can_and_rests_the_rest() {
    let mut w = World::new();
    let bob = w.user(10, 0);
    let alice = w.user(50, 0);
    w.rest(&bob, Side::Bid, 75, 4);
    // Floor 70: 4 sell at Bob's 75, 6 rest at 70.
    expect_success(
        &w.h.harness
            .buy_no(&alice, &w.m, 10, 70, OrderKind::Limit, &[&bob]),
    );
    assert_eq!(
        w.wallet(&alice),
        (50 * USDC - 10 * USDC + notional(75, 4), 0, 10)
    );
    assert_eq!(w.h.harness.balances(&w.m, &alice), (0, 0, 1));
    assert_eq!(w.orders(), (0, 1));
    w.conserved(&[&alice, &bob]);
}

// ---- failure paths ----------------------------------------------------------------------------

#[test]
fn no_paths_are_rejected_while_paused_and_after_close() {
    let mut w = World::new();
    let alice = w.user(20, 5);
    let bob = w.user(5, 0);
    w.rest(&bob, Side::Bid, 62, 5);
    let before = w.wallet(&alice);

    expect_success(&w.h.harness.pause());
    assert_meridian_error(
        &w.h.harness
            .buy_no(&alice, &w.m, 1, 1, OrderKind::Ioc, &[&bob]),
        MeridianError::Paused,
    );
    assert_meridian_error(
        &w.h.harness.sell_no(&alice, &w.m, 1, 99, &[]),
        MeridianError::Paused,
    );
    expect_success(&w.h.harness.unpause());

    for now in [BASE_CLOSE_TS, BASE_CLOSE_TS + 86_400] {
        w.h.harness.set_unix_timestamp(now);
        assert_meridian_error(
            &w.h.harness
                .buy_no(&alice, &w.m, 1, 1, OrderKind::Limit, &[]),
            MeridianError::MarketClosed,
        );
        assert_meridian_error(
            &w.h.harness.sell_no(&alice, &w.m, 1, 99, &[]),
            MeridianError::MarketClosed,
        );
    }
    assert_eq!(w.wallet(&alice), before);
    w.conserved(&[&alice, &bob]);
}

#[test]
fn invalid_quantity_and_price_are_rejected() {
    let mut w = World::new();
    let alice = w.user(20, 5);
    for kind in [OrderKind::Ioc, OrderKind::Limit] {
        assert_meridian_error(
            &w.h.harness.buy_no(&alice, &w.m, 0, 50, kind, &[]),
            MeridianError::InvalidQuantity,
        );
        for price in [0u8, 100, 255] {
            assert_meridian_error(
                &w.h.harness.buy_no(&alice, &w.m, 1, price, kind, &[]),
                MeridianError::InvalidPrice,
            );
        }
    }
    assert_meridian_error(
        &w.h.harness.sell_no(&alice, &w.m, 0, 50, &[]),
        MeridianError::InvalidQuantity,
    );
    for price in [0u8, 100] {
        assert_meridian_error(
            &w.h.harness.sell_no(&alice, &w.m, 1, price, &[]),
            MeridianError::InvalidPrice,
        );
    }
    assert_eq!(w.pairs(), 5, "a rejected buy_no mints nothing");
    w.conserved(&[&alice]);
}

#[test]
fn sell_no_without_the_no_tokens_reverts_everything() {
    let mut w = World::new();
    let carol = w.user(0, 5);
    let alice = w.user(50, 0); // no NO at all
    w.rest(&carol, Side::Ask, 40, 5);
    let before = (w.wallet(&alice), w.h.harness.book_data(w.m.book));
    assert_token_error(
        &w.h.harness.sell_no(&alice, &w.m, 5, 99, &[&carol]),
        TokenError::InsufficientFunds,
    );
    assert_eq!((w.wallet(&alice), w.h.harness.book_data(w.m.book)), before);
    w.conserved(&[&alice, &carol]);
}

#[test]
fn buy_no_without_usdc_reverts_and_missing_maker_accounts_are_refused() {
    let mut w = World::new();
    let bob = w.user(10, 0);
    let poor = w.user(0, 0);
    let alice = w.user(50, 0);
    w.rest(&bob, Side::Bid, 62, 5);
    let book = w.h.harness.book_data(w.m.book);
    assert_token_error(
        &w.h.harness
            .buy_no(&poor, &w.m, 1, 1, OrderKind::Ioc, &[&bob]),
        TokenError::InsufficientFunds,
    );
    assert_anchor_error(
        &w.h.harness.buy_no(&alice, &w.m, 5, 1, OrderKind::Ioc, &[]),
        ErrorCode::AccountNotEnoughKeys,
    );
    assert_eq!(w.h.harness.book_data(w.m.book), book);
    assert_eq!(w.pairs(), 0);
    w.conserved(&[&alice, &bob, &poor]);
}

#[test]
fn another_users_token_accounts_are_refused() {
    let mut w = World::new();
    let alice = w.user(20, 5);
    let mallory = w.user(20, 5);
    let m = w.m;
    let mut ix = buy_no_ix(&mallory, &m, 1, 1, OrderKind::Ioc, &[]);
    ix.accounts[7].pubkey = alice.no; // user_no
    assert_anchor_error(
        &w.h.harness.send(ix, &[&mallory.keypair]),
        ErrorCode::ConstraintTokenOwner,
    );
    w.conserved(&[&alice, &mallory]);
}

// ---- compute budget ---------------------------------------------------------------------------

#[test]
fn buy_no_and_sell_no_matching_eight_orders_stay_under_400k_compute_units() {
    let mut w = World::new();
    let bidders: Vec<User> = (0..8).map(|_| w.user(5, 0)).collect();
    for bidder in &bidders {
        w.rest(bidder, Side::Bid, 50, 1);
    }
    let alice = w.user(50, 0);
    let owners: Vec<_> = bidders.iter().map(|b| b.pubkey()).collect();
    let m = w.m;
    let ix = buy_no_ix(&alice, &m, 8, 1, OrderKind::Ioc, &owners);
    let meta = expect_success(
        &w.h.harness
            .send_with_budget(ix, &[&alice.keypair], CU_LIMIT),
    )
    .clone();
    println!("buy_no with 8 fills: {} CU", meta.compute_units_consumed);
    assert!(meta.compute_units_consumed < u64::from(CU_LIMIT));
    assert_eq!(w.wallet(&alice).2, 8);

    let askers: Vec<User> = (0..8).map(|_| w.user(0, 1)).collect();
    for asker in &askers {
        w.rest(asker, Side::Ask, 60, 1);
    }
    let owners: Vec<_> = askers.iter().map(|b| b.pubkey()).collect();
    let ix = common::orders::sell_no_ix(&alice, &m, 8, 99, &owners);
    let meta = expect_success(
        &w.h.harness
            .send_with_budget(ix, &[&alice.keypair], CU_LIMIT),
    )
    .clone();
    println!("sell_no with 8 fills: {} CU", meta.compute_units_consumed);
    assert!(meta.compute_units_consumed < u64::from(CU_LIMIT));
    assert_eq!(w.wallet(&alice).2, 0);
    let mut all: Vec<&User> = bidders.iter().chain(askers.iter()).collect();
    all.push(&alice);
    w.conserved(&all);
}

// ---- AC4: invariants over random mixes of the four intents ------------------------------------

#[derive(Clone, Debug)]
enum Op {
    BuyYes {
        user: usize,
        price: u8,
        qty: u64,
        ioc: bool,
    },
    SellYes {
        user: usize,
        price: u8,
        qty: u64,
        ioc: bool,
    },
    BuyNo {
        user: usize,
        floor: u8,
        qty: u64,
        ioc: bool,
    },
    SellNo {
        user: usize,
        cap: u8,
        qty: u64,
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
    let user = 0..3usize;
    let price = 40..61u8;
    let qty = 1..6u64;
    prop_oneof![
        2 => (user.clone(), price.clone(), qty.clone(), prop::bool::ANY)
            .prop_map(|(user, price, qty, ioc)| Op::BuyYes { user, price, qty, ioc }),
        2 => (user.clone(), price.clone(), qty.clone(), prop::bool::ANY)
            .prop_map(|(user, price, qty, ioc)| Op::SellYes { user, price, qty, ioc }),
        3 => (user.clone(), price.clone(), qty.clone(), prop::bool::ANY)
            .prop_map(|(user, floor, qty, ioc)| Op::BuyNo { user, floor, qty, ioc }),
        3 => (user.clone(), price, qty)
            .prop_map(|(user, cap, qty)| Op::SellNo { user, cap, qty }),
        1 => (user.clone(), 0..8usize).prop_map(|(user, nth)| Op::Cancel { user, nth }),
        1 => user.prop_map(|user| Op::Settle { user }),
    ]
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(12))]

    /// After every instruction, accepted or rejected: vault = 1 USDC × pairs outstanding, YES
    /// and NO supply = pairs outstanding, escrows = resting orders + free balances, and USDC is
    /// neither created nor destroyed.
    #[test]
    fn vault_and_escrow_invariants_hold_across_all_four_intents(
        ops in prop::collection::vec(op_strategy(), 1..14)
    ) {
        let mut w = World::new();
        let users: Vec<User> = (0..3).map(|_| w.user(30, 10)).collect();
        let refs: Vec<&User> = users.iter().collect();
        let total_usdc = |w: &World| -> u64 {
            users.iter().map(|u| w.wallet(u).0).sum::<u64>()
                + w.h.harness.token_amount(w.m.escrow_usdc)
                + w.h.harness.token_amount(w.m.vault)
        };
        let start = total_usdc(&w);
        for op in ops {
            let others = |user: usize| -> Vec<&User> {
                users.iter().filter(|u| u.pubkey() != users[user].pubkey()).collect()
            };
            let kind = |ioc: bool| if ioc { OrderKind::Ioc } else { OrderKind::Limit };
            let m = w.m;
            match op {
                Op::BuyYes { user, price, qty, ioc } => {
                    let _ = w.h.harness.place_order(&users[user], &m, Side::Bid, price, qty, kind(ioc), &others(user));
                }
                Op::SellYes { user, price, qty, ioc } => {
                    let _ = w.h.harness.place_order(&users[user], &m, Side::Ask, price, qty, kind(ioc), &others(user));
                }
                Op::BuyNo { user, floor, qty, ioc } => {
                    let _ = w.h.harness.buy_no(&users[user], &m, qty, floor, kind(ioc), &others(user));
                }
                Op::SellNo { user, cap, qty } => {
                    let _ = w.h.harness.sell_no(&users[user], &m, qty, cap, &others(user));
                }
                Op::Cancel { user, nth } => {
                    let book = w.h.harness.book(m.book);
                    let mine: Vec<u64> = book.bids.iter().chain(book.asks.iter())
                        .filter(|o| o.qty > 0 && o.owner == users[user].pubkey())
                        .map(|o| o.order_id).collect();
                    if let Some(id) = mine.get(nth % mine.len().max(1)) {
                        expect_success(&w.h.harness.cancel_order(&users[user], &m, *id));
                    }
                }
                Op::Settle { user } => {
                    if w.h.harness.open_orders(m.market, users[user].pubkey()).is_some() {
                        expect_success(&w.h.harness.settle_funds(&users[user], &m));
                    }
                }
            }
            w.conserved(&refs);
            prop_assert_eq!(total_usdc(&w), start);
        }
    }
}
