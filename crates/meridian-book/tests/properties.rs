//! Property tests (M1-03 AC2): over ≥ 1,000 random operation sequences, quantity is conserved,
//! bids never cross asks, every resting order has a valid price and quantity, and every rule's
//! bound (per-owner cap, side capacity, max fills) holds after every call.
#![allow(
    clippy::arithmetic_side_effects,
    clippy::indexing_slicing,
    clippy::unwrap_used
)]

use std::collections::HashMap;

use meridian_book::{
    Book, BookError, OrderKind, Owner, Side, MAX_FILLS_PER_PLACE, MAX_ORDERS_PER_OWNER, MAX_PRICE,
    MIN_PRICE, SIDE_CAPACITY,
};
use proptest::prelude::*;

#[derive(Clone, Debug)]
enum Op {
    Place {
        side: Side,
        price: u8,
        qty: u64,
        kind: OrderKind,
        owner: u8,
    },
    /// Cancel the `nth` most recent known order id (or an unknown id when none), as `owner`.
    Cancel { nth: usize, owner: u8 },
}

fn side() -> impl Strategy<Value = Side> {
    prop_oneof![Just(Side::Bid), Just(Side::Ask)]
}

fn kind() -> impl Strategy<Value = OrderKind> {
    prop_oneof![3 => Just(OrderKind::Limit), 1 => Just(OrderKind::Ioc)]
}

fn op() -> impl Strategy<Value = Op> {
    prop_oneof![
        6 => (side(), 0u8..=101, 0u64..=12, kind(), 0u8..5).prop_map(|(side, price, qty, kind, owner)| Op::Place { side, price, qty, kind, owner }),
        // Prices clustered around 50 so that orders actually cross.
        6 => (side(), 44u8..=56, 1u64..=12, kind(), 0u8..5).prop_map(|(side, price, qty, kind, owner)| Op::Place { side, price, qty, kind, owner }),
        3 => (0usize..40, 0u8..5).prop_map(|(nth, owner)| Op::Cancel { nth, owner }),
    ]
}

fn owner_key(n: u8) -> Owner {
    [n; 32]
}

/// Per-order quantity ledger: placed = filled (as taker or maker) + cancelled + resting.
#[derive(Default, Debug)]
struct Ledger {
    placed: u64,
    filled: u64,
    cancelled: u64,
}

#[derive(Default)]
struct Model {
    orders: HashMap<u64, Ledger>,
    ids: Vec<u64>,
    total_placed: u64,
    total_filled: u64,
    total_cancelled: u64,
}

fn check_book(book: &Book) -> Result<(), TestCaseError> {
    if let (Some(bid), Some(ask)) = (book.best_bid(), book.best_ask()) {
        prop_assert!(bid < ask, "book crossed: best bid {bid} ≥ best ask {ask}");
    }
    let mut per_owner: HashMap<Owner, usize> = HashMap::new();
    let mut seen = std::collections::HashSet::new();
    for side in [Side::Bid, Side::Ask] {
        let orders: Vec<_> = book.orders(side).collect();
        prop_assert!(orders.len() <= SIDE_CAPACITY);
        for o in orders {
            prop_assert!(
                (MIN_PRICE..=MAX_PRICE).contains(&o.price),
                "price {} rests",
                o.price
            );
            prop_assert!(o.qty >= 1, "zero-qty order rests");
            prop_assert_eq!(o.order_id, o.seq);
            prop_assert!(o.order_id < book.next_seq);
            prop_assert!(seen.insert(o.order_id), "duplicate order id {}", o.order_id);
            *per_owner.entry(o.owner).or_default() += 1;
        }
    }
    for (owner, count) in per_owner {
        prop_assert!(
            count <= MAX_ORDERS_PER_OWNER,
            "owner {:?} rests {count} orders",
            owner[0]
        );
    }
    Ok(())
}

fn check_conservation(book: &Book, model: &Model) -> Result<(), TestCaseError> {
    let resting: u64 = book
        .orders(Side::Bid)
        .chain(book.orders(Side::Ask))
        .map(|o| o.qty)
        .sum();
    // Every fill moves qty out of two orders (taker and maker).
    prop_assert_eq!(
        model.total_placed,
        resting + 2 * model.total_filled + model.total_cancelled,
        "placed = resting + 2 × filled + cancelled"
    );
    for (id, ledger) in &model.orders {
        let resting = book.find(*id).map(|(_, o)| o.qty).unwrap_or(0);
        prop_assert_eq!(
            ledger.placed,
            ledger.filled + ledger.cancelled + resting,
            "order {} ledger {:?} vs resting {}",
            id,
            ledger,
            resting
        );
    }
    Ok(())
}

