//! `add_strike` (FR-03, D-030): the admin creates an extra strike for a ticker before close.
//! Same accounts, validation and creation path as `create_strike_market`, with the admin as
//! signer and payer instead of the automation authority (AB-06).

use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::errors::MeridianError;
use crate::instructions::create_strike_market::{
    create_market, validate_market_params, MarketAccounts, MarketParams,
};
use crate::state::{
    Book, Config, Market, BOOK_SEED, CONFIG_SEED, ESCROW_USDC_SEED, ESCROW_YES_SEED, MARKET_SEED,
    NO_MINT_SEED, SYMBOL_LEN, VAULT_SEED, YES_MINT_SEED,
};

#[derive(Accounts)]
#[instruction(ticker: [u8; SYMBOL_LEN], strike_cents: u64, trading_date: u32, close_ts: i64)]
pub struct AddStrike<'info> {
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ MeridianError::AdminOnly,
        has_one = usdc_mint @ MeridianError::InvalidUsdcMint,
    )]
    pub config: Box<Account<'info, Config>>,
    /// The admin; pays for the new accounts.
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        payer = admin,
        space = 8 + Market::INIT_SPACE,
        seeds = [MARKET_SEED, &ticker, &trading_date.to_le_bytes(), &strike_cents.to_le_bytes()],
        bump,
    )]
    pub market: Box<Account<'info, Market>>,
    #[account(
        init,
        payer = admin,
        seeds = [YES_MINT_SEED, market.key().as_ref()],
        bump,
        mint::decimals = 0,
        mint::authority = market,
    )]
    pub yes_mint: Box<Account<'info, Mint>>,
    #[account(
        init,
        payer = admin,
        seeds = [NO_MINT_SEED, market.key().as_ref()],
        bump,
        mint::decimals = 0,
        mint::authority = market,
    )]
    pub no_mint: Box<Account<'info, Mint>>,
    #[account(
        init,
        payer = admin,
        seeds = [VAULT_SEED, market.key().as_ref()],
        bump,
        token::mint = usdc_mint,
        token::authority = market,
    )]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(
        init,
        payer = admin,
        seeds = [ESCROW_USDC_SEED, market.key().as_ref()],
        bump,
        token::mint = usdc_mint,
        token::authority = market,
    )]
    pub escrow_usdc: Box<Account<'info, TokenAccount>>,
    #[account(
        init,
        payer = admin,
        seeds = [ESCROW_YES_SEED, market.key().as_ref()],
        bump,
        token::mint = yes_mint,
        token::authority = market,
    )]
    pub escrow_yes: Box<Account<'info, TokenAccount>>,
    #[account(
        init,
        payer = admin,
        space = Book::SPACE,
        seeds = [BOOK_SEED, market.key().as_ref()],
        bump,
    )]
    pub book: AccountLoader<'info, Book>,
    /// The test-USDC mint pinned in the config.
    pub usdc_mint: Box<Account<'info, Mint>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handle_add_strike(
    ctx: Context<AddStrike>,
    ticker: [u8; SYMBOL_LEN],
    strike_cents: u64,
    trading_date: u32,
    close_ts: i64,
) -> Result<()> {
    let params = MarketParams {
        ticker,
        strike_cents,
        trading_date,
        close_ts,
    };
    validate_market_params(&ctx.accounts.config, &params, Clock::get()?.unix_timestamp)?;
    create_market(
        MarketAccounts {
            market: &mut ctx.accounts.market,
            book: &ctx.accounts.book,
            yes_mint: ctx.accounts.yes_mint.key(),
            no_mint: ctx.accounts.no_mint.key(),
            vault: ctx.accounts.vault.key(),
            escrow_usdc: ctx.accounts.escrow_usdc.key(),
            escrow_yes: ctx.accounts.escrow_yes.key(),
            market_bump: ctx.bumps.market,
            book_bump: ctx.bumps.book,
        },
        &params,
    )
}
