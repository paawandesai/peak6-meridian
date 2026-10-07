//! The order book and its matching rules (domain.md § Order book rules).
//!
//! Layout: every side is a fixed array of [`SIDE_CAPACITY`] slots; a slot with `qty == 0` is
//! empty. Slots are not kept sorted: priority is computed on every lookup (price first, then the
//! lower `seq`), which keeps mutations to single-slot writes. All types are `#[repr(C)]` with no
//! implicit padding so the program can store the book in a zero-copy account unchanged.
//!
//! Every operation either returns `Err` and leaves the book untouched, or applies all of its
//! effects. No arithmetic can overflow or panic: quantities only ever decrease, except the
//! sequence counter, which uses checked addition.

use core::fmt;

/// Resting orders per side.
pub const SIDE_CAPACITY: usize = 32;
/// Lowest valid price, in cents.
pub const MIN_PRICE: u8 = 1;
/// Highest valid price, in cents.
pub const MAX_PRICE: u8 = 99;
/// Minimum order size, in contracts.
pub const MIN_ORDER_QTY: u64 = 1;
/// Maximum resting orders per owner per book (both sides together).
pub const MAX_ORDERS_PER_OWNER: usize = 8;
/// Maximum fills produced by one `place` call.
pub const MAX_FILLS_PER_PLACE: usize = 8;

/// Owner of an order: the 32 bytes of a public key. The engine treats it as an opaque identity.
pub type Owner = [u8; 32];

/// Book side. Bids buy YES with USDC, asks sell YES for USDC.
#[repr(u8)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Side {
    Bid = 0,
    Ask = 1,
}

impl Side {
    /// The side a taker on `self` matches against.
    pub fn opposite(self) -> Side {
        match self {
            Side::Bid => Side::Ask,
            Side::Ask => Side::Bid,
        }
    }
}

/// How an order behaves once matching is done.
#[repr(u8)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum OrderKind {
    /// Any unfilled remainder rests on the book.
    Limit = 0,
    /// Immediate-or-cancel: any unfilled remainder is cancelled. The price is the worst
    /// acceptable price.
    Ioc = 1,
}

/// A resting order. `order_id` and `seq` are both the value of the book's sequence counter when
/// the order was placed; `seq` is the time-priority key, `order_id` the handle used to cancel.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct Order {
    pub order_id: u64,
    pub owner: Owner,
    pub price: u8,
    /// Explicit padding so the struct has no implicit padding bytes (zero-copy friendly).
    pub _pad: [u8; 7],
    pub qty: u64,
    pub seq: u64,
}

impl Order {
    /// The empty slot marker.
    pub const EMPTY: Order = Order {
        order_id: 0,
        owner: [0; 32],
        price: 0,
        _pad: [0; 7],
        qty: 0,
        seq: 0,
    };

    /// `true` when this slot holds no order.
    pub fn is_empty(&self) -> bool {
        self.qty == 0
    }
}

/// One match between a taker order and a resting maker order, at the maker's price.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Fill {
    pub maker_order_id: u64,
    pub maker: Owner,
    pub taker_order_id: u64,
    pub taker: Owner,
    /// Maker's price, in cents.
    pub price: u8,
    pub qty: u64,
    pub taker_side: Side,
}

/// Why an order (or the remainder of one) left the book without filling.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum CancelReason {
    /// The owner cancelled it with [`Book::cancel`].
    Requested,
    /// A resting order of the taker's own that the new order would have traded against.
    SelfTrade,
    /// The worst resting order of a full side, replaced by a better-priced new order.
    Displaced,
    /// Unfilled remainder of an IOC order.
    IocRemainder,
    /// Unfilled remainder of a limit order that would still cross after
    /// [`MAX_FILLS_PER_PLACE`] fills; resting it would leave the book crossed.
    FillLimit,
}

/// An order (or remainder) removed from the book. The program refunds `order.qty` at
/// `order.price` on `side` to `order.owner`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Cancelled {
    pub side: Side,
    pub order: Order,
    pub reason: CancelReason,
}

/// Outcome of a successful [`Book::place`].
///
/// Quantity is conserved: `fills` + `rested` + the taker's own entry in `cancelled` (if any)
/// equals the placed quantity. Other `cancelled` entries belong to resting orders that were
/// removed (self-trade or displacement).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PlaceResult {
    /// Sequence number assigned to the new order; also its `order_id` if it rests.
    pub order_id: u64,
    pub fills: Vec<Fill>,
    pub rested: Option<Order>,
    pub cancelled: Vec<Cancelled>,
}

