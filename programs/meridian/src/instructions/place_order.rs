//! `place_order` (FR-05, FR-12, D-029): places a YES bid or ask, limit or IOC, on the market's
//! zero-copy book and applies the matching engine's result.
//!
//! Escrow model (every token sits in one of two market-owned accounts):
//! - `escrow_usdc` = Σ resting bid notional (`price × 10,000 × qty`) + Σ `OpenOrders.free_usdc`.
//! - `escrow_yes`  = Σ resting ask qty + Σ `OpenOrders.free_yes`.
//!
//! A bid taker deposits USDC for its fills (at the makers' prices, so price improvement is never
//! charged) plus its resting remainder, and receives the filled YES at once. An ask taker
//! deposits YES for its fills plus remainder and receives the fill proceeds at once. Makers, and
//! owners whose resting orders the engine cancels (self-trade, displacement), are credited in
//! their `OpenOrders`; those accounts are passed as `remaining_accounts` (the taker's own is a
//! named account, created on first use). Amounts are checked before any token moves.
//!
//! `buy_no` and `sell_no` reuse [`execute_order`] (M1-06).
//!
//! Rejected: while paused, at or after `close_ts`, after settlement, price outside 1–99, zero
//! quantity, owner cap, full book without a better price (AB-09, AB-10, AB-11).

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::errors::MeridianError;
use crate::events::{Fill, OrderCancelled, OrderPlaced};
use crate::state::{
    Book, Config, Market, MarketStatus, OpenOrders, OrderKind, Side, BASE_UNITS_PER_CENT,
    BOOK_SEED, CONFIG_SEED, MARKET_SEED, OPEN_ORDERS_SEED,
};

#[derive(Accounts)]
pub struct PlaceOrder<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        seeds = [
            MARKET_SEED,
            &market.ticker,
            &market.trading_date.to_le_bytes(),
            &market.strike_cents.to_le_bytes(),
        ],
        bump = market.bump,
        has_one = book,
        has_one = escrow_usdc,
        has_one = escrow_yes,
    )]
    pub market: Box<Account<'info, Market>>,
    #[account(mut, seeds = [BOOK_SEED, market.key().as_ref()], bump)]
    pub book: AccountLoader<'info, Book>,
    /// The order owner; pays rent for `open_orders` on first use.
    #[account(mut)]
    pub user: Signer<'info>,
    /// The owner's balances in this market, created on first use.
    #[account(
        init_if_needed,
        payer = user,
        space = 8 + OpenOrders::INIT_SPACE,
        seeds = [OPEN_ORDERS_SEED, market.key().as_ref(), user.key().as_ref()],
        bump,
    )]
    pub open_orders: Box<Account<'info, OpenOrders>>,
    /// USDC source (bids) and destination (ask proceeds).
    #[account(
        mut,
        token::mint = escrow_usdc.mint,
        token::authority = user,
    )]
    pub user_usdc: Box<Account<'info, TokenAccount>>,
    /// YES source (asks) and destination (bid fills).
    #[account(
        mut,
        token::mint = escrow_yes.mint,
        token::authority = user,
    )]
    pub user_yes: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub escrow_usdc: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub escrow_yes: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// Balance owed to one owner by one instruction.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct Credit {
    pub owner: Pubkey,
    pub usdc: u64,
    pub yes: u64,
    /// Resting orders of the owner that left the book.
    pub released: u8,
}

/// USDC base units of `qty` contracts at `price` cents.
pub(crate) fn notional(price: u8, qty: u64) -> Result<u64> {
    qty.checked_mul(u64::from(price))
        .and_then(|cents| cents.checked_mul(BASE_UNITS_PER_CENT))
        .ok_or_else(|| MeridianError::MathOverflow.into())
}

pub(crate) fn add(a: u64, b: u64) -> Result<u64> {
    a.checked_add(b)
        .ok_or_else(|| MeridianError::MathOverflow.into())
}

