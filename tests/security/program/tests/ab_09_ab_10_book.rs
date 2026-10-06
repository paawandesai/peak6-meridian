//! AB-09 and AB-10 against the matching engine (M1-03 AC3; threat-model.md).
//!
//! AB-09 · Book manipulation: cancel another user's order, price outside 1–99¢, zero size,
//! self-trade loops. AB-10 · Fill the book with dust: per-owner resting cap, full book accepts
//! only better prices, fills per call bounded at 8. Escrow and fund movement are the program's
//! job (M1-05); here every attack must fail at the engine and leave the book byte-for-byte
//! unchanged.
#![allow(clippy::arithmetic_side_effects, clippy::indexing_slicing)]

use meridian_book::{
    Book, BookError, CancelReason, OrderKind, Owner, Side, MAX_FILLS_PER_PLACE,
    MAX_ORDERS_PER_OWNER, SIDE_CAPACITY,
};

const VICTIM: Owner = [0xA1; 32];
const ATTACKER: Owner = [0xB2; 32];

fn owner(n: u8) -> Owner {
    [n; 32]
}

fn rest(book: &mut Book, side: Side, price: u8, qty: u64, who: Owner) -> u64 {
    let res = book.place(side, price, qty, OrderKind::Limit, who).unwrap();
    assert!(res.fills.is_empty());
    res.rested.unwrap().order_id
}

// ---- AB-09 ------------------------------------------------------------------------------------

#[test]
fn ab_09_cancel_by_non_owner_fails_and_leaves_the_order_resting() {
    let mut book = Book::new();
    let bid = rest(&mut book, Side::Bid, 40, 10, VICTIM);
    let ask = rest(&mut book, Side::Ask, 60, 10, VICTIM);
    let before = book;

    assert_eq!(book.cancel(bid, &ATTACKER), Err(BookError::NotOwner));
    assert_eq!(book.cancel(ask, &ATTACKER), Err(BookError::NotOwner));
    // An all-zero "owner" (uninitialised key) gets nothing either.
    assert_eq!(book.cancel(bid, &[0; 32]), Err(BookError::NotOwner));
    assert_eq!(book, before, "failed cancels must not touch the book");

    // The real owner still can.
    assert_eq!(book.cancel(bid, &VICTIM).unwrap().order.qty, 10);
    assert_eq!(book.cancel(ask, &VICTIM).unwrap().order.qty, 10);
    assert!(book.is_empty());
}

#[test]
fn ab_09_cancel_of_unknown_or_already_filled_order_fails() {
    let mut book = Book::new();
    let ask = rest(&mut book, Side::Ask, 60, 1, VICTIM);
    assert_eq!(
        book.cancel(ask + 1, &ATTACKER),
        Err(BookError::OrderNotFound)
    );
    // Fill it, then try to cancel the dead id as either party.
    book.place(Side::Bid, 60, 1, OrderKind::Ioc, ATTACKER)
        .unwrap();
    assert_eq!(book.cancel(ask, &VICTIM), Err(BookError::OrderNotFound));
    assert_eq!(book.cancel(ask, &ATTACKER), Err(BookError::OrderNotFound));
}

#[test]
fn ab_09_price_outside_1_to_99_is_rejected_for_every_side_and_kind() {
    let mut book = Book::new();
    rest(&mut book, Side::Ask, 50, 1, VICTIM);
    let before = book;
    for price in [0u8, 100, 101, 200, u8::MAX] {
        for side in [Side::Bid, Side::Ask] {
            for kind in [OrderKind::Limit, OrderKind::Ioc] {
                assert_eq!(
                    book.place(side, price, 1, kind, ATTACKER),
                    Err(BookError::InvalidPrice)
                );
            }
        }
    }
    assert_eq!(book, before);
}

#[test]
fn ab_09_zero_size_is_rejected_and_huge_sizes_cannot_overflow() {
    let mut book = Book::new();
    let before = book;
    assert_eq!(
        book.place(Side::Bid, 50, 0, OrderKind::Limit, ATTACKER),
        Err(BookError::InvalidQty)
    );
    assert_eq!(
        book.place(Side::Ask, 50, 0, OrderKind::Ioc, ATTACKER),
        Err(BookError::InvalidQty)
    );
    assert_eq!(book, before);

    // u64::MAX on both sides: matching and conservation stay exact.
    rest(&mut book, Side::Ask, 50, u64::MAX, VICTIM);
    let res = book
        .place(Side::Bid, 50, u64::MAX, OrderKind::Limit, ATTACKER)
        .unwrap();
    assert_eq!(res.filled_qty(), u64::MAX);
    assert_eq!(res.rested, None);
    assert!(book.is_empty());

    // A u64::MAX taker against a small maker leaves exactly the difference.
    rest(&mut book, Side::Ask, 50, 3, VICTIM);
    let res = book
        .place(Side::Bid, 50, u64::MAX, OrderKind::Limit, ATTACKER)
        .unwrap();
    assert_eq!(res.filled_qty(), 3);
    assert_eq!(res.rested.unwrap().qty, u64::MAX - 3);
}

