//! `cancel_order` (FR-05, D-029): the owner removes one of their resting orders. The escrow
//! stays where it is; the order's notional (bid) or quantity (ask) becomes a free balance in
//! the owner's `OpenOrders`, withdrawn with `settle_funds`. Never blocked by pause, close or
//! settlement (domain.md § Market lifecycle). Another owner's order, an unknown id and an
//! already-filled id all fail and leave the book untouched (AB-09).

use anchor_lang::prelude::*;

use crate::errors::MeridianError;
use crate::events::OrderCancelled;
use crate::instructions::place_order::{accrue, apply_credit, engine_book, engine_error, notional};
use crate::state::{Book, Market, OpenOrders, BOOK_SEED, MARKET_SEED, OPEN_ORDERS_SEED};

#[derive(Accounts)]
pub struct CancelOrder<'info> {
    #[account(
        seeds = [
            MARKET_SEED,
            &market.ticker,
            &market.trading_date.to_le_bytes(),
            &market.strike_cents.to_le_bytes(),
        ],
        bump = market.bump,
        has_one = book,
    )]
    pub market: Box<Account<'info, Market>>,
    #[account(mut, seeds = [BOOK_SEED, market.key().as_ref()], bump)]
    pub book: AccountLoader<'info, Book>,
    /// The order owner.
    pub owner: Signer<'info>,
    /// Receives the refund. Its PDA seeds name its stored owner, which must be the signer.
    #[account(
        mut,
        seeds = [OPEN_ORDERS_SEED, market.key().as_ref(), open_orders.owner.as_ref()],
        bump = open_orders.bump,
        constraint = open_orders.owner == owner.key() @ MeridianError::NotOrderOwner,
        constraint = open_orders.market == market.key() @ MeridianError::NotOrderOwner,
    )]
    pub open_orders: Box<Account<'info, OpenOrders>>,
}

pub fn handle_cancel_order(ctx: Context<CancelOrder>, order_id: u64) -> Result<()> {
    let owner = ctx.accounts.owner.key();
    let cancelled = {
        let mut guard = ctx.accounts.book.load_mut()?;
        engine_book(&mut guard)
            .cancel(order_id, &owner.to_bytes())
            .map_err(engine_error)?
    };

    let (usdc, yes) = match cancelled.side {
        meridian_book::Side::Bid => (notional(cancelled.order.price, cancelled.order.qty)?, 0),
        meridian_book::Side::Ask => (0, cancelled.order.qty),
    };
    let mut credits = Vec::new();
    accrue(&mut credits, owner, usdc, yes, 1)?;
    for credit in &credits {
        apply_credit(&mut ctx.accounts.open_orders, credit)?;
    }

    emit!(OrderCancelled {
        market: ctx.accounts.market.key(),
        owner,
        order_id,
        qty: cancelled.order.qty,
    });
    Ok(())
}
