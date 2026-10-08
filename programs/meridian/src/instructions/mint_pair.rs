//! `mint_pair` (FR-04, FR-11, FR-12): the user deposits `qty × 1 USDC` into the market vault and
//! receives `qty` YES + `qty` NO. The market PDA is the only mint authority (AB-01), so tokens
//! exist only against collateral: vault = 1,000,000 × pairs outstanding (invariant 1).
//!
//! Rejected while paused, at or after `close_ts`, after settlement, for `qty == 0` and for any
//! quantity whose collateral or pair count would overflow (AB-11, AB-12). Amounts are computed
//! with checked arithmetic before any token movement.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount, Transfer};

use crate::errors::MeridianError;
use crate::events::PairsMinted;
use crate::state::{Config, Market, MarketStatus, CONFIG_SEED, MARKET_SEED, PAIR_COLLATERAL};

#[derive(Accounts)]
pub struct MintPair<'info> {
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
        has_one = yes_mint,
        has_one = no_mint,
        has_one = vault,
    )]
    pub market: Box<Account<'info, Market>>,
    /// The user depositing USDC.
    pub user: Signer<'info>,
    /// The user's USDC account; the token program checks `user` may debit it.
    #[account(mut, token::mint = config.usdc_mint)]
    pub user_usdc: Box<Account<'info, TokenAccount>>,
    /// Receives the YES tokens.
    #[account(mut, token::mint = yes_mint)]
    pub user_yes: Box<Account<'info, TokenAccount>>,
    /// Receives the NO tokens.
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

pub fn handle_mint_pair(ctx: Context<MintPair>, qty: u64) -> Result<()> {
    let config = &ctx.accounts.config;
    let market = &ctx.accounts.market;
    require!(!config.paused, MeridianError::Paused);
    require!(
        market.status == MarketStatus::Open,
        MeridianError::AlreadySettled
    );
    let now = Clock::get()?.unix_timestamp;
    require!(now < market.close_ts, MeridianError::MarketClosed);
    require!(qty > 0, MeridianError::InvalidQuantity);

    mint_pairs(
        &ctx.accounts.token_program,
        &ctx.accounts.user,
        &ctx.accounts.user_usdc,
        &ctx.accounts.vault,
        (&ctx.accounts.yes_mint, &ctx.accounts.user_yes),
        (&ctx.accounts.no_mint, &ctx.accounts.user_no),
        &mut ctx.accounts.market,
        qty,
    )
}

/// Deposits `qty` USDC into the vault and mints `qty` YES + `qty` NO to the user; the caller
/// has checked pause, close and `qty > 0`. Also used by `buy_no`. Amounts are computed with
/// checked arithmetic before any token movement (AB-12).
#[allow(clippy::too_many_arguments)]
pub(crate) fn mint_pairs<'info>(
    token_program: &Program<'info, Token>,
    user: &Signer<'info>,
    user_usdc: &Account<'info, TokenAccount>,
    vault: &Account<'info, TokenAccount>,
    (yes_mint, user_yes): (&Account<'info, Mint>, &Account<'info, TokenAccount>),
    (no_mint, user_no): (&Account<'info, Mint>, &Account<'info, TokenAccount>),
    market: &mut Account<'info, Market>,
    qty: u64,
) -> Result<()> {
    let collateral = qty
        .checked_mul(PAIR_COLLATERAL)
        .ok_or(MeridianError::MathOverflow)?;
    let pairs_outstanding = market
        .pairs_outstanding
        .checked_add(qty)
        .ok_or(MeridianError::MathOverflow)?;

    token::transfer(
        CpiContext::new(
            token_program.to_account_info(),
            Transfer {
                from: user_usdc.to_account_info(),
                to: vault.to_account_info(),
                authority: user.to_account_info(),
            },
        ),
        collateral,
    )?;

    let signer_seeds: &[&[&[u8]]] = &[&[
        MARKET_SEED,
        &market.ticker,
        &market.trading_date.to_le_bytes(),
        &market.strike_cents.to_le_bytes(),
        &[market.bump],
    ]];
    for (mint, to) in [(yes_mint, user_yes), (no_mint, user_no)] {
        token::mint_to(
            CpiContext::new_with_signer(
                token_program.to_account_info(),
                MintTo {
                    mint: mint.to_account_info(),
                    to: to.to_account_info(),
                    authority: market.to_account_info(),
                },
                signer_seeds,
            ),
            qty,
        )?;
    }

    market.pairs_outstanding = pairs_outstanding;
    emit!(PairsMinted {
        market: market.key(),
        user: user.key(),
        qty,
        pairs_outstanding,
    });
    Ok(())
}
