//! Behavior tests for the matching engine (M1-03 AC1, AC3 and every rule in
//! domain.md § Order book rules), including failure paths.
#![allow(
    clippy::arithmetic_side_effects,
    clippy::indexing_slicing,
    clippy::unwrap_used
)]

use meridian_book::{
    Book, BookError, CancelReason, Fill, Order, OrderKind, Owner, Side, MAX_FILLS_PER_PLACE,
    MAX_ORDERS_PER_OWNER, SIDE_CAPACITY,
};

fn owner(n: u8) -> Owner {
    [n; 32]
}

const ALICE: Owner = [1; 32];
const BOB: Owner = [2; 32];
const CAROL: Owner = [3; 32];

fn limit(book: &mut Book, side: Side, price: u8, qty: u64, who: Owner) -> u64 {
    let res = book.place(side, price, qty, OrderKind::Limit, who).unwrap();
    assert!(
        res.fills.is_empty(),
        "expected a resting order, got fills {:?}",
        res.fills
    );
    res.rested.unwrap().order_id
}

// ---- validation -----------------------------------------------------------------------------

#[test]
fn rejects_price_outside_1_to_99() {
    let mut book = Book::new();
    for price in [0u8, 100, 255] {
        for side in [Side::Bid, Side::Ask] {
            for kind in [OrderKind::Limit, OrderKind::Ioc] {
                assert_eq!(
                    book.place(side, price, 1, kind, ALICE),
                    Err(BookError::InvalidPrice)
                );
            }
        }
    }
    assert!(book.is_empty());
    assert_eq!(
        book.next_seq, 1,
        "a rejected order consumes no sequence number"
    );
}

#[test]
fn accepts_boundary_prices() {
    let mut book = Book::new();
    limit(&mut book, Side::Bid, 1, 1, ALICE);
    limit(&mut book, Side::Ask, 99, 1, ALICE);
    assert_eq!(book.best_bid(), Some(1));
    assert_eq!(book.best_ask(), Some(99));
}

#[test]
fn rejects_zero_quantity() {
    let mut book = Book::new();
    assert_eq!(
        book.place(Side::Bid, 50, 0, OrderKind::Limit, ALICE),
        Err(BookError::InvalidQty)
    );
    assert_eq!(
        book.place(Side::Ask, 50, 0, OrderKind::Ioc, ALICE),
        Err(BookError::InvalidQty)
    );
    assert!(book.is_empty());
}

#[test]
fn seq_overflow_is_an_error_and_leaves_the_book_unchanged() {
    let mut book = Book::new();
    book.next_seq = u64::MAX;
    let before = book;
    assert_eq!(
        book.place(Side::Bid, 50, 1, OrderKind::Limit, ALICE),
        Err(BookError::SeqOverflow)
    );
    assert_eq!(book, before);
}

#[test]
fn errors_display_a_message() {
    let errors = [
        BookError::InvalidPrice,
        BookError::InvalidQty,
        BookError::OwnerCapExceeded,
        BookError::BookFull,
        BookError::OrderNotFound,
        BookError::NotOwner,
        BookError::SeqOverflow,
    ];
    for e in errors {
        assert!(!e.to_string().is_empty());
    }
    let boxed: Box<dyn std::error::Error> = Box::new(BookError::BookFull);
    assert!(boxed.to_string().contains("full"));
}

// ---- resting and ids ------------------------------------------------------------------------

#[test]
fn resting_order_records_its_fields_and_ids_are_sequential() {
    let mut book = Book::new();
    let res = book
        .place(Side::Bid, 60, 5, OrderKind::Limit, ALICE)
        .unwrap();
    assert_eq!(res.order_id, 1);
    let rested = res.rested.unwrap();
    assert_eq!(
        rested,
        Order {
            order_id: 1,
            owner: ALICE,
            price: 60,
            _pad: [0; 7],
            qty: 5,
            seq: 1
        }
    );
    assert!(res.cancelled.is_empty());
    assert_eq!(book.next_seq, 2);

    let res2 = book.place(Side::Ask, 70, 3, OrderKind::Limit, BOB).unwrap();
    assert_eq!(res2.order_id, 2);
    assert_eq!(book.find(2).unwrap(), (Side::Ask, &res2.rested.unwrap()));
    assert_eq!(book.find(1).unwrap().0, Side::Bid);
    assert!(book.find(99).is_none());
    assert_eq!(book.len(Side::Bid), 1);
    assert_eq!(book.len(Side::Ask), 1);
    assert_eq!(book.owner_count(&ALICE), 1);
    assert_eq!(book.owner_count(&CAROL), 0);
}

