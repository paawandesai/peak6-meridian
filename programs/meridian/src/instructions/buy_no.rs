//! `buy_no` (FR-06, domain.md § The four trade paths): mint `qty` pairs, then sell the YES
//! half on the book as an ask at the YES price floor `price` (= 100 − the NO limit).
//!
//! - IOC: the YES that finds a bid is sold at once; the unsold YES is pair-redeemed with the
//!   user's NO in the same instruction, so a market Buy NO never leaves YES behind.
//! - Limit: the unfilled remainder rests as a YES ask; the user holds NO + that escrowed YES
//!   until it fills (the one allowed YES+NO state). A remainder the engine cancels (8-fill
//!   limit) is pair-redeemed like an IOC remainder.
//!
//! Net cost is `qty` USDC minus the sale proceeds. Rejected while paused, after close and
//! after settlement, like `place_order` (AB-11); one transaction, so all or nothing.

use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use super::mint_pair::mint_pairs;
use super::place_order::{ensure_tradable, execute_order, init_open_orders, OrderEnv};
use super::redeem::redeem_pairs;
use crate::errors::MeridianError;
use crate::state::{
    Book, Config, Market, OpenOrders, OrderKind, Side, BOOK_SEED, CONFIG_SEED, MARKET_SEED,
    OPEN_ORDERS_SEED,
};

#[derive(Accounts)]
pub struct BuyNo<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        mut,
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
        has_one = yes_mint,
        has_one = no_mint,
        has_one = vault,
    )]
    pub market: Box<Account<'info, Market>>,
    #[account(mut, seeds = [BOOK_SEED, market.key().as_ref()], bump)]
    pub book: AccountLoader<'info, Book>,
    /// The user buying NO; pays rent for `open_orders` on first use.
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        init_if_needed,
        payer = user,
        space = 8 + OpenOrders::INIT_SPACE,
        seeds = [OPEN_ORDERS_SEED, market.key().as_ref(), user.key().as_ref()],
        bump,
    )]
    pub open_orders: Box<Account<'info, OpenOrders>>,
    #[account(mut, token::mint = escrow_usdc.mint, token::authority = user)]
    pub user_usdc: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = yes_mint, token::authority = user)]
    pub user_yes: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = no_mint, token::authority = user)]
    pub user_no: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub yes_mint: Box<Account<'info, Mint>>,
    #[account(mut)]
    pub no_mint: Box<Account<'info, Mint>>,
    #[account(mut)]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub escrow_usdc: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub escrow_yes: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// `price` is the YES price floor in cents: 100 − the NO price the user will pay.
pub fn handle_buy_no(mut ctx: Context<BuyNo>, qty: u64, price: u8, kind: OrderKind) -> Result<()> {
    ensure_tradable(&ctx.accounts.config, &ctx.accounts.market)?;
    require!(qty > 0, MeridianError::InvalidQuantity);
    let accounts = &mut ctx.accounts;
    init_open_orders(
        &mut accounts.open_orders,
        accounts.user.key(),
        accounts.market.key(),
        ctx.bumps.open_orders,
    );

    mint_pairs(
        &accounts.token_program,
        &accounts.user,
        &accounts.user_usdc,
        &accounts.vault,
        (&accounts.yes_mint, &accounts.user_yes),
        (&accounts.no_mint, &accounts.user_no),
        &mut accounts.market,
        qty,
    )?;
    let placed = execute_order(
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
        Side::Ask,
        price,
        qty,
        kind,
    )?;

    // YES that neither sold nor rests goes back against the matching NO.
    let unsold = qty
        .checked_sub(placed.filled)
        .and_then(|rest| rest.checked_sub(placed.rested_qty))
        .ok_or(MeridianError::MathOverflow)?;
    if unsold > 0 {
        redeem_pairs(
            &accounts.token_program,
            &accounts.user,
            &accounts.user_usdc,
            (&accounts.yes_mint, &accounts.user_yes),
            (&accounts.no_mint, &accounts.user_no),
            &accounts.vault,
            &mut accounts.market,
            unsold,
        )?;
    }
    Ok(())
}