/// Adds to the entry of `owner`, creating it on first use.
pub(crate) fn accrue(
    credits: &mut Vec<Credit>,
    owner: Pubkey,
    usdc: u64,
    yes: u64,
    released: u8,
) -> Result<()> {
    let index = match credits.iter().position(|c| c.owner == owner) {
        Some(index) => index,
        None => {
            credits.push(Credit {
                owner,
                ..Credit::default()
            });
            credits.len().saturating_sub(1)
        }
    };
    let entry = credits.get_mut(index).ok_or(MeridianError::MathOverflow)?;
    entry.usdc = add(entry.usdc, usdc)?;
    entry.yes = add(entry.yes, yes)?;
    entry.released = entry
        .released
        .checked_add(released)
        .ok_or(MeridianError::MathOverflow)?;
    Ok(())
}

/// Credits `credit` to `open_orders` and releases its resting-order slots.
pub(crate) fn apply_credit(open_orders: &mut OpenOrders, credit: &Credit) -> Result<()> {
    open_orders.free_usdc = add(open_orders.free_usdc, credit.usdc)?;
    open_orders.free_yes = add(open_orders.free_yes, credit.yes)?;
    open_orders.resting_count = open_orders
        .resting_count
        .checked_sub(credit.released)
        .ok_or(MeridianError::MathOverflow)?;
    Ok(())
}

/// Credits another owner's `OpenOrders`, found among `remaining` by owner and verified to be
/// the program-owned PDA of that owner in this market (AB-09: no one can redirect a credit).
fn credit_other(remaining: &[AccountInfo], market: &Pubkey, credit: &Credit) -> Result<()> {
    for info in remaining {
        if info.owner != &crate::ID {
            continue;
        }
        let Ok(mut open_orders) = OpenOrders::try_deserialize(&mut &info.try_borrow_data()?[..])
        else {
            continue;
        };
        if open_orders.owner != credit.owner || open_orders.market != *market {
            continue;
        }
        let expected = Pubkey::create_program_address(
            &[
                OPEN_ORDERS_SEED,
                market.as_ref(),
                credit.owner.as_ref(),
                &[open_orders.bump],
            ],
            &crate::ID,
        )
        .map_err(|_| error!(MeridianError::NotOrderOwner))?;
        require_keys_eq!(info.key(), expected, MeridianError::NotOrderOwner);
        require!(info.is_writable, ErrorCode::AccountNotMutable);
        apply_credit(&mut open_orders, credit)?;
        let mut data = info.try_borrow_mut_data()?;
        return open_orders.try_serialize(&mut &mut data[..]);
    }
    Err(ErrorCode::AccountNotEnoughKeys.into())
}

/// Applies every credit: the signer's own to `own`, the rest to `remaining`.
pub(crate) fn apply_credits(
    credits: &[Credit],
    own: &mut OpenOrders,
    remaining: &[AccountInfo],
    market: &Pubkey,
) -> Result<()> {
    for credit in credits {
        if credit.owner == own.owner {
            apply_credit(own, credit)?;
        } else {
            credit_other(remaining, market, credit)?;
        }
    }
    Ok(())
}

pub(crate) fn engine_side(side: Side) -> meridian_book::Side {
    match side {
        Side::Bid => meridian_book::Side::Bid,
        Side::Ask => meridian_book::Side::Ask,
    }
}

pub(crate) fn program_side(side: meridian_book::Side) -> Side {
    match side {
        meridian_book::Side::Bid => Side::Bid,
        meridian_book::Side::Ask => Side::Ask,
    }
}

pub(crate) fn engine_error(error: meridian_book::BookError) -> Error {
    use meridian_book::BookError;
    match error {
        BookError::InvalidPrice => MeridianError::InvalidPrice,
        BookError::InvalidQty => MeridianError::InvalidQuantity,
        BookError::OwnerCapExceeded => MeridianError::TooManyRestingOrders,
        BookError::BookFull => MeridianError::BookFull,
        BookError::OrderNotFound => MeridianError::OrderNotFound,
        BookError::NotOwner => MeridianError::NotOrderOwner,
        BookError::SeqOverflow => MeridianError::MathOverflow,
    }
    .into()
}

// The engine's `Book` is the leading prefix of the account (asserted field by field in
// `state/book.rs`); these make the overlay below sound.
const _: () = assert!(core::mem::size_of::<meridian_book::Book>() <= core::mem::size_of::<Book>());
const _: () =
    assert!(core::mem::align_of::<meridian_book::Book>() == core::mem::align_of::<Book>());