#[test]
fn default_book_is_empty_with_seq_one() {
    let book = Book::default();
    assert!(book.is_empty());
    assert_eq!(book.next_seq, 1);
    assert_eq!(book.best_bid(), None);
    assert_eq!(book.best_ask(), None);
    assert!(book.best(Side::Bid).is_none());
    assert!(book.worst(Side::Ask).is_none());
    assert!(Order::EMPTY.is_empty());
    assert_eq!(Order::default(), Order::EMPTY);
    assert_eq!(Side::Bid.opposite(), Side::Ask);
    assert_eq!(Side::Ask.opposite(), Side::Bid);
}

#[test]
fn layout_is_zero_copy_friendly() {
    assert_eq!(std::mem::size_of::<Order>(), 64);
    assert_eq!(std::mem::size_of::<Book>(), 2 * SIDE_CAPACITY * 64 + 8);
    assert_eq!(std::mem::align_of::<Book>(), 8);
}

// ---- price-time priority (AC1) ---------------------------------------------------------------

#[test]
fn bids_sort_by_price_desc_then_time_and_asks_by_price_asc_then_time() {
    let mut book = Book::new();
    let b1 = limit(&mut book, Side::Bid, 50, 1, ALICE);
    let b2 = limit(&mut book, Side::Bid, 55, 1, BOB);
    let b3 = limit(&mut book, Side::Bid, 55, 1, CAROL);
    let a1 = limit(&mut book, Side::Ask, 60, 1, ALICE);
    let a2 = limit(&mut book, Side::Ask, 58, 1, BOB);
    let a3 = limit(&mut book, Side::Ask, 58, 1, CAROL);

    let bids: Vec<u64> = book
        .sorted_orders(Side::Bid)
        .iter()
        .map(|o| o.order_id)
        .collect();
    assert_eq!(bids, vec![b2, b3, b1]);
    let asks: Vec<u64> = book
        .sorted_orders(Side::Ask)
        .iter()
        .map(|o| o.order_id)
        .collect();
    assert_eq!(asks, vec![a2, a3, a1]);
    assert_eq!(book.best(Side::Bid).unwrap().order_id, b2);
    assert_eq!(book.worst(Side::Bid).unwrap().order_id, b1);
    assert_eq!(book.best(Side::Ask).unwrap().order_id, a2);
    assert_eq!(book.worst(Side::Ask).unwrap().order_id, a1);
}

#[test]
fn taker_fills_best_price_first_then_earliest_at_same_price() {
    let mut book = Book::new();
    let a_late_cheap = limit(&mut book, Side::Ask, 60, 2, ALICE); // id 1
    let b_early_62 = limit(&mut book, Side::Ask, 62, 2, BOB); // id 2
    let c_late_62 = limit(&mut book, Side::Ask, 62, 2, CAROL); // id 3

    let res = book
        .place(Side::Bid, 65, 5, OrderKind::Limit, owner(9))
        .unwrap();
    let ids: Vec<u64> = res.fills.iter().map(|f| f.maker_order_id).collect();
    assert_eq!(ids, vec![a_late_cheap, b_early_62, c_late_62]);
    let fill_prices: Vec<u8> = res.fills.iter().map(|f| f.price).collect();
    assert_eq!(fill_prices, vec![60, 62, 62]);
    let qtys: Vec<u64> = res.fills.iter().map(|f| f.qty).collect();
    assert_eq!(qtys, vec![2, 2, 1]);
    assert_eq!(res.rested, None, "fully filled: nothing rests");
    assert!(res.cancelled.is_empty());
    // Carol keeps 1 contract at 62.
    assert_eq!(
        book.sorted_orders(Side::Ask),
        vec![Order {
            order_id: 3,
            owner: CAROL,
            price: 62,
            _pad: [0; 7],
            qty: 1,
            seq: 3
        }]
    );
    assert!(book.orders(Side::Bid).next().is_none());
}