impl PlaceResult {
    /// Total quantity filled by this call.
    pub fn filled_qty(&self) -> u64 {
        self.fills
            .iter()
            .fold(0u64, |acc, f| acc.saturating_add(f.qty))
    }
}

/// One variant per rule the engine enforces. The program maps these to `MeridianError`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum BookError {
    /// Price outside 1–99 cents.
    InvalidPrice,
    /// Quantity below the minimum order size.
    InvalidQty,
    /// The owner already has the maximum number of resting orders.
    OwnerCapExceeded,
    /// The side is full and the new order does not beat its worst resting order.
    BookFull,
    /// No resting order has this id.
    OrderNotFound,
    /// The order exists but belongs to someone else.
    NotOwner,
    /// The sequence counter is exhausted.
    SeqOverflow,
}

impl fmt::Display for BookError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let msg = match self {
            BookError::InvalidPrice => "price must be between 1 and 99 cents",
            BookError::InvalidQty => "quantity must be at least the minimum order size",
            BookError::OwnerCapExceeded => "owner already has the maximum number of resting orders",
            BookError::BookFull => "side is full and the order does not beat its worst order",
            BookError::OrderNotFound => "no resting order with this id",
            BookError::NotOwner => "order belongs to another owner",
            BookError::SeqOverflow => "sequence counter exhausted",
        };
        f.write_str(msg)
    }
}

impl std::error::Error for BookError {}

/// A fixed-capacity order book for one market.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Book {
    pub bids: [Order; SIDE_CAPACITY],
    pub asks: [Order; SIDE_CAPACITY],
    /// Next sequence number / order id. Starts at 1 so that 0 never names an order.
    pub next_seq: u64,
}

const _: () = assert!(core::mem::size_of::<Order>() == 64);
const _: () = assert!(core::mem::size_of::<Book>() == 2 * SIDE_CAPACITY * 64 + 8);

impl Default for Book {
    fn default() -> Self {
        Self::new()
    }
}

/// Matching plan computed without mutating the book; applied only if every rule passes.
struct Plan {
    seq: u64,
    /// Opposite-side slots fully consumed (filled completely or self-trade cancelled).
    consumed: [bool; SIDE_CAPACITY],
    /// Opposite-side slot filled partially (only the last fill can be partial) and its fill qty.
    partial: Option<(usize, u64)>,
    fills: Vec<Fill>,
    cancelled: Vec<Cancelled>,
    /// Where the remainder rests: slot index on the taker's side, and the order to write.
    rest: Option<(usize, Order)>,
}

impl Book {
    /// An empty book.
    pub fn new() -> Self {
        Book {
            bids: [Order::EMPTY; SIDE_CAPACITY],
            asks: [Order::EMPTY; SIDE_CAPACITY],
            next_seq: 1,
        }
    }

    /// The slots of one side, including empty ones.
    pub fn side(&self, side: Side) -> &[Order; SIDE_CAPACITY] {
        match side {
            Side::Bid => &self.bids,
            Side::Ask => &self.asks,
        }
    }

    fn side_mut(&mut self, side: Side) -> &mut [Order; SIDE_CAPACITY] {
        match side {
            Side::Bid => &mut self.bids,
            Side::Ask => &mut self.asks,
        }
    }

    /// Resting orders of one side, in no particular order.
    pub fn orders(&self, side: Side) -> impl Iterator<Item = &Order> {
        self.side(side).iter().filter(|o| !o.is_empty())
    }

    /// Resting orders of one side in priority order (best price first, then earliest `seq`).
    pub fn sorted_orders(&self, side: Side) -> Vec<Order> {
        let mut orders: Vec<Order> = self.orders(side).copied().collect();
        orders.sort_by(|a, b| priority_cmp(side, a, b));
        orders
    }

    /// Number of resting orders on one side.
    pub fn len(&self, side: Side) -> usize {
        self.orders(side).count()
    }

    /// `true` when neither side has a resting order.
    pub fn is_empty(&self) -> bool {
        self.len(Side::Bid) == 0 && self.len(Side::Ask) == 0
    }

    /// Resting orders of `owner` across both sides.
    pub fn owner_count(&self, owner: &Owner) -> usize {
        self.orders(Side::Bid)
            .chain(self.orders(Side::Ask))
            .filter(|o| &o.owner == owner)
            .count()
    }

    /// Highest-priority resting order on a side.
    pub fn best(&self, side: Side) -> Option<&Order> {
        self.orders(side).min_by(|a, b| priority_cmp(side, a, b))
    }

    /// Lowest-priority resting order on a side (the one displaced when the side is full).
    pub fn worst(&self, side: Side) -> Option<&Order> {
        self.orders(side).max_by(|a, b| priority_cmp(side, a, b))
    }

