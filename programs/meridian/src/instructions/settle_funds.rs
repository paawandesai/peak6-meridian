//! `settle_funds` (FR-05, FR-12, D-029): the owner withdraws their whole free balance from the
//! market escrows to their own token accounts. Works while paused, after close and after
//! settlement. Only the owner can withdraw (AB-09): the `OpenOrders` PDA is derived from its
//! stored owner, which must be the signer, and the destination accounts must belong to the
//! signer.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::errors::MeridianError;
use crate::events::FundsSettled;
use crate::state::{Market, OpenOrders, MARKET_SEED, OPEN_ORDERS_SEED};

#[derive(Accounts)]
pub struct SettleFunds<'info> {
    #[account(
        seeds = [
            MARKET_SEED,
            &market.ticker,
            &market.trading_date.to_le_bytes(),
            &market.strike_cents.to_le_bytes(),
        ],
        bump = market.bump,
        has_one = escrow_usdc,
        has_one = escrow_yes,
    )]
    pub market: Box<Account<'info, Market>>,
    /// The open orders owner.
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [OPEN_ORDERS_SEED, market.key().as_ref(), open_orders.owner.as_ref()],
        bump = open_orders.bump,
        constraint = open_orders.owner == owner.key() @ MeridianError::NotOrderOwner,
        constraint = open_orders.market == market.key() @ MeridianError::NotOrderOwner,
    )]
    pub open_orders: Box<Account<'info, OpenOrders>>,
    #[account(mut)]
    pub escrow_usdc: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub escrow_yes: Box<Account<'info, TokenAccount>>,
    /// Receives the free USDC.
    #[account(mut, token::mint = escrow_usdc.mint, token::authority = owner)]
    pub user_usdc: Box<Account<'info, TokenAccount>>,
    /// Receives the free YES.
    #[account(mut, token::mint = escrow_yes.mint, token::authority = owner)]
    pub user_yes: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

pub fn handle_settle_funds(ctx: Context<SettleFunds>) -> Result<()> {
    let usdc = ctx.accounts.open_orders.free_usdc;
    let yes = ctx.accounts.open_orders.free_yes;

    // Zero the balances before any transfer; a failed transfer reverts the transaction.
    let open_orders = &mut ctx.accounts.open_orders;
    open_orders.free_usdc = 0;
    open_orders.free_yes = 0;

    let market = &ctx.accounts.market;
    let signer_seeds: &[&[&[u8]]] = &[&[
        MARKET_SEED,
        &market.ticker,
        &market.trading_date.to_le_bytes(),
        &market.strike_cents.to_le_bytes(),
        &[market.bump],
    ]];
    for (amount, from, to) in [
        (usdc, &ctx.accounts.escrow_usdc, &ctx.accounts.user_usdc),
        (yes, &ctx.accounts.escrow_yes, &ctx.accounts.user_yes),
    ] {
        if amount == 0 {
            continue;
        }
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: from.to_account_info(),
                    to: to.to_account_info(),
                    authority: market.to_account_info(),
                },
                signer_seeds,
            ),
            amount,
        )?;
    }

    emit!(FundsSettled {
        market: market.key(),
        owner: ctx.accounts.owner.key(),
        usdc,
        yes,
    });
    Ok(())
}