#[test]
fn ask_taker_fills_highest_bid_first_at_maker_price() {
    let mut book = Book::new();
    limit(&mut book, Side::Bid, 40, 3, ALICE);
    limit(&mut book, Side::Bid, 45, 3, BOB);
    let res = book
        .place(Side::Ask, 41, 4, OrderKind::Limit, CAROL)
        .unwrap();
    assert_eq!(res.fills.len(), 1);
    assert_eq!(
        res.fills[0],
        Fill {
            maker_order_id: 2,
            maker: BOB,
            taker_order_id: 3,
            taker: CAROL,
            price: 45,
            qty: 3,
            taker_side: Side::Ask
        }
    );
    // Remainder 1 rests as an ask at 41; Alice's 40 bid does not cross it.
    assert_eq!(res.rested.unwrap().qty, 1);
    assert_eq!(book.best_bid(), Some(40));
    assert_eq!(book.best_ask(), Some(41));
}

#[test]
fn non_crossing_limit_rests_without_fills() {
    let mut book = Book::new();
    limit(&mut book, Side::Ask, 60, 5, ALICE);
    let res = book.place(Side::Bid, 59, 5, OrderKind::Limit, BOB).unwrap();
    assert!(res.fills.is_empty());
    assert_eq!(res.rested.unwrap().price, 59);
    assert_eq!(book.best_bid(), Some(59));
    assert_eq!(book.best_ask(), Some(60));
}

// ---- partial fills (AC1) --------------------------------------------------------------------

#[test]
fn partial_fill_of_maker_reduces_its_quantity_and_keeps_its_priority() {
    let mut book = Book::new();
    let maker = limit(&mut book, Side::Ask, 60, 10, ALICE);
    limit(&mut book, Side::Ask, 60, 10, BOB);
    let res = book
        .place(Side::Bid, 60, 4, OrderKind::Limit, CAROL)
        .unwrap();
    assert_eq!(res.fills.len(), 1);
    assert_eq!(res.fills[0].maker_order_id, maker);
    assert_eq!(res.fills[0].qty, 4);
    assert_eq!(res.filled_qty(), 4);
    assert_eq!(res.rested, None);
    let asks = book.sorted_orders(Side::Ask);
    assert_eq!(asks[0].order_id, maker);
    assert_eq!(asks[0].qty, 6);
    assert_eq!(asks[0].seq, 1, "partial fill keeps the original seq");
    assert_eq!(asks[1].qty, 10);
}

#[test]
fn partial_fill_of_taker_rests_remainder_at_its_own_price() {
    let mut book = Book::new();
    limit(&mut book, Side::Ask, 60, 3, ALICE);
    let res = book
        .place(Side::Bid, 62, 10, OrderKind::Limit, BOB)
        .unwrap();
    assert_eq!(res.filled_qty(), 3);
    assert_eq!(res.fills[0].price, 60, "fill at the maker's price");
    let rested = res.rested.unwrap();
    assert_eq!((rested.price, rested.qty, rested.owner), (62, 7, BOB));
    assert_eq!(book.len(Side::Ask), 0);
    assert_eq!(book.best_bid(), Some(62));
}

// ---- IOC ----------------------------------------------------------------------------------

#[test]
fn ioc_fills_what_it_can_and_cancels_the_rest() {
    let mut book = Book::new();
    limit(&mut book, Side::Ask, 60, 3, ALICE);
    limit(&mut book, Side::Ask, 70, 3, ALICE);
    let res = book.place(Side::Bid, 65, 10, OrderKind::Ioc, BOB).unwrap();
    assert_eq!(res.filled_qty(), 3);
    assert_eq!(res.rested, None);
    assert_eq!(res.cancelled.len(), 1);
    let c = res.cancelled[0];
    assert_eq!(c.reason, CancelReason::IocRemainder);
    assert_eq!(c.side, Side::Bid);
    assert_eq!(
        (c.order.owner, c.order.price, c.order.qty, c.order.order_id),
        (BOB, 65, 7, res.order_id)
    );
    assert_eq!(book.len(Side::Bid), 0);
    assert_eq!(book.best_ask(), Some(70));
}

#[test]
fn ioc_on_empty_book_cancels_everything_but_consumes_a_seq() {
    let mut book = Book::new();
    let res = book.place(Side::Ask, 30, 4, OrderKind::Ioc, ALICE).unwrap();
    assert!(res.fills.is_empty());
    assert_eq!(res.cancelled[0].order.qty, 4);
    assert!(book.is_empty());
    assert_eq!(book.next_seq, 2);
}