fn run(ops: &[Op]) -> Result<(), TestCaseError> {
    let mut book = Book::new();
    let mut model = Model::default();
    for op in ops {
        let before = book;
        match *op {
            Op::Place {
                side,
                price,
                qty,
                kind,
                owner,
            } => {
                let owner_key = owner_key(owner);
                let owner_before = book.owner_count(&owner_key);
                let side_len_before = book.len(side);
                let worst_before = book.worst(side).copied();
                match book.place(side, price, qty, kind, owner_key) {
                    Ok(res) => {
                        prop_assert!((MIN_PRICE..=MAX_PRICE).contains(&price));
                        prop_assert!(qty >= 1);
                        prop_assert!(res.fills.len() <= MAX_FILLS_PER_PLACE);
                        prop_assert_eq!(res.order_id, before.next_seq);
                        prop_assert_eq!(book.next_seq, before.next_seq + 1);
                        model.ids.push(res.order_id);
                        model.total_placed += qty;
                        model.orders.insert(
                            res.order_id,
                            Ledger {
                                placed: qty,
                                ..Ledger::default()
                            },
                        );
                        // Fills: at maker prices, in non-improving order for the taker.
                        let mut last_price: Option<u8> = None;
                        for f in &res.fills {
                            prop_assert_eq!(f.taker, owner_key);
                            prop_assert_eq!(f.taker_order_id, res.order_id);
                            prop_assert_eq!(f.taker_side, side);
                            prop_assert!(f.maker != owner_key, "self-trade filled");
                            prop_assert!(f.qty >= 1);
                            let crosses = match side {
                                Side::Bid => f.price <= price,
                                Side::Ask => f.price >= price,
                            };
                            prop_assert!(crosses, "fill at {} for {:?} @ {}", f.price, side, price);
                            if let Some(last) = last_price {
                                let ok = match side {
                                    Side::Bid => f.price >= last,
                                    Side::Ask => f.price <= last,
                                };
                                prop_assert!(ok, "fills not in price priority order");
                            }
                            last_price = Some(f.price);
                            let maker_before = before.find(f.maker_order_id).map(|(_, o)| *o);
                            let maker_before =
                                maker_before.ok_or_else(|| TestCaseError::fail("unknown maker"))?;
                            prop_assert_eq!(maker_before.price, f.price);
                            prop_assert!(f.qty <= maker_before.qty);
                            model.total_filled += f.qty;
                            if let Some(l) = model.orders.get_mut(&res.order_id) {
                                l.filled += f.qty;
                            }
                            if let Some(l) = model.orders.get_mut(&f.maker_order_id) {
                                l.filled += f.qty;
                            }
                        }
                        for c in &res.cancelled {
                            model.total_cancelled += c.order.qty;
                            if c.order.order_id == res.order_id {
                                prop_assert_eq!(c.side, side);
                                prop_assert_eq!(c.order.owner, owner_key);
                                prop_assert!(
                                    kind == OrderKind::Ioc
                                        || res.fills.len() == MAX_FILLS_PER_PLACE
                                );
                            } else {
                                let was = before.find(c.order.order_id).map(|(s, o)| (s, *o));
                                prop_assert_eq!(
                                    was,
                                    Some((c.side, c.order)),
                                    "cancelled a record that was not resting"
                                );
                                prop_assert!(book.find(c.order.order_id).is_none());
                            }
                            if let Some(l) = model.orders.get_mut(&c.order.order_id) {
                                l.cancelled += c.order.qty;
                            }
                        }
                        if let Some(rested) = res.rested {
                            prop_assert_eq!(kind, OrderKind::Limit);
                            prop_assert_eq!(
                                (rested.order_id, rested.owner, rested.price, rested.seq),
                                (res.order_id, owner_key, price, res.order_id)
                            );
                            prop_assert_eq!(book.find(res.order_id), Some((side, &rested)));
                            if side_len_before == SIDE_CAPACITY {
                                let worst = worst_before.ok_or_else(|| {
                                    TestCaseError::fail("full side without worst")
                                })?;
                                let beats = match side {
                                    Side::Bid => price > worst.price,
                                    Side::Ask => price < worst.price,
                                };
                                prop_assert!(
                                    beats,
                                    "rested on a full side without beating the worst"
                                );
                                prop_assert!(res
                                    .cancelled
                                    .iter()
                                    .any(|c| c.order.order_id == worst.order_id));
                            }
                        } else {
                            prop_assert!(book.find(res.order_id).is_none());
                        }
                    }
                    Err(e) => {
                        prop_assert_eq!(book, before, "a rejected place must not change the book");
                        match e {
                            BookError::InvalidPrice => {
                                prop_assert!(!(MIN_PRICE..=MAX_PRICE).contains(&price))
                            }
                            BookError::InvalidQty => prop_assert_eq!(qty, 0),
                            BookError::OwnerCapExceeded => {
                                prop_assert_eq!(kind, OrderKind::Limit);
                                prop_assert!(owner_before >= 1, "cap error with no resting orders");
                            }
                            BookError::BookFull => {
                                prop_assert_eq!(kind, OrderKind::Limit);
                                prop_assert_eq!(side_len_before, SIDE_CAPACITY);
                            }
                            other => prop_assert!(false, "unexpected error {other:?}"),
                        }
                    }
                }
            }
            Op::Cancel { nth, owner } => {
                let owner_key = owner_key(owner);
                let id = model.ids.iter().rev().nth(nth).copied().unwrap_or(u64::MAX);
                let was = before.find(id).map(|(s, o)| (s, *o));
                match book.cancel(id, &owner_key) {
                    Ok(c) => {
                        prop_assert_eq!(was, Some((c.side, c.order)));
                        prop_assert_eq!(c.order.owner, owner_key);
                        prop_assert!(book.find(id).is_none());
                        model.total_cancelled += c.order.qty;
                        if let Some(l) = model.orders.get_mut(&id) {
                            l.cancelled += c.order.qty;
                        }
                    }
                    Err(BookError::OrderNotFound) => {
                        prop_assert!(was.is_none());
                        prop_assert_eq!(book, before);
                    }
                    Err(BookError::NotOwner) => {
                        let (_, o) =
                            was.ok_or_else(|| TestCaseError::fail("NotOwner for a missing order"))?;
                        prop_assert!(o.owner != owner_key);
                        prop_assert_eq!(book, before);
                    }
                    Err(other) => prop_assert!(false, "unexpected cancel error {other:?}"),
                }
            }
        }
        check_book(&book)?;
        check_conservation(&book, &model)?;
    }
    Ok(())
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 1_200, max_shrink_iters: 2_000, .. ProptestConfig::default() })]

    #[test]
    fn random_sequences_preserve_every_invariant(ops in prop::collection::vec(op(), 1..120)) {
        run(&ops)?;
    }
}

