//! `local_oracle_set`: test-only oracle writer behind the `local-oracle` feature (D-028, AB-22).
//! Stores a price in a [`LocalFeed`] PDA that `settle_market` reads like a Switchboard feed. The
//! module is not compiled without the feature, so devnet builds neither contain nor list it.
//! Like every test-only helper it emits no event (the event list is frozen, D-022).

use anchor_lang::prelude::*;

use crate::errors::MeridianError;
use crate::oracle::{LocalFeed, LOCAL_FEED_SEED};
use crate::state::{Config, CONFIG_SEED, FEEDS_PER_TICKER, SYMBOL_LEN};

#[derive(Accounts)]
#[instruction(ticker: [u8; SYMBOL_LEN], source_slot: u8)]
pub struct LocalOracleSet<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ MeridianError::AdminOnly)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        init_if_needed,
        payer = admin,
        space = 8 + LocalFeed::INIT_SPACE,
        seeds = [LOCAL_FEED_SEED, &ticker, &[source_slot]],
        bump,
    )]
    pub local_feed: Box<Account<'info, LocalFeed>>,
    /// The admin writes the local oracle (test only).
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handle_local_oracle_set(
    ctx: Context<LocalOracleSet>,
    ticker: [u8; SYMBOL_LEN],
    source_slot: u8,
    value: i128,
    slot: u64,
) -> Result<()> {
    require!(
        usize::from(source_slot) < FEEDS_PER_TICKER,
        MeridianError::InvalidTickerSlot
    );
    require!(
        ctx.accounts.config.ticker(&ticker).is_some(),
        MeridianError::UnknownTicker
    );
    let feed = &mut ctx.accounts.local_feed;
    feed.ticker = ticker;
    feed.source_slot = source_slot;
    feed.value = value;
    feed.slot = slot;
    feed.updated_at = Clock::get()?.unix_timestamp;
    feed.bump = ctx.bumps.local_feed;
    Ok(())
}