#[test]
fn ioc_never_counts_against_the_owner_cap() {
    let mut book = Book::new();
    for _ in 0..MAX_ORDERS_PER_OWNER {
        limit(&mut book, Side::Bid, 10, 1, ALICE);
    }
    limit(&mut book, Side::Ask, 60, 1, BOB);
    let res = book.place(Side::Bid, 60, 5, OrderKind::Ioc, ALICE).unwrap();
    assert_eq!(res.filled_qty(), 1);
    assert_eq!(res.cancelled[0].reason, CancelReason::IocRemainder);
    assert_eq!(book.owner_count(&ALICE), MAX_ORDERS_PER_OWNER);
}

// ---- self-trade -----------------------------------------------------------------------------

#[test]
fn self_trade_cancels_own_resting_order_and_keeps_matching_others() {
    let mut book = Book::new();
    let own = limit(&mut book, Side::Ask, 60, 5, ALICE);
    let bobs = limit(&mut book, Side::Ask, 61, 5, BOB);
    let res = book
        .place(Side::Bid, 65, 3, OrderKind::Limit, ALICE)
        .unwrap();
    assert_eq!(res.cancelled.len(), 1);
    assert_eq!(res.cancelled[0].reason, CancelReason::SelfTrade);
    assert_eq!(res.cancelled[0].order.order_id, own);
    assert_eq!(
        res.cancelled[0].order.qty, 5,
        "whole resting order is cancelled, not just the overlap"
    );
    assert_eq!(res.cancelled[0].side, Side::Ask);
    assert_eq!(res.fills.len(), 1);
    assert_eq!(res.fills[0].maker_order_id, bobs);
    assert_eq!(res.fills[0].qty, 3);
    assert_eq!(res.rested, None);
    assert!(book.find(own).is_none());
    assert_eq!(book.find(bobs).unwrap().1.qty, 2);
}

#[test]
fn self_trade_only_cancels_crossing_own_orders() {
    let mut book = Book::new();
    let far = limit(&mut book, Side::Ask, 80, 5, ALICE);
    let near = limit(&mut book, Side::Ask, 60, 5, ALICE);
    let res = book
        .place(Side::Bid, 65, 3, OrderKind::Limit, ALICE)
        .unwrap();
    assert_eq!(
        res.cancelled
            .iter()
            .map(|c| c.order.order_id)
            .collect::<Vec<_>>(),
        vec![near]
    );
    assert!(res.fills.is_empty());
    assert_eq!(res.rested.unwrap().price, 65);
    assert!(book.find(far).is_some());
    assert_eq!(book.best_bid(), Some(65));
    assert_eq!(book.best_ask(), Some(80));
}

#[test]
fn self_trade_cancel_frees_a_slot_under_the_owner_cap() {
    let mut book = Book::new();
    for _ in 0..(MAX_ORDERS_PER_OWNER - 1) {
        limit(&mut book, Side::Bid, 10, 1, ALICE);
    }
    let own_ask = limit(&mut book, Side::Ask, 60, 1, ALICE);
    assert_eq!(book.owner_count(&ALICE), MAX_ORDERS_PER_OWNER);
    // Crossing own ask: it is cancelled, so the bid can rest within the cap.
    let res = book
        .place(Side::Bid, 60, 1, OrderKind::Limit, ALICE)
        .unwrap();
    assert_eq!(res.cancelled[0].order.order_id, own_ask);
    assert!(res.rested.is_some());
    assert_eq!(book.owner_count(&ALICE), MAX_ORDERS_PER_OWNER);
}

// ---- fill limit (AC3) -----------------------------------------------------------------------

#[test]
fn matching_stops_at_max_fills_and_cancels_a_still_crossing_limit_remainder() {
    let mut book = Book::new();
    for i in 0..(MAX_FILLS_PER_PLACE + 2) {
        limit(&mut book, Side::Ask, 50, 1, owner(10 + i as u8));
    }
    let res = book
        .place(Side::Bid, 50, 20, OrderKind::Limit, ALICE)
        .unwrap();
    assert_eq!(res.fills.len(), MAX_FILLS_PER_PLACE);
    assert_eq!(res.filled_qty(), 8);
    assert_eq!(
        res.rested, None,
        "resting would cross the two remaining asks"
    );
    assert_eq!(res.cancelled.len(), 1);
    assert_eq!(res.cancelled[0].reason, CancelReason::FillLimit);
    assert_eq!(res.cancelled[0].order.qty, 12);
    assert_eq!(book.len(Side::Ask), 2);
    assert_eq!(book.len(Side::Bid), 0);
    assert_eq!(book.best_bid(), None);
    assert_eq!(book.best_ask(), Some(50));
}