#[test]
fn ab_09_self_trade_loop_never_fills_against_yourself() {
    let mut book = Book::new();
    let mut fills = 0usize;
    // Attacker alternates crossing bids and asks against their own resting orders.
    for round in 0..20u8 {
        let (side, price) = if round % 2 == 0 {
            (Side::Bid, 60)
        } else {
            (Side::Ask, 40)
        };
        let res = book
            .place(side, price, 5, OrderKind::Limit, ATTACKER)
            .unwrap();
        fills += res.fills.len();
        for c in &res.cancelled {
            assert_eq!(c.reason, CancelReason::SelfTrade);
            assert_eq!(c.order.owner, ATTACKER);
        }
        assert!(
            res.rested.is_some(),
            "the new order rests after cancelling the old one"
        );
        assert_eq!(
            book.owner_count(&ATTACKER),
            1,
            "never more than one of the attacker's orders survives"
        );
    }
    assert_eq!(fills, 0, "a self-trade loop produces no fills");
    if let (Some(b), Some(a)) = (book.best_bid(), book.best_ask()) {
        assert!(b < a);
    }
}

// ---- AB-10 ------------------------------------------------------------------------------------

#[test]
fn ab_10_dust_spam_beyond_the_per_owner_cap_fails() {
    let mut book = Book::new();
    for i in 0..MAX_ORDERS_PER_OWNER {
        rest(&mut book, Side::Bid, 1 + i as u8, 1, ATTACKER);
    }
    let before = book;
    for price in [1u8, 20, 50, 99] {
        assert_eq!(
            book.place(Side::Bid, price, 1, OrderKind::Limit, ATTACKER),
            Err(BookError::OwnerCapExceeded)
        );
    }
    // Asks above the attacker's own bids (no self-trade) are capped too.
    for price in [9u8, 20, 50, 99] {
        assert_eq!(
            book.place(Side::Ask, price, 1, OrderKind::Limit, ATTACKER),
            Err(BookError::OwnerCapExceeded)
        );
    }
    assert_eq!(book, before);
    assert_eq!(book.owner_count(&ATTACKER), MAX_ORDERS_PER_OWNER);
    assert_eq!(
        book.len(Side::Bid),
        MAX_ORDERS_PER_OWNER,
        "the spammer holds 8 of 32 slots, not more"
    );
    // Everyone else still trades normally.
    assert!(book
        .place(Side::Bid, 50, 1, OrderKind::Limit, VICTIM)
        .unwrap()
        .rested
        .is_some());
}

#[test]
fn ab_10_four_colluding_owners_fill_a_side_but_cannot_block_better_prices() {
    let mut book = Book::new();
    // 4 attackers × 8 orders = 32 dust bids at 1–8¢.
    for a in 0..4u8 {
        for i in 0..MAX_ORDERS_PER_OWNER {
            rest(&mut book, Side::Bid, 1 + i as u8, 1, owner(0xC0 + a));
        }
    }
    assert_eq!(book.len(Side::Bid), SIDE_CAPACITY);
    let before = book;

    // The spammers themselves cannot add a 33rd order at any price (cap), and a 5th attacker
    // cannot add one at or below the worst price (full book).
    assert_eq!(
        book.place(Side::Bid, 99, 1, OrderKind::Limit, owner(0xC0)),
        Err(BookError::OwnerCapExceeded)
    );
    assert_eq!(
        book.place(Side::Bid, 1, 1, OrderKind::Limit, ATTACKER),
        Err(BookError::BookFull)
    );
    assert_eq!(book, before);

    // A real bid at a better price displaces the worst dust order and rests.
    let res = book
        .place(Side::Bid, 50, 10, OrderKind::Limit, VICTIM)
        .unwrap();
    assert_eq!(res.cancelled.len(), 1);
    assert_eq!(res.cancelled[0].reason, CancelReason::Displaced);
    assert_eq!(res.cancelled[0].order.price, 1);
    assert_eq!(res.rested.unwrap().price, 50);
    assert_eq!(book.best_bid(), Some(50));
    assert_eq!(book.len(Side::Bid), SIDE_CAPACITY);
}