/// Views the zero-copy account as the matching engine's book, without copying.
pub(crate) fn engine_book(book: &mut Book) -> &mut meridian_book::Book {
    // SAFETY: `Book` is `#[repr(C)]` and starts with the same fields at the same offsets as
    // `meridian_book::Book` (compile-time assertions in `state/book.rs` and above); both have
    // the same alignment, every bit pattern is valid for the engine's integer/byte-array
    // fields, and the exclusive borrow of `book` is carried over to the returned reference.
    #[allow(unsafe_code)]
    unsafe {
        &mut *(book as *mut Book).cast::<meridian_book::Book>()
    }
}

/// Rejects new orders while paused, after settlement and at or after `close_ts` (AB-11).
pub(crate) fn ensure_tradable(config: &Config, market: &Market) -> Result<()> {
    require!(!config.paused, MeridianError::Paused);
    require!(
        market.status == MarketStatus::Open,
        MeridianError::AlreadySettled
    );
    let now = Clock::get()?.unix_timestamp;
    require!(now < market.close_ts, MeridianError::MarketClosed);
    Ok(())
}

/// Fills in a freshly created `OpenOrders` (its owner is still the default key).
pub(crate) fn init_open_orders(
    open_orders: &mut OpenOrders,
    owner: Pubkey,
    market: Pubkey,
    bump: u8,
) {
    if open_orders.owner == Pubkey::default() {
        open_orders.owner = owner;
        open_orders.market = market;
        open_orders.bump = bump;
    }
}

/// Everything an order needs; shared by `place_order`, `buy_no` and `sell_no`.
pub(crate) struct OrderEnv<'a, 'info, 'r> {
    pub market: &'a Account<'info, Market>,
    pub book: &'a AccountLoader<'info, Book>,
    pub user: &'a Signer<'info>,
    pub open_orders: &'a mut Account<'info, OpenOrders>,
    pub user_usdc: &'a Account<'info, TokenAccount>,
    pub user_yes: &'a Account<'info, TokenAccount>,
    pub escrow_usdc: &'a Account<'info, TokenAccount>,
    pub escrow_yes: &'a Account<'info, TokenAccount>,
    pub token_program: &'a Program<'info, Token>,
    pub remaining: &'a [AccountInfo<'r>],
}

/// What an order did to the taker.
pub(crate) struct Placed {
    /// Contracts matched against resting orders.
    pub filled: u64,
    /// Contracts left resting on the book.
    pub rested_qty: u64,
}

pub fn handle_place_order(
    mut ctx: Context<PlaceOrder>,
    side: Side,
    price: u8,
    qty: u64,
    kind: OrderKind,
) -> Result<()> {
    ensure_tradable(&ctx.accounts.config, &ctx.accounts.market)?;
    let accounts = &mut ctx.accounts;
    init_open_orders(
        &mut accounts.open_orders,
        accounts.user.key(),
        accounts.market.key(),
        ctx.bumps.open_orders,
    );
    execute_order(
        OrderEnv {
            market: &accounts.market,
            book: &accounts.book,
            user: &accounts.user,
            open_orders: &mut accounts.open_orders,
            user_usdc: &accounts.user_usdc,
            user_yes: &accounts.user_yes,
            escrow_usdc: &accounts.escrow_usdc,
            escrow_yes: &accounts.escrow_yes,
            token_program: &accounts.token_program,
            remaining: ctx.remaining_accounts,
        },
        side,
        price,
        qty,
        kind,
    )?;
    Ok(())
}