#[test]
fn matching_stops_at_max_fills_and_cancels_an_ioc_remainder() {
    let mut book = Book::new();
    for i in 0..(MAX_FILLS_PER_PLACE + 1) {
        limit(&mut book, Side::Bid, 50, 1, owner(10 + i as u8));
    }
    let res = book.place(Side::Ask, 50, 9, OrderKind::Ioc, ALICE).unwrap();
    assert_eq!(res.fills.len(), MAX_FILLS_PER_PLACE);
    assert_eq!(res.cancelled[0].reason, CancelReason::IocRemainder);
    assert_eq!(res.cancelled[0].order.qty, 1);
    assert_eq!(book.len(Side::Bid), 1);
}

#[test]
fn limit_remainder_rests_when_exactly_max_fills_exhaust_the_crossing_liquidity() {
    let mut book = Book::new();
    for i in 0..MAX_FILLS_PER_PLACE {
        limit(&mut book, Side::Ask, 50, 1, owner(10 + i as u8));
    }
    limit(&mut book, Side::Ask, 51, 1, BOB); // does not cross a 50 bid
    let res = book
        .place(Side::Bid, 50, 10, OrderKind::Limit, ALICE)
        .unwrap();
    assert_eq!(res.fills.len(), MAX_FILLS_PER_PLACE);
    assert!(res.cancelled.is_empty());
    assert_eq!(res.rested.unwrap().qty, 2);
    assert_eq!(book.best_bid(), Some(50));
    assert_eq!(book.best_ask(), Some(51));
}

#[test]
fn self_trade_cancels_do_not_count_as_fills() {
    let mut book = Book::new();
    limit(&mut book, Side::Ask, 49, 1, ALICE); // own, best priced: cancelled first
    for i in 0..MAX_FILLS_PER_PLACE {
        limit(&mut book, Side::Ask, 50, 1, owner(10 + i as u8));
    }
    let res = book
        .place(Side::Bid, 50, 8, OrderKind::Limit, ALICE)
        .unwrap();
    assert_eq!(res.fills.len(), MAX_FILLS_PER_PLACE);
    assert_eq!(res.cancelled.len(), 1);
    assert_eq!(res.cancelled[0].reason, CancelReason::SelfTrade);
    assert_eq!(res.rested, None);
    assert!(book.is_empty());
}

// ---- per-owner cap (AB-10) -----------------------------------------------------------------

#[test]
fn ninth_resting_order_of_an_owner_is_rejected_on_either_side() {
    let mut book = Book::new();
    for i in 0..MAX_ORDERS_PER_OWNER {
        let side = if i % 2 == 0 { Side::Bid } else { Side::Ask };
        let price = if side == Side::Bid { 10 } else { 90 };
        limit(&mut book, side, price, 1, ALICE);
    }
    let before = book;
    assert_eq!(
        book.place(Side::Bid, 11, 1, OrderKind::Limit, ALICE),
        Err(BookError::OwnerCapExceeded)
    );
    assert_eq!(
        book.place(Side::Ask, 89, 1, OrderKind::Limit, ALICE),
        Err(BookError::OwnerCapExceeded)
    );
    assert_eq!(book, before, "a rejected order changes nothing");
    // Another owner is unaffected.
    assert!(book.place(Side::Bid, 11, 1, OrderKind::Limit, BOB).is_ok());
}

#[test]
fn capped_owner_can_still_take_liquidity_with_a_fully_filling_limit() {
    let mut book = Book::new();
    for _ in 0..MAX_ORDERS_PER_OWNER {
        limit(&mut book, Side::Bid, 10, 1, ALICE);
    }
    limit(&mut book, Side::Ask, 60, 5, BOB);
    let res = book
        .place(Side::Bid, 60, 5, OrderKind::Limit, ALICE)
        .unwrap();
    assert_eq!(res.filled_qty(), 5);
    assert_eq!(res.rested, None);
}