#[test]
fn ab_10_full_book_only_accepts_strictly_better_prices() {
    let mut book = Book::new();
    for i in 0..SIDE_CAPACITY {
        rest(
            &mut book,
            Side::Ask,
            60 + (i / 8) as u8,
            1,
            owner(0xD0 + (i / 8) as u8),
        );
    }
    // Asks at 60, 61, 62, 63 (8 each); worst = 63.
    assert_eq!(book.worst(Side::Ask).unwrap().price, 63);
    let before = book;
    assert_eq!(
        book.place(Side::Ask, 63, 1, OrderKind::Limit, ATTACKER),
        Err(BookError::BookFull)
    );
    assert_eq!(
        book.place(Side::Ask, 64, 1, OrderKind::Limit, ATTACKER),
        Err(BookError::BookFull)
    );
    assert_eq!(
        book.place(Side::Ask, 99, 1, OrderKind::Limit, ATTACKER),
        Err(BookError::BookFull)
    );
    assert_eq!(book, before);

    let res = book
        .place(Side::Ask, 62, 1, OrderKind::Limit, VICTIM)
        .unwrap();
    assert_eq!(res.cancelled[0].reason, CancelReason::Displaced);
    assert_eq!(res.cancelled[0].order.price, 63);
    // The displaced order is the latest of the 63s (time priority protects the earlier ones).
    let displaced = res.cancelled[0].order;
    assert!(book
        .orders(Side::Ask)
        .filter(|o| o.price == 63)
        .all(|o| o.seq < displaced.seq));
    assert_eq!(book.len(Side::Ask), SIDE_CAPACITY);
}

#[test]
fn ab_10_a_sweep_stops_after_eight_fills() {
    let mut book = Book::new();
    // 32 one-contract asks from 4 owners at 50¢.
    for i in 0..SIDE_CAPACITY {
        rest(&mut book, Side::Ask, 50, 1, owner(0xE0 + (i / 8) as u8));
    }
    let res = book
        .place(Side::Bid, 99, 100, OrderKind::Ioc, ATTACKER)
        .unwrap();
    assert_eq!(res.fills.len(), MAX_FILLS_PER_PLACE);
    assert_eq!(res.filled_qty(), MAX_FILLS_PER_PLACE as u64);
    assert_eq!(res.cancelled.len(), 1);
    assert_eq!(res.cancelled[0].reason, CancelReason::IocRemainder);
    assert_eq!(res.cancelled[0].order.qty, 100 - MAX_FILLS_PER_PLACE as u64);
    assert_eq!(book.len(Side::Ask), SIDE_CAPACITY - MAX_FILLS_PER_PLACE);

    // Same with a limit order: the remainder would still cross, so it is cancelled, not rested.
    let res = book
        .place(Side::Bid, 99, 100, OrderKind::Limit, ATTACKER)
        .unwrap();
    assert_eq!(res.fills.len(), MAX_FILLS_PER_PLACE);
    assert_eq!(res.rested, None);
    assert_eq!(res.cancelled[0].reason, CancelReason::FillLimit);
    assert_eq!(book.len(Side::Ask), SIDE_CAPACITY - 2 * MAX_FILLS_PER_PLACE);
    assert_eq!(book.len(Side::Bid), 0);
    // Fills are at the makers' price, never at the taker's 99¢ limit.
    assert!(res.fills.iter().all(|f| f.price == 50));
}

#[test]
fn ab_10_fill_limit_counts_fills_not_self_cancels_and_the_book_never_crosses() {
    let mut book = Book::new();
    for _ in 0..MAX_ORDERS_PER_OWNER {
        rest(&mut book, Side::Ask, 50, 1, ATTACKER); // 8 own asks, best priority
    }
    for i in 0..(MAX_FILLS_PER_PLACE + 4) {
        rest(&mut book, Side::Ask, 51, 1, owner(0x10 + i as u8));
    }
    let res = book
        .place(Side::Bid, 60, 50, OrderKind::Limit, ATTACKER)
        .unwrap();
    let self_cancels = res
        .cancelled
        .iter()
        .filter(|c| c.reason == CancelReason::SelfTrade)
        .count();
    assert_eq!(self_cancels, MAX_ORDERS_PER_OWNER);
    assert_eq!(
        res.fills.len(),
        MAX_FILLS_PER_PLACE,
        "self-cancels do not eat into the fill budget"
    );
    assert_eq!(res.rested, None);
    assert!(res
        .cancelled
        .iter()
        .any(|c| c.reason == CancelReason::FillLimit));
    assert_eq!(book.len(Side::Ask), 4);
    assert_eq!(book.best_bid(), None);
}