/// Matches, escrows, pays and credits one order (see the module docs). The caller has already
/// checked [`ensure_tradable`] and initialised the taker's `OpenOrders`.
pub(crate) fn execute_order(
    env: OrderEnv<'_, '_, '_>,
    side: Side,
    price: u8,
    qty: u64,
    kind: OrderKind,
) -> Result<Placed> {
    let OrderEnv {
        market,
        book,
        user,
        open_orders,
        user_usdc,
        user_yes,
        escrow_usdc,
        escrow_yes,
        token_program,
        remaining,
    } = env;
    let user_key = user.key();
    let market_key = market.key();

    let engine_kind = match kind {
        OrderKind::Limit => meridian_book::OrderKind::Limit,
        OrderKind::Ioc => meridian_book::OrderKind::Ioc,
    };
    let engine_side = engine_side(side);
    let (result, consumed) = {
        let mut guard = book.load_mut()?;
        let engine = engine_book(&mut guard);
        let result = engine
            .place(engine_side, price, qty, engine_kind, user_key.to_bytes())
            .map_err(engine_error)?;
        let consumed: Vec<bool> = result
            .fills
            .iter()
            .map(|fill| engine.find(fill.maker_order_id).is_none())
            .collect();
        (result, consumed)
    };

    // Fund movements and credits implied by the result.
    let rested_qty = result.rested.map_or(0, |order| order.qty);
    let mut credits: Vec<Credit> = Vec::new();
    let mut fill_notional = 0u64;
    let mut filled = 0u64;
    for (fill, maker_gone) in result.fills.iter().zip(consumed) {
        let value = notional(fill.price, fill.qty)?;
        fill_notional = add(fill_notional, value)?;
        filled = add(filled, fill.qty)?;
        let released = u8::from(maker_gone);
        let (usdc, yes) = match side {
            Side::Bid => (value, 0),
            Side::Ask => (0, fill.qty),
        };
        accrue(
            &mut credits,
            Pubkey::new_from_array(fill.maker),
            usdc,
            yes,
            released,
        )?;
    }
    for cancelled in &result.cancelled {
        // The taker's own unfilled remainder was never escrowed.
        if cancelled.order.order_id == result.order_id {
            continue;
        }
        let (usdc, yes) = match cancelled.side {
            meridian_book::Side::Bid => (notional(cancelled.order.price, cancelled.order.qty)?, 0),
            meridian_book::Side::Ask => (0, cancelled.order.qty),
        };
        accrue(
            &mut credits,
            Pubkey::new_from_array(cancelled.order.owner),
            usdc,
            yes,
            1,
        )?;
    }
    let rested_notional = match result.rested {
        Some(order) => notional(order.price, order.qty)?,
        None => 0,
    };
    let (deposit, deposit_from, deposit_to, payout, payout_from, payout_to) = match side {
        Side::Bid => (
            add(fill_notional, rested_notional)?,
            user_usdc,
            escrow_usdc,
            filled,
            escrow_yes,
            user_yes,
        ),
        Side::Ask => (
            add(filled, rested_qty)?,
            user_yes,
            escrow_yes,
            fill_notional,
            escrow_usdc,
            user_usdc,
        ),
    };

    if deposit > 0 {
        token::transfer(
            CpiContext::new(
                token_program.to_account_info(),
                Transfer {
                    from: deposit_from.to_account_info(),
                    to: deposit_to.to_account_info(),
                    authority: user.to_account_info(),
                },
            ),
            deposit,
        )?;
    }
    if payout > 0 {
        let signer_seeds: &[&[&[u8]]] = &[&[
            MARKET_SEED,
            &market.ticker,
            &market.trading_date.to_le_bytes(),
            &market.strike_cents.to_le_bytes(),
            &[market.bump],
        ]];
        token::transfer(
            CpiContext::new_with_signer(
                token_program.to_account_info(),
                Transfer {
                    from: payout_from.to_account_info(),
                    to: payout_to.to_account_info(),
                    authority: market.to_account_info(),
                },
                signer_seeds,
            ),
            payout,
        )?;
    }

    {
        if result.rested.is_some() {
            open_orders.resting_count = open_orders
                .resting_count
                .checked_add(1)
                .ok_or(MeridianError::MathOverflow)?;
        }
        apply_credits(&credits, open_orders, remaining, &market_key)?;
    }

    emit!(OrderPlaced {
        market: market_key,
        owner: user_key,
        order_id: result.order_id,
        side,
        price,
        qty,
        rested_qty,
    });
    for fill in &result.fills {
        emit!(Fill {
            market: market_key,
            maker: Pubkey::new_from_array(fill.maker),
            taker: user_key,
            price: fill.price,
            qty: fill.qty,
            taker_side: program_side(fill.taker_side),
        });
    }
    for cancelled in &result.cancelled {
        emit!(OrderCancelled {
            market: market_key,
            owner: Pubkey::new_from_array(cancelled.order.owner),
            order_id: cancelled.order.order_id,
            qty: cancelled.order.qty,
        });
    }
    Ok(Placed { filled, rested_qty })
}