#[test]
fn capped_owner_crossing_limit_with_a_remainder_is_rejected_atomically() {
    let mut book = Book::new();
    for _ in 0..MAX_ORDERS_PER_OWNER {
        limit(&mut book, Side::Bid, 10, 1, ALICE);
    }
    limit(&mut book, Side::Ask, 60, 2, BOB);
    let before = book;
    assert_eq!(
        book.place(Side::Bid, 60, 5, OrderKind::Limit, ALICE),
        Err(BookError::OwnerCapExceeded)
    );
    assert_eq!(
        book, before,
        "no partial fill is applied when the remainder cannot rest"
    );
}

#[test]
fn cancel_frees_owner_capacity() {
    let mut book = Book::new();
    let mut ids = Vec::new();
    for _ in 0..MAX_ORDERS_PER_OWNER {
        ids.push(limit(&mut book, Side::Bid, 10, 1, ALICE));
    }
    assert_eq!(
        book.place(Side::Bid, 10, 1, OrderKind::Limit, ALICE),
        Err(BookError::OwnerCapExceeded)
    );
    book.cancel(ids[0], &ALICE).unwrap();
    assert!(book
        .place(Side::Bid, 10, 1, OrderKind::Limit, ALICE)
        .is_ok());
}

// ---- full book (AB-10) ---------------------------------------------------------------------

fn fill_side(book: &mut Book, side: Side, price_of: impl Fn(usize) -> u8) -> Vec<u64> {
    (0..SIDE_CAPACITY)
        .map(|i| {
            limit(
                book,
                side,
                price_of(i),
                1,
                owner((i / MAX_ORDERS_PER_OWNER) as u8 + 20),
            )
        })
        .collect()
}

#[test]
fn full_bid_side_rejects_equal_or_worse_prices_and_accepts_better_displacing_the_worst() {
    let mut book = Book::new();
    // Prices 10..=41, 8 owners × 4 orders. Worst bid: price 10 (id 1).
    let ids = fill_side(&mut book, Side::Bid, |i| 10 + i as u8);
    assert_eq!(book.len(Side::Bid), SIDE_CAPACITY);
    let before = book;
    assert_eq!(
        book.place(Side::Bid, 9, 1, OrderKind::Limit, ALICE),
        Err(BookError::BookFull)
    );
    assert_eq!(
        book.place(Side::Bid, 10, 1, OrderKind::Limit, ALICE),
        Err(BookError::BookFull),
        "equal price does not beat the worst"
    );
    assert_eq!(book, before);

    let res = book
        .place(Side::Bid, 11, 1, OrderKind::Limit, ALICE)
        .unwrap();
    assert_eq!(res.cancelled.len(), 1);
    assert_eq!(res.cancelled[0].reason, CancelReason::Displaced);
    assert_eq!(res.cancelled[0].order.order_id, ids[0]);
    assert_eq!(res.cancelled[0].side, Side::Bid);
    assert!(res.rested.is_some());
    assert_eq!(book.len(Side::Bid), SIDE_CAPACITY);
    assert!(book.find(ids[0]).is_none());
    assert_eq!(book.worst(Side::Bid).unwrap().price, 11);
    // Among equal worst prices, the latest (highest seq) is displaced.
    assert_eq!(book.worst(Side::Bid).unwrap().order_id, res.order_id);
}

#[test]
fn full_ask_side_displaces_highest_price_latest_order() {
    let mut book = Book::new();
    let ids = fill_side(&mut book, Side::Ask, |i| 90 - (i / 2) as u8); // pairs at equal prices; worst = 90, latest id 2
    assert_eq!(
        book.place(Side::Ask, 90, 1, OrderKind::Limit, ALICE),
        Err(BookError::BookFull)
    );
    assert_eq!(
        book.place(Side::Ask, 91, 1, OrderKind::Limit, ALICE),
        Err(BookError::BookFull)
    );
    let res = book
        .place(Side::Ask, 89, 1, OrderKind::Limit, ALICE)
        .unwrap();
    assert_eq!(
        res.cancelled[0].order.order_id, ids[1],
        "later order at the worst price goes first"
    );
    assert_eq!(res.cancelled[0].reason, CancelReason::Displaced);
    assert_eq!(book.len(Side::Ask), SIDE_CAPACITY);
}

