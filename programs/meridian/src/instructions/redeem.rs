//! `redeem` (FR-10, D-011). Pair mode (this ticket, M1-04): before settlement the user burns
//! `n` YES + `n` NO of the same market and receives `n` USDC from the vault; works at any time,
//! including while paused and after close (AB-11). Winner mode (after settlement) arrives with
//! M1-07 and returns `NotImplemented` until then.
//!
//! The vault only pays against burned tokens, which only the market PDA can mint (AB-01), so
//! vault = 1,000,000 × pairs outstanding holds after every call (invariant 1). Amounts use
//! checked arithmetic before any token movement (AB-12).

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, Token, TokenAccount, Transfer};

use crate::errors::MeridianError;
use crate::events::Redeemed;
use crate::state::{Market, MarketStatus, MARKET_SEED, PAIR_COLLATERAL};

#[derive(Accounts)]
pub struct Redeem<'info> {
    #[account(
        mut,
        seeds = [
            MARKET_SEED,
            &market.ticker,
            &market.trading_date.to_le_bytes(),
            &market.strike_cents.to_le_bytes(),
        ],
        bump = market.bump,
        has_one = yes_mint,
        has_one = no_mint,
        has_one = vault,
    )]
    pub market: Box<Account<'info, Market>>,
    /// The user redeeming.
    pub user: Signer<'info>,
    /// Receives the USDC.
    #[account(mut, token::mint = vault.mint)]
    pub user_usdc: Box<Account<'info, TokenAccount>>,
    /// The user's YES account; the token program checks `user` may burn from it.
    #[account(mut, token::mint = yes_mint)]
    pub user_yes: Box<Account<'info, TokenAccount>>,
    /// The user's NO account; the token program checks `user` may burn from it.
    #[account(mut, token::mint = no_mint)]
    pub user_no: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub yes_mint: Box<Account<'info, Mint>>,
    #[account(mut)]
    pub no_mint: Box<Account<'info, Mint>>,
    #[account(mut)]
    pub vault: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

pub fn handle_redeem(ctx: Context<Redeem>, yes_qty: u64, no_qty: u64) -> Result<()> {
    match ctx.accounts.market.status {
        MarketStatus::Open => redeem_pair(ctx, yes_qty, no_qty),
        // Winner mode: M1-07.
        MarketStatus::Settled => Err(MeridianError::NotImplemented.into()),
    }
}

/// Pair mode: equal quantities, same market, any time before settlement.
fn redeem_pair(ctx: Context<Redeem>, yes_qty: u64, no_qty: u64) -> Result<()> {
    require!(yes_qty == no_qty, MeridianError::PairQuantityMismatch);
    require!(yes_qty > 0, MeridianError::NothingToRedeem);
    redeem_pairs(
        &ctx.accounts.token_program,
        &ctx.accounts.user,
        &ctx.accounts.user_usdc,
        (&ctx.accounts.yes_mint, &ctx.accounts.user_yes),
        (&ctx.accounts.no_mint, &ctx.accounts.user_no),
        &ctx.accounts.vault,
        &mut ctx.accounts.market,
        yes_qty,
    )
}

/// Burns `qty` YES + `qty` NO of the user and pays `qty` USDC from the vault; the caller has
/// checked `qty > 0`. Also used by `buy_no` and `sell_no`. Tokens are burned before the vault
/// pays, with checked arithmetic first (AB-02, AB-12).
#[allow(clippy::too_many_arguments)]
pub(crate) fn redeem_pairs<'info>(
    token_program: &Program<'info, Token>,
    user: &Signer<'info>,
    user_usdc: &Account<'info, TokenAccount>,
    (yes_mint, user_yes): (&Account<'info, Mint>, &Account<'info, TokenAccount>),
    (no_mint, user_no): (&Account<'info, Mint>, &Account<'info, TokenAccount>),
    vault: &Account<'info, TokenAccount>,
    market: &mut Account<'info, Market>,
    qty: u64,
) -> Result<()> {
    let usdc = qty
        .checked_mul(PAIR_COLLATERAL)
        .ok_or(MeridianError::MathOverflow)?;
    let pairs_outstanding = market
        .pairs_outstanding
        .checked_sub(qty)
        .ok_or(MeridianError::MathOverflow)?;

    for (mint, from) in [(yes_mint, user_yes), (no_mint, user_no)] {
        token::burn(
            CpiContext::new(
                token_program.to_account_info(),
                Burn {
                    mint: mint.to_account_info(),
                    from: from.to_account_info(),
                    authority: user.to_account_info(),
                },
            ),
            qty,
        )?;
    }

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
                from: vault.to_account_info(),
                to: user_usdc.to_account_info(),
                authority: market.to_account_info(),
            },
            signer_seeds,
        ),
        usdc,
    )?;

    market.pairs_outstanding = pairs_outstanding;
    emit!(Redeemed {
        market: market.key(),
        user: user.key(),
        yes_qty: qty,
        no_qty: qty,
        usdc,
    });
    Ok(())
}