    /// Best bid price, if any bid rests.
    pub fn best_bid(&self) -> Option<u8> {
        self.best(Side::Bid).map(|o| o.price)
    }

    /// Best ask price, if any ask rests.
    pub fn best_ask(&self) -> Option<u8> {
        self.best(Side::Ask).map(|o| o.price)
    }

    /// Find a resting order by id, with its side.
    pub fn find(&self, order_id: u64) -> Option<(Side, &Order)> {
        self.orders(Side::Bid)
            .map(|o| (Side::Bid, o))
            .chain(self.orders(Side::Ask).map(|o| (Side::Ask, o)))
            .find(|(_, o)| o.order_id == order_id)
    }

    /// Place a new order for `owner`: match against the opposite side with price-time priority,
    /// then rest, cancel or reject the remainder according to `kind` and the book rules.
    ///
    /// Rules (domain.md § Order book rules):
    /// - `price` in 1–99 and `qty ≥ 1`, else `InvalidPrice` / `InvalidQty`.
    /// - A resting order of the same owner that would be hit is cancelled (`SelfTrade`) instead.
    /// - At most [`MAX_FILLS_PER_PLACE`] fills; a limit remainder that would still cross is
    ///   cancelled (`FillLimit`) so the book never crosses. An IOC remainder is cancelled.
    /// - A limit remainder rests only if the owner has fewer than [`MAX_ORDERS_PER_OWNER`]
    ///   resting orders after this call's cancellations (`OwnerCapExceeded` otherwise), and, when
    ///   the side is full, only if it strictly beats the worst resting order, which is then
    ///   cancelled (`Displaced`); otherwise `BookFull`.
    ///
    /// On `Err` the book is unchanged.
    pub fn place(
        &mut self,
        side: Side,
        price: u8,
        qty: u64,
        kind: OrderKind,
        owner: Owner,
    ) -> Result<PlaceResult, BookError> {
        let plan = self.plan(side, price, qty, kind, owner)?;
        Ok(self.apply(side, plan))
    }

    fn plan(
        &self,
        side: Side,
        price: u8,
        qty: u64,
        kind: OrderKind,
        owner: Owner,
    ) -> Result<Plan, BookError> {
        if !(MIN_PRICE..=MAX_PRICE).contains(&price) {
            return Err(BookError::InvalidPrice);
        }
        if qty < MIN_ORDER_QTY {
            return Err(BookError::InvalidQty);
        }
        let seq = self.next_seq;
        seq.checked_add(1).ok_or(BookError::SeqOverflow)?;

        let opposite = self.side(side.opposite());
        let mut plan = Plan {
            seq,
            consumed: [false; SIDE_CAPACITY],
            partial: None,
            fills: Vec::new(),
            cancelled: Vec::new(),
            rest: None,
        };
        let mut remaining = qty;
        let mut fill_limit_hit = false;

        while remaining > 0 {
            let Some((idx, maker)) = best_crossing(side, price, opposite, &plan.consumed) else {
                break;
            };
            if maker.owner == owner {
                plan.consumed = mark(plan.consumed, idx);
                plan.cancelled.push(Cancelled {
                    side: side.opposite(),
                    order: *maker,
                    reason: CancelReason::SelfTrade,
                });
                continue;
            }
            if plan.fills.len() >= MAX_FILLS_PER_PLACE {
                fill_limit_hit = true;
                break;
            }
            let fill_qty = remaining.min(maker.qty);
            // `fill_qty <= remaining`, so this cannot underflow.
            remaining = remaining.saturating_sub(fill_qty);
            if fill_qty == maker.qty {
                plan.consumed = mark(plan.consumed, idx);
            } else {
                plan.partial = Some((idx, fill_qty));
            }
            plan.fills.push(Fill {
                maker_order_id: maker.order_id,
                maker: maker.owner,
                taker_order_id: seq,
                taker: owner,
                price: maker.price,
                qty: fill_qty,
                taker_side: side,
            });
        }

        if remaining == 0 {
            return Ok(plan);
        }
        let remainder = Order {
            order_id: seq,
            owner,
            price,
            _pad: [0; 7],
            qty: remaining,
            seq,
        };
        let reason = match kind {
            OrderKind::Ioc => Some(CancelReason::IocRemainder),
            OrderKind::Limit if fill_limit_hit => Some(CancelReason::FillLimit),
            OrderKind::Limit => None,
        };
        if let Some(reason) = reason {
            plan.cancelled.push(Cancelled {
                side,
                order: remainder,
                reason,
            });
            return Ok(plan);
        }

        // Rest the remainder: find a slot, displacing the worst order on a full side.
        let own = self.side(side);
        let slot = match own.iter().position(Order::is_empty) {
            Some(free) => free,
            None => {
                let (worst_idx, worst) = own
                    .iter()
                    .enumerate()
                    .max_by(|(_, a), (_, b)| priority_cmp(side, a, b))
                    .ok_or(BookError::BookFull)?;
                if !beats(side, price, worst.price) {
                    return Err(BookError::BookFull);
                }
                plan.cancelled.push(Cancelled {
                    side,
                    order: *worst,
                    reason: CancelReason::Displaced,
                });
                worst_idx
            }
        };
        let owner_cancelled = plan
            .cancelled
            .iter()
            .filter(|c| c.order.owner == owner && c.order.order_id != seq)
            .count();
        let owner_after = self.owner_count(&owner).saturating_sub(owner_cancelled);
        if owner_after >= MAX_ORDERS_PER_OWNER {
            return Err(BookError::OwnerCapExceeded);
        }
        plan.rest = Some((slot, remainder));
        Ok(plan)
    }

