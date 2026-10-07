//! `create_strike_market` (FR-02, D-030): the automation authority creates one strike market:
//! the `Market` account, YES/NO mints (0 decimals, authority = market PDA), the USDC vault,
//! the USDC and YES book escrows and the zero-copy book; emits `MarketCreated`.
//!
//! Rejected: an unknown ticker, a strike that is not a positive multiple of $10, a malformed
//! trading date, a `close_ts` not in the future, and a duplicate market (the PDA already
//! exists, so `init` fails). `add_strike` (admin) shares [`create_market`].
//!
//! Accounts are boxed: twelve accounts with `init` constraints overflow the 4 KB SBF stack
//! frame otherwise (the build prints "Stack offset ... exceeded", and execution faults).

use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::errors::MeridianError;
use crate::events::MarketCreated;
use crate::state::{
    Book, Config, Market, MarketStatus, Outcome, SettleSource, BOOK_SEED, CONFIG_SEED,
    ESCROW_USDC_SEED, ESCROW_YES_SEED, MARKET_SEED, NO_MINT_SEED, STRIKE_STEP_CENTS, SYMBOL_LEN,
    VAULT_SEED, YES_MINT_SEED,
};

#[derive(Accounts)]
#[instruction(ticker: [u8; SYMBOL_LEN], strike_cents: u64, trading_date: u32, close_ts: i64)]
pub struct CreateStrikeMarket<'info> {
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = automation_authority @ MeridianError::AutomationOnly,
        has_one = usdc_mint @ MeridianError::InvalidUsdcMint,
    )]
    pub config: Box<Account<'info, Config>>,
    /// The automation authority (D-030); pays for the new accounts.
    #[account(mut)]
    pub automation_authority: Signer<'info>,
    #[account(
        init,
        payer = automation_authority,
        space = 8 + Market::INIT_SPACE,
        seeds = [MARKET_SEED, &ticker, &trading_date.to_le_bytes(), &strike_cents.to_le_bytes()],
        bump,
    )]
    pub market: Box<Account<'info, Market>>,
    #[account(
        init,
        payer = automation_authority,
        seeds = [YES_MINT_SEED, market.key().as_ref()],
        bump,
        mint::decimals = 0,
        mint::authority = market,
    )]
    pub yes_mint: Box<Account<'info, Mint>>,
    #[account(
        init,
        payer = automation_authority,
        seeds = [NO_MINT_SEED, market.key().as_ref()],
        bump,
        mint::decimals = 0,
        mint::authority = market,
    )]
    pub no_mint: Box<Account<'info, Mint>>,
    #[account(
        init,
        payer = automation_authority,
        seeds = [VAULT_SEED, market.key().as_ref()],
        bump,
        token::mint = usdc_mint,
        token::authority = market,
    )]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(
        init,
        payer = automation_authority,
        seeds = [ESCROW_USDC_SEED, market.key().as_ref()],
        bump,
        token::mint = usdc_mint,
        token::authority = market,
    )]
    pub escrow_usdc: Box<Account<'info, TokenAccount>>,
    #[account(
        init,
        payer = automation_authority,
        seeds = [ESCROW_YES_SEED, market.key().as_ref()],
        bump,
        token::mint = yes_mint,
        token::authority = market,
    )]
    pub escrow_yes: Box<Account<'info, TokenAccount>>,
    #[account(
        init,
        payer = automation_authority,
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

/// Arguments of one market creation, validated by [`validate_market_params`].
#[derive(Clone, Copy, Debug)]
pub struct MarketParams {
    pub ticker: [u8; SYMBOL_LEN],
    pub strike_cents: u64,
    pub trading_date: u32,
    pub close_ts: i64,
}

/// The accounts every creation path writes: the market, its book and the keys stored in it.
pub struct MarketAccounts<'a, 'info> {
    pub market: &'a mut Box<Account<'info, Market>>,
    pub book: &'a AccountLoader<'info, Book>,
    pub yes_mint: Pubkey,
    pub no_mint: Pubkey,
    pub vault: Pubkey,
    pub escrow_usdc: Pubkey,
    pub escrow_yes: Pubkey,
    pub market_bump: u8,
    pub book_bump: u8,
}

/// Rejects an unknown ticker, a bad strike, a malformed trading date or a close time that is
/// not after `now` (FR-02, FR-03).
pub fn validate_market_params(config: &Config, params: &MarketParams, now: i64) -> Result<()> {
    require!(
        config.ticker(&params.ticker).is_some(),
        MeridianError::UnknownTicker
    );
    require!(
        params.strike_cents > 0 && params.strike_cents.checked_rem(STRIKE_STEP_CENTS) == Some(0),
        MeridianError::InvalidStrike
    );
    require!(
        is_calendar_date(params.trading_date),
        MeridianError::InvalidTradingDate
    );
    require!(params.close_ts > now, MeridianError::CloseInThePast);
    Ok(())
}

/// True when `yyyymmdd` is a real calendar date between 2000-01-01 and 9999-12-31.
pub fn is_calendar_date(yyyymmdd: u32) -> bool {
    let year = yyyymmdd / 10_000;
    let month = (yyyymmdd / 100) % 100;
    let day = yyyymmdd % 100;
    if !(2_000..=9_999).contains(&year) {
        return false;
    }
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let days_in_month = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return false,
    };
    (1..=days_in_month).contains(&day)
}

/// Writes a fresh market and its book, then emits `MarketCreated`. The caller has already
/// validated `params` and created every account.
pub fn create_market(accounts: MarketAccounts<'_, '_>, params: &MarketParams) -> Result<()> {
    let market_key = accounts.market.key();
    let market = accounts.market;
    market.ticker = params.ticker;
    market.strike_cents = params.strike_cents;
    market.trading_date = params.trading_date;
    market.close_ts = params.close_ts;
    market.yes_mint = accounts.yes_mint;
    market.no_mint = accounts.no_mint;
    market.vault = accounts.vault;
    market.escrow_usdc = accounts.escrow_usdc;
    market.escrow_yes = accounts.escrow_yes;
    market.book = accounts.book.key();
    market.pairs_outstanding = 0;
    market.status = MarketStatus::Open;
    market.outcome = Outcome::None;
    market.settle_price_scaled = 0;
    market.settle_slot = 0;
    market.settled_at = 0;
    market.settle_source = SettleSource::None;
    market.bump = accounts.market_bump;

    let mut book = accounts.book.load_init()?;
    book.next_seq = 1;
    book.market = market_key;
    book.bump = accounts.book_bump;

    emit!(MarketCreated {
        market: market_key,
        ticker: params.ticker,
        strike_cents: params.strike_cents,
        trading_date: params.trading_date,
        close_ts: params.close_ts,
        yes_mint: accounts.yes_mint,
        no_mint: accounts.no_mint,
    });
    Ok(())
}

pub fn handle_create_strike_market(
    ctx: Context<CreateStrikeMarket>,
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