/// Operations that fill both sides: many owners resting non-crossing orders in two price bands,
/// plus occasional large sweeps that cross the whole opposite side.
fn dense_op() -> impl Strategy<Value = Op> {
    prop_oneof![
        8 => (side(), 0u8..=20, 1u64..=3, 0u8..24).prop_map(|(side, offset, qty, owner)| {
            let price = match side {
                Side::Bid => 10 + offset,
                Side::Ask => 70 + offset,
            };
            Op::Place { side, price, qty, kind: OrderKind::Limit, owner }
        }),
        1 => (side(), 0u8..=29, 5u64..=40, kind(), 0u8..24).prop_map(|(side, offset, qty, kind, owner)| {
            let price = match side {
                Side::Bid => 70 + offset,
                Side::Ask => 1 + offset,
            };
            Op::Place { side, price, qty, kind, owner }
        }),
        1 => (0usize..60, 0u8..24).prop_map(|(nth, owner)| Op::Cancel { nth, owner }),
    ]
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 400, .. ProptestConfig::default() })]

    /// Dense sequences exercise the full-book, displacement and fill-limit paths often.
    #[test]
    fn dense_sequences_fill_the_book_and_hold_invariants(ops in prop::collection::vec(dense_op(), 50..250)) {
        run(&ops)?;
    }
}