    fn apply(&mut self, side: Side, plan: Plan) -> PlaceResult {
        // The plan was validated against this exact state; `next_seq + 1` was checked in `plan`.
        self.next_seq = plan.seq.saturating_add(1);
        {
            let opposite = self.side_mut(side.opposite());
            for (slot, consumed) in opposite.iter_mut().zip(plan.consumed.iter()) {
                if *consumed {
                    *slot = Order::EMPTY;
                }
            }
            if let Some((idx, fill_qty)) = plan.partial {
                if let Some(slot) = opposite.get_mut(idx) {
                    slot.qty = slot.qty.saturating_sub(fill_qty);
                }
            }
        }
        if let Some((idx, order)) = plan.rest {
            if let Some(slot) = self.side_mut(side).get_mut(idx) {
                *slot = order;
            }
        }
        PlaceResult {
            order_id: plan.seq,
            fills: plan.fills,
            rested: plan.rest.map(|(_, order)| order),
            cancelled: plan.cancelled,
        }
    }

    /// Cancel the resting order `order_id`. Only its owner may cancel it (AB-09).
    ///
    /// Returns the removed order so the program can refund its escrow. On `Err` the book is
    /// unchanged.
    pub fn cancel(&mut self, order_id: u64, owner: &Owner) -> Result<Cancelled, BookError> {
        let (side, order) = self
            .find(order_id)
            .map(|(s, o)| (s, *o))
            .ok_or(BookError::OrderNotFound)?;
        if &order.owner != owner {
            return Err(BookError::NotOwner);
        }
        if let Some(slot) = self
            .side_mut(side)
            .iter_mut()
            .find(|o| o.order_id == order_id && !o.is_empty())
        {
            *slot = Order::EMPTY;
        }
        Ok(Cancelled {
            side,
            order,
            reason: CancelReason::Requested,
        })
    }
}

/// Priority order on one side: `Less` means `a` has priority over `b`.
fn priority_cmp(side: Side, a: &Order, b: &Order) -> core::cmp::Ordering {
    let by_price = match side {
        Side::Bid => b.price.cmp(&a.price),
        Side::Ask => a.price.cmp(&b.price),
    };
    by_price.then(a.seq.cmp(&b.seq))
}

/// Does a taker on `side` at `taker_price` cross a resting opposite order at `maker_price`?
fn crosses(side: Side, taker_price: u8, maker_price: u8) -> bool {
    match side {
        Side::Bid => maker_price <= taker_price,
        Side::Ask => maker_price >= taker_price,
    }
}

/// Does a new order on `side` at `price` strictly beat a resting order at `resting_price`?
fn beats(side: Side, price: u8, resting_price: u8) -> bool {
    match side {
        Side::Bid => price > resting_price,
        Side::Ask => price < resting_price,
    }
}

/// Best-priority opposite order that crosses `price` and is not already consumed by this plan.
fn best_crossing<'a>(
    side: Side,
    price: u8,
    opposite: &'a [Order; SIDE_CAPACITY],
    consumed: &[bool; SIDE_CAPACITY],
) -> Option<(usize, &'a Order)> {
    opposite
        .iter()
        .enumerate()
        .zip(consumed.iter())
        .filter(|((_, o), used)| !**used && !o.is_empty() && crosses(side, price, o.price))
        .map(|(entry, _)| entry)
        .min_by(|(_, a), (_, b)| priority_cmp(side.opposite(), a, b))
}

fn mark(mut consumed: [bool; SIDE_CAPACITY], idx: usize) -> [bool; SIDE_CAPACITY] {
    if let Some(flag) = consumed.get_mut(idx) {
        *flag = true;
    }
    consumed
}