#[test]
fn full_book_rejection_does_not_apply_to_ioc_or_fully_filled_orders() {
    let mut book = Book::new();
    fill_side(&mut book, Side::Bid, |i| 10 + i as u8);
    // An ask that fills completely never needs a slot on the ask side; the full bid side is irrelevant to it.
    let res = book
        .place(Side::Ask, 41, 1, OrderKind::Limit, ALICE)
        .unwrap();
    assert_eq!(res.filled_qty(), 1);
    // A worse-priced IOC bid is simply cancelled, not rejected.
    let res = book.place(Side::Bid, 5, 1, OrderKind::Ioc, ALICE).unwrap();
    assert_eq!(res.cancelled[0].reason, CancelReason::IocRemainder);
}

#[test]
fn displacing_own_worst_order_keeps_owner_within_cap() {
    let mut book = Book::new();
    // Alice holds the 8 worst bids (10..=17); others fill the rest.
    for i in 0..MAX_ORDERS_PER_OWNER {
        limit(&mut book, Side::Bid, 10 + i as u8, 1, ALICE);
    }
    for i in MAX_ORDERS_PER_OWNER..SIDE_CAPACITY {
        limit(
            &mut book,
            Side::Bid,
            10 + i as u8,
            1,
            owner((i / MAX_ORDERS_PER_OWNER) as u8 + 20),
        );
    }
    let res = book
        .place(Side::Bid, 20, 1, OrderKind::Limit, ALICE)
        .unwrap();
    assert_eq!(res.cancelled[0].reason, CancelReason::Displaced);
    assert_eq!(res.cancelled[0].order.owner, ALICE);
    assert_eq!(book.owner_count(&ALICE), MAX_ORDERS_PER_OWNER);
}

#[test]
fn full_book_error_takes_precedence_over_owner_cap() {
    let mut book = Book::new();
    fill_side(&mut book, Side::Bid, |i| 10 + i as u8);
    for _ in 0..MAX_ORDERS_PER_OWNER {
        limit(&mut book, Side::Ask, 90, 1, ALICE);
    }
    assert_eq!(
        book.place(Side::Bid, 10, 1, OrderKind::Limit, ALICE),
        Err(BookError::BookFull)
    );
    assert_eq!(
        book.place(Side::Bid, 11, 1, OrderKind::Limit, ALICE),
        Err(BookError::OwnerCapExceeded)
    );
}

// ---- cancel (AB-09) ------------------------------------------------------------------------

#[test]
fn owner_cancels_and_gets_the_order_back() {
    let mut book = Book::new();
    let id = limit(&mut book, Side::Ask, 70, 4, ALICE);
    let c = book.cancel(id, &ALICE).unwrap();
    assert_eq!(c.reason, CancelReason::Requested);
    assert_eq!(c.side, Side::Ask);
    assert_eq!(
        (c.order.order_id, c.order.qty, c.order.price, c.order.owner),
        (id, 4, 70, ALICE)
    );
    assert!(book.is_empty());
    assert_eq!(
        book.cancel(id, &ALICE),
        Err(BookError::OrderNotFound),
        "cannot cancel twice"
    );
}

#[test]
fn cancel_by_non_owner_fails_and_changes_nothing() {
    let mut book = Book::new();
    let id = limit(&mut book, Side::Bid, 30, 4, ALICE);
    let before = book;
    assert_eq!(book.cancel(id, &BOB), Err(BookError::NotOwner));
    assert_eq!(book, before);
}

#[test]
fn cancel_unknown_id_fails() {
    let mut book = Book::new();
    assert_eq!(book.cancel(1, &ALICE), Err(BookError::OrderNotFound));
    assert_eq!(book.cancel(0, &ALICE), Err(BookError::OrderNotFound));
    limit(&mut book, Side::Bid, 30, 4, ALICE);
    assert_eq!(book.cancel(2, &ALICE), Err(BookError::OrderNotFound));
}

#[test]
fn cancelled_partially_filled_order_returns_remaining_qty() {
    let mut book = Book::new();
    let id = limit(&mut book, Side::Ask, 60, 10, ALICE);
    book.place(Side::Bid, 60, 4, OrderKind::Ioc, BOB).unwrap();
    let c = book.cancel(id, &ALICE).unwrap();
    assert_eq!(c.order.qty, 6);
}
