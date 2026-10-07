//! Zero-copy order book: fixed-capacity bids and asks of one market (domain.md § Order book
//! rules). Matching itself lives in `crates/meridian-book`; this is only the on-chain layout,
//! kept byte-compatible with the engine's `Book` by the compile-time assertions at the bottom.

use anchor_lang::prelude::*;

/// PDA seed of a market's book: `["book", market]`.
pub const BOOK_SEED: &[u8] = b"book";
/// Resting orders per side.
pub const BOOK_CAPACITY: usize = 32;
/// Lowest valid order price, in cents.
pub const MIN_PRICE_CENTS: u8 = 1;
/// Highest valid order price, in cents.
pub const MAX_PRICE_CENTS: u8 = 99;
/// Smallest order, in contracts.
pub const MIN_ORDER_QTY: u64 = 1;
/// Resting orders per owner per market.
pub const MAX_RESTING_PER_OWNER: u8 = 8;
/// Fills applied by one instruction at most.
pub const MAX_FILLS_PER_INSTRUCTION: usize = 8;

/// Side of the single YES-vs-USDC book.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    /// Buys YES with USDC.
    Bid,
    /// Sells YES for USDC.
    Ask,
}

/// How an order behaves when it does not fill completely.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum OrderKind {
    /// Rests on the book.
    Limit,
    /// Immediate-or-cancel: the unfilled remainder is cancelled.
    Ioc,
}

/// One resting order. An empty slot has `qty == 0`. Byte-for-byte the layout of
/// [`meridian_book::Order`] (asserted below), so M1-05 can overlay the engine's book on the
/// account data without copying.
#[zero_copy]
#[derive(Debug, Default, PartialEq, Eq)]
pub struct BookOrder {
    /// Unique per market, assigned from `Book::next_seq`.
    pub order_id: u64,
    /// Order owner.
    pub owner: Pubkey,
    /// Limit price, cents, 1–99.
    pub price: u8,
    /// Keeps the struct free of implicit padding (bytemuck `Pod`); mirrors `Order::_pad`.
    pub _padding: [u8; 7],
    /// Remaining contracts.
    pub qty: u64,
    /// Time priority: lower fills first at the same price.
    pub seq: u64,
}

/// The order book of one market. PDA seeds: `["book", market]`.
#[account(zero_copy)]
#[derive(Debug)]
pub struct Book {
    /// Resting bids; empty slots have `qty == 0`.
    pub bids: [BookOrder; BOOK_CAPACITY],
    /// Resting asks; empty slots have `qty == 0`.
    pub asks: [BookOrder; BOOK_CAPACITY],
    /// Next order id / sequence number.
    pub next_seq: u64,
    /// The market this book belongs to.
    pub market: Pubkey,
    /// PDA bump.
    pub bump: u8,
    /// Keeps the struct free of implicit padding (bytemuck `Pod`).
    pub _padding: [u8; 7],
}

impl Book {
    /// Account size including the 8-byte discriminator.
    pub const SPACE: usize = 8 + core::mem::size_of::<Book>();
}

// Layout contract with the matching engine (D-022): the account is the engine's `Book`
// followed by `market`, `bump` and padding; every order field sits at the same offset.
const _: () = assert!(BOOK_CAPACITY == meridian_book::SIDE_CAPACITY);
const _: () = assert!(MIN_PRICE_CENTS == meridian_book::MIN_PRICE);
const _: () = assert!(MAX_PRICE_CENTS == meridian_book::MAX_PRICE);
const _: () = assert!(MIN_ORDER_QTY == meridian_book::MIN_ORDER_QTY);
const _: () = assert!(MAX_RESTING_PER_OWNER as usize == meridian_book::MAX_ORDERS_PER_OWNER);
const _: () = assert!(MAX_FILLS_PER_INSTRUCTION == meridian_book::MAX_FILLS_PER_PLACE);
const _: () =
    assert!(core::mem::size_of::<BookOrder>() == core::mem::size_of::<meridian_book::Order>());
const _: () = assert!(
    core::mem::offset_of!(BookOrder, order_id)
        == core::mem::offset_of!(meridian_book::Order, order_id)
);
const _: () = assert!(
    core::mem::offset_of!(BookOrder, owner) == core::mem::offset_of!(meridian_book::Order, owner)
);
const _: () = assert!(
    core::mem::offset_of!(BookOrder, price) == core::mem::offset_of!(meridian_book::Order, price)
);
const _: () = assert!(
    core::mem::offset_of!(BookOrder, _padding) == core::mem::offset_of!(meridian_book::Order, _pad)
);
const _: () = assert!(
    core::mem::offset_of!(BookOrder, qty) == core::mem::offset_of!(meridian_book::Order, qty)
);
const _: () = assert!(
    core::mem::offset_of!(BookOrder, seq) == core::mem::offset_of!(meridian_book::Order, seq)
);
const _: () =
    assert!(core::mem::offset_of!(Book, bids) == core::mem::offset_of!(meridian_book::Book, bids));
const _: () =
    assert!(core::mem::offset_of!(Book, asks) == core::mem::offset_of!(meridian_book::Book, asks));
const _: () = assert!(
    core::mem::offset_of!(Book, next_seq) == core::mem::offset_of!(meridian_book::Book, next_seq)
);
const _: () =
    assert!(core::mem::offset_of!(Book, market) == core::mem::size_of::<meridian_book::Book>());
